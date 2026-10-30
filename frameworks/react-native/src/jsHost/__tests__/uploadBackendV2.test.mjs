import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsEncryptedUploadV2Backend } = loadSource('uploadBackendV2.ts');
const UUID = '00112233-4455-6677-8899-aabbccddeeff';
const SESSION = '11112233-4455-6677-8899-aabbccddeeff';
const SUCCESSOR = '22112233-4455-6677-8899-aabbccddeeff';
const hash = value => createHash('sha256').update(value).digest();
const hex = value => hash(value).toString('hex');
const authorization = Buffer.alloc(408, 7);
const receipt = Buffer.alloc(336, 8);
const manifest = Buffer.alloc(580, 9);
const ciphertext = Buffer.alloc(900, 10);
const ciphertextHash = hex(ciphertext);
const evidence = { ciphertext_length: '900', ciphertext_sha256: Array.from(hash(ciphertext)),
  manifest_length: 580, manifest_sha256: Array.from(hash(manifest)) };
function input(operationId = 'upload-1', extra = {}) {
  return { operationId, scope: { apiOrigin: 'https://api.example.com', apiBasePath: '/v1',
    accountId: 'a', projectId: 'p', organizationId: 'org', environment: 'production', endUserId: 'eu_1',
    deviceId: 'dev_1', bindingGeneration: 2, serialNumber: 'BOTA1', nativeDeviceId: 'ble-id', scopeKey: 'a:p:production' },
  recording: { uuid: UUID, generation: 3, ciphertextLength: '900', ciphertextSha256: ciphertextHash,
    startedAtMs: '1704067200123', durationMs: '1000', plaintextLength: '608', storageFormat: 3 },
  capability: { rawValueHex: '00'.repeat(24), flags: 0x37f }, ...extra };
}
function session(extra = {}) {
  return { profile: 'encrypted_upload_v2', session_id: SESSION, owner_revision: 2, policy: 'v2_required',
    authorization_base64: authorization.toString('base64'), authorization_sha256: hex(authorization),
    expires_at: '2030-01-01T00:00:00Z', state: 'staging', channel: 'ble', ciphertext_length: 900,
    ciphertext_sha256: ciphertextHash, ...extra };
}
function response(url, status, value, extra = {}) {
  return { url, status, async text() { return typeof value === 'string' ? value : JSON.stringify(value); }, ...extra };
}
function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no; }); return { promise,resolve,reject }; }
function fixture(handler, overrides = {}) {
  const core = createGeneratedJsCore();
  const journal = new Map();
  const calls = [], uploads = [], materials = new Map();
  const nonceState = { value: '01'.repeat(16) };
  const cleanup = { removals: 0, unregisters: 0 };
  const context = (operationId = 'upload-1', signal = new AbortController().signal) => ({ operationId,
    operation: 'EncryptedUploadV2', generation: '4', cancellationId: '1', requestId: '0', signal });
  const files = { async metadata() { return { durableUnits: '900' }; }, async read(_handle,offset,maximum) {
    return Uint8Array.from(ciphertext.subarray(Number(offset), Number(offset) + maximum)); } };
  const options = { core, files, context, now: () => 1704067200000, wait: async () => {},
    persistence: { namespace: 'a:p:production', async load(key) { return structuredClone(journal.get(key) ?? null); },
      async save(key, value) { journal.set(key, structuredClone(value)); }, async remove(key) { cleanup.removals++; journal.delete(key); } },
    requestCredentials: async () => 'fresh-app-token', readNonce: async () => nonceState.value,
    registerMaterial(operationId, material) { materials.set(operationId, material); return `material:${operationId}`; },
    unregisterMaterial(id) { cleanup.unregisters++; materials.delete(id.replace('material:', '')); },
    uploadFile: async (...args) => { uploads.push(args); },
    fetch: async (url, request) => { calls.push({ url, request }); return await handler(url, request, calls); }, ...overrides };
  return { backend: createJsEncryptedUploadV2Backend(options), options, core, journal, calls, uploads, materials, context, nonceState, cleanup,
    sink: { id: 'captured-file', kind: 'file', scope: options.persistence.namespace } };
}
function baseHandler(url, request) {
  if (url.endsWith('/recordings')) return response(url, 201, { id: 'rec_1' });
  if (url.endsWith('/sessions')) return response(url, 201, session());
  throw new Error('unexpected HTTP');
}

test('generated managed backend sends root and prefixed routes to the exact configured origin', async () => {
  for (const prefix of ['', '/v1', '/dashboard/projects/proj_a']) {
    const f = fixture(baseHandler);
    try {
      const value = input(); value.scope.apiBasePath = prefix;
      await f.backend.prepare(JSON.stringify(value));
      assert.deepEqual(f.calls.map(call => call.url), [
        `https://api.example.com${prefix}/recordings`,
        `https://api.example.com${prefix}/recordings/rec_1/encrypted-upload-v2/sessions`,
      ]);
    } finally { await f.backend.dispose(); f.core.dispose?.(); }
  }
});

test('generated managed policy performs strict create, manifest reconciliation, staging and receipt-gated journal removal', async () => {
  let submitted = false;
  const f = fixture((url, request) => {
    if (url.endsWith('/manifest')) {
      if (!submitted) { submitted = true; return response(url, 409, { error: { code: 'encrypted_upload_v2_staging_missing' } }); }
      return response(url, 200, {});
    }
    if (url.endsWith('/staging-url')) return response(url, 200, { url: 'https://storage.example.com/file?signature=1', method: 'PUT', headers: { 'X-Storage': '1' } });
    if (url.endsWith(SESSION)) return response(url, 200, session({ state: 'published', plaintext_length: 608,
      completion_receipt_base64: receipt.toString('base64'), completion_receipt_sha256: hex(receipt) }));
    return baseHandler(url, request);
  });
  try {
    const selection = JSON.parse(await f.backend.prepare(JSON.stringify(input())));
    assert.equal(selection.recordingId, 'rec_1');
    assert.equal(Object.keys(JSON.parse(f.calls[1].request.body)).length, 10);
    assert.equal(JSON.parse(f.calls[1].request.body).end_user_id, undefined);
    assert.ok(f.calls.every(call => call.request.redirect === 'error' && call.request.credentials === 'omit'));
    assert.equal(f.journal.size, 1);
    await assert.rejects(f.backend.complete('upload-1'), error => error.code === 'BOTA_UPLOAD_STATE');
    const material = f.materials.get('upload-1');
    assert.deepEqual(Buffer.from(await material.authorization(f.context())), authorization);
    assert.equal(await material.reconcileStaging(manifest, evidence, f.context()), true);
    await material.stageCiphertext(f.sink, evidence, f.context());
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0][1], f.sink);
    assert.equal(f.uploads[0][0].headers.Authorization, undefined);
    await material.submitManifest(manifest, evidence, f.context());
    await material.finalize(evidence, f.context());
    assert.deepEqual(Buffer.from(await material.completionReceipt(evidence, f.context())), receipt);
    await assert.rejects(f.backend.complete('upload-1'), error => error.code === 'BOTA_UPLOAD_STATE');
    await material.confirmed(f.context());
    await Promise.all([f.backend.complete('upload-1'), f.backend.complete('upload-1')]);
    assert.equal(f.journal.size, 0); assert.equal(f.materials.size, 0);
    assert.equal(f.cleanup.removals, 1); assert.equal(f.cleanup.unregisters, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('successful manifest reconciliation never repeats PUT after an uncertain prior upload', async () => {
  const f = fixture((url, request) => url.endsWith('/manifest') ? response(url, 200, {}) : baseHandler(url, request));
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const material = f.materials.get('upload-1');
    assert.equal(await material.reconcileStaging(manifest, evidence, f.context()), false);
    await material.stageCiphertext(f.sink, evidence, f.context());
    await material.submitManifest(manifest, evidence, f.context());
    assert.equal(f.uploads.length, 0);
    assert.equal(f.calls.filter(call => call.url.endsWith('/manifest')).length, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('lost create response remains durably unknown and a later operation cannot create a duplicate', async () => {
  const f = fixture(async () => { throw new Error('lost response after dispatch'); });
  try {
    await assert.rejects(f.backend.prepare(JSON.stringify(input())), error => error.code === 'BOTA_UPLOAD_TRANSPORT');
    assert.equal([...f.journal.values()][0].phase, 'recording_create_unknown');
    await assert.rejects(f.backend.prepare(JSON.stringify(input('upload-2'))), error => error.code === 'BOTA_UPLOAD_PENDING');
    assert.equal(f.calls.length, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('a retained V2 capture in a fresh namespace conflicts without creating another cloud recording', async () => {
  let duplicateCreates = 0;
  const f = fixture((url, request) => {
    if (url.endsWith('/recordings')) {
      const body = JSON.parse(request.body);
      // The existing backend's exact identity conflict is deliberately not a resume API.
      if (body.device_id === 'dev_1' && body.recording_uuid === UUID && body.recording_generation === 3) {
        return response(url, 409, { error: { code: 'conflict', message: 'Recording identity already exists with a different upload format' } });
      }
      duplicateCreates++;
      return response(url, 201, { id: 'rec_duplicate' });
    }
    return baseHandler(url, request);
  });
  try {
    assert.equal(f.journal.size, 0);
    await assert.rejects(f.backend.prepare(JSON.stringify(input())), /BOTA_UPLOAD_HTTP_409/);
    assert.equal(duplicateCreates, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.materials.size, 0);
    assert.equal([...f.journal.values()][0].phase, 'recording_create_unknown');
    await assert.rejects(f.backend.prepare(JSON.stringify(input('upload-after-restart'))), /BOTA_UPLOAD_PENDING/);
    assert.equal(f.calls.length, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('cancellation joins an ignored create abort and commits returned identity before the operation releases', async () => {
  const held = deferred(), dispatched = deferred();
  const f = fixture(async (url) => { dispatched.resolve(); return held.promise; });
  try {
    const operation = f.backend.prepare(JSON.stringify(input()));
    void operation.catch(() => {});
    await dispatched.promise;
    let cancelled = false;
    const cancellation = f.backend.cancel('upload-1').then(() => { cancelled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, false);
    held.resolve(response('https://api.example.com/v1/recordings', 201, { id: 'rec_known' }));
    await cancellation;
    await assert.rejects(operation, error => error.code === 'BOTA_UPLOAD_CANCELLED');
    const saved = [...f.journal.values()][0];
    assert.equal(saved.phase, 'ready'); assert.equal(saved.entry.recordingId, 'rec_known');
    assert.equal(f.calls.length, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('exact authorization rejection rolls back uncertainty while other failures preserve it', async () => {
  for (const status of [401,403,409,503]) {
    const f = fixture((url) => response(url, status, { error: { code: 'denied' } }));
    try {
      await assert.rejects(f.backend.prepare(JSON.stringify(input())), new RegExp(`BOTA_UPLOAD_HTTP_${status}`));
      assert.equal(f.journal.size, status === 401 || status === 403 ? 0 : 1);
    } finally { await f.backend.dispose(); f.core.dispose?.(); }
  }
});

test('restoration checks exact owner and can recover a changed nonce without restarting cloud creation', async () => {
  const f = fixture((url, request) => {
    if (url.endsWith('/recover')) return response(url, 200, session({ session_id: SUCCESSOR, owner_revision: 3 }));
    if (url.endsWith(SUCCESSOR)) return response(url, 200, session({ session_id: SUCCESSOR, owner_revision: 3 }));
    if (url.endsWith(SESSION)) return response(url, 200, session());
    return baseHandler(url, request);
  });
  try {
    await f.backend.prepare(JSON.stringify(input()));
    await f.backend.cancel('upload-1');
    f.nonceState.value = '02'.repeat(16);
    const result = JSON.parse(await f.backend.prepare(JSON.stringify(input('upload-2'))));
    assert.equal(result.uploadSessionId, SUCCESSOR); assert.equal(result.ownerRevision, 3);
    assert.equal(f.calls.filter(call => call.url.endsWith('/recordings')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/sessions')).length, 1);
    const recover = f.calls.find(call => call.url.endsWith('/recover'));
    assert.equal(JSON.parse(recover.request.body).reason, 'nonce_changed');
    assert.equal([...f.journal.values()][0].entry.sessionId, SUCCESSOR);
    assert.equal([...f.journal.values()][0].recoveryNonceBase64, undefined);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('wrong evidence, response redirect and namespace mutation never upload or remove a journal', async () => {
  const f = fixture(baseHandler);
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const material = f.materials.get('upload-1');
    await assert.rejects(material.stageCiphertext(f.sink, { ...evidence, ciphertext_length: '901' }, f.context()),
      error => error.code === 'BOTA_UPLOAD_IDENTITY_CONFLICT');
    assert.equal(f.uploads.length, 0);
    f.options.persistence.namespace = 'other-scope';
    await assert.rejects(f.backend.complete('upload-1'), error => error.code === 'BOTA_UPLOAD_IDENTITY_CONFLICT');
    assert.equal(f.journal.size, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
  const redirected = fixture((url) => response(url, 200, { id: 'rec_1' }, { redirected: true }));
  try { await assert.rejects(redirected.backend.prepare(JSON.stringify(input())), error => error.code === 'BOTA_UPLOAD_INVALID_DOCUMENT'); }
  finally { await redirected.backend.dispose(); redirected.core.dispose?.(); }
});

test('signed context exchange is exact to its initial context and never exposes documents publicly', async () => {
  const challenge = Buffer.alloc(196, 5), result = Buffer.alloc(264, 6), proof = Buffer.alloc(116, 1);
  const initial = { context_id: UUID, state: 'challenge', challenge_base64: challenge.toString('base64'), expires_at: '2030-01-01T00:00:00Z' };
  const f = fixture((url, request) => {
    if (url.endsWith('/contexts')) return response(url, 200, initial);
    if (url.endsWith('/proof')) return response(url, 200, { ...initial, state: 'complete', result_base64: result.toString('base64') });
    return baseHandler(url, request);
  });
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const material = f.materials.get('upload-1');
    assert.deepEqual(Buffer.from(await material.uploadContext.challenge(7, Buffer.alloc(16), f.context())), challenge);
    assert.deepEqual(Buffer.from(await material.uploadContext.result(7, proof, f.context())), result);
    assert.equal(f.journal.size, 1);
    assert.ok(!JSON.stringify([...f.journal.values()]).includes(challenge.toString('base64')));
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('durable journal readback mismatch stops before authenticated creation', async () => {
  const f = fixture(baseHandler);
  f.options.persistence.save = async () => {};
  try {
    await assert.rejects(f.backend.prepare(JSON.stringify(input())), error => error.code === 'BOTA_UPLOAD_JOURNAL');
    assert.equal(f.calls.length, 0);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('the exact generated workflow owner cancellation aborts submitted HTTP and schedules no retry', async () => {
  const held = deferred(), submitted = deferred();
  let activeSignal;
  const f = fixture((url, request) => {
    if (url.endsWith('/manifest')) { activeSignal = request.signal; submitted.resolve(); return held.promise; }
    return baseHandler(url, request);
  });
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const controller = new AbortController();
    const context = f.context('upload-1', controller.signal);
    const work = f.materials.get('upload-1').reconcileStaging(manifest, evidence, context);
    void work.catch(() => {});
    await submitted.promise;
    controller.abort();
    assert.equal(activeSignal.aborted, true);
    held.resolve(response('https://api.example.com/v1/recordings/rec_1/encrypted-upload-v2/sessions/' + SESSION + '/manifest', 503, {}));
    await assert.rejects(work, error => error.code === 'BOTA_UPLOAD_CANCELLED');
    assert.equal(f.calls.filter(call => call.url.endsWith('/manifest')).length, 1);
    assert.equal(f.journal.size, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('marked admission and completion relay both signed documents while marker upload uses scoped file handles', async () => {
  const contextDocument = Buffer.alloc(176, 2), markerAuthorization = Buffer.alloc(280, 3), markerReceipt = Buffer.alloc(296, 4);
  const seal = Buffer.alloc(200, 1), page = Buffer.alloc(216, 2);
  const f = fixture((url, request) => {
    if (url.includes('/markers/authorization?')) return response(url, 200, { profile: 'recording-markers/1',
      context_base64: contextDocument.toString('base64'), authorization_base64: markerAuthorization.toString('base64'),
      authorization_sha256: hex(markerAuthorization) });
    if (url.endsWith('/markers/batch')) return response(url, 200, {});
    if (url.endsWith(SESSION)) return response(url, 200, session({ state: 'published', plaintext_length: 608,
      completion_receipt_base64: receipt.toString('base64'), completion_receipt_sha256: hex(receipt),
      marker_completion_receipt_base64: markerReceipt.toString('base64'), marker_completion_receipt_sha256: hex(markerReceipt) }));
    return baseHandler(url, request);
  });
  const documents = [seal, page].map((bytes, index) => ({ index, count: 2, sha256: Array.from(hash(bytes)),
    handle: { id: `marker-${index}`, kind: 'file', scope: f.options.persistence.namespace } }));
  f.options.files.metadata = async handle => ({ durableUnits: String(handle.id === 'marker-0' ? seal.length : page.length) });
  f.options.files.read = async handle => Uint8Array.from(handle.id === 'marker-0' ? seal : page);
  try {
    const request = input(); request.recording.markersRequired = true;
    await f.backend.prepare(JSON.stringify(request));
    const material = f.materials.get('upload-1');
    assert.equal((await material.authorization(f.context())).length, 864);
    await material.submitMarkers(documents, evidence, f.context());
    const body = JSON.parse(f.calls.find(call => call.url.endsWith('/markers/batch')).request.body);
    assert.equal(body.seal_base64, seal.toString('base64')); assert.deepEqual(body.pages_base64, [page.toString('base64')]);
    await material.finalize(evidence, f.context());
    assert.equal((await material.completionReceipt(evidence, f.context())).length, 632);
    assert.ok(!JSON.stringify([...f.journal.values()]).includes(markerAuthorization.toString('base64')));
    await material.confirmed(f.context()); await f.backend.complete('upload-1');
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('ciphertext changed during a provider callback is rejected before PUT', async () => {
  const f = fixture((url, request) => url.endsWith('/staging-url')
    ? response(url, 200, { url: 'https://storage.example.com/file', method: 'PUT', headers: {} }) : baseHandler(url, request));
  try {
    await f.backend.prepare(JSON.stringify(input()));
    f.options.files.read = async () => Uint8Array.from(Buffer.alloc(900, 99));
    await assert.rejects(f.materials.get('upload-1').stageCiphertext(f.sink, evidence, f.context()),
      error => error.code === 'BOTA_UPLOAD_IDENTITY_CONFLICT');
    assert.equal(f.uploads.length, 0); assert.equal(f.journal.size, 1);
  } finally { await f.backend.dispose(); f.core.dispose?.(); }
});

test('cancellation joins a dispatched durable completion before a newer journal owner can prepare', async () => {
  const removing = deferred(), finish = deferred();
  const f = fixture((url, request) => url.endsWith(SESSION)
    ? response(url, 200, session({ state: 'published', plaintext_length: 608,
      completion_receipt_base64: receipt.toString('base64'), completion_receipt_sha256: hex(receipt) }))
    : baseHandler(url, request));
  f.options.persistence.remove = async key => { removing.resolve(); await finish.promise; f.cleanup.removals++; f.journal.delete(key); };
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const material = f.materials.get('upload-1');
    await material.finalize(evidence, f.context()); await material.completionReceipt(evidence, f.context()); await material.confirmed(f.context());
    const complete = f.backend.complete('upload-1');
    await removing.promise;
    let drained = false;
    const cancel = f.backend.cancel('upload-1').then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(f.cleanup.unregisters, 0);
    assert.throws(() => f.backend.prepare(JSON.stringify(input('new-owner'))), error => error.code === 'BOTA_UPLOAD_STATE');
    finish.resolve(); await complete; await cancel;
    assert.equal(f.cleanup.removals, 1); assert.equal(f.cleanup.unregisters, 1); assert.equal(f.journal.size, 0);
  } finally { finish.resolve(); await f.backend.dispose(); f.core.dispose(); }
});

test('failed material unregistration still removes every captured abort observer and rejects stale material access', async () => {
  const tracked = () => {
    const controller = new AbortController(), signal = controller.signal, counts = { adds: 0, removes: 0 };
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { if (args[0] === 'abort') counts.adds++; add(...args); };
    signal.removeEventListener = (...args) => { if (args[0] === 'abort') counts.removes++; remove(...args); };
    return { signal, counts };
  };
  const lifetime = tracked(), owner = tracked(), cleanupFailure = new Error('host cleanup failed');
  const f = fixture(baseHandler, { signal: lifetime.signal, unregisterMaterial: async () => { throw cleanupFailure; } });
  try {
    await f.backend.prepare(JSON.stringify(input()));
    const material = f.materials.get('upload-1');
    await material.authorization(f.context('upload-1', owner.signal));
    await assert.rejects(f.backend.dispose(), error => error === cleanupFailure);
    assert.deepEqual(lifetime.counts, { adds: 1, removes: 1 }); assert.deepEqual(owner.counts, { adds: 1, removes: 1 });
    await assert.rejects(material.authorization(f.context()), error => error.code === 'BOTA_UPLOAD_CANCELLED');
  } finally { await f.backend.dispose().catch(() => {}); f.core.dispose(); }
});

 test('local control uses a fresh nonce after session authorization and never journals its key response', async () => {
   const grant={format:'bota-local-wifi-control-v1',control_key_base64:Buffer.alloc(32,7).toString('base64'),envelope_base64:Buffer.alloc(509,8).toString('base64'),expires_in_seconds:300};
   const f=fixture((url,request)=>{
     if(url.endsWith('/control-grant'))return response(url,200,grant);
     if(url.endsWith('/sessions'))return response(url,201,session({channel:'local_wifi'}));
     return baseHandler(url,request);
   });
   try {
     const value=input();value.capability.localWifiRawValueHex='020210001f0000000300b900b600b600';
     await f.backend.prepare(JSON.stringify(value));f.nonceState.value='09'.repeat(16);
     const result=await f.materials.get('upload-1').localWifiControlGrant('41',f.context());
     assert.deepEqual(JSON.parse(result),grant);
     assert.equal(f.calls.at(-1).url,'https://api.example.com/v1/devices/dev_1/local-wifi/control-grant');
     assert.deepEqual(JSON.parse(f.calls.at(-1).request.body),{binding_generation:2,session_id:'41',auth_nonce_base64:Buffer.alloc(16,9).toString('base64')});
     assert.ok(!JSON.stringify([...f.journal]).includes(grant.control_key_base64));
   } finally {await f.backend.dispose();f.core.dispose?.();}
 });
