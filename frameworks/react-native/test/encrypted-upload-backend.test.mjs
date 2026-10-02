import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createManagedEncryptedUploadV2Backend: create } = require('../lib/commonjs/encryptedUploadV2Backend.js');
const session = '22222222-2222-4222-8222-222222222222';
const device = { id: 'peripheral-a', serialNumber: 'BOTA123' };
const recording = { uuid: '11111111-1111-4111-8111-111111111111', generation: 1,
  ciphertextLength: '1024', ciphertextSha256: 'ab'.repeat(32), plaintextLength: '900',
  startedAtMs: '1700000000000', durationMs: '1000', storageFormat: 3 };
const target = { deviceId: 'dev_a', bindingGeneration: 1 };
const selection = { profile: 'encrypted_upload_v2', recordingId: 'rec_a', uploadSessionId: session,
  ownerRevision: 1, securityPolicy: 'v2_required', materialRegistrationId: 'native-material' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const lifetime = new AbortController(), calls = [], listeners = new Set();
  const config = { baseUrl: 'https://customer.example/v1/', scopeKey: 'account-a/project-a',
    accountId: 'account-a', projectId: 'project-a', endUserId: 'eu_a', environment: 'production',
    signal: lifetime.signal, getAccessToken: async () => 'fresh-app-token' };
  const native = {
    onCredentialsRequested: cb => { listeners.add(cb); return { remove() { listeners.delete(cb); } }; },
    prepare: async input => { calls.push(['prepare', JSON.parse(input)]); return JSON.stringify(selection); },
    cancel: async id => { calls.push(['cancel', id]); }, complete: async id => { calls.push(['complete', id]); },
    resolveCredentials: async (...args) => { calls.push(['resolve', ...args]); },
    rejectCredentials: async (...args) => { calls.push(['reject', ...args]); },
  };
  const context = { operationId: 'operation-a', recording, capability: { rawValueHex: '00'.repeat(24), flags: 895 } };
  const client = { syncEncryptedRecordingV2: async (_device, _recording, provider) => {
    const result = await provider(context); calls.push(['selected', result]); calls.push(['confirmed']);
  } };
  return { lifetime, calls, listeners, config, native, client, context,
    emit: event => listeners.forEach(cb => cb(event)), create: () => create(native, client, config) };
}
test('managed sync uses only metadata and removes journal only after native confirmation', async () => {
  const f = fixture();
  f.context.recording = { ...recording, ciphertext: 'must-not-cross', authorization: 'must-not-cross' };
  assert.deepEqual(await f.create().sync(device, recording, target), { recordingId: 'rec_a' });
  const [, input] = f.calls[0];
  assert.equal(input.scope.apiOrigin, 'https://customer.example');
  assert.equal(input.scope.apiBasePath, '/v1');
  assert.deepEqual(Object.keys(input.recording).sort(), Object.keys(recording).sort());
  assert.equal(input.journalKey, undefined); // Derived and validated in native code.
  assert.deepEqual(f.calls.map(c => c[0]), ['prepare', 'selected', 'confirmed', 'complete']);
  assert.equal(f.listeners.size, 0);
});
test('backend origin, account and target are captured before async provider work', async () => {
  const f = fixture(), gate = deferred(), d = { ...device }, t = { ...target };
  f.client.syncEncryptedRecordingV2 = async (_, __, provider) => { await gate.promise; await provider(f.context); };
  const backend = f.create(), pending = backend.sync(d, recording, t);
  f.config.baseUrl = 'https://wrong.example/v2'; f.config.accountId = 'account-b';
  d.serialNumber = 'OTHER'; t.deviceId = 'dev_b'; t.bindingGeneration = 2;
  gate.resolve(); await pending;
  const scope = f.calls.find(c => c[0] === 'prepare')[1].scope;
  assert.equal(scope.apiOrigin, 'https://customer.example'); assert.equal(scope.accountId, 'account-a');
  assert.equal(scope.deviceId, 'dev_a'); assert.equal(scope.serialNumber, 'BOTA123'); assert.equal(scope.bindingGeneration, 1);
});
test('confirmed cleanup is not turned into failure by redundant bridge cancellation', async () => {
  const f = fixture();
  f.native.cancel = async () => { throw new Error('bridge unavailable'); };
  assert.deepEqual(await f.create().sync(device, recording, target), { recordingId: 'rec_a' });
  assert.equal(f.listeners.size, 0);
});
test('each credential request gets a fresh token and foreign operations are ignored', async () => {
  const f = fixture(), gate = deferred(); let issued = 0;
  f.config.getAccessToken = async () => `token-${++issued}`;
  f.native.prepare = async () => gate.promise;
  const run = f.create().sync(device, recording, target);
  f.emit({ operationId: 'foreign', requestId: 'ignored' });
  f.emit({ operationId: 'operation-a', requestId: 'one' }); await flush();
  f.emit({ operationId: 'operation-a', requestId: 'two' }); await flush();
  assert.deepEqual(f.calls, [['resolve', 'one', 'token-1'], ['resolve', 'two', 'token-2']]);
  gate.resolve(JSON.stringify(selection)); await run;
});
test('logout rejects a late token and late preparation without completing or retargeting', async () => {
  const f = fixture(), token = deferred(), prepare = deferred();
  f.config.getAccessToken = () => token.promise; f.native.prepare = () => prepare.promise;
  const backend = f.create(), run = backend.sync(device, recording, target);
  const failed = assert.rejects(run, /cancelled/);
  f.emit({ operationId: 'operation-a', requestId: 'pending' });
  f.lifetime.abort(); token.resolve('token-from-new-account'); await flush();
  prepare.resolve(JSON.stringify(selection)); await failed;
  assert.equal(f.calls.some(c => c[0] === 'resolve' || c[0] === 'complete'), false);
  assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'reject'), ['reject', 'pending']);
  await assert.rejects(backend.sync(device, recording, target), /cancelled/);
});
test('failed or interrupted native receipt/CONFIRM keeps the backend journal for retry', async () => {
  const f = fixture();
  f.client.syncEncryptedRecordingV2 = async (_, __, provider) => { await provider(f.context); throw new Error('pending verification'); };
  await assert.rejects(f.create().sync(device, recording, target), /pending verification/);
  assert.equal(f.calls.some(c => c[0] === 'complete'), false); assert.equal(f.listeners.size, 0);
});
test('dispose waits for native sync cancellation settlement', async () => {
  const f = fixture(), finished = deferred();
  f.client.syncEncryptedRecordingV2 = async (_, __, provider) => { await provider(f.context); await finished.promise; };
  const backend = f.create(), run = backend.sync(device, recording, target);
  const failed = assert.rejects(run, /cancelled/); await flush();
  let disposed = false; const disposal = backend.dispose().then(() => { disposed = true; });
  await flush(); assert.equal(disposed, false);
  finished.resolve(); await failed; await disposal;
  assert.equal(disposed, true); assert.equal(f.calls.some(c => c[0] === 'complete'), false);
});
test('reinvocation uses native journal identity; imported pointer contains metadata only', async () => {
  const f = fixture(), backend = f.create();
  const priorUpload = { recordingId: 'rec_old', sessionId: session, ownerRevision: 2, receipt: 'private' };
  await backend.sync(device, recording, { ...target, priorUpload });
  const input = f.calls.find(c => c[0] === 'prepare')[1];
  assert.deepEqual(input.priorJournalEntry, { recordingId: 'rec_old', sessionId: session, ownerRevision: 2 });
});
test('missing native binary, unsafe URL and invalid selection fail before journal completion', async () => {
  const f = fixture();
  await assert.rejects(create(null, f.client, f.config).sync(device, recording, target), /native SDK binary/);
  for (const baseUrl of ['http://example.com/v1', 'https://token@example.com/v1', 'https://example.com/v1?token=secret', 'https://example.com/v1#fragment']) {
    assert.throws(() => create(f.native, f.client, { ...f.config, baseUrl }), /configuration/);
  }
  f.native.prepare = async () => JSON.stringify({ ...selection, ownerRevision: 0 });
  await assert.rejects(f.create().sync(device, recording, target), /Invalid encrypted upload backend response/);
  assert.equal(f.calls.some(c => c[0] === 'complete'), false);
});
