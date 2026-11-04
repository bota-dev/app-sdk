import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';
const { createGeneratedJsCore } = loadSource('core.ts');
const v=JSON.parse(readFileSync(new URL('../../../../../protocol/wifi-config-v2.vector.json',import.meta.url),'utf8'));
const r=v.response;
const grant={format:r.format,grantBlob:r.envelope_base64,keyBase64:r.key_base64,requestId:r.request_id,
  authNonce:r.auth_nonce,action:r.action,serialNumber:r.serial_number,bindingGeneration:r.binding_generation,expiresAt:r.expires_at};
const create={Create:{grant,ssid:'Audit-Network',password:'Audit-Only-123',nonce:r.auth_nonce,serial:r.serial_number,capacity:182}};
test('committed generated runtime sends encrypted credentials and authenticates the firmware receipt',()=>{
 const core=createGeneratedJsCore();try {
  const prepared=core.codec('wifiProvisioning',create);
  assert.equal(Buffer.from(prepared.credentials).toString('hex'),v.credentialHex);
  assert.equal(prepared.chunks.length,3);
  assert.equal(core.codec('wifiProvisioning',{Result:{id:prepared.id,bytes:[...Buffer.from(v.successHex,'hex')]}}).success,true);
  assert.throws(()=>core.codec('wifiProvisioning',{Result:{id:prepared.id,bytes:[...Buffer.from(v.successHex,'hex')]}}));
  assert.throws(()=>core.codec('encodeWiFiCredentials',{ssid:'Audit-Network',password:'Audit-Only-123'}));
 } finally {core.dispose();}
});
test('old capabilities, changed nonce and legacy grants fail before encrypted frame creation',()=>{
 const core=createGeneratedJsCore();try {
  assert.throws(()=>core.codec('wifiProvisioning',{Capability:{bytes:[]}}));
  assert.throws(()=>core.codec('wifiProvisioning',{Create:{...create.Create,nonce:'01'.repeat(16)}}));
  assert.throws(()=>core.codec('wifiProvisioning',{Create:{...create.Create,grant:{...grant,grantBlob:'jwt'}}}));
 } finally {core.dispose();}
});

test('both directions depend on every operation-key byte and the complete grant', () => {
 const variants = Array.from({length:32}, (_, index) => {
  const key = Buffer.from(grant.keyBase64, 'base64');
  key[index] ^= 1;
  return {...grant, keyBase64:key.toString('base64')};
 });
 // The SDK treats the signed envelope as salt; firmware authenticates it.
 // Its final signature byte must still affect both directional keys.
 const envelope = Buffer.from(grant.grantBlob, 'base64');
 envelope[envelope.length - 1] ^= 1;
 variants.push({...grant, grantBlob:envelope.toString('base64')});
 for (const [index, changedGrant] of variants.entries()) {
  const core = createGeneratedJsCore();
  try {
   const prepared = core.codec('wifiProvisioning', {Create:{...create.Create, grant:changedGrant}});
   assert.notEqual(Buffer.from(prepared.credentials).toString('hex'), v.credentialHex, `key/grant variant ${index}`);
   assert.throws(() => core.codec('wifiProvisioning', {Result:{id:prepared.id, bytes:[...Buffer.from(v.successHex, 'hex')]}}));
  } finally {core.dispose();}
 }
 const core = createGeneratedJsCore();
 try {
  assert.throws(() => core.codec('wifiProvisioning', {Create:{...create.Create,
   grant:{...grant, keyBase64:Buffer.alloc(32).toString('base64')}}}));
 } finally {core.dispose();}
});

const { JsDeviceControls } = loadSource('deviceControls.ts');
function host(mode = 'success', version = 2) {
 const vector=version===2?v:JSON.parse(readFileSync(new URL('../../../../../protocol/wifi-config-v3.vector.json',import.meta.url),'utf8'));
 const r=vector.response;
 const core=createGeneratedJsCore(), meta=core.codec('protocolMetadata',{}), writes=[], listeners=new Set();
 const device={id:'peripheral',serialNumber:r.serial_number,mtu:185};
 let generation='1', removed=0;
 const controller=new AbortController();
 const context={operation:'DeviceControl',operationId:'test',requestId:'0',cancellationId:'01'.repeat(16),generation:'1',signal:controller.signal};
 const ble={
  async read(address) {
   if(address.characteristicUuid===meta.CHAR_SERIAL_NUMBER)return Buffer.from(r.serial_number);
   if(address.characteristicUuid===meta.CHAR_AUTH_NONCE)return Buffer.from(mode==='nonce'?'01'.repeat(16):r.auth_nonce,'hex');
   return mode==='legacy'?new Uint8Array():Uint8Array.from(version===2?[0xb2,2,7,0,253,1,126,0]:[0xb2,3,7,0,29,2,126,0]);
  },
  async subscribe(_address,callback) {listeners.add(callback);return {async remove(){removed++;listeners.delete(callback);}};},
  async write(address,value) {
   writes.push({characteristic:address.characteristicUuid,bytes:Buffer.from(value)});
   if(mode==='reconnect')generation='2';
   if(mode==='cancel')controller.abort();
   if(address.characteristicUuid===meta.CHAR_WIFI_CREDENTIAL) {
    const receipt=Buffer.from(vector.successHex,'hex');if(mode==='tamper')receipt[28]^=1;
    // A connected notification containing an SSID cannot acknowledge setup.
    for(const callback of listeners){callback(Buffer.from([2,1,65]));callback(receipt);}
   }
  },
 };
 const controls=new JsDeviceControls({core,ports:{ble,persistence:{namespace:'workspace'}},
  connection:()=>({device,generation}),gatt:(_ctx,body)=>body(),emit(){}});
 return {core,controls,context,device,writes,meta,removed:()=>removed};
}
test('actual generated core and BLE host send only ciphertext and wait for authenticated receipt',async()=>{
 const f=host();try {
  const result=await f.controls.execute('configureSecureWiFi',[f.device,create.Create.ssid,create.Create.password,JSON.stringify(grant)],f.context);
  assert.equal(result.success,true);assert.equal(f.writes.length,4);assert.equal(f.removed(),1);
  assert.equal(f.writes.at(-1).bytes.toString('hex'),v.credentialHex);
  assert.equal(Buffer.concat(f.writes.slice(0,3).map(w=>w.bytes.subarray(6))).toString('base64'),r.envelope_base64);
  for(const write of f.writes) {
   assert.equal(write.bytes.includes(Buffer.from(create.Create.ssid)),false);
   assert.equal(write.bytes.includes(Buffer.from(create.Create.password)),false);
  }
 } finally {await f.controls.close();f.core.dispose();}
});
for(const mode of ['legacy','nonce','reconnect','cancel','tamper'])test(`secure host refuses ${mode} without plaintext fallback`,async()=>{
 const f=host(mode);try {
  await assert.rejects(f.controls.execute('configureSecureWiFi',[f.device,create.Create.ssid,create.Create.password,JSON.stringify(grant)],f.context));
  if(['legacy','nonce'].includes(mode))assert.equal(f.writes.length,0);
  if(['reconnect','cancel'].includes(mode))assert.equal(f.writes.length,1);
  if(mode==='tamper')assert.equal(f.writes.length,4);
 } finally {await f.controls.close();f.core.dispose();}
});

test('generated runtime binds the v3 grant and refuses mismatched response versions',()=>{
 const v3=JSON.parse(readFileSync(new URL('../../../../../protocol/wifi-config-v3.vector.json',import.meta.url),'utf8'));
 const response=v3.response;
 const material={format:response.format,grantBlob:response.envelope_base64,keyBase64:response.key_base64,
  requestId:response.request_id,authNonce:response.auth_nonce,action:response.action,serialNumber:response.serial_number,
  bindingGeneration:response.binding_generation,expiresAt:response.expires_at};
 const core=createGeneratedJsCore();try {
  assert.equal(core.codec('wifiProvisioning',{Capability:{bytes:[0xb2,3,7,0,29,2,126,0]}}),3);
  const input={...create.Create,grant:material};
  const prepared=core.codec('wifiProvisioning',{Create:input});
  assert.equal(prepared.chunks.length,4);
  assert.equal(Buffer.from(prepared.credentials).toString('hex'),v3.credentialHex);
  assert.equal(core.codec('wifiProvisioning',{Result:{id:prepared.id,bytes:[...Buffer.from(v3.successHex,'hex')]}}).success,true);
  assert.throws(()=>core.codec('wifiProvisioning',{Create:{...input,grant:{...material,format:'bota-wifi-config-v2'}}}));
 } finally {core.dispose();}
});

test('v3 capability selects v3 on the real generated host and refuses a v2 response',async()=>{
 const v3=JSON.parse(readFileSync(new URL('../../../../../protocol/wifi-config-v3.vector.json',import.meta.url),'utf8'));
 const r3=v3.response;
 const material={...grant,format:r3.format,grantBlob:r3.envelope_base64,keyBase64:r3.key_base64};
 const f=host('success',3);try {
  assert.equal(await f.controls.execute('readWiFiProvisioningVersion',[f.device],f.context),3);
  await assert.rejects(f.controls.execute('configureSecureWiFi',[f.device,'Audit-Network','Audit-Only-123',JSON.stringify(grant)],f.context));
  assert.equal(f.writes.length,0);
  const result=await f.controls.execute('configureSecureWiFi',[f.device,'Audit-Network','Audit-Only-123',JSON.stringify(material)],f.context);
  assert.equal(result.success,true);assert.equal(f.writes.length,5);
  assert.equal(f.writes.at(-1).bytes.toString('hex'),v3.credentialHex);
  assert.equal(Buffer.concat(f.writes.slice(0,4).map(w=>w.bytes.subarray(6))).toString('base64'),r3.envelope_base64);
 } finally {await f.controls.close();f.core.dispose();}
});
