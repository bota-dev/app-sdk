import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createBotaDeviceSDK } = require('../lib/commonjs/client.js');
const device = { id: 'peripheral', serialNumber: 'TEST', deviceType: 'bota_note',
  firmwareVersion: '1.0.17', isProvisioned: true, connectionState: 'connected', mtu: 247 };
const recording = { uuid: '12345678-1234-1234-1234-123456789abc', generation: 1,
  ciphertextLength: '1000', ciphertextSha256: 'a'.repeat(64),
  startedAtMs: '1720000000000', durationMs: '2000', plaintextLength: '850', storageFormat: 3 };
const operationId = '11111111-1111-4111-8111-111111111111';
const selection = { profile: 'encrypted_upload_v2', uploadSessionId: operationId,
  ownerRevision: 1, securityPolicy: 'v2_required', materialRegistrationId: 'native-material' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const legacyRecording = { uuid: '99999999-0000-0000-0000-000000000000', startedAtMs: 1700000000000,
  durationMs: 1000, fileSize: 200, codec: 'opus_16k', isEncrypted: false };

test('mixed catalog requires canonical UUIDs and decimal strings without coercion', async () => {
  for (const patch of [
    { uuid: undefined }, { uuid: '12345678' }, { uuid: recording.uuid.toUpperCase() },
    { startedAtMs: 1720000000000 }, { durationMs: 2000 },
    { plaintextLength: 850 }, { ciphertextLength: 1000 },
    { startedAtMs: '8640000000000001' }, { startedAtMs: '-1' }, { durationMs: '01' },
    { plaintextLength: '18446744073709551616' }, { ciphertextLength: '18446744073709551616' },
    { plaintextLength: '+850' }, { ciphertextLength: '0' }, { ciphertextLength: '1e3' },
    { generation: -1 }, { generation: 0x100000000 }, { generation: 1.5 }, { generation: '1' },
    { storageFormat: 2 }, { ciphertextSha256: 'A'.repeat(64) }, { ciphertextSha256: 'a'.repeat(63) },
    { ciphertextSha256: { toString: () => 'a'.repeat(64) } },
  ]) {
    const client = createBotaDeviceSDK({ listPendingRecordings: async () => [
      { profile: 'encrypted_upload_v2', encrypted: { ...recording, ...patch } },
    ] });
    await assert.rejects(client.recordings.listPendingRecordings(device), /catalog/, JSON.stringify(patch));
  }
});

test('mixed catalog validates legacy identity and numeric metadata too', async () => {
  for (const patch of [
    { uuid: undefined }, { uuid: 'bad-id' }, { startedAtMs: NaN },
    { startedAtMs: 8640000000000001 }, { startedAtMs: '1700000000000' },
    { durationMs: -1 }, { durationMs: 0.5 }, { fileSize: Number.MAX_SAFE_INTEGER + 1 },
    { fileSize: '200' }, { isEncrypted: 'false' }, { codec: undefined },
  ]) {
    const client = createBotaDeviceSDK({ listPendingRecordings: async () => [
      { profile: 'legacy', legacy: { ...legacyRecording, ...patch } },
    ] });
    await assert.rejects(client.recordings.listPendingRecordings(device), /catalog/, JSON.stringify(patch));
  }
});

test('mixed catalog projects only declared metadata and preserves maximum u64 strings', async () => {
  const client = createBotaDeviceSDK({ listPendingRecordings: async () => [
    { profile: 'encrypted_upload_v2', encrypted: { ...recording,
      plaintextLength: '18446744073709551615', ciphertextLength: '18446744073709551615',
      payload: 'unexpected-private-payload', authorization: 'unexpected-document' } },
  ] });
  const [value] = await client.recordings.listPendingRecordings(device);
  assert.deepEqual(Object.keys(value).sort(), [
    'uuid', 'generation', 'storageFormat', 'startedAtMs', 'startedAt', 'durationMs',
    'plaintextLength', 'ciphertextLength', 'ciphertextSha256',
  ].sort());
  assert.equal(value.plaintextLength, '18446744073709551615');
  assert.equal(value.ciphertextLength, '18446744073709551615');
});

test('abort suppresses subsequent progress before native cancellation settles', async () => {
  const controller = new AbortController();
  const nativeRun = deferred(), cancellation = deferred();
  const seen = []; let onProgress; const cancelled = [];
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() {} }),
    onEncryptedUploadV2Progress: callback => { onProgress = callback; return { remove() {} }; },
    syncEncryptedRecordingV2: () => nativeRun.promise,
    cancelEncryptedRecordingV2: id => { cancelled.push(id); return cancellation.promise; },
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    event => seen.push(event.phase), { signal: controller.signal, operationId });
  const failure = assert.rejects(run, /cancelled/);
  onProgress({ operationId, recordingUuid: recording.uuid, phase: 'transferring', completedBytes: '0', totalBytes: '1000' });
  controller.abort();
  onProgress({ operationId, recordingUuid: recording.uuid, phase: 'transferring', completedBytes: '500', totalBytes: '1000' });
  cancellation.resolve(); nativeRun.reject(new Error('cancelled')); await failure;
  assert.deepEqual(cancelled, [operationId]);
  assert.deepEqual(seen, ['transferring']);
});

test('listener cleanup exhausts every removal and awaits owned cancellation after a removal throws', async () => {
  const controller = new AbortController();
  const nativeRun = deferred(), cancellation = deferred();
  const removals = []; let settled = false;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() { removals.push('profile'); throw new Error('private cleanup details'); } }),
    onEncryptedUploadV2Progress: () => ({ remove() { removals.push('progress'); } }),
    syncEncryptedRecordingV2: () => nativeRun.promise,
    cancelEncryptedRecordingV2: () => cancellation.promise,
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    undefined, { signal: controller.signal, operationId });
  void run.then(() => { settled = true; }, () => { settled = true; });
  const outcome = run.then(() => undefined, error => error);
  controller.abort(); nativeRun.reject(new Error('cancelled')); await flush();
  const settledBeforeCancellation = settled;
  cancellation.resolve();
  assert.match((await outcome)?.message ?? '', /encrypted upload v2 listener cleanup failed/);
  assert.deepEqual(removals, ['profile', 'progress']);
  assert.equal(settledBeforeCancellation, false);
});

test('cancellation rejection is not swallowed when it has no truthy reason', async () => {
  const controller = new AbortController(), nativeRun = deferred();
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() {} }),
    onEncryptedUploadV2Progress: () => ({ remove() {} }),
    syncEncryptedRecordingV2: () => nativeRun.promise,
    cancelEncryptedRecordingV2: () => Promise.reject(undefined),
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    undefined, { signal: controller.signal, operationId });
  const failure = assert.rejects(run, /encrypted upload v2 cancellation failed/);
  controller.abort(); nativeRun.resolve(); await failure;
});

test('synchronous native cancellation failure stays on the operation promise', async () => {
  const nativeRun = deferred(); let abortListener;
  const signal = { aborted: false,
    addEventListener: (_name, listener) => { abortListener = listener; },
    removeEventListener() {},
  };
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() {} }),
    onEncryptedUploadV2Progress: () => ({ remove() {} }),
    syncEncryptedRecordingV2: () => nativeRun.promise,
    cancelEncryptedRecordingV2: () => { throw new Error('private native bridge details'); },
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    undefined, { signal, operationId });
  const outcome = run.then(() => undefined, error => error);
  signal.aborted = true;
  let abortError;
  try { abortListener(); } catch (error) { abortError = error; }
  nativeRun.resolve();
  const error = await outcome;
  assert.equal(abortError, undefined);
  assert.match(error?.message ?? '', /encrypted upload v2 cancellation failed/);
});

test('abort during subscription setup removes both listeners without native work', async () => {
  const controller = new AbortController(); let removals = 0, starts = 0, cancels = 0;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() { removals++; } }),
    onEncryptedUploadV2Progress: () => { controller.abort(); return { remove() { removals++; } }; },
    syncEncryptedRecordingV2: async () => { starts++; },
    cancelEncryptedRecordingV2: async () => { cancels++; },
  });
  await assert.rejects(client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    undefined, { signal: controller.signal, operationId }), /cancelled/);
  assert.equal(removals, 2); assert.equal(starts, 0); assert.equal(cancels, 0);
});

test('native confirmed success wins the abort race after cancellation has been joined', async () => {
  const controller = new AbortController(), nativeRun = deferred(), cancellation = deferred();
  let settled = false;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() {} }),
    onEncryptedUploadV2Progress: () => ({ remove() {} }),
    syncEncryptedRecordingV2: () => nativeRun.promise,
    cancelEncryptedRecordingV2: () => cancellation.promise,
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection,
    undefined, { signal: controller.signal, operationId });
  void run.then(() => { settled = true; });
  controller.abort(); nativeRun.resolve(); await flush();
  const settledBeforeCancellation = settled;
  cancellation.resolve(); await run;
  assert.equal(settledBeforeCancellation, false);
});

test('terminal operations ignore queued callbacks and release late provider material', async () => {
  const nativeRun = deferred(), material = deferred();
  let onProfile, onProgress, requests = 0; const calls = [];
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: callback => { onProfile = callback; return { remove() {} }; },
    onEncryptedUploadV2Progress: callback => { onProgress = callback; return { remove() {} }; },
    syncEncryptedRecordingV2: () => nativeRun.promise,
    resolveEncryptedUploadV2Profile: async () => { calls.push('resolve'); },
    rejectEncryptedUploadV2Profile: async () => { calls.push('reject'); },
    releaseEncryptedUploadV2Material: async id => { calls.push(['release', id]); },
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async () => {
    requests++; return material.promise;
  }, () => { calls.push('progress'); }, { operationId });
  const request = { operationId, requestId: 'request', recording, capability: {} };
  onProfile({ ...request, operationId: '22222222-2222-4222-8222-222222222222' });
  onProfile(request); nativeRun.resolve(); await run;
  onProfile(request);
  onProgress({ operationId, recordingUuid: recording.uuid, phase: 'completed', completedBytes: '1000', totalBytes: '1000' });
  material.resolve(selection); await flush();
  assert.equal(requests, 1);
  assert.deepEqual(calls, [['release', selection.materialRegistrationId]]);
});

test('mixed catalog maps native metadata without inventing legacy identities', async () => {
  const legacy = { uuid: '99999999-0000-0000-0000-000000000000', startedAtMs: 1700000000000,
    durationMs: 1000, fileSize: 200, codec: 'opus_16k', isEncrypted: false };
  const client = createBotaDeviceSDK({ listPendingRecordings: async () => [
    { profile: 'encrypted_upload_v2', encrypted: recording }, { profile: 'legacy', legacy },
  ] });
  assert.equal(typeof client.recordings.listPendingRecordings, 'function');
  const [v2, old] = await client.recordings.listPendingRecordings(device);
  assert.equal(v2.storageFormat, 3);
  assert.equal(v2.plaintextLength, '850');
  assert.equal(v2.ciphertextSha256, recording.ciphertextSha256);
  assert.equal(v2.startedAt.getTime(), 1720000000000);
  assert.equal(old.uuid, legacy.uuid);
  assert.equal(old.fileSizeBytes, 200);
});

test('mixed catalog rejects ambiguous tags and invalid metadata', async () => {
  for (const row of [
    { profile: 'encrypted_upload_v2', encrypted: recording, legacy: {} },
    { profile: 'unknown', encrypted: recording },
    { profile: 'encrypted_upload_v2', encrypted: { ...recording, durationMs: '9007199254740993' } },
    { profile: 'encrypted_upload_v2', encrypted: { ...recording, plaintextLength: undefined } },
  ]) {
    const client = createBotaDeviceSDK({ listPendingRecordings: async () => [row] });
    assert.equal(typeof client.recordings.listPendingRecordings, 'function');
    await assert.rejects(client.recordings.listPendingRecordings(device), /catalog/);
  }
});

test('pre-aborted v2 sync does not subscribe or start native work', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => { calls++; return { remove() {} }; },
    onEncryptedUploadV2Progress: () => { calls++; return { remove() {} }; },
    syncEncryptedRecordingV2: async () => { calls++; },
  });
  await assert.rejects(client.recordings.syncEncryptedRecordingV2(device, recording,
    async () => selection, undefined, { signal: controller.signal, operationId }), /cancel/i);
  assert.equal(calls, 0);
});

test('v2 cancellation targets its operation and disposes late native material', async () => {
  const controller = new AbortController();
  const material = deferred(), nativeRun = deferred();
  const calls = []; let onProfile; let removed = 0;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: cb => { onProfile = cb; return { remove() { removed++; } }; },
    onEncryptedUploadV2Progress: () => ({ remove() { removed++; } }),
    syncEncryptedRecordingV2: (_d, _r, id) => { assert.equal(id, operationId); return nativeRun.promise; },
    cancelEncryptedRecordingV2: async id => { calls.push(['cancel', id]); nativeRun.reject(new Error('cancelled')); },
    resolveEncryptedUploadV2Profile: async () => { calls.push(['resolve']); },
    rejectEncryptedUploadV2Profile: async () => { calls.push(['reject']); },
    releaseEncryptedUploadV2Material: async id => { calls.push(['release', id]); },
  });
  const run = client.recordings.syncEncryptedRecordingV2(device, recording, async context => {
    assert.equal(context.operationId, operationId);
    return material.promise;
  }, undefined, { signal: controller.signal, operationId });
  const rejected = assert.rejects(run, /cancel/);
  onProfile({ operationId, requestId: 'request', recording, capability: {} });
  await flush(); controller.abort(); await rejected;
  material.resolve(selection); await flush();
  assert.deepEqual(calls, [['cancel', operationId], ['release', 'native-material']]);
  assert.equal(removed, 2);
});

test('subscription setup failure removes earlier listeners without starting sync', async () => {
  let removed = 0, starts = 0;
  const client = createBotaDeviceSDK({
    onEncryptedUploadV2ProfileRequested: () => ({ remove() { removed++; } }),
    onEncryptedUploadV2Progress: () => { throw new Error('subscription failed'); },
    syncEncryptedRecordingV2: async () => { starts++; },
  });
  await assert.rejects(client.recordings.syncEncryptedRecordingV2(device, recording, async () => selection), /subscription/);
  assert.equal(removed, 1); assert.equal(starts, 0);
});
