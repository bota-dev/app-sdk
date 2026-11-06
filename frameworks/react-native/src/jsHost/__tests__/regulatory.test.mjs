import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';
const {createGeneratedJsCore}=loadSource('core.ts');
const {JsDeviceControls}=loadSource('deviceControls.ts');
const vector=JSON.parse(readFileSync(new URL('../../../../../protocol/fixtures/regulatory-signed-v1.json',import.meta.url),'utf8'));
const wire=Buffer.from(vector.documentHex,'hex'),receipt=Buffer.from(vector.receiptHex,'hex');
function fixture(mode='notify') {
 const core=createGeneratedJsCore(),meta=core.codec('protocolMetadata',{}),calls=[];
 const device={id:'peripheral',serialNumber:'SYNTHETIC',mtu:23};
 const scope=new AbortController(),operation=new AbortController();
 const context={operation:'DeviceControl',operationId:'country-test',requestId:'0',cancellationId:'01'.repeat(16),generation:'1',signal:operation.signal};
 let callback;
 const ports={signal:scope.signal,persistence:{namespace:'test/country'},ble:{
  async hasService(){return true;},
  async read(address){calls.push(['read',address.characteristicUuid]);
   if(address.characteristicUuid===meta.CHAR_SERIAL_NUMBER)return new Uint8Array(Buffer.from(device.serialNumber));
   if(address.characteristicUuid===meta.CHAR_REGULATORY_CAPABILITIES)return Uint8Array.from([1,15,66,2,198,0,120,0]);
   if(address.characteristicUuid===meta.CHAR_REGULATORY_RECEIPT)return new Uint8Array(receipt);
   throw Error('unexpected read');},
  async subscribe(_address,notify){calls.push(['subscribe']);callback=notify;return {async remove(){calls.push(['remove']);}};},
  async write(address,bytes){calls.push(['write',address.characteristicUuid,[...bytes]]);
   if(mode==='scope')scope.abort();
   if(bytes[0]+1===bytes[1]&&mode==='notify'){
    const total=Math.ceil(receipt.length/16);
    for(let i=0;i<total;i++)callback(Uint8Array.from([i,total,...receipt.subarray(i*16,(i+1)*16)]));
   }
  },
 }};
 const connection={device,generation:'connection-1'};
 const controls=new JsDeviceControls({core,ports,connection:()=>connection,emit(){},gatt:(_context,body)=>body()});
 const apply=()=>controls.execute('applyRegulatoryConfiguration',[device,{format:'bota-regulatory-signed-v1',encoding:'base64url',data:wire.toString('base64url'),nonce:'01'.repeat(16)}],context);
 return {controls,apply,calls,core,meta};
}
test('actual generated Rust sends minimum-MTU frames after subscribing and matches fragmented ACK',async()=>{
 const f=fixture();try {
  const result=await f.apply();assert.equal(result.result,0);assert.equal(result.acknowledgement,receipt.toString('base64url'));
  const writes=f.calls.filter(c=>c[0]==='write');assert.ok(writes.length>1);assert.ok(writes.every(c=>c[2].length<=20));
  assert.deepEqual(Buffer.from(writes.flatMap(c=>c[2].slice(2))),wire);
  assert.ok(f.calls.findIndex(c=>c[0]==='subscribe')<f.calls.findIndex(c=>c[0]==='write'));
  assert.equal(f.calls.filter(c=>c[0]==='remove').length,1);
  assert.throws(()=>f.core.codec('regulatory',{op:'Receipt',bytes:[...receipt]}));
 } finally {await f.controls.close();}
});
test('lost notifications recover from a complete durable Read Blob receipt',async()=>{
 const f=fixture('read');try {assert.equal((await f.apply()).result,0);
 assert.ok(f.calls.some(c=>c[0]==='read'&&c[1]===f.meta.CHAR_REGULATORY_RECEIPT));
 assert.equal(f.calls.filter(c=>c[0]==='remove').length,1);
 }finally{await f.controls.close();}
});
test('scope invalidation during fragmented write stops further writes and retires subscription',async()=>{
 const f=fixture('scope');try {
 await assert.rejects(f.apply());assert.equal(f.calls.filter(c=>c[0]==='write').length,1);
 assert.equal(f.calls.filter(c=>c[0]==='remove').length,1);
 }finally{await f.controls.close();}
});
