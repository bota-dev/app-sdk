import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createUploadRecoveryProvider } = require('../lib/commonjs/uploadRecovery.js');

function fixture() {
  const calls = []; const controller = new AbortController();
  const task = { recordingId: 'rec_1', recoveryScope: 'account/project', relayUpload: false, fileSizeBytes: 4, signal: controller.signal };
  const scope = { scopeKey: task.recoveryScope, signal: controller.signal,
    checkScope() { if (controller.signal.aborted) throw new Error('scope changed'); },
    dispose() { calls.push('dispose'); },
    async getRecording() { return { id: task.recordingId, status: 'uploaded', file_size_bytes: 4 }; },
    async getUploadInfo() { calls.push('target'); return { uploadUrl: 'https://example.test' }; },
    async completeRecording(id, data) { calls.push(['complete', id, data]); },
  };
  return { calls, controller, task, scope, provider: createUploadRecoveryProvider(async () => scope) };
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
