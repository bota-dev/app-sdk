import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
const require=createRequire(import.meta.url);
const {DeviceManager}=require('../lib/commonjs/managers/DeviceManager.js');
const {setCompatibilityClientForTesting}=require('../lib/commonjs/compatibility/runtime.js');
afterEach(()=>setCompatibilityClientForTesting(null));
const device={id:'peripheral',serialNumber:'SERIAL',connectionState:'connected'};
function fixture(){
 const effects=[];let nonce=0;
 const controls={readFindCapabilities:async()=>({supported:true}),readAuthNonce:async()=>{effects.push('nonce');return (++nonce).toString(16).padStart(32,'0');},
 requestFindDevice:async(_d,r)=>{effects.push(r.action);return {active:r.action==='start',success:true};}};
 setCompatibilityClientForTesting({controls});const manager=new DeviceManager();manager.rememberConnected(device);
 return {manager,effects,controls};
}
test('stop queued during grant acquisition obtains its own fresh nonce after start settles',async()=>{
 const f=fixture();let release;const wait=new Promise(r=>release=r);const nonces=[];
 const start=f.manager.requestFindDevice(device,'01'.repeat(16),async n=>{nonces.push(n);await wait;return 'grant';});
 const stop=f.manager.requestStopFindDevice(device,'02'.repeat(16),async n=>{nonces.push(n);return 'grant';});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.effects,['nonce']);release();
 await Promise.all([start,stop]);assert.deepEqual(f.effects,['nonce','start','nonce','stop']);assert.notEqual(nonces[0],nonces[1]);
});
test('same-ID reconnect while grant is fetched suppresses all control writes',async()=>{
 const f=fixture();await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=>{f.manager.rememberConnected({...device});return 'grant';}),/connection_changed/);
 assert.deepEqual(f.effects,['nonce']);
});
test('explicit stop remains possible after a failed start receipt',async()=>{
 const f=fixture();const write=f.controls.requestFindDevice;
 f.controls.requestFindDevice=async(d,r)=>{if(r.action==='start')throw Error('timeout');return write(d,r);};
 await assert.rejects(f.manager.requestFindDevice(device,'01'.repeat(16),async()=> 'grant'),/timeout/);
 assert.equal((await f.manager.requestStopFindDevice(device,'02'.repeat(16),async()=> 'grant')).active,false);
});
