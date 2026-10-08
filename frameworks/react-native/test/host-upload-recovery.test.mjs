import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createUploadRecoveryProvider } = require('../lib/commonjs/uploadRecovery.js');

function fixture() {
  const calls = []; const controller = new AbortController(); const leaseController = new AbortController();
  const task = { recordingId: 'rec_1', recoveryScope: 'account/project', relayUpload: false, fileSizeBytes: 4, signal: controller.signal };
  const scope = { scopeKey: task.recoveryScope, signal: leaseController.signal,
    checkScope() { if (controller.signal.aborted) throw new Error('scope changed'); },
    dispose() { calls.push('dispose'); },
    async getRecording() { return { id: task.recordingId, status: 'uploaded', file_size_bytes: 4 }; },
    async getUploadInfo() { calls.push('target'); return { uploadUrl: 'https://example.test' }; },
    async completeRecording(id, data) { calls.push(['complete', id, data]); },
  };
  return { calls, controller, leaseController, task, scope, provider: createUploadRecoveryProvider(async () => scope) };
}
test('uploaded recovery still supplies exact backend completion and releases scope only on disposal', async () => {
  const f = fixture(); const info = await f.provider(f.task);
  assert.equal(info.alreadyUploaded, true); assert.deepEqual(f.calls, []);
  await info.complete({ fileSizeBytes: 4, signal: f.task.signal });
  assert.deepEqual(f.calls[0], ['complete', 'rec_1', { duration_seconds: undefined, file_size_bytes: 4, content_sha256: undefined }]);
  info.dispose(); assert.equal(f.calls.at(-1), 'dispose');
});
test('foreign scope, conflicting bytes and cancelled completion cannot delete or acknowledge', async () => {
  const f = fixture(); f.scope.scopeKey = 'other'; assert.equal(await f.provider(f.task), null);
  assert.deepEqual(f.calls, ['dispose']);
  const conflict = fixture(); conflict.task.fileSizeBytes = 5;
  await assert.rejects(conflict.provider(conflict.task), /Upload recovery request failed/);
  assert.deepEqual(conflict.calls, ['dispose']);
  const cancelled = fixture(); const info = await cancelled.provider(cancelled.task); cancelled.controller.abort();
  await assert.rejects(info.complete({ fileSizeBytes: 4, signal: cancelled.task.signal }), /scope|cancel/i);
  assert.deepEqual(cancelled.calls, []); info.dispose();
});

test('wire file sizes accept safe integers, canonical decimal strings and optional absence', async () => {
  for (const [wire, expected] of [[4, 4], ['4', 4], [0, 0], ['0', 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [null, 4], [undefined, 4]]) {
    const f = fixture(); f.task.fileSizeBytes = expected;
    f.scope.getRecording = async () => ({ id: f.task.recordingId, status: 'uploaded', file_size_bytes: wire });
    const info = await f.provider(f.task);
    assert.equal(info.alreadyUploaded, true); assert.deepEqual(f.calls, []);
    await info.complete({ fileSizeBytes: expected, signal: f.task.signal });
    assert.equal(f.calls[0][2].file_size_bytes, expected);
    info.dispose();
  }
});

test('mismatched canonical decimal size fails before requesting target or completion', async () => {
  const f = fixture();
  f.scope.getRecording = async () => ({ id: f.task.recordingId, status: 'uploaded', file_size_bytes: '5' });
  await assert.rejects(f.provider(f.task), /Upload recovery request failed/);
  assert.deepEqual(f.calls, ['dispose']);
});

test('invalid wire size fails even without local comparison evidence', async () => {
  for (const wire of ['', '04', '-1', '+4', '1.5', '4e0', '0x4', ' 4 ', '9007199254740992',
    -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, true, {}]) {
    const f = fixture(); f.task.fileSizeBytes = undefined;
    f.scope.getRecording = async () => ({ id: f.task.recordingId, status: 'uploaded', file_size_bytes: wire });
    await assert.rejects(f.provider(f.task), /Upload recovery request failed/);
    assert.deepEqual(f.calls, ['dispose']);
  }
});

const verificationPending = () => Object.assign(new Error('verification pending'), {
  status: 425, data: { error: { code: 'upload_verification_pending' } },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('exact verification pending retries only completion with unchanged evidence until ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  f.scope.getRecording = async () => ({ id: f.task.recordingId, status: 'pending', file_size_bytes: 4 });
  let attempts = 0;
  f.scope.completeRecording = async (id, data, signal) => {
    f.calls.push(['complete', id, data, signal]);
    if (++attempts < 3) throw verificationPending();
  };
  const info = await f.provider(f.task);
  let acknowledged = false;
  const completion = info.complete({ fileSizeBytes: 4, contentSha256: 'a'.repeat(64), signal: f.task.signal }).then(() => { acknowledged = true; });
  await tick();
  assert.equal(attempts, 1); assert.equal(acknowledged, false);
  t.mock.timers.tick(2_000); await tick();
  assert.equal(attempts, 2); assert.equal(acknowledged, false);
  t.mock.timers.tick(2_000); await completion;
  assert.equal(attempts, 3); assert.equal(acknowledged, true);
  assert.equal(f.calls.filter(value => value === 'target').length, 1);
  const completions = f.calls.filter(Array.isArray);
  assert.ok(completions.every(value => value[1] === 'rec_1' && value[3] === f.task.signal));
  assert.ok(completions.every(value => JSON.stringify(value[2]) === JSON.stringify(completions[0][2])));
  assert.equal(getEventListeners(f.task.signal, 'abort').length, 0);
  assert.equal(getEventListeners(f.scope.signal, 'abort').length, 0);
  info.dispose();
});

for (const [name, error] of [
  ['unclassified 425', Object.assign(new Error('upload_verification_pending'), { status: 425 })],
  ['another 425', { status: 425, data: { error: { code: 'upload_recovery_pending' } } }],
  ['wrong status', { status: 409, data: { error: { code: 'upload_verification_pending' } } }],
  ['string status', { status: '425', data: { error: { code: 'upload_verification_pending' } } }],
  ['flat code', { status: 425, code: 'upload_verification_pending' }],
  ['permission failure', { status: 403 }],
  ['server failure', { status: 503 }],
]) {
  test(`completion does not poll ${name}`, async () => {
    const f = fixture(); let attempts = 0;
    f.scope.completeRecording = async () => { attempts++; throw error; };
    const info = await f.provider(f.task);
    await assert.rejects(info.complete({ fileSizeBytes: 4, signal: f.task.signal }), value => value === error);
    assert.equal(attempts, 1); info.dispose();
  });
}

for (const source of ['task', 'lease', 'attempt']) {
  test(`${source} cancellation promptly stops a pending completion timer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture(); const attempt = new AbortController(); let calls = 0;
    f.scope.completeRecording = async () => { calls++; throw verificationPending(); };
    const info = await f.provider(f.task);
    const rejected = assert.rejects(info.complete({ fileSizeBytes: 4, signal: attempt.signal }), /cancel|scope/i);
    await tick();
    ({ task: f.controller, lease: f.leaseController, attempt })[source].abort();
    await rejected;
    t.mock.timers.tick(120_000); await tick();
    assert.equal(calls, 1);
    for (const signal of [f.task.signal, f.scope.signal, attempt.signal]) {
      assert.equal(getEventListeners(signal, 'abort').length, 0);
    }
    info.dispose();
  });
}

test('account fence is checked before retry and after a late completion ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(); let changed = false; let calls = 0;
  f.scope.checkScope = () => { if (changed) throw new Error('scope changed'); };
  f.scope.completeRecording = async () => { calls++; throw verificationPending(); };
  const info = await f.provider(f.task);
  const rejected = assert.rejects(info.complete({ fileSizeBytes: 4, signal: f.task.signal }), /scope changed/);
  await tick(); changed = true; t.mock.timers.tick(2_000); await rejected;
  assert.equal(calls, 1); info.dispose();

  const late = fixture(); let resolve; let switched = false;
  late.scope.checkScope = () => { if (switched) throw new Error('scope changed'); };
  late.scope.completeRecording = () => new Promise(done => { resolve = done; });
  const lateInfo = await late.provider(late.task);
  const lateRejected = assert.rejects(lateInfo.complete({ fileSizeBytes: 4, signal: late.task.signal }), /scope changed/);
  switched = true; resolve(); await lateRejected; lateInfo.dispose();
});

test('verification polling has a two-minute budget and never treats expiry as ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(); let calls = 0;
  f.scope.completeRecording = async () => { calls++; throw verificationPending(); };
  const info = await f.provider(f.task);
  const rejected = assert.rejects(info.complete({ fileSizeBytes: 4, signal: f.task.signal }), /verification pending/i);
  await tick();
  for (let i = 0; i < 60; i++) { t.mock.timers.tick(2_000); await tick(); }
  await rejected;
  assert.ok(calls > 1 && calls <= 120);
  assert.equal(getEventListeners(f.task.signal, 'abort').length, 0);
  assert.equal(getEventListeners(f.scope.signal, 'abort').length, 0);
  info.dispose();
});
