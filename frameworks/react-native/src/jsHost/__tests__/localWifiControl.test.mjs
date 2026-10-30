import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';
const {createGeneratedJsCore}=loadSource('core.ts');
const vector=JSON.parse(readFileSync(new URL('../../../../../protocol/local-wifi-control-v1.vector.json',import.meta.url),'utf8'));
const bytes=hex=>[...Buffer.from(hex,'hex')];
function fixture(response=vector.response) {
 const core=createGeneratedJsCore();const rpc=(op,input)=>core.codec('localWifiTransfer',{op,...input});
 const created=rpc('ControlCreate',{session_id:vector.sessionId,response_json:JSON.stringify(response)});
 return {core,created,rpc};
}
test('generated Rust agrees byte-for-byte with independent Node/OpenSSL vector',()=>{
 const f=fixture();try {
  assert.equal(f.created.blobKind,7);assert.equal(f.created.envelope.length,509);
  assert.equal(Buffer.from(f.rpc('ControlSeal',{id:f.created.id,bytes:bytes(vector.queryPlainHex)})).toString('hex'),vector.queryWireHex);
  assert.deepEqual(f.rpc('ControlOpen',{id:f.created.id,bytes:bytes(vector.replyWireHex)}),bytes(vector.replyPlainHex));
  assert.throws(()=>f.rpc('ControlOpen',{id:f.created.id,bytes:bytes(vector.replyWireHex)}));
  assert.throws(()=>f.rpc('ControlSeal',{id:f.created.id,bytes:bytes(vector.queryPlainHex)}),'authentication failure retires key');
 }finally{f.core.dispose();}
});
test('generation refuses malformed grant and never treats profile 1 as secure',()=>{
 for(const change of [{expires_in_seconds:301},{format:'bota-device-token-v1'},{control_key_base64:'AA=='},{extra:true}]) {
  const core=createGeneratedJsCore();try {
   assert.throws(()=>core.codec('localWifiTransfer',{op:'ControlCreate',session_id:'41',response_json:JSON.stringify({...vector.response,...change})}));
   assert.throws(()=>core.codec('localWifiTransfer',{op:'Capabilities',bytes:bytes('010110000f0000000300b900b600b600'),att_mtu:185}));
  } finally {core.dispose();}
 }
});
