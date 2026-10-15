import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createManagedEncryptedUploadV2Backend: create } = loadSource('../encryptedUploadV2Backend.ts');
const { createBotaDeviceSDK } = loadSource('../client.ts');
const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsEncryptedUploadV2Backend } = loadSource('uploadBackendV2.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const device = { id: 'ble-one', serialNumber: 'SERIAL', deviceType: 'bota_pin', firmwareVersion: '1.0.19', isProvisioned: true, connectionState: 'connected', mtu: 512 };
const recording = { uuid: '00112233-4455-6677-8899-aabbccddeeff', generation: 3, storageFormat: 3,
  ciphertextLength: '900', ciphertextSha256: createHash('sha256').update(Buffer.alloc(900, 1)).digest('hex'),
  startedAtMs: '1704067200123', durationMs: '1000', plaintextLength: '608' };
const target = { deviceId: 'dev_one', bindingGeneration: 2 };
const rejectedMaterial = () => Object.assign(new Error('redacted material rejection'), { code: 'application_material_rejected', operation: 'TransferRecording' });

function fixture() {
  const scope = new AbortController(), calls = [], subscriptions = new Set(), operations = new Map(), requests = new Map();
  let profile, progress, ordinal = 0;
  const module = {
    onEncryptedUploadV2ProfileRequested(listener) { profile = listener; subscriptions.add(listener); return { remove() { subscriptions.delete(listener); } }; },
    onEncryptedUploadV2Progress(listener) { progress = listener; subscriptions.add(listener); return { remove() { subscriptions.delete(listener); } }; },
    syncEncryptedRecordingV2(_device, value, operationId) {
      const pending = deferred(); operations.set(operationId, pending); calls.push(['sync', operationId]);
      const context = { operationId, requestId: 'profile-' + ++ordinal, recording: value,
        capability: { rawValueHex: '00'.repeat(24), flags: 0x37f } };
      requests.set(context.requestId, operationId); f.context = context; profile(context);
      return pending.promise;
    },
    async rejectEncryptedUploadV2Profile(requestId, code) {
      calls.push(['reject', code]);
      if (f.onReject) await f.onReject(requestId);
      else operations.get(requests.get(requestId)).reject(f.terminal());
    },
    async resolveEncryptedUploadV2Profile() { throw new Error('Unexpected successful preparation'); },
    async releaseEncryptedUploadV2Material() {},
    async cancelEncryptedRecordingV2(id) { calls.push(['client-cancel', id]); operations.get(id)?.reject(new Error('encrypted upload v2 cancelled')); },
  };
  const native = {
    async prepare(value) { calls.push(['prepare', JSON.parse(value).operationId]); throw f.failure; },
    async cancel(id) { calls.push(['cancel', id]); if (f.cancelGate) await f.cancelGate.promise; if (f.cancelFailure) throw f.cancelFailure; },
    async complete() { calls.push(['complete']); },
    onCredentialsRequested(listener) { subscriptions.add(listener); return { remove() { subscriptions.delete(listener); if (f.removeFailure) throw f.removeFailure; } }; },
    async resolveCredentials() {}, async rejectCredentials() {},
  };
  const config = { baseUrl: 'https://customer.example/v1', scopeKey: 'account/project', accountId: 'account',
    projectId: 'project', endUserId: 'eu_one', environment: 'production', signal: scope.signal,
    getAccessToken: async () => 'private-token' };
  const f = { calls, scope, native, module, config, subscriptions, operations, terminal: rejectedMaterial,
    failure: Object.assign(new Error('private-url-and-token'), { code: 'BOTA_UPLOAD_IDENTITY_CONFLICT' }),
    create: () => create(native, createBotaDeviceSDK(module).recordings, config), emit: event => progress?.(event),
    profile(context) { requests.set(context.requestId, context.operationId); profile(context); } };
  return f;
}

test('real client provider redaction retains only recognized managed prepare diagnostics', async () => {
  for (const failure of [
    Object.assign(new Error('private-body'), { code: 'BOTA_UPLOAD_IDENTITY_CONFLICT', detail: 'private-signed-blob' }),
    Object.assign(new Error('BOTA_UPLOAD_HTTP_409'), { status: 409, body: 'private-body' }),
    Object.assign(new Error('private-body'), { code: 'BOTA_UPLOAD_HTTP_403' }),
  ]) {
    const f = fixture(); f.failure = failure;
    await assert.rejects(f.create().sync(device, recording, target), error => {
      assert.match(error.code, /^BOTA_UPLOAD_(IDENTITY_CONFLICT|HTTP_40[39])$/);
      assert.equal(error.operation, 'PrepareEncryptedUploadV2');
      assert(!JSON.stringify(error).includes('private')); assert(!String(error).includes('private'));
      assert.equal(error.cause, undefined); assert.equal(error.detail, undefined);
      return true;
    });
    assert.deepEqual(f.calls.filter(call => call[0] === 'reject'), [['reject', 'application_material_rejected']]);
    assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 1);
    assert.equal(f.subscriptions.size, 0); assert(!f.calls.some(call => call[0] === 'complete'));
  }
});

test('unknown malformed or foreign prepare errors cannot replace the client rejection', async () => {
  for (const failure of [new Error('BOTA_UPLOAD_HTTP_409 private-token'),
    { code: 'private-code', status: 409 }, { status: 409, message: 'private-body' },
    { get code() { throw new Error('private-getter'); } }]) {
    const f = fixture(); f.failure = failure; const terminal = rejectedMaterial(); f.terminal = () => terminal;
    await assert.rejects(f.create().sync(device, recording, target), error => error === terminal);
    assert.equal(f.subscriptions.size, 0);
  }
  for (const terminal of [Object.assign(new Error('cancelled'), { code: 'cancelled' }),
    Object.assign(new Error('cleanup incomplete'), { code: 'cleanup_incomplete' }),
    Object.assign(new Error('foreign operation'), { code: 'application_material_rejected', operation: 'FactoryReset' })]) {
    const f = fixture(); f.terminal = () => terminal;
    await assert.rejects(f.create().sync(device, recording, target), error => error === terminal);
  }
});

test('diagnostics are local to each invocation', async () => {
  const f = fixture(), backend = f.create();
  await assert.rejects(backend.sync(device, recording, target), { code: 'BOTA_UPLOAD_IDENTITY_CONFLICT' });
  const terminal = rejectedMaterial(); f.failure = new Error('private-unrecognized'); f.terminal = () => terminal;
  await assert.rejects(backend.sync(device, recording, target), error => error === terminal);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 2);
  assert.equal(f.subscriptions.size, 0);
});

test('an older provider failure cannot overwrite the latest request diagnostic', async () => {
  const f = fixture(), first = deferred(), firstEntered = deferred(), oldRejected = deferred(), latestRejected = deferred(), finish = deferred();
  const terminal = rejectedMaterial(); let prepares = 0;
  f.native.prepare = async () => {
    if (++prepares === 1) { firstEntered.resolve(); return first.promise; }
    throw new Error('unrecognized private provider body');
  };
  f.onReject = async requestId => {
    if (requestId !== 'latest-request') { oldRejected.resolve(); return; }
    latestRejected.resolve(); await finish.promise; f.operations.get(f.context.operationId).reject(terminal);
  };
  const rejected = assert.rejects(f.create().sync(device, recording, target), error => error === terminal);
  await firstEntered.promise;
  f.profile({ ...f.context, requestId: 'latest-request' }); await latestRejected.promise;
  first.reject(Object.assign(new Error('private stale body'), { code: 'BOTA_UPLOAD_HTTP_409' }));
  await oldRejected.promise; finish.resolve(); await rejected;
  assert.equal(f.subscriptions.size, 0);
});

test('scope and caller cancellation during joined prepare cleanup beat diagnostic substitution', async () => {
  for (const abortScope of [true, false]) {
    const f = fixture(), caller = new AbortController(); f.cancelGate = deferred();
    const backend = f.create(); let settled = false;
    const run = backend.sync(device, recording, { ...target, signal: caller.signal }).finally(() => { settled = true; });
    const rejected = assert.rejects(run, /cancelled/);
    while (!f.calls.some(call => call[0] === 'cancel')) await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); (abortScope ? f.scope : caller).abort(); f.cancelGate.resolve();
    await rejected; assert.equal(f.subscriptions.size, 0);
  }
});

test('cancel and subscription cleanup failures retain precedence over prepare diagnostics', async () => {
  for (const stage of ['cancelFailure', 'removeFailure']) {
    const f = fixture(), failure = new Error('test cleanup failure'); f[stage] = failure;
    await assert.rejects(f.create().sync(device, recording, target), error => error === failure);
    assert(!f.calls.some(call => call[0] === 'complete'));
  }
});

test('actual generated HTTP conflict composes through client redaction without extra create/session/PUT', async () => {
  const f = fixture(), core = createGeneratedJsCore(), journal = new Map(), http = [];
  const managed = createJsEncryptedUploadV2Backend({ core, files: {}, persistence: { namespace: 'account/project',
    async load(key) { return journal.get(key) ?? null; }, async save(key, value) { journal.set(key, structuredClone(value)); }, async remove(key) { journal.delete(key); } },
    context: operationId => ({ operationId, operation: 'PrepareEncryptedUploadV2', generation: '1', cancellationId: '1', requestId: '1', signal: f.scope.signal }),
    now: () => 1704067200000, requestCredentials: async () => 'private-token', readNonce: async () => '01'.repeat(16),
    registerMaterial() { throw new Error('Unexpected material'); }, unregisterMaterial() {},
    uploadFile() { throw new Error('Unexpected PUT'); },
    fetch: async (url, request) => { http.push({ url, request }); return { url, status: 409, async text() { return '{"error":{"code":"private-backend-detail"}}'; } }; },
  });
  f.native.prepare = value => managed.prepare(value); f.native.cancel = id => managed.cancel(id);
  try {
    await assert.rejects(f.create().sync(device, recording, target), { code: 'BOTA_UPLOAD_HTTP_409', status: 409, operation: 'PrepareEncryptedUploadV2' });
    assert.equal(http.length, 1); assert.equal(http[0].request.method, 'POST');
    const body = JSON.parse(http[0].request.body);
    assert.equal(body.recording_uuid, recording.uuid); assert.equal(body.recording_generation, recording.generation);
    assert.equal([...journal.values()][0].phase, 'recording_create_unknown');
    assert.equal(f.subscriptions.size, 0);
  } finally { await managed.dispose(); core.dispose?.(); }
});
