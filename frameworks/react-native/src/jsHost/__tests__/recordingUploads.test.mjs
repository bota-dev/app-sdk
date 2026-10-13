import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { JsRecordingUploads } = loadSource('recordingUploads.ts');
const { UploadVerificationPendingError } = loadSource('../managers/uploadVerificationPending.ts');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const task = (status = 'completed') => ({ id: 'base-id', recordingId: 'rec_1', deviceId: 'dev_1', localPath: 'owned-file',
  fileSizeBytes: 4, status, retryCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const request = extra => ({ taskId: 'base-id_attempt', recordingId: 'rec_1', deviceId: 'dev_1', localPath: 'owned-file',
  fileSizeBytes: 4, uploadUrl: 'https://storage.example.com/file?signature=1', ...extra });
function fixture(overrides = {}) {
  const core = createGeneratedJsCore();
  const state = { queue: null, lookups: 0, removes: 0, metadata: 0, live: true };
  const uploads = [], http = [], progress = [];
  const context = signal => ({ operationId: 'exclusive-host-lease', operation: 'UploadRecording', generation: '3', cancellationId: '4',
    requestId: '0', signal: signal ?? new AbortController().signal });
  const file = { localPath: 'owned-file', durableUnits: '4', handle: { id: 'registered-file', kind: 'file', scope: 'scope' } };
  const options = { core, files: { async metadata() { state.metadata++; return { localPath: file.localPath, durableUnits: file.durableUnits }; },
      async remove(handle) { assert.equal(handle, file.handle); state.removes++; } },
    persistence: { namespace: 'scope', async load() { return structuredClone(state.queue); }, async save(_key,value) { state.queue = structuredClone(value); } },
    lookup: async () => { state.lookups++; return file; },
    checkOwner() { if (!state.live) throw new Error('scope changed'); }, onProgress: value => progress.push(value),
    uploadFile: async (...args) => { uploads.push(args); args[2]('2', '4'); },
    fetch: async (url, input) => { http.push({ url, input }); return { status: 200, url, async text() { return '{}'; } }; }, ...overrides };
  return { host: new JsRecordingUploads(options), core, options, state, uploads, http, progress, file, context };
}

test('generated upload policy sends one owned file and exact completion body with joined progress', async () => {
  const f = fixture();
  try {
    await f.host.upload(request({ completeUrl: 'https://api.example.com/complete', uploadToken: 'up_exact', contentSha256: 'aa'.repeat(32) }), f.context());
    assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0][1], f.file.handle);
    assert.equal(f.uploads[0][0].method, 'PUT'); assert.equal(f.uploads[0][0].headers['Content-Type'], 'audio/opus');
    assert.equal(f.http.length, 1); assert.equal(f.http[0].input.redirect, 'error'); assert.equal(f.http[0].input.credentials, 'omit');
    assert.deepEqual(JSON.parse(f.http[0].input.body), { recording_id: 'rec_1', content_sha256: 'aa'.repeat(32) });
    assert.equal(f.http[0].input.headers.Authorization, 'Bearer up_exact');
    assert.deepEqual(f.progress.map(p => p.completedBytes), [0,2,4]);
    assert.ok(f.progress.every(p => p.taskId === 'base-id_attempt' && p.totalBytes === 4));
    f.uploads[0][2]('4', '4'); // Retired OS callback cannot emit after settlement.
    assert.equal(f.progress.length, 3);
  } finally { await f.host.close(); f.core.dispose(); }
});

test('relay POST uses octet stream and suppresses a separate completion request', async () => {
  const f = fixture();
  try {
    await f.host.upload(request({ relayUrl: 'https://api.example.com/relay', relayBearerToken: 'app-lease',
      completeUrl: 'https://api.example.com/complete', uploadToken: 'up_exact' }), f.context());
    assert.equal(f.uploads[0][0].method, 'POST');
    assert.equal(f.uploads[0][0].headers['Content-Type'], 'application/octet-stream');
    assert.equal(f.uploads[0][0].headers.Authorization, 'Bearer app-lease'); assert.equal(f.http.length, 0);
  } finally { await f.host.close(); f.core.dispose(); }
});

test('changed file size and foreign handles reject before HTTP or reading foreign metadata', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.host.upload(request({ fileSizeBytes: 5 }), f.context()));
    await assert.rejects(f.host.upload(request({ fileSizeBytes: NaN }), f.context()));
    assert.equal(f.uploads.length, 0); assert.equal(f.state.metadata, 0);
    f.file.handle.scope = 'foreign';
    await assert.rejects(f.host.upload(request(), f.context()));
    assert.equal(f.state.metadata, 0); assert.equal(f.uploads.length, 0);
  } finally { await f.host.close(); f.core.dispose(); }
});

test('queue persistence strips credentials and release requires exact completed durable metadata', async () => {
  const f = fixture();
  try {
    await f.host.saveQueue(JSON.stringify([{ ...task('pending'), uploadUrl: 'signed-url', uploadToken: 'secret', relay: { bearerToken: 'secret' } }]), f.context());
    const saved = JSON.parse(await f.host.loadQueue(f.context()))[0];
    assert.equal(saved.uploadUrl, undefined); assert.equal(saved.uploadToken, undefined); assert.equal(saved.relay, undefined); assert.equal(saved.relayUpload, true);
    await assert.rejects(f.host.release('base-id', 'owned-file', f.context()));
    assert.equal(f.state.lookups, 0); assert.equal(f.state.removes, 0);
    await f.host.saveQueue(JSON.stringify([task()]), f.context());
    await assert.rejects(f.host.release('other-id', 'owned-file', f.context()));
    await f.host.release('base-id', 'owned-file', f.context()); assert.equal(f.state.removes, 1);
  } finally { await f.host.close(); f.core.dispose(); }
});

test('uncertain journal replacement blocks deletion until a later durable save succeeds', async () => {
  const f = fixture();
  f.options.persistence.load = async () => null;
  try {
    await assert.rejects(f.host.saveQueue(JSON.stringify([task()]), f.context()), error => error.code === 'upload_journal_commit_mismatch');
    f.options.persistence.load = async () => structuredClone(f.state.queue);
    await assert.rejects(f.host.release('base-id', 'owned-file', f.context()));
    assert.equal(f.state.lookups, 0); assert.equal(f.state.removes, 0);
    await f.host.saveQueue(JSON.stringify([task()]), f.context());
    await f.host.release('base-id', 'owned-file', f.context()); assert.equal(f.state.removes, 1);
  } finally { await f.host.close(); f.core.dispose(); }
});

test('cancellation and disposal join an upload primitive that ignores abort', async () => {
  const held = deferred(), started = deferred();
  let signal;
  const f = fixture({ uploadFile: async (_target,_file,_progress,context) => { signal = context.signal; started.resolve(); await held.promise; } });
  try {
    const work = f.host.upload(request(), f.context()); void work.catch(() => {});
    await started.promise;
    let cancelled = false;
    const cancel = f.host.cancel('base-id_attempt').then(() => { cancelled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, false); assert.equal(signal.aborted, true);
    held.resolve(); await cancel;
    await assert.rejects(work, error => error.code === 'operation_cancelled');
    assert.deepEqual(f.progress.map(p => p.completedBytes), [0]);
    await assert.rejects(f.host.upload(request(), f.context()), error => error.code === 'operation_cancelled');
  } finally { await f.host.close(); f.core.dispose(); }
});

test('only exact authenticated pending 425 parks completion; generic 425 remains a failure', async () => {
  for (const exact of [false,true]) {
    const f = fixture({ fetch: async url => ({ status: 425, url, async text() { return JSON.stringify({ error: { code: exact ? 'upload_verification_pending' : 'other' } }); } }) });
    try {
      await assert.rejects(f.host.upload(request({ completeUrl: 'https://api.example.com/complete', uploadToken: 'up_exact' }), f.context()), error => {
        assert.equal(error instanceof UploadVerificationPendingError, exact); assert.equal(error.status, 425);
        if (exact) assert.equal(error.completionPending, true); return true;
      });
      assert.ok(!f.progress.some(p => p.completedBytes === 4)); assert.equal(f.state.removes, 0);
    } finally { await f.host.close(); f.core.dispose(); }
  }
});

test('restart lookup resolves the original durable task and rejects mismatched recording/device identities', () => {
  const f = fixture();
  try {
    const value = f.core.codec('recordingFileLookupAdmission', { tasks: [task('pending')], taskId: 'base-id_attempt', localPath: 'owned-file',
      recordingId: 'rec_1', deviceId: 'dev_1' });
    assert.equal(value.logicalId, 'recording/base-id');
    assert.throws(() => f.core.codec('recordingFileLookupAdmission', { tasks: [task('pending')], taskId: 'base-id_attempt', localPath: 'owned-file',
      recordingId: 'rec_other', deviceId: 'dev_1' }));
  } finally { void f.host.close(); f.core.dispose(); }
});

test('a held upload source rejects a second owner, mutations and deletion until ignored abort settles', async () => {
  const held = deferred(), started = deferred();
  const f = fixture({ uploadFile: async () => { started.resolve(); await held.promise; } });
  try {
    const work = f.host.upload(request(), f.context()); void work.catch(() => {});
    await started.promise;
    await assert.rejects(f.host.upload(request({ taskId: 'second-attempt' }), f.context()), error => error.code === 'operation_in_progress');
    assert.throws(() => f.host.assertWritable({ ...f.file.handle }), error => error.code === 'operation_in_progress');
    assert.throws(() => f.host.acquireWritable(f.file.handle), error => error.code === 'operation_in_progress');
    await f.host.saveQueue(JSON.stringify([task()]), f.context());
    await assert.rejects(f.host.release('base-id', 'owned-file', f.context()), error => error.code === 'operation_in_progress');
    const cancelled = f.host.cancel('base-id_attempt');
    assert.throws(() => f.host.assertWritable(f.file.handle), error => error.code === 'operation_in_progress');
    held.resolve(); await cancelled;
    await assert.rejects(work, error => error.code === 'operation_cancelled');
    f.host.assertWritable(f.file.handle);
    await f.host.release('base-id', 'owned-file', f.context());
    assert.equal(f.state.removes, 1);
  } finally { held.resolve(); await f.host.close(); f.core.dispose(); }
});

test('an already dispatched file writer blocks upload admission until its physical IO releases', async () => {
  const f = fixture();
  const release = f.host.acquireWritable(f.file.handle);
  try {
    await assert.rejects(f.host.upload(request(), f.context()), error => error.code === 'operation_in_progress');
    assert.equal(f.state.metadata, 0); assert.equal(f.uploads.length, 0);
    release(); release();
    await f.host.upload(request(), f.context()); assert.equal(f.uploads.length, 1);
  } finally { release(); await f.host.close(); f.core.dispose(); }
});
