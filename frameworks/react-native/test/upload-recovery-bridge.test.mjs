import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createBotaDeviceSDK } = require('../lib/commonjs/client.js');

test('completed file release delegates exact task and path to the native journal owner', async () => {
  const calls = [];
  const client = createBotaDeviceSDK({
    releaseRecordingFile: async (id, path) => { calls.push([id, path]); },
  });
  assert.equal(typeof client.recordings.releaseRecordingFile, 'function');
  await client.recordings.releaseRecordingFile('task-1', '/native/recording.ogg');
  assert.deepEqual(calls, [['task-1', '/native/recording.ogg']]);
});

test('upload bridge sends the recorded file size to native validation', async () => {
  let request;
  const client = createBotaDeviceSDK({
    onRecordingUploadProgress: () => ({ remove() {} }),
    uploadRecordingFile: async value => { request = value; },
  });
  await client.recordings.uploadRecordingFile({
    id: 'task-1', recordingId: 'rec_test', deviceId: 'device-1',
    localPath: '/native/recording.recording', uploadUrl: 'https://example.test/upload',
    fileSizeBytes: 48036,
  });
  assert.equal(request.fileSizeBytes, 48036);
});

test('a non-array recovery journal is rejected before it can become an empty queue', async () => {
  const client = createBotaDeviceSDK({ loadCompatibilityUploadQueue: async () => '{"invalid":true}' });
  await assert.rejects(client.recordings.loadUploadQueue(), /journal/i);
});

test('empty journals and coerced timestamp primitives fail before date normalization', async () => {
  for (const value of ['', '[null]', '[{"createdAt":null,"updatedAt":0}]']) {
    const client = createBotaDeviceSDK({ loadCompatibilityUploadQueue: async () => value });
    await assert.rejects(client.recordings.loadUploadQueue());
  }
});
