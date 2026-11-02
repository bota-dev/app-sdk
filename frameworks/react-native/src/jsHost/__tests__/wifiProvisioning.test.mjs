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
