import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';
const { createGeneratedJsCore } = loadSource('core.ts');
const { NativeUploadQueue, setCompatibilityUploadPolicy } = loadSource('../managers/NativeUploadQueue.ts');
const { UploadVerificationPendingError } = loadSource('../managers/uploadVerificationPending.ts');
const { createUploadRecoveryProvider } = loadSource('../uploadRecovery.ts');

test('generated queue policy parks exact pending without repair retries and skips another PUT', async () => {
  const core = createGeneratedJsCore();
  const calls = [];
  const client = { async loadUploadQueue() { return []; }, async saveUploadQueue() {},
    async uploadRecordingFile() { calls.push('put'); throw new UploadVerificationPendingError(); },
    async releaseRecordingFile() { calls.push('release'); }, async cancelRecordingUpload() {}, async destroyCompatibilityOperations() {} };
  setCompatibilityUploadPolicy(client, (name,input) => core.codec(name,input));
  let attempts = 0;
  const provider = async context => ({ recordingId: context.recordingId, uploadUrl: 'https://storage.example.com/file',
    completeUrl: 'https://api.example.com/complete', uploadToken: 'up_exact',
    ...(attempts++ === 0 ? {} : { complete: async () => { calls.push('commit'); } }) });
  const queue = new NativeUploadQueue(client, provider);
  try {
    await queue.initialize();
    await queue.add({ id: 'task', recordingId: 'rec_1', deviceId: 'dev_1', recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
      localPath: 'owned-file', fileSizeBytes: 4, uploadUrl: '', status: 'pending', retryCount: 0, createdAt: new Date(), updatedAt: new Date() },
      { recordingId: 'rec_1', uploadUrl: '' });
    await assert.rejects(queue.run('task'), UploadVerificationPendingError);
    assert.equal(queue.get('task').completionPending, true); assert.equal(queue.get('task').retryCount, 0);
    await queue.run('task');
    assert.equal(queue.get('task').status, 'completed'); assert.deepEqual(calls, ['put','commit','release']);
  } finally { queue.destroy(); setCompatibilityUploadPolicy(client); core.dispose(); }
});

test('generated retry and scheduler enforce finite lifetime, concurrency and no fallback on parked source', () => {
  const core = createGeneratedJsCore();
  try {
    const failed = core.codec('planCompatibilityUploadQueueFailure', { nowMs: 86_400_001, createdAtMs: 0, retryCount: 1,
      hasProvider: true, credentialUnavailable: false, aborted: false, verificationPending: false, completionPending: null });
    assert.equal(failed.status, 'failed'); assert.equal(failed.retryCount, 2); assert.equal(failed.nextAttemptAt, null);
    const parked = core.codec('planCompatibilityUploadQueueFailure', { nowMs: 86_400_001, createdAtMs: 0, retryCount: 1,
      hasProvider: true, credentialUnavailable: true, aborted: false, verificationPending: false, completionPending: true });
    assert.equal(parked.status, 'pending'); assert.equal(parked.retryCount, 1); assert.equal(parked.completionPending, true);
    const skipped = core.codec('planCompatibilityUploadQueueSchedule', { status: 'pending', localPath: 'owned', active: false,
      cancelled: false, hasProvider: true, hasCredentials: false, activeCount: 2, nextAttemptAt: null, nowMs: 0 });
    assert.equal(skipped.action, 'skip');
  } finally { core.dispose(); }
});

test('generated completion polling recognizes exact 425 and preserves its two-minute budget', async () => {
  const core = createGeneratedJsCore();
  const oldNow = Date.now;
  let current = oldNow();
  Date.now = () => current;
  let requests = 0;
  const lifetime = new AbortController();
  const backend = { scopeKey: 'scope', signal: lifetime.signal, checkScope() {}, dispose() {},
    async getRecording() { return { id: 'rec_1', status: 'pending', file_size_bytes: 4 }; },
    async getUploadInfo() { return { uploadUrl: 'https://storage.example.com/file' }; },
    async completeRecording() { requests++; current += 120_001; throw { status: 425, data: { error: { code: 'upload_verification_pending' } } }; } };
  try {
    const provider = createUploadRecoveryProvider(async () => backend, (name,input) => core.codec(name,input));
    const taskSignal = new AbortController();
    const info = await provider({ taskId: 'task', recordingId: 'rec_1', deviceId: 'dev_1', recordingUuid: 'uuid',
      recoveryScope: 'scope', fileSizeBytes: 4, relayUpload: false, signal: taskSignal.signal });
    await assert.rejects(info.complete({ fileSizeBytes: 4, signal: taskSignal.signal }), UploadVerificationPendingError);
    assert.equal(requests, 1);
    const nonPending = core.codec('planUploadCompletionPoll', { stage: 'response', elapsedMs: 1, poll: 0,
      randomFraction: 0.5, status: 425, code: 'other' });
    assert.equal(nonPending.verificationPending, false); assert.equal(nonPending.waitMs, null);
  } finally { Date.now = oldNow; core.dispose(); }
});

test('firmware recovery metadata comes from the canonical shared core timeout', () => {
  const core = createGeneratedJsCore();
  try { assert.equal(core.codec('protocolMetadata', {}).firmwareRecoveryTimeoutMs, 120000); }
  finally { core.dispose(); }
});

test('generated credential policy refreshes an expired lease and fences a foreign recovered identity before PUT', async () => {
  const core = createGeneratedJsCore();
  try {
    for (const foreign of [false,true]) {
      const calls = [];
      const client = { async loadUploadQueue() { return []; }, async saveUploadQueue() {},
        async uploadRecordingFile(value) { calls.push(value.uploadUrl); }, async releaseRecordingFile() { calls.push('release'); },
        async cancelRecordingUpload() {}, async destroyCompatibilityOperations() {} };
      setCompatibilityUploadPolicy(client, (name,input) => core.codec(name,input));
      const provider = async context => { calls.push('refresh'); return { recordingId: foreign ? 'rec_other' : context.recordingId,
        recoveryScope: context.recoveryScope, uploadUrl: 'https://storage.example.com/fresh', expiresAt: new Date(Date.now() + 60000),
        complete: async () => { calls.push('commit'); } }; };
      const queue = new NativeUploadQueue(client, provider);
      try {
        await queue.initialize();
        await queue.add({ id: 'task', recordingId: 'rec_1', deviceId: 'dev_1', recordingUuid: 'uuid', recoveryScope: 'scope',
          localPath: 'owned', fileSizeBytes: 4, uploadUrl: '', status: 'pending', retryCount: 0, createdAt: new Date(), updatedAt: new Date() },
          { recordingId: 'rec_1', recoveryScope: 'scope', uploadUrl: 'https://storage.example.com/expired', expiresAt: new Date(0) });
        if (foreign) { await assert.rejects(queue.run('task')); assert.deepEqual(calls, ['refresh']); }
        else { await queue.run('task'); assert.deepEqual(calls, ['refresh','https://storage.example.com/fresh','commit','release']); }
      } finally { queue.destroy(); setCompatibilityUploadPolicy(client); }
    }
  } finally { core.dispose(); }
});

test('generated recording recovery rejects malformed or changed evidence and derives completion route and duration', async () => {
  const core = createGeneratedJsCore();
  const lifetime = new AbortController();
  const response = { id: 'rec_1', status: 'pending', file_size_bytes: '4', content_sha256: 'hash',
    metadata: { started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:02.500Z' } };
  let targets = 0, completion;
  const backend = { scopeKey: 'scope', signal: lifetime.signal, checkScope() {}, dispose() {},
    async getRecording() { return structuredClone(response); },
    async getUploadInfo() { targets++; return { uploadUrl: 'https://storage.example.com/file' }; },
    async completeRecording(_id,data) { completion = data; } };
  const task = { taskId: 'task', recordingId: 'rec_1', deviceId: 'dev_1', recordingUuid: 'uuid', recoveryScope: 'scope',
    fileSizeBytes: 4, contentSha256: 'hash', relayUpload: false, completionPending: true, signal: new AbortController().signal };
  try {
    const provider = createUploadRecoveryProvider(async () => backend, (name,input) => core.codec(name,input));
    const info = await provider(task);
    assert.equal(info.alreadyUploaded, true); assert.equal(info.reuploadRequired, false); assert.equal(targets, 0);
    await info.complete({ fileSizeBytes: 4, contentSha256: 'hash', signal: task.signal });
    assert.deepEqual(completion, { duration_seconds: 2, file_size_bytes: 4, content_sha256: 'hash' });
    for (const wire of ['04',false,'5','9007199254740992']) {
      response.file_size_bytes = wire;
      await assert.rejects(provider(task)); assert.equal(targets, 0);
    }
    response.file_size_bytes = '4'; response.status = 'deleted'; await assert.rejects(provider(task));
    response.status = 'integrity_failure';
    const repair = await provider(task); assert.equal(repair.alreadyUploaded, false); assert.equal(repair.reuploadRequired, true); assert.equal(targets, 1);
  } finally { core.dispose(); }
});
