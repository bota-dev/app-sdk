import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';
const { RecordingManager } = loadSource('../managers/RecordingManager.ts');
const { withCompatibilityClient } = loadSource('../compatibility/runtime.ts');

test('normal recording transfer uses the durable queue task UUID as its sink identity', async () => {
  let tasks = [], sinkId;
  const client = { recordings: {
    async loadUploadQueue() { return tasks; }, async saveUploadQueue(value) { tasks = structuredClone(value); },
    async syncRecording(_device, _recording, _progress, sink) {
      sinkId = sink;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, sink, 'restart must derive the same logical recording file from the durable task');
      return { localPath: 'owned-file', fileSizeBytes: 4, e2eEncrypted: false };
    },
    async uploadRecordingFile() {}, async confirmRecording() {}, async releaseRecordingFile() {},
    async cancelRecordingUpload() {}, async destroyCompatibilityOperations() {},
  } };
  const manager = withCompatibilityClient(client, () => new RecordingManager());
  try {
    await manager.initialize();
    for await (const _ of manager.syncRecording({ id: 'ble-selected', serialNumber: 'SERIAL' },
      { uuid: '11111111-0000-0000-0000-000000000000', fileSizeBytes: 4, startedAt: new Date(0), durationMs: 1000 },
      { recordingId: 'rec_existing', uploadUrl: 'https://storage.example.test/object' })) {}
    assert.match(sinkId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(tasks[0].id, sinkId); assert.equal(tasks[0].status, 'completed');
  } finally { manager.destroy(); }
});
