import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localWifiControlPeer } from './localWifiControlPeer.mjs';
import { loadSource } from './loadSource.mjs';
const { JsLocalWifiTransfer } = loadSource('localWifi.ts');
const { createGeneratedJsCore } = loadSource('core.ts');
const { JsEncryptedUploadV2Host } = loadSource('encryptedUploadV2.ts');
const { BotaJsHostExecutor } = loadSource('executor.ts');
const { createJsEncryptedUploadV2Backend } = loadSource('uploadBackendV2.ts');
const binary = fileURLToPath(new URL('../../../../../target/debug/js-trace', import.meta.url));
const useNative = process.env.BOTA_LOCAL_WIFI_NATIVE_TEST === '1';
const native = { skip: useNative && !existsSync(binary) && 'Build cargo build -p bota-device-sdk-js --bin js-trace first' };
const hash = b => [...createHash('sha256').update(b).digest()];
// Replay exact RPC history through Rust, not a hand-written substitute reducer.
function core() {
  if (!useNative) return createGeneratedJsCore();
  const history=[];
  const invoke = input => {
    history.push(JSON.stringify(input));
    const lines=execFileSync(binary,{input:history.join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n');
    return JSON.parse(lines.at(-1));
  };
  return { codec:(codec,input)=>{const result=invoke({version:1,action:'codec',codec,input});
    if(!result.ok)throw Object.assign(new Error(result.error.code),result.error);return result.result;},
    createEngine(){const engine=core();return {request:input=>engine.invoke(input),dispose(){}};},invoke };
}
function fixture({ initialFile=Buffer.alloc(0), journal=null, httpStatus=200, badReadback=false, blockedRead=false, failJoin=false, loseFinish=false, losePrepared=false, tamperReady=false, wrongGrantKey=false, closeTimeout, successor=false, manifestByte=6 }={}) {
  const peer=localWifiControlPeer();
  const rust=core(), calls=[], saved=new Map(journal ? [['encrypted-upload-v2/test/local-wifi',journal]]:[]), callbacks=new Map();
  const codec=rust.codec.bind(rust);rust.codec=(name,input)=>{if(name==='localWifiTransfer'&&input.op==='ControlFree')calls.push('control-free');const result=codec(name,input);return name==='protocolMetadata'&&closeTimeout ? {...result,operationTimeoutMs:closeTimeout} : result;};
  const data=Buffer.alloc(330,9), manifest=Buffer.alloc(580,manifestByte), scope='account/project/binding';
  let file=Buffer.from(initialFile), reads=0;
  const cap=[1,2,24,0,127,1,0,0,0,4,0,4,244,0,16,0,8,0,0,0,16,0,0,0];
  const request={local_wifi:true,device:'EVFXXW67KP',recording:Array(16).fill(2),recording_generation:3,
    storage_format:3,upload_session_uuid:Array(16).fill(successor?3:1),owner_revision:successor?6:5,transport_session_id:'7',material_id:'material',sink_id:'sink',
    selection:{policy:'V2Preferred',profile:'EncryptedUploadV2'},
    capabilities:rust.codec('decodeEncryptedUploadV2Capabilities',{bytes:cap}),window_packets:16,data_payload_bytes:244,
    ciphertext_length:'330',ciphertext_sha256:hash(data)};
  const metadata=rust.codec('protocolMetadata',{}), controller=new AbortController();
  const context={operation:'TransferRecording',operationId:'local-1',generation:'1',requestId:'1',cancellationId:'aa',signal:controller.signal};
  const sink={id:'sink',kind:'file',scope};
  function common(kind,len) {const b=Buffer.alloc(len);b[0]=kind;b[1]=2;b.writeBigUInt64LE(BigInt(request.transport_session_id),4);return b;}
  function evidence(kind) {const b=common(kind,128);b.set(request.upload_session_uuid,12);b.fill(2,28,44);b.writeUInt32LE(3,44);b.writeUInt32LE(request.owner_revision,48);b.writeBigUInt64LE(330n,52);b.set(hash(data),60);b.set(hash(manifest),92);b.writeUInt32LE(1,124);return b;}
  function emit(characteristic,frame) {const wire=characteristic==='CHAR_LOCAL_WIFI_EVENT'?peer.seal(frame):frame;if(tamperReady&&frame[0]===0x90&&frame[14]===2)wire[wire.length-1]^=1;callbacks.get(metadata[characteristic])?.(new Uint8Array(wire));}
  const ble={async read(){calls.push('caps');return Uint8Array.from([2,2,16,0,31,0,0,0,3,0,185,0,182,0,182,0]);},
    async subscribe(address,accept){callbacks.set(address.characteristicUuid,accept);return {async remove(){calls.push('unsubscribe');callbacks.delete(address.characteristicUuid);}};},
    async write(address,bytes){if(address.characteristicUuid===metadata.CHAR_LOCAL_WIFI_CONTROL)bytes=peer.open(bytes);calls.push(`write:${bytes[0]}`);
      if(bytes[0]===0x11){const frame=common(0x90,16);frame[15]=0x11;emit('CHAR_LOCAL_WIFI_EVENT',frame);}
      if(bytes[0]===0x30){request.transport_session_id=Buffer.from(bytes).readBigUInt64LE(4).toString();if(losePrepared){controller.abort();return;}emit('CHAR_LOCAL_WIFI_EVENT',evidence(0xb0));for(let offset=0;offset<580;offset+=130){const part=manifest.subarray(offset,offset+130),frame=common(0x43,52+part.length);frame.writeUInt16LE(580,12);frame.writeUInt16LE(offset,14);frame.writeUInt16LE(part.length,16);frame.set(hash(manifest),20);frame.set(part,52);emit('CHAR_RECORDING_TRANSFER_V2',frame);}}
      if(bytes[0]===0x10){const frame=common(0x90,131);frame[14]=2;frame[15]=0x10;frame[16]=2;frame.writeUInt16LE(36,17);frame.set([192,168,4,1],19);frame.writeUInt16LE(443,23);frame.writeUInt32LE(60,25);frame[29]=4;frame.set(Buffer.from('BOTA'),30);frame[34]=32;frame.fill(65,35,67);frame.fill(3,67,99);frame.fill(4,99,131);emit('CHAR_LOCAL_WIFI_EVENT',frame);}
      if(bytes[0]===0x12){const frame=common(0x90,16);frame[15]=0x12;emit('CHAR_LOCAL_WIFI_EVENT',frame);}
      if(bytes[0]===0x31){if(loseFinish)controller.abort();else emit('CHAR_LOCAL_WIFI_EVENT',evidence(0xb1));}
    }};
  const files={async metadata(){return {durableUnits:String(file.length)};},async read(_,offset,count){return new Uint8Array(file.subarray(Number(offset),Number(offset)+count));},async truncate(_,offset){calls.push('truncate');file=file.subarray(0,Number(offset));},async flush(){calls.push('flush');},
    async append(_,offset,value){assert.equal(Number(offset),file.length);file=Buffer.concat([file,Buffer.from(value)]);calls.push('append');return {durableUnits:String(file.length)};}};
  const localWifi={async preflight(){calls.push('secure-ble');},async join(material){calls.push('join');assert.equal(material.password.length,32);if(failJoin)throw new Error('join-rejected');
    return {async open(plan){calls.push('get');calls.push(`range:${plan.offset}`);assert.match(plan.path,/^\/recordings\/02020202-/);let offset=Number(plan.offset);
      return {response:{status:offset?206:httpStatus,content_length:String(330-offset),content_range:offset?`bytes ${offset}-329/330`:null,etag:plan.etag,content_encoding:null},
        async read(max,ctx){calls.push('read');reads++;if(blockedRead)return await new Promise((_,reject)=>{if(ctx.signal.aborted)reject(new Error('aborted'));else ctx.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
          if(offset===330)return null;const part=data.subarray(offset,offset+100);offset+=part.length;return new Uint8Array(part);},
        async close(){calls.push('reader-close');}};},async close(){calls.push('lease-close');}};}};
  const persistence={namespace:scope,async load(key){const value=saved.get(key)??null;return badReadback&&value?null:value;},async save(key,value){calls.push('save');saved.set(key,structuredClone(value));},async remove(key){saved.delete(key);}};
  const options={core:rust,ports:{ble,files,persistence,localWifi},request,sink,journalKey:'test',peripheralId:'device',maximumWriteBytes:182,
    gatt:async(_,body)=>body(),checkOwner(ctx){if(ctx.signal.aborted)throw new Error('aborted');},
    async inspect(prefix,flush){if(flush)await files.flush();return {length:String(file.length),sha256:hash(file.subarray(0,Number(prefix)))};},
    async controlGrant(session){request.transport_session_id=session;return wrongGrantKey?JSON.stringify({...JSON.parse(peer.grant),control_key_base64:Buffer.alloc(32,9).toString('base64')}):peer.grant;},async sendSignedBlob(kind,bytes){assert.equal(kind,7);assert.deepEqual(Buffer.from(bytes),peer.envelope);},
    onTransferEvent(){},onCleanupFailure(){calls.push('cleanup-failed');}};
  return {host:new JsLocalWifiTransfer(options),options,context,controller,calls,saved,file:()=>file,reads:()=>reads,
    tamper(){const frame=common(0x90,16);frame[15]=0x11;const wire=peer.seal(frame);wire[wire.length-1]^=1;callbacks.get(metadata.CHAR_LOCAL_WIFI_EVENT)?.(wire);}};
}

test('real Rust host path joins, downloads, persists, FINISHes and restores network before cloud handoff',native,async()=>{
  const f=fixture();await f.host.preflight(f.context);const result=await f.host.run(f.context,Array(32).fill(4));
  assert.equal(result.evidence.ciphertext_length,'330');assert.equal(result.manifest.length,580);assert.deepEqual(f.file(),Buffer.alloc(330,9));
  assert.ok(f.calls.indexOf('secure-ble')<f.calls.indexOf('write:48'));
  assert.ok(f.calls.indexOf('reader-close')<f.calls.indexOf('write:49'));
  assert.ok(f.calls.includes('lease-close'));assert.ok(f.calls.includes('write:18'));assert.equal(f.calls.filter(x=>x==='save').length,4);
  const saved=f.saved.get('encrypted-upload-v2/test/local-wifi');assert.ok(!JSON.stringify(saved).includes('password'));
  let forwarded=false;f.options.onTransferEvent=()=>{forwarded=true;};
  await f.options.ports.ble.write({},Uint8Array.of(0x12));assert.equal(forwarded,false);
  await f.host.close();assert.equal(f.calls.filter(x=>x==='unsubscribe').length,2);
  const restored=fixture({initialFile:f.file(),journal:saved});await restored.host.preflight(restored.context);await restored.host.run(restored.context,Array(32).fill(4));
  assert.ok(!restored.calls.includes('join'));assert.ok(!restored.calls.includes('get'));assert.ok(!restored.calls.includes('truncate'));await restored.host.close();
});
test('bad HTTP and journal readback cannot emit FINISH; source is retained',native,async()=>{
  for(const config of [{httpStatus:206},{badReadback:true},{failJoin:true}]){
    const f=fixture(config);await f.host.preflight(f.context);await assert.rejects(f.host.run(f.context,Array(32).fill(4)));
    assert.ok(!f.calls.includes('write:49'));await f.host.close();assert.equal(f.calls.filter(x=>x==='unsubscribe').length,2);
  }
});
test('cancel joins the active reader and network lease before releasing subscriptions',native,async()=>{
  const f=fixture({blockedRead:true});await f.host.preflight(f.context);const run=f.host.run(f.context,Array(32).fill(4));
  while(!f.reads())await Promise.race([run,new Promise(resolve=>setTimeout(resolve,1))]);f.controller.abort();await assert.rejects(run);await f.host.close();
  assert.ok(!f.calls.includes('write:49'));assert.ok(f.calls.indexOf('reader-close')<f.calls.indexOf('lease-close'));
  assert.ok(f.calls.indexOf('lease-close')<f.calls.indexOf('unsubscribe'));
});

test('CLOSE timeout cancels and joins a submitted BLE write while the phone lease is released',native,async()=>{
  const f=fixture({closeTimeout:25}), write=f.options.ports.ble.write;
  let release, cleanupSignal, entered;
  const closing=new Promise(resolve=>{entered=resolve;});
  f.options.ports.ble.write=async (address,frame,response,context)=>{
    if(f.calls.includes('write:49')) {
      cleanupSignal=context.signal;entered();
      await new Promise(resolve=>{
        release=resolve;
        context.signal.addEventListener('abort',resolve,{once:true});
      });
      if(context.signal.aborted) throw Error('cancelled BLE write');
    }
    return write(address,frame,response,context);
  };
  await f.host.preflight(f.context);
  const run=f.host.run(f.context,Array(32).fill(4));
  const result=run.then(()=>({completed:true}),error=>({error}));
  try {
    await Promise.race([closing,new Promise((_,reject)=>setTimeout(()=>reject(Error('CLOSE write was never submitted')),5000))]);
    const settled=await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve(null),5000))]);
    assert(settled,'CLOSE must not hang behind a blocked BLE write');
    assert.equal(settled.error?.code,'cleanup_incomplete');
    assert.equal(cleanupSignal.aborted,true);
    assert(f.calls.includes('lease-close'));
    assert(f.calls.includes('cleanup-failed'));
  } finally {
    release?.(); await result;
    f.options.ports.ble.write=write;
    // The peer did not receive that encrypted counter; a retry need not succeed.
    await f.host.close().catch(error=>assert.equal(error.code,'cleanup_incomplete'));
  }
});

for (const publicEntry of [false, true, 'native-bridge']) test(`existing ${publicEntry === 'native-bridge' ? 'public SDK with native OS bridge' : publicEntry ? 'public SDK entry' : 'Rust workflow'} keeps cloud reconciliation and receipt as the only CONFIRM gate`,native,async()=>{
  const f=fixture(), {request,core:rust,sink}=f.options, ports=f.options.ports;
  if (publicEntry === 'native-bridge') {
    const { createNativeLocalWifiPort } = loadSource('nativeLocalWifi.ts');
    const source = ports.localWifi;
    let lease, reader;
    ports.localWifi = createNativeLocalWifiPort({
      async preflight() {}, async createLease() { f.calls.push('native-create'); return 'native-lease'; },
      async join(id,json) { assert.equal(id,'native-lease'); const input=JSON.parse(json); lease=await source.join({password:Buffer.from(input.password)},f.context); },
      async open(id,json) { assert.equal(id,'native-lease'); reader=await lease.open(JSON.parse(json),f.context); const r=reader.response;
        return JSON.stringify({status:r.status,headers:{'content-length':r.content_length,etag:r.etag,...(r.content_range?{'content-range':r.content_range}:{})}}); },
      async read(id,max) { assert.equal(id,'native-lease'); const bytes=await reader.read(max,f.context); return bytes===null?null:Buffer.from(bytes).toString('base64'); },
      async closeReader(id) { assert.equal(id,'native-lease'); await reader?.close(); },
      async closeLease(id) { assert.equal(id,'native-lease'); await lease?.close(); },
    }, { assertOwner: () => source.preflight() });
  }
  const metadata=rust.codec('protocolMetadata',{}), listeners=new Map(), realWrite=ports.ble.write, realRead=ports.ble.read, realSubscribe=ports.ble.subscribe;
  const vectors=JSON.parse(readFileSync(new URL('../../../../../protocol/vectors/encrypted-upload-v2.json',import.meta.url),'utf8'));
  const vector=name=>Buffer.from(vectors.cases.find(v=>v.name===name).inputHex,'hex');
  const constants=readFileSync(new URL('../../../../../core/device-sdk-core/src/generated/protocol.rs',import.meta.url),'utf8');
  const offset=name=>Number(constants.match(new RegExp(`pub const ${name}: usize = (\\d+);`))[1]);
  const authorization=vector('authorization-development'), receipt=vector('completion-receipt');
  for(const [prefix,document] of [['UPLOAD_AUTHORIZATION_V2',authorization],['COMPLETION_RECEIPT_V2',receipt]]){
    document.set(request.upload_session_uuid,offset(`${prefix}_UPLOAD_SESSION_UUID_OFFSET`));
    document.set(request.recording,offset(`${prefix}_RECORDING_UUID_OFFSET`));
    document.writeUInt32LE(request.recording_generation,offset(`${prefix}_RECORDING_GENERATION_OFFSET`));
    document.writeUInt32LE(request.owner_revision,offset(`${prefix}_UPLOAD_OWNER_REVISION_OFFSET`));
    document.set(request.ciphertext_sha256,offset(`${prefix}_CIPHERTEXT_SHA256_OFFSET`));
  }
  authorization[offset('UPLOAD_AUTHORIZATION_V2_ALLOWED_CHANNEL_MASK_OFFSET')]=8;
  authorization[offset('UPLOAD_AUTHORIZATION_V2_EFFECTIVE_POLICY_OFFSET')]=1;
  authorization.writeBigUInt64LE(330n,offset('UPLOAD_AUTHORIZATION_V2_MINIMUM_CIPHERTEXT_LENGTH_OFFSET'));
  authorization.writeBigUInt64LE(330n,offset('UPLOAD_AUTHORIZATION_V2_MAXIMUM_CIPHERTEXT_LENGTH_OFFSET'));
  let attempt=0,state=0,uploadAuthorizationInstalled=false;
  ports.randomBytes=n=>new Uint8Array(n).fill(1);
  ports.ble.subscribe=async(address,accept,...args)=>{listeners.set(address.characteristicUuid,accept);const sub=await realSubscribe(address,accept,...args);return {async remove(){listeners.delete(address.characteristicUuid);await sub.remove();}};};
  ports.ble.read=async(address,...args)=>{
    if(address.characteristicUuid!==metadata.CHAR_UPLOAD_CONTEXT_V2)return realRead(address,...args);
    const payload=Buffer.alloc(state===1?16:state===2?116:0,7), frame=Buffer.alloc(12+payload.length);
    frame[0]=0x66;frame[1]=2;frame[2]=state;frame.writeUInt32LE(attempt,4);frame.writeUInt16LE(payload.length,10);frame.set(payload,12);return new Uint8Array(frame);
  };
  ports.ble.write=async(address,value,...args)=>{
    if(address.characteristicUuid===metadata.CHAR_UPLOAD_CONTEXT_V2){attempt=Buffer.from(value).readUInt32LE(4);state=1;return;}
    if(address.characteristicUuid===metadata.CHAR_TRANSFER_SIGNED_BLOB_V2){
      if(value[0]===vector('ble-blob-commit')[0]){const result=vector('ble-blob-result');result[2]=value[2];Buffer.from(value).copy(result,4,4,8);result.writeUInt16LE(0,8);
        if(value[2]===1)uploadAuthorizationInstalled=true;if(value[2]===3)state=2;if(value[2]===4)state=3;listeners.get(address.characteristicUuid)(new Uint8Array(result));}return;
    }
    if(address.characteristicUuid===metadata.CHAR_TRANSFER_CONTROL_V2){
      const parsed=rust.codec('decodeEncryptedUploadV2Transfer',{bytes:Array.from(value)});assert.equal(parsed.kind,'confirm');f.calls.push('confirm');return;
    }
    return realWrite(address,value,...args);
  };
  const doc=(magic,size)=>{const b=Buffer.alloc(size);b.write(magic);b.writeUInt16LE(1,8);b.writeUInt16LE(size,10);return new Uint8Array(b);};
  const material={async localWifiControlGrant(...args){assert.equal(uploadAuthorizationInstalled,true);return f.options.controlGrant(...args);},async authorization(){return new Uint8Array(authorization);},uploadContext:{async challenge(){return doc('BOTACTXQ',196);},async result(){return doc('BOTACTXR',264);}},
    async reconcileStaging(){f.calls.push('reconcile');return false;},async stageCiphertext(){throw new Error('Reconciled ciphertext must not be PUT twice');},
    async submitManifest(){f.calls.push('submit-manifest');},async finalize(){f.calls.push('finalize');},async completionReceipt(){f.calls.push('receipt');return new Uint8Array(receipt);},
    async confirmed(){f.calls.push('confirmed');},async cancel(){f.calls.push('cancel');}};
  let destroy, retainedBleKey;
  if (publicEntry) {
    const { createJsDeviceAdapter } = loadSource('deviceAdapter.ts');
    const { createBotaDeviceSDK } = loadSource('../client.ts');
    const values = new Map([
      [metadata.CHAR_SERIAL_NUMBER, Buffer.from(request.device)], [metadata.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
      [metadata.CHAR_FIRMWARE_REVISION, Buffer.from('1.0.19')], [metadata.CHAR_HARDWARE_REVISION, Buffer.from('rev1')],
      [metadata.CHAR_PAIRING_STATE, Uint8Array.of(2)],
      [metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2, Uint8Array.from([1,2,24,0,127,1,0,0,0,4,0,4,244,0,16,0,8,0,0,0,16,0,0,0])],
    ]);
    const priorRead=ports.ble.read;
    Object.assign(ports, { apiVersion:1, platform:'test' });
    Object.assign(ports.ble, { async scan(){return {async remove(){}};},async connect(){},async discoverServices(){},async disconnect(){},async getMtu(){return 185;},
      async read(address,...args){return values.get(address.characteristicUuid) ?? priorRead(address,...args);} });
    Object.assign(ports.files,{ async open(id){return { ...sink,id };},async finalize(){},async remove(){} });
    const adapter=createJsDeviceAdapter(rust,ports), sdk=createBotaDeviceSDK(adapter);
    await sdk.configure({logLevel:'none'});
    const connected=await adapter.connectSelected({id:'device',name:'Bota Note',rssi:-50});
    const uuid=bytes=>Buffer.from(bytes).toString('hex').replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
    const recording={uuid:uuid(request.recording),generation:3,storageFormat:3,
      ciphertextLength:'330',ciphertextSha256:Buffer.from(request.ciphertext_sha256).toString('hex')};
    const identity=rust.codec('encryptedUploadV2LocalIdentity',{scope:ports.persistence.namespace,serialNumber:request.device,recording});
    retainedBleKey=`encrypted-upload-v2/${identity.journalKey}`;
    f.saved.set(retainedBleKey,{sentinel:'BLE checkpoint must remain untouched'});
    await sdk.recordings.syncEncryptedRecordingV2(connected,recording,async context=>{
      assert.equal(context.capability.localWifiRawValueHex,'020210001f0000000300b900b600b600');
      assert.equal(context.checkpoint,undefined);
      return {profile:'encrypted_upload_v2',uploadSessionId:uuid(request.upload_session_uuid),ownerRevision:5,securityPolicy:'v2_preferred',
        materialRegistrationId:adapter.registerMaterial(context.operationId,material)};
    },undefined,{transport:'local_wifi'});
    destroy=()=>adapter.destroy();
  } else {
    const executor=new BotaJsHostExecutor(rust,ports);
    const host=new JsEncryptedUploadV2Host({core:rust,ports,request,sink,journalKey:'test',material,peripheralId:'device',maximumWriteBytes:182,
      gatt:(context,body)=>executor.gatt(context,body),checkOwner:context=>executor.check(context)});
    executor.registerHandler('EncryptedUploadV2',host.handle);
    const result=await executor.run({TransferEncryptedRecording:{request}},{operation:'TransferRecording',operationId:'local-composed',
      capabilities:['Ble','Persistence','Progress','HostMaterial','RecordingSink','NetworkTransfer']});
    assert.ok(result.notifications.some(v=>v.Completed));
    destroy=()=>executor.destroy();
  }
  assert.deepEqual(f.calls.filter(v=>['reconcile','submit-manifest','finalize','receipt','confirm','confirmed','cancel'].includes(v)),
    ['reconcile','submit-manifest','finalize','receipt','confirm','confirmed']);
  if (retainedBleKey) assert.deepEqual(f.saved.get(retainedBleKey),{sentinel:'BLE checkpoint must remain untouched'});
  assert.equal([...f.saved.keys()].filter(key=>key.startsWith('encrypted-upload-v2/') && key!==retainedBleKey).length,0);
  assert.equal(listeners.size,0);await destroy();
});

test('partial download resumes its exact Range and lost FINISH retries without a second GET',native,async()=>{
  for (const config of [{badReadback:true},{loseFinish:true}]) {
    const first=fixture(config);await first.host.preflight(first.context);
    await assert.rejects(first.host.run(first.context,Array(32).fill(4)));await first.host.close();
    const journal=first.saved.get('encrypted-upload-v2/test/local-wifi');assert.ok(journal);
    const resumed=fixture({initialFile:first.file(),journal});await resumed.host.preflight(resumed.context);
    await resumed.host.run(resumed.context,Array(32).fill(4));
    assert.equal(resumed.calls.filter(v=>v==='get').length,config.loseFinish?0:1);
    assert.equal(resumed.calls.filter(v=>v==='truncate').length,0);
    assert.deepEqual(resumed.file(),Buffer.alloc(330,9));await resumed.host.close();
  }
});
test('missing secure platform primitives fail before any admission/control write',native,async()=>{
  const f=fixture();delete f.options.ports.localWifi;
  await assert.rejects(f.host.preflight(f.context),{code:'unsupported_capability'});
  assert.ok(!f.calls.some(v=>v.startsWith('write:')));await f.host.close();
});

test('an older core cannot silently interpret the local request as BLE and truncate its file',()=>{
  const ports={persistence:{namespace:'scope'},files:{async truncate(){throw new Error('Must not truncate');}}};
  assert.throws(()=>new JsEncryptedUploadV2Host({core:{codec:()=>({})},ports,request:{local_wifi:true},journalKey:'old-core',
    sink:{id:'sink',kind:'file',scope:'scope'},checkOwner(){}}),{code:'unsupported_capability'});
});

test('cancel after attempted PREPARE still closes the operation even before AP OPEN',native,async()=>{
  const f=fixture({losePrepared:true});await f.host.preflight(f.context);
  await assert.rejects(f.host.run(f.context,Array(32).fill(4)));await f.host.close();
  assert.ok(f.calls.includes('write:48'));assert.ok(f.calls.includes('write:18'));
  assert.ok(!f.calls.includes('write:16'));assert.ok(!f.calls.includes('write:49'));
});

for (const securityFailure of [{tamperReady:true},{wrongGrantKey:true}]) test('unauthenticated control never exposes material to native join',native,async()=>{
 const f=fixture(securityFailure);await f.host.preflight(f.context);
 await assert.rejects(f.host.run(f.context,Array(32).fill(4)));
 await f.host.close().catch(()=>{});
 assert.ok(!f.calls.includes('join'));assert.ok(!f.calls.includes('get'));assert.ok(!f.calls.includes('write:49'));
});

test('authentication failure cancels an in-flight socket read promptly',native,async()=>{
 const f=fixture({blockedRead:true});await f.host.preflight(f.context);
 const run=f.host.run(f.context,Array(32).fill(4));const settled=run.then(()=>true,()=>true);
 try {
  while(!f.reads())await Promise.race([run,new Promise(resolve=>setTimeout(resolve,1))]);
  f.tamper();
  assert.equal(await Promise.race([settled,new Promise(resolve=>setTimeout(()=>resolve(false),250))]),true);
  assert.ok(f.calls.includes('reader-close'));assert.ok(f.calls.includes('lease-close'));
  assert.ok(!f.calls.includes('write:49'));
 } finally {f.controller.abort();await settled;await f.host.close().catch(()=>{});}
});

test('completed local control retires its key before the independent cloud handoff',native,async()=>{
 const f=fixture();await f.host.preflight(f.context);await f.host.run(f.context,Array(32).fill(4));
 try {
  assert.ok(f.calls.includes('control-free'));
  f.tamper();f.host.assertHealthy(f.context);
 } finally {await f.host.close().catch(()=>{});}
});


// Compose the actual managed journal reducer, nonce recovery and transfer receiver.
// The mock boundary is server/device IO, never checkpoint authorization policy.
for (const [retained, failure] of [[200,null],[330,null],[330,'save'],[200,'corrupt']]) test(`managed nonce recovery reuses ${retained} durable bytes across restart (${failure??'success'})`, native, async () => {
  const first=fixture();
  await first.host.preflight(first.context);await first.host.run(first.context,Array(32).fill(4));await first.host.close();
  const journal=structuredClone(first.saved.get('encrypted-upload-v2/test/local-wifi'));
  journal.checkpoint.next_ciphertext_offset=String(retained);
  journal.checkpoint.prefix_sha256=hash(first.file().subarray(0,retained));
  const next=fixture({initialFile:first.file().subarray(0,retained),journal,successor:true,manifestByte:8});
  const sessionId=n=>Array(16).fill(n).map(x=>x.toString(16).padStart(2,'0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
  const durable=new Map(), materials=new Map(), requests=[];
  let nonce='01'.repeat(16), backend;
  const authorization=Buffer.alloc(408,7);
  const session=n=>({profile:'encrypted_upload_v2',session_id:sessionId(n),owner_revision:n===1?5:6,
    policy:'v2_required',authorization_base64:authorization.toString('base64'),authorization_sha256:Buffer.from(hash(authorization)).toString('hex'),
    expires_at:'2030-01-01T00:00:00Z',state:'staging',channel:'local_wifi',ciphertext_length:330,ciphertext_sha256:Buffer.from(hash(first.file())).toString('hex')});
  const input=operationId=>({operationId,scope:{apiOrigin:'https://api.example.com',apiBasePath:'/v1',accountId:'a',projectId:'p',organizationId:'org',environment:'production',endUserId:'eu_1',deviceId:'dev_1',bindingGeneration:2,serialNumber:'BOTA1',nativeDeviceId:'ble-id',scopeKey:'account/project/binding'},
    recording:{uuid:sessionId(2),generation:3,ciphertextLength:'330',ciphertextSha256:session(1).ciphertext_sha256,startedAtMs:'1704067200123',durationMs:'1000',plaintextLength:'38',storageFormat:3},
    capability:{rawValueHex:'00'.repeat(24),flags:0x37f,localWifiRawValueHex:'020210001f0000000300b900b600b600'}});
  const options={core:next.options.core,files:next.options.ports.files,context:operationId=>({...next.context,operationId}),now:()=>1704067200000,wait:async()=>{},
    persistence:{namespace:'account/project/binding',async load(key){return structuredClone(durable.get(key)??null);},async save(key,value){durable.set(key,structuredClone(value));},async remove(key){durable.delete(key);}},
    requestCredentials:async()=>'fresh-token',readNonce:async()=>nonce,
    registerMaterial(id,material){materials.set(id,material);return `material:${id}`;},unregisterMaterial(id){materials.delete(id.replace('material:',''));},uploadFile:async()=>{throw new Error('Unexpected PUT');},
    fetch:async(url,request)=>{requests.push(url);let value;
      if(url.endsWith('/recordings'))value={id:'rec_1'};
      else if(url.endsWith('/sessions')||url.endsWith(sessionId(1)))value=session(1);
      else if(url.endsWith('/recover')||url.endsWith(sessionId(3)))value=session(3);
      else throw new Error(`Unexpected route ${url}`);
      return {url,status:200,async text(){return JSON.stringify(value);}};}};
  try {
    backend=createJsEncryptedUploadV2Backend(options);
    await backend.prepare(JSON.stringify(input('old')));await backend.dispose();
    nonce='02'.repeat(16);backend=createJsEncryptedUploadV2Backend(options);
    const selection=JSON.parse(await backend.prepare(JSON.stringify(input('recovered'))));
    assert.equal(selection.uploadSessionId,sessionId(3));await backend.dispose();
    // Restart after server recovery but before the local checkpoint is migrated.
    backend=createJsEncryptedUploadV2Backend(options);
    await backend.prepare(JSON.stringify(input('local-1')));
    next.options.recovery=(checkpoint,context)=>materials.get('local-1').localWifiRecovery(checkpoint,context);
    if(failure==='save')next.options.ports.persistence.save=async()=>{throw new Error('disk unavailable');};
    if(failure==='corrupt')next.options.inspect=async()=>({length:String(retained),sha256:Array(32).fill(99)});
    await next.host.preflight(next.context);
    if(failure){
      await assert.rejects(next.host.run(next.context,Array(32).fill(4)));
      assert.equal(next.calls.includes('get'),false);assert.equal(next.calls.includes('write:49'),false);
      assert.equal(next.saved.get('encrypted-upload-v2/test/local-wifi').checkpoint.owner_revision,5);
      assert.deepEqual(next.file(),first.file().subarray(0,retained));return;
    }
    await next.host.run(next.context,Array(32).fill(4));
    assert.deepEqual(next.file(),first.file());
    assert.equal(next.calls.includes('get'),retained<330);
    if(retained<330)assert.ok(next.calls.includes(`range:${retained}`));
    assert.equal(requests.filter(url=>url.endsWith('/recordings')).length,1);
    assert.equal(requests.filter(url=>url.endsWith('/sessions')).length,1);
    assert.equal(requests.filter(url=>url.endsWith('/recover')).length,1);
    assert.equal(next.saved.get('encrypted-upload-v2/test/local-wifi').checkpoint.owner_revision,6);
    assert.ok(next.calls.indexOf('save')<next.calls.indexOf('write:49'));
  } finally {await next.host.close();await backend?.dispose();}
});
