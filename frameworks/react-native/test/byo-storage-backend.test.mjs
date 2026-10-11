import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require=createRequire(import.meta.url);
const {createManagedByoStorageBackend:create}=require('../lib/commonjs/byoStorageBackend.js');
function setup() {
 const controller=new AbortController(),calls=[];
 const native={syncByo:async input=>{calls.push(JSON.parse(input));return JSON.stringify({recordingId:'rec_a',uploadSessionId:'00112233-4455-4677-8899-aabbccddeeff'});},
 cancelByo:async id=>{calls.push(['cancel',id]);},onCredentialsRequested:()=>({remove(){}}),resolveCredentials:async()=>{},rejectCredentials:async()=>{}};
 const options={baseUrl:'https://app.example/v1',scopeKey:'account-a',organizationId:'org_a',projectId:'proj_a',environment:'production',signal:controller.signal,getAccessToken:async()=> 'app-token'};
 return {controller,calls,native,options};
}
test('BYO facade forwards identity metadata only and preserves caller capture',async()=>{
 const f=setup(),backend=create(f.native,f.options);f.options.projectId='proj_changed';
 const result=await backend.sync({id:'ble-a',serialNumber:'device-a'}, {uuid:'00112233-4455-4677-8899-aabbccddeeff',generation:1}, {deviceId:'dev_a',bindingGeneration:1});
 assert.equal(result.recordingId,'rec_a');assert.equal(f.calls[0].scope.projectId,'proj_a');
 assert.equal(JSON.stringify(f.calls).includes('app-token'),false);await backend.dispose();
});
test('cancel waits for native settlement and rejects a late success',async()=>{
 const f=setup();let finish;let entered;
 const started=new Promise(resolve=>{entered=resolve});
 f.native.syncByo=async()=>{entered();return new Promise(resolve=>{finish=()=>resolve(JSON.stringify({recordingId:'rec_a',uploadSessionId:'00112233-4455-4677-8899-aabbccddeeff'}))})};
 f.native.cancelByo=async()=>{finish()};
 const backend=create(f.native,f.options);
 const task=backend.sync({id:'ble-a'}, {uuid:'00112233-4455-4677-8899-aabbccddeeff',generation:1}, {deviceId:'dev_a',bindingGeneration:1});
 const rejected=assert.rejects(task,/cancelled/);await started;f.controller.abort();await rejected;await backend.dispose();
});
test('catalog exposes only validated recording identities',async()=>{
 const f=setup(),uuid='00112233-4455-4677-8899-aabbccddeeff';
 f.native.syncByo=async input=>{f.calls.push(JSON.parse(input));return JSON.stringify([{uuid,generation:7,opaque:'must-not-cross'}]);};
 const backend=create(f.native,f.options);
 assert.deepEqual(await backend.list({id:'ble-a'},{deviceId:'dev_a',bindingGeneration:1}),[{uuid,generation:7}]);
 assert.equal(f.calls[0].mode,'list');assert.equal(f.calls[0].recording,null);
 f.native.syncByo=async()=>JSON.stringify([{uuid,generation:-1}]);
 await assert.rejects(backend.list({id:'ble-a'},{deviceId:'dev_a',bindingGeneration:1}),/Invalid BYO native catalog/);
 await backend.dispose();
});

test('stream selects the native live path without exposing ciphertext or grants',async()=>{
 const f=setup();const backend=create(f.native,f.options);const uuid="00112233-4455-4677-8899-aabbccddeeff";
 await backend.stream({id:"ble-a",serialNumber:"device-a"},{uuid,generation:7},{deviceId:"dev_a",bindingGeneration:1});
 assert.equal(f.calls[0].mode,'stream');assert.equal(f.calls[0].recording.uuid,uuid);
 await backend.dispose();
});

test('stream can discover the active physical recording natively',async()=>{
 const f=setup(),backend=create(f.native,f.options);
 await backend.stream({id:'ble-a',serialNumber:'device-a'},null,{deviceId:'dev_a',bindingGeneration:1});
 assert.equal(f.calls[0].mode,'stream');assert.equal(f.calls[0].recording,null);await backend.dispose();
});
