import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { RecordingManager } = require('../lib/commonjs/managers/RecordingManager.js');
const { BotaClient } = require('../lib/commonjs/BotaClient.js');
const { setCompatibilityClientForTesting } = require('../lib/commonjs/compatibility/runtime.js');
const managers = [];
afterEach(() => { managers.splice(0).forEach(manager => manager.destroy()); setCompatibilityClientForTesting(null); });

const device = { id: 'device-1', serialNumber: 'SERIAL', connectionState: 'connected' };
const recording = { uuid: '00112233-4455-6677-8899-aabbccddeeff', startedAt: new Date(), durationMs: 1000, fileSizeBytes: 4, codec: 'opus_16k' };
const task = () => ({
  id: 'task-1', recordingId: 'rec_existing', deviceId: device.id, recordingUuid: recording.uuid,
  recoveryScope: 'account/project/production', localPath: '/native/recording.recording', fileSizeBytes: 4,
  uploadUrl: 'https://old.example/?secret', uploadToken: 'up_secret', completeUrl: 'https://old.example/secret',
  errorMessage: 'secret', relayUpload: false, status: 'uploading', retryCount: 0,
  createdAt: new Date(), updatedAt: new Date(),
});
const fresh = (extra = {}) => ({ recordingId: 'rec_existing', recoveryScope: 'account/project/production', uploadUrl: 'https://fresh.example', complete: async () => {}, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const drain = async generator => { for await (const _ of generator) {} };
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail('condition did not settle'); }
function fixture(persisted = [task()], provider) {
  const f = { persisted, saves: [], uploads: [], releases: [], confirms: [], cancels: [], transfers: 0, stops: 0 };
  f.client = { recordings: {
    async loadUploadQueue() { return structuredClone(f.persisted); },
    async saveUploadQueue(tasks) { if (f.saveError) throw f.saveError; f.persisted = structuredClone(tasks); f.saves.push(structuredClone(tasks)); },
    async uploadRecordingFile(value, progress) { f.uploads.push(value); f.progress = progress; if (f.uploadGate) await f.uploadGate.promise; if (f.uploadError) throw f.uploadError; },
    async releaseRecordingFile(id, path) { assert.equal(f.persisted.find(t => t.id === id)?.status, 'completed'); f.releases.push(path); },
    async confirmRecording(_device, uuid) { f.confirms.push(uuid); },
    async syncRecording() { f.transfers++; return { localPath: '/native/recording.recording', e2eEncrypted: false, fileSizeBytes: 4 }; },
    async cancelRecordingUpload(id) { f.cancels.push(id); },
    async destroyCompatibilityOperations() { f.stops++; if (f.stopGate) await f.stopGate.promise; },
  } };
  setCompatibilityClientForTesting(f.client);
  f.manager = new RecordingManager({ uploadRecoveryProvider: provider }); managers.push(f.manager);
  return f;
}

test('migrates interrupted tasks to metadata only and never reuses legacy credentials', async () => {
  const f = fixture(); await f.manager.initialize();
  assert.equal(f.manager.getAllUploads()[0].status, 'pending');
  assert.equal(f.manager.getAllUploads()[0].uploadUrl, '');
  assert.doesNotMatch(JSON.stringify(f.persisted), /old.example|up_secret|errorMessage/);
  assert.equal(f.uploads.length, 0);
});

test('fresh recovery stays on exact identity and retains the file until host completion', async () => {
  const ack = deferred(); const entered = deferred(); let context; let disposed = 0;
  const f = fixture([task()], async value => { context = value; return fresh({ complete: async value => { entered.resolve(value); await ack.promise; }, dispose: () => disposed++ }); });
  await f.manager.initialize();
  const completion = await entered.promise;
  assert.equal(completion.fileSizeBytes, 4); assert.ok(completion.signal instanceof AbortSignal);
  assert.equal(context.recordingId, 'rec_existing'); assert.equal(context.recoveryScope, 'account/project/production');
  assert.equal(f.releases.length, 0); assert.equal(f.manager.getAllUploads()[0].status, 'uploading');
  ack.resolve(); await until(() => disposed === 1);
  assert.equal(f.manager.getAllUploads()[0].status, 'completed'); assert.equal(f.releases.length, 1);
  assert.equal(f.confirms.length, 0);
  assert.doesNotMatch(JSON.stringify(f.persisted), /fresh.example|completeUrl|uploadToken|signal|dispose/);
});

test('alreadyUploaded skips PUT but waits for host completion before release or BLE confirm', async () => {
  const ack = deferred(); const entered = deferred();
  const f = fixture([task()], async () => fresh({ alreadyUploaded: true, uploadUrl: '', complete: async () => { entered.resolve(); await ack.promise; } }));
  await f.manager.initialize(); await entered.promise;
  const foreground = drain(f.manager.syncRecording(device, recording, fresh()));
  await tick(); assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0); assert.equal(f.confirms.length, 0);
  ack.resolve(); await foreground;
  assert.equal(f.uploads.length, 0); assert.equal(f.transfers, 0); assert.equal(f.confirms.length, 1);
});

for (const [label, changed] of [ ['recording', { recordingId: 'rec_other' }], ['scope', { recoveryScope: 'other-account' }], ['route', { relay: { url: 'https://relay', bearerToken: 'secret' } }] ]) {
  test(`rejects changed recovery ${label} without sending bytes`, async () => {
    let disposed = 0;
    const f = fixture([task()], async () => fresh({ ...changed, dispose: () => disposed++ }));
    await f.manager.initialize(); await until(() => disposed === 1);
    assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0);
    assert.notEqual(f.manager.getAllUploads()[0].status, 'completed');
  });
}

test('null provider parks without consuming retry budget and does not spin', async () => {
  let calls = 0; const f = fixture([task()], async () => { calls++; return null; });
  await f.manager.initialize(); await until(() => f.manager.getAllUploads()[0]?.nextAttemptAt);
  assert.equal(calls, 1); assert.equal(f.manager.getAllUploads()[0].retryCount, 0);
  assert.ok(f.manager.getAllUploads()[0].nextAttemptAt > Date.now());
});

test('destroy while provider is pending disposes late credentials and never sends bytes', async () => {
  const provider = deferred(); const entered = deferred(); let disposed = 0;
  const f = fixture([task()], async () => { entered.resolve(); return provider.promise; });
  await f.manager.initialize(); await entered.promise; f.manager.destroy();
  provider.resolve(fresh({ dispose: () => disposed++ })); await until(() => disposed === 1);
  assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0);
});

test('context cancellation during host completion rejects late ACK and stale progress', async () => {
  const ack = deferred(); const entered = deferred(); const identity = new AbortController(); let disposed = 0;
  const f = fixture([task()], async () => fresh({ signal: identity.signal, dispose: () => disposed++, complete: async () => { entered.resolve(); await ack.promise; } }));
  let completed = 0; let progress = 0;
  f.manager.on('uploadCompleted', () => completed++); f.manager.on('uploadProgress', () => progress++);
  await f.manager.initialize(); await entered.promise; identity.abort();
  ack.resolve(); await until(() => disposed === 1);
  f.progress?.({ completedBytes: 4, totalBytes: 4 });
  assert.equal(completed, 0); assert.equal(progress, 0); assert.equal(f.releases.length, 0);
  assert.equal(f.manager.getAllUploads()[0].retryCount, 0);
});

test('failed attempts persist sanitized backoff and refresh credentials on explicit retry', async () => {
  let calls = 0;
  const f = fixture([task()], async () => { calls++; return fresh({ uploadUrl: `https://fresh.example/${calls}` }); });
  f.uploadError = new Error('https://secret.example/token'); await f.manager.initialize();
  await until(() => f.manager.getAllUploads()[0].retryCount === 1);
  assert.ok(f.persisted[0].nextAttemptAt - Date.now() > 29000); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(f.persisted), /secret|fresh.example/);
  f.manager.pauseUploads(); f.uploadError = null;
  await f.manager.retryFailedUploads(); assert.equal(calls, 1);
  f.manager.resumeUploads(); await until(() => f.manager.getAllUploads()[0].status === 'completed');
  assert.equal(calls, 2); assert.notEqual(f.uploads[0].id, f.uploads[1].id);
});

test('malformed journal is rejected without overwrite', async () => {
  const f = fixture([{ id: 'broken' }]);
  await assert.rejects(f.manager.initialize(), /journal/i); assert.equal(f.saves.length, 0);
});

test('failed journal completion leaves file and never emits success', async () => {
  const entered = deferred(); const ack = deferred();
  const f = fixture([task()], async () => fresh({ complete: async () => { entered.resolve(); await ack.promise; } }));
  let completed = 0; f.manager.on('uploadCompleted', () => completed++);
  await f.manager.initialize(); await entered.promise; f.saveError = new Error('disk'); ack.resolve();
  await tick(); await tick(); assert.equal(f.releases.length, 0); assert.equal(completed, 0);
});

test('legacy JS byte callbacks fail explicitly before native configuration', async () => {
  let configured = false; const f = fixture([]);
  f.client.configure = async () => { configured = true; };
  const recordingDataStore = { saveRecordingData() {}, loadRecordingData() {}, deleteRecordingData() {} };
  assert.throws(() => new RecordingManager({ recordingDataStore }), /native|RecordingDataStore/);
  await assert.rejects(BotaClient.configure({ recordingDataStore }), /native|RecordingDataStore/);
  assert.equal(configured, false);
});

test('missing completion acknowledgement never releases an alreadyUploaded task', async () => {
  let disposed = 0;
  const f = fixture([task()], async () => fresh({ alreadyUploaded: true, complete: undefined, dispose: () => disposed++ }));
  await f.manager.initialize(); await until(() => disposed === 1);
  assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0);
  assert.notEqual(f.manager.getAllUploads()[0].status, 'completed');
});

test('persisted backoff survives a new manager and pause prevents scheduled attempts', async () => {
  const retained = { ...task(), status: 'pending', nextAttemptAt: Date.now() + 120000, retryCount: 2 };
  let calls = 0; const f = fixture([retained], async () => { calls++; return fresh(); });
  f.manager.pauseUploads(); await f.manager.initialize(); await tick();
  assert.equal(calls, 0); f.manager.resumeUploads(); await tick();
  assert.equal(calls, 0); assert.equal(f.manager.getAllUploads()[0].retryCount, 2);
  assert.equal(f.persisted[0].nextAttemptAt, retained.nextAttemptAt);
});

test('restart without a provider parks legacy credentials instead of retrying them', async () => {
  const f = fixture([{ ...task(), status: 'failed' }]); await f.manager.initialize();
  await f.manager.retryFailedUploads();
  assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0);
});

test('cancel during native upload rejects late success and progress for that attempt', async () => {
  let disposed = 0;
  const f = fixture([task()], async () => fresh({ dispose: () => disposed++ })); f.uploadGate = deferred();
  let completed = 0; let progress = 0;
  f.manager.on('uploadCompleted', () => completed++); f.manager.on('uploadProgress', () => progress++);
  await f.manager.initialize(); await until(() => f.uploads.length === 1);
  await f.manager.cancelUpload('task-1');
  assert.equal(f.cancels[0], f.uploads[0].id);
  f.progress({ completedBytes: 4, totalBytes: 4 }); f.uploadGate.resolve(); await until(() => disposed === 1);
  assert.equal(completed, 0); assert.equal(progress, 0); assert.equal(f.releases.length, 0);
});

test('failed transfer disposes the initial credential lease without waiting for destroy', async () => {
  let disposed = 0; const f = fixture([]); await f.manager.initialize();
  f.client.recordings.syncRecording = async () => { throw new Error('disconnected'); };
  await assert.rejects(drain(f.manager.syncRecording(device, recording, fresh({ dispose: () => disposed++ }))), /disconnected/);
  assert.equal(disposed, 1); assert.equal(f.uploads.length, 0);
});

test('native transfer byte length, not list estimate, reaches host completion', async () => {
  let size; const f = fixture([]); await f.manager.initialize();
  f.client.recordings.syncRecording = async () => ({ localPath: '/native/recording.recording', e2eEncrypted: false, fileSizeBytes: 11 });
  await drain(f.manager.syncRecording(device, recording, fresh({ complete: async value => { size = value.fileSizeBytes; } })));
  assert.equal(size, 11); assert.equal(f.uploads[0].fileSizeBytes, 11);
});

test('failed queue add rolls back without poisoning a concurrent successful sync', async () => {
  const f = fixture([]); await f.manager.initialize();
  let calls = 0; const save = f.client.recordings.saveUploadQueue;
  f.client.recordings.saveUploadQueue = async tasks => { if (++calls === 1) throw new Error('disk'); return save(tasks); };
  const one = drain(f.manager.syncRecording(device, recording, fresh()));
  const two = drain(f.manager.syncRecording(device, { ...recording, uuid: 'other' }, fresh({ recordingId: 'rec_other' })));
  await assert.rejects(one, /disk/); await two;
  assert.deepEqual(f.persisted.map(value => value.recordingId), ['rec_other']);
});

test('expired initial credentials refresh through the same scoped provider before upload', async () => {
  let disposed = 0; let recovered = 0;
  const f = fixture([], async context => { recovered++; assert.equal(context.recoveryScope, 'account/project/production'); return fresh(); });
  await f.manager.initialize();
  await drain(f.manager.syncRecording(device, recording, fresh({ uploadUrl: 'https://expired', expiresAt: new Date(0), dispose: () => disposed++ })));
  assert.equal(recovered, 1); assert.equal(disposed, 1);
  assert.equal(f.uploads[0].uploadUrl, 'https://fresh.example');
});

test('foreground supplies fresh credentials for retained bytes without a background provider', async () => {
  let disposed = 0;
  const f = fixture(); await f.manager.initialize();
  await drain(f.manager.syncRecording(device, recording, fresh({ dispose: () => disposed++ })));
  assert.equal(f.transfers, 0); assert.equal(f.uploads.length, 1); assert.equal(f.confirms.length, 1);
  assert.equal(disposed, 1);
});

test('two live managers cannot own the same client journal or duplicate recovery', async () => {
  let calls = 0; const provider = deferred();
  const f = fixture([task()], async () => { calls++; return provider.promise; });
  await f.manager.initialize(); await until(() => calls === 1);
  const second = new RecordingManager({ uploadRecoveryProvider: async () => { calls++; return fresh(); } }); managers.push(second);
  await assert.rejects(second.initialize(), /owned|owner/i);
  assert.equal(calls, 1); assert.equal(f.uploads.length, 0);
  provider.resolve(fresh()); await until(() => f.manager.getAllUploads()[0].status === 'completed');
  assert.equal(f.uploads.length, 1);
});

test('destroyed journal owner cannot overwrite its replacement after a late provider response', async () => {
  let oldDisposed = 0; const old = deferred(); const entered = deferred();
  const f = fixture([task()], async () => { entered.resolve(); return old.promise; });
  await f.manager.initialize(); await entered.promise; f.manager.destroy();
  const second = new RecordingManager({ uploadRecoveryProvider: async () => fresh() }); managers.push(second);
  await second.initialize(); await until(() => second.getAllUploads()[0].status === 'completed');
  old.resolve(fresh({ dispose: () => oldDisposed++ })); await until(() => oldDisposed === 1);
  assert.equal(f.uploads.length, 1); assert.equal(f.persisted[0].status, 'completed');
});

test('host completion never substitutes a list estimate for missing native file size', async () => {
  const f = fixture([]); await f.manager.initialize();
  f.client.recordings.syncRecording = async () => ({ localPath: '/native/recording.recording', e2eEncrypted: true });
  let completed = 0;
  await assert.rejects(drain(f.manager.syncRecording(device, recording, fresh({ relay: { url: 'https://relay', bearerToken: 'token' }, complete: async () => completed++ }))), /size/i);
  assert.equal(completed, 0); assert.equal(f.releases.length, 0); assert.equal(f.confirms.length, 0);
});

for (const mode of ['destroy', 'cancel', 'host-abort']) {
  test(`reentrant ${mode} from uploadStarted cannot send bytes`, async () => {
    let disposed = 0; const identity = new AbortController();
    const f = fixture([task()], async () => fresh({ signal: identity.signal, dispose: () => disposed++ }));
    f.manager.on('uploadStarted', id => {
      if (mode === 'destroy') f.manager.destroy();
      else if (mode === 'cancel') void f.manager.cancelUpload(id);
      else identity.abort();
    });
    await f.manager.initialize(); await until(() => disposed === 1);
    assert.equal(f.uploads.length, 0); assert.equal(f.releases.length, 0);
  });
}

test('rejected second owner cannot stop native operations of the live manager', async () => {
  const f = fixture([]); await f.manager.initialize();
  const second = new RecordingManager(); managers.push(second);
  await assert.rejects(second.initialize(), /owned|owner/i);
  second.destroy(); await tick(); assert.equal(f.stops, 0);
});

test('replacement journal owner waits for old native teardown before recovery', async () => {
  const f = fixture(); await f.manager.initialize(); f.stopGate = deferred();
  f.manager.destroy();
  const replacement = new RecordingManager({ uploadRecoveryProvider: async () => fresh() }); managers.push(replacement);
  const initialized = replacement.initialize(); await tick();
  assert.equal(f.uploads.length, 0); assert.equal(f.stops, 1);
  f.stopGate.resolve(); await initialized; await until(() => replacement.getAllUploads()[0].status === 'completed');
  assert.equal(f.uploads.length, 1);
});

test('clearCompleted removes only its released snapshot while another task completes', async () => {
  const first = { ...task(), status: 'completed' };
  const second = { ...task(), id: 'task-2', recordingId: 'rec_second', status: 'pending', nextAttemptAt: Date.now() + 60000 };
  const f = fixture([first, second], async context => fresh({ recordingId: context.recordingId }));
  await f.manager.initialize(); await tick();
  const releaseA = deferred(); const entered = deferred();
  f.client.recordings.releaseRecordingFile = async id => {
    if (id === first.id) { entered.resolve(); await releaseA.promise; }
    else throw new Error('unlink failed');
  };
  const clearing = f.manager.clearCompletedUploads(); await entered.promise;
  await f.manager.retryFailedUploads();
  assert.equal(f.manager.getAllUploads().find(task => task.id === second.id)?.status, 'completed');
  releaseA.resolve(); await clearing;
  assert.deepEqual(f.persisted.map(task => task.id), ['task-2']);
});

test('cleanup durability failure retains completed metadata until release retry succeeds', async () => {
  const f = fixture([{ ...task(), status: 'completed' }]);
  const failure = new Error('recording directory sync failed');
  let failCleanup = true;
  f.client.recordings.releaseRecordingFile = async () => { if (failCleanup) throw failure; };
  await f.manager.initialize(); await tick();
  const journal = structuredClone(f.persisted);
  await assert.rejects(f.manager.clearCompletedUploads(), error => error === failure);
  assert.deepEqual(f.persisted, journal);
  assert.equal(f.manager.getAllUploads()[0].status, 'completed');
  failCleanup = false;
  await f.manager.clearCompletedUploads();
  assert.deepEqual(f.persisted, []);
  assert.deepEqual(f.manager.getAllUploads(), []);
});
