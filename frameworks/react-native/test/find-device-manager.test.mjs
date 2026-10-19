import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
const require=createRequire(import.meta.url);
const {DeviceManager}=require('../lib/commonjs/managers/DeviceManager.js');
const {setCompatibilityClientForTesting}=require('../lib/commonjs/compatibility/runtime.js');
afterEach(()=>setCompatibilityClientForTesting(null));
const binding={issue:async()=> 'confirmation',acknowledge:async()=>{}};
const device={id:'peripheral',serialNumber:'SERIAL',connectionState:'connected'};
function fixture(){
 const effects=[];let nonce=0;
 const controls={readFindCapabilities:async()=>({supported:true,protocolVersion:2}),readFindBindingChallenge:async()=>'01'.repeat(16),confirmFindBinding:async()=>'ack',readAuthNonce:async()=>{throw Error('legacy nonce touched');},readFindChallenge:async()=>{effects.push('nonce');return (++nonce).toString(16).padStart(32,'0');},
 requestFindDevice:async(_d,r)=>{effects.push(r.action);return {active:r.action==='start',success:true};}};
 setCompatibilityClientForTesting({controls});const manager=new DeviceManager();manager.rememberConnected(device);
 return {manager,effects,controls};
}
test('STOP cancels a waiting START and obtains fresh independent authority',async()=>{
 const f=fixture();let release;const wait=new Promise(r=>release=r);const nonces=[];
 const start=f.manager.requestFindDevice(device,'01'.repeat(16),async n=>{nonces.push(n);await wait;return 'grant';},10,binding);
 const rejected=assert.rejects(start,/cancelled/);
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.effects,['nonce']);
 const stop=f.manager.requestStopFindDevice(device,'02'.repeat(16),async n=>{nonces.push(n);return 'grant';},binding);
 release();await rejected;await stop;
 assert.deepEqual(f.effects,['nonce','nonce','stop']);assert.notEqual(nonces[0],nonces[1]);
});
test('same-ID reconnect while grant is fetched suppresses all control writes',async()=>{
 const f=fixture();await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=>{f.manager.rememberConnected({...device});return 'grant';},10,binding),/connection_changed/);
 assert.deepEqual(f.effects,['nonce']);
});
test('explicit stop remains possible after a failed start receipt',async()=>{
 const f=fixture();const write=f.controls.requestFindDevice;
 f.controls.requestFindDevice=async(d,r)=>{if(r.action==='start')throw Error('timeout');return write(d,r);};
 await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=> 'grant',10,binding),/timeout/);
 assert.equal((await f.manager.requestStopFindDevice(device,'02'.repeat(16),async()=> 'grant',binding)).active,false);
});

test('missing confirmation provider and legacy capabilities fail before authority', async()=>{
 const f=fixture();await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=> 'grant'),/binding_confirmation_required/);
 assert.deepEqual(f.effects,[]);
 f.controls.readFindCapabilities=async()=>({supported:true,protocolVersion:1});
 await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=> 'grant',10,binding),/unsupported_capability/);
 assert.deepEqual(f.effects,[]);
});
test('confirmation failure leaves connection intact and never requests a Find challenge',async()=>{
 const f=fixture();await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=> 'grant',10,{...binding,acknowledge:async()=>{throw Error('lost ACK');}}),/lost ACK/);
 assert.deepEqual(f.effects,[]);assert.equal(f.manager.getConnectedDevices()[0],device);
});

test('a stalled HTTP grant expires locally and cannot block the next explicit STOP indefinitely', async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();let late;
 const start=f.manager.requestFindDevice(device,'01'.repeat(16),()=>new Promise(resolve=>{late=resolve;}),10,binding);
 const expired=assert.rejects(start,/authorization_timeout/);
 await new Promise(r=>setImmediate(r));
 t.mock.timers.tick(15000);await expired;
 await f.manager.requestStopFindDevice(device,'02'.repeat(16),async()=> 'stop-grant',binding);
 late('stale-start-grant');await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.effects,['nonce','nonce','stop']);
});
