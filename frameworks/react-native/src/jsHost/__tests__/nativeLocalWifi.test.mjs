import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';
const { createNativeLocalWifiPort } = loadSource('nativeLocalWifi.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture() {
  const controller = new AbortController();
  const context = { operationId: 'op', operation: 'TransferRecording', requestId: '1', cancellationId: 'cancel', generation: '1', signal: controller.signal };
  const material = { ssid: 'test-ap', password: new Uint8Array(32).fill(65), ipv4: [192,168,4,1], port: 443, expiresInSeconds: 60, tlsSpkiSha256: new Uint8Array(32).fill(1), downloadToken: new Uint8Array(32).fill(255) };
  const calls = [];
  const native = {
    async preflight() { calls.push(['preflight']); },
    async createLease() { calls.push(['create']); return 'lease-1'; },
    async join(id,json) { calls.push(['join',id,JSON.parse(json)]); },
    async open(id,json) { calls.push(['open',id,JSON.parse(json)]); return JSON.stringify({status:200,headers:{'content-length':'3',etag:'"test"'}}); },
    async read(id,max) { calls.push(['read',id,max]); return 'YWJj'; },
    async closeReader(id) { calls.push(['closeReader',id]); },
    async closeLease(id) { calls.push(['closeLease',id]); },
  };
  const port = createNativeLocalWifiPort(native, { async assertOwner(id,ctx) { calls.push(['secure',id,ctx.generation]); } });
  return { controller, context, material, calls, native, port };
}
const request = {path:'/recordings/test/1',offset:'0',etag:'"test"'};
test('absent native module or security verifier refuses before resource acquisition', async () => {
  const f=fixture();
  for (const port of [createNativeLocalWifiPort(null,{assertOwner:async()=>{}}),createNativeLocalWifiPort(f.native,{})]) {
    await assert.rejects(port.preflight('device',f.context),{code:'unsupported_capability'});
  }
  assert.equal(f.calls.length,0);
});
test('native network IO preserves the existing material and bounded reader contract', async () => {
  const f=fixture(); await f.port.preflight('device',f.context);
  const lease=await f.port.join(f.material,f.context);
  const reader=await lease.open(request,f.context);
  assert.equal(reader.response.content_length,'3');
  assert.deepEqual(await reader.read(3,f.context),new Uint8Array([97,98,99]));
  assert.equal(f.calls.filter(c=>c[0]==='secure').length,2);
  const open=f.calls.find(c=>c[0]==='open')[2];
  assert.equal(open.bearer,Buffer.from(f.material.downloadToken).toString('base64url'));
  assert.equal(open.spkiHex,'01'.repeat(32));
  assert.equal(open.ipv4,'192.168.4.1');
  await reader.close(); await reader.close(); await lease.close(); await lease.close();
  assert.equal(f.calls.filter(c=>c[0]==='closeReader').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='closeLease').length,1);
});
test('unpreflighted or replaced operation cannot join or use a captured lease',async()=>{
  const f=fixture(); await assert.rejects(f.port.join(f.material,f.context),{code:'stale_host_owner'});
  await f.port.preflight('device',f.context); const lease=await f.port.join(f.material,f.context);
  await assert.rejects(lease.open(request,{...f.context,generation:'2'}),{code:'stale_host_owner'});
  assert.equal(f.calls.filter(c=>c[0]==='open').length,0); await lease.close();
});
test('cancelled late lease acquisition releases that exact handle without joining AP',async()=>{
  const f=fixture(), acquired=deferred(); f.native.createLease=()=>acquired.promise;
  await f.port.preflight('device',f.context); const pending=f.port.join(f.material,f.context);
  await new Promise(setImmediate); f.controller.abort(); acquired.resolve('late-lease');
  await assert.rejects(pending,{code:'cancelled'});
  assert.deepEqual(f.calls.filter(c=>c[0]==='closeLease'),[['closeLease','late-lease']]);
  assert.equal(f.calls.filter(c=>c[0]==='join').length,0);
});
test('cancellation joins both native close and the submitted join before rejecting',async()=>{
  const f=fixture(), joined=deferred(), closed=deferred(), started=deferred();
  f.native.join=()=>{started.resolve();return joined.promise;}; f.native.closeLease=()=>closed.promise;
  await f.port.preflight('device',f.context);
  let settled=false; const pending=f.port.join(f.material,f.context).finally(()=>{settled=true;});
  const rejection=assert.rejects(pending,{code:'cancelled'});
  await started.promise; f.controller.abort(); closed.resolve();
  await new Promise(setImmediate); assert.equal(settled,false);
  joined.resolve(); await rejection;
});
test('invalid headers or oversized native reads fail and release the lease',async()=>{
  for(const invalidHeaders of [true,false]) {
    const f=fixture(); await f.port.preflight('device',f.context);const lease=await f.port.join(f.material,f.context);
    if(invalidHeaders){f.native.open=async()=>'{'; await assert.rejects(lease.open(request,f.context));}
    else { const reader=await lease.open(request,f.context); f.native.read=async()=>Buffer.alloc(5).toString('base64'); await assert.rejects(reader.read(3,f.context)); }
    assert.equal(f.calls.filter(c=>c[0]==='closeLease').length,1);await lease.close();
  }
});
test('failed cleanup remains visible and retryable, and security rejection creates no lease',async()=>{
  const f=fixture(); const port=createNativeLocalWifiPort(f.native,{async assertOwner(){throw Error('not authenticated');}});
  await assert.rejects(port.preflight('device',f.context));assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
  await f.port.preflight('device',f.context); const lease=await f.port.join(f.material,f.context);
  f.native.closeLease=async()=>{throw Error('unregister failed');}; await assert.rejects(lease.close(),{code:'cleanup_incomplete'});
  f.native.closeLease=async()=>{}; await lease.close();
});
test('explicit reader or lease close refuses late successful reads without an aborted signal',async()=>{
  for (const closeReader of [false,true]) {
    const f=fixture(), pending=deferred(), started=deferred();
    await f.port.preflight('device',f.context); const lease=await f.port.join(f.material,f.context);
    const reader=await lease.open(request,f.context);
    f.native.read=()=>{started.resolve(); return pending.promise;};
    const read=reader.read(3,f.context); await started.promise;
    await (closeReader ? reader.close() : lease.close()); pending.resolve('YWJj');
    await assert.rejects(read,{code:'stale_host_owner'});
  }
});
