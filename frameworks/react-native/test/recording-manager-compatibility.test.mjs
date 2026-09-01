import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { RecordingManager } = require(
  '../lib/commonjs/managers/RecordingManager.js'
);
const { setCompatibilityClientForTesting } = require(
  '../lib/commonjs/compatibility/runtime.js'
);

afterEach(() => setCompatibilityClientForTesting(null));

test('RecordingManager transfers, uploads, and emits the frozen stage order', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  const events = [];
  manager.on('syncStarted', (uuid) => events.push(['started', uuid]));
  manager.on('uploadProgress', (taskId, progress) => {
    events.push(['uploadProgress', taskId, progress]);
  });
  manager.on('uploadCompleted', (taskId, recordingId) => {
    events.push(['uploadCompleted', taskId, recordingId]);
  });
  manager.on('syncCompleted', (uuid, recordingId) => {
    events.push(['completed', uuid, recordingId]);
  });

  await manager.initialize();
  const progress = [];
  for await (const value of manager.syncRecording(
    connectedDevice,
    encryptedRecording,
    uploadInfo
  )) {
    progress.push(value);
  }

  assert.deepEqual(progress.map((value) => value.stage), [
    'preparing',
    'transferring',
    'transferring',
    'uploading',
    'uploading',
    'uploading',
    'completing',
    'completed',
  ]);
  assert.deepEqual(fake.calls.slice(0, 2), [
    ['loadUploadQueue'],
    ['saveUploadQueue', 1],
  ]);
  const uploadCall = fake.calls.find((call) => call[0] === 'uploadRecordingFile');
  assert.equal(typeof uploadCall[1], 'string');
  assert.deepEqual(uploadCall.slice(2), [
    '/native/recording.bin',
    uploadInfo.relay.url,
  ]);
  const confirmCall = fake.calls.find((call) => call[0] === 'confirmRecording');
  assert.deepEqual(confirmCall, ['confirmRecording', encryptedRecording.uuid]);
  assert.ok(fake.calls.indexOf(uploadCall) < fake.calls.indexOf(confirmCall));
  assert.equal(manager.getAllUploads()[0].contentSha256, '5a'.repeat(32));
  assert.equal(manager.getPendingUploads().length, 0);
  assert.equal(manager.getAllUploads()[0].status, 'completed');
  assert.deepEqual(events.at(-1), [
    'completed',
    encryptedRecording.uuid,
    uploadInfo.recordingId,
  ]);
});

test('RecordingManager selects relay from native transfer metadata, not list flags', async () => {
  const fake = createFakeClient();
  fake.transferResult = {
    localPath: '/native/plaintext.ogg',
    e2eEncrypted: false,
  };
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();

  for await (const _ of manager.syncRecording(
    connectedDevice,
    encryptedRecording,
    uploadInfo
  )) {
    // Drain the compatibility generator.
  }

  const uploadCall = fake.calls.find((call) => call[0] === 'uploadRecordingFile');
  assert.deepEqual(uploadCall.slice(2), [
    '/native/plaintext.ogg',
    uploadInfo.uploadUrl,
  ]);
});

test('RecordingManager preserves failed uploads for explicit retry', async () => {
  const fake = createFakeClient();
  fake.uploadError = new Error('network unavailable');
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();

  const progress = [];
  await assert.rejects(async () => {
    for await (const value of manager.syncRecording(
      connectedDevice,
      encryptedRecording,
      uploadInfo
    )) {
      progress.push(value);
    }
  }, /network unavailable/);

  assert.equal(progress.at(-1).stage, 'failed');
  assert.equal(manager.getAllUploads()[0].status, 'failed');
  assert.equal(fake.calls.some((call) => call[0] === 'confirmRecording'), false);
  fake.uploadError = null;
  await manager.retryFailedUploads();
  assert.equal(manager.getAllUploads()[0].status, 'completed');
});

test('RecordingManager keeps a successful upload completed when device confirm fails', async () => {
  const fake = createFakeClient();
  fake.confirmError = new Error('device disconnected before confirm');
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();

  await assert.rejects(async () => {
    for await (const _ of manager.syncRecording(
      connectedDevice,
      encryptedRecording,
      uploadInfo
    )) {
      // Drain the compatibility generator.
    }
  }, /device disconnected before confirm/);

  assert.equal(manager.getAllUploads()[0].status, 'completed');
  await manager.retryFailedUploads();
  assert.equal(
    fake.calls.filter((call) => call[0] === 'uploadRecordingFile').length,
    1
  );
});

test('RecordingManager obeys native direct-upload ownership before BLE fallback', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return uploadInfo;
  };

  fake.ownershipResult = {
    kind: 'device_upload_preserved',
    uploadId: 'ownership-probe',
  };
  const preserved = [];
  for await (const value of manager.syncAllRecordings(connectedDevice, provider)) {
    preserved.push(value);
  }
  assert.equal(providerCalls, 0);
  assert.deepEqual(preserved.map((value) => value.stage), ['device_uploading']);

  fake.ownershipResult = {
    kind: 'bluetooth_fallback',
    recordingUuid: encryptedRecording.uuid,
    uploadId: 'ownership-probe',
    destinationId: 'ownership-probe',
  };
  const fallback = [];
  for await (const value of manager.syncAllRecordings(connectedDevice, provider)) {
    fallback.push(value);
  }
  assert.equal(providerCalls, 1);
  assert.equal(fallback.at(-1).stage, 'completed');
});

test('RecordingManager queue controls and destroy cancel native ownership once', async () => {
  const fake = createFakeClient();
  fake.persistedTasks = [failedTask];
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();

  manager.pauseUploads();
  manager.resumeUploads();
  await manager.cancelUpload(failedTask.id);
  await manager.clearCompletedUploads();
  await manager.clearAllUploads();
  manager.destroy();
  manager.destroy();

  assert.deepEqual(fake.calls.filter((call) => call[0] === 'cancelRecordingUpload'), [
    ['cancelRecordingUpload', failedTask.id],
  ]);
  assert.equal(fake.destroyRecordingOperations, 1);
});

const connectedDevice = {
  id: 'device-1',
  serialNumber: 'EVFXXW67KP',
  deviceType: 'bota_note',
  firmwareVersion: '1.0.17',
  isProvisioned: true,
  connectionState: 'connected',
  mtu: 247,
};

const encryptedRecording = {
  uuid: '00112233-4455-6677-8899-aabbccddeeff',
  startedAt: new Date(1_000),
  durationMs: 30_000,
  fileSizeBytes: 100,
  codec: 'opus_16k',
  isEncrypted: true,
};

const uploadInfo = {
  uploadUrl: 'https://s3.example/upload',
  recordingId: 'rec_example',
  uploadToken: 'up_example',
  completeUrl: 'https://api.example/complete',
  contentType: 'audio/ogg',
  relay: {
    url: 'https://api.example/upload-relay',
    bearerToken: 'dtok_example',
  },
};

const failedTask = {
  id: 'task_failed',
  recordingId: 'rec_failed',
  deviceId: connectedDevice.id,
  localPath: '/native/failed.bin',
  uploadUrl: 'https://s3.example/failed',
  status: 'failed',
  retryCount: 1,
  errorMessage: 'offline',
  createdAt: new Date(1_000),
  updatedAt: new Date(2_000),
};

function createFakeClient() {
  const fake = {
    calls: [],
    persistedTasks: [],
    uploadError: null,
    confirmError: null,
    transferResult: {
      localPath: '/native/recording.bin',
      e2eEncrypted: true,
      contentSha256: '5a'.repeat(32),
    },
    ownershipResult: { kind: 'device_upload_completed' },
    destroyRecordingOperations: 0,
  };
  fake.client = {
    devices: {
      async readStatus() {
        return {
          storageTotalMb: 1024,
          storageUsedMb: 128,
        };
      },
    },
    recordings: {
      async loadUploadQueue() {
        fake.calls.push(['loadUploadQueue']);
        return fake.persistedTasks;
      },
      async saveUploadQueue(tasks) {
        fake.persistedTasks = structuredClone(tasks);
        fake.calls.push(['saveUploadQueue', tasks.length]);
      },
      async listRecordings() {
        return [encryptedRecording];
      },
      async syncRecording(_device, _recording, onProgress) {
        onProgress?.({ completedBytes: 50, totalBytes: 100 });
        onProgress?.({ completedBytes: 100, totalBytes: 100 });
        return fake.transferResult;
      },
      async uploadRecordingFile(task, onProgress) {
        fake.calls.push([
          'uploadRecordingFile',
          task.id,
          task.localPath,
          task.relay?.url ?? task.uploadUrl,
        ]);
        onProgress?.({ completedBytes: 25, totalBytes: 100 });
        if (fake.uploadError) throw fake.uploadError;
        onProgress?.({ completedBytes: 100, totalBytes: 100 });
      },
      async confirmRecording(_device, recordingUuid) {
        fake.calls.push(['confirmRecording', recordingUuid]);
        if (fake.confirmError) throw fake.confirmError;
      },
      async cancelRecordingUpload(taskId) {
        fake.calls.push(['cancelRecordingUpload', taskId]);
      },
      async observeUploadOwnership(_device, _request, onProgress) {
        onProgress?.({ completedBytes: 0, totalBytes: 1 });
        return fake.ownershipResult;
      },
      async destroyCompatibilityOperations() {
        fake.destroyRecordingOperations += 1;
      },
    },
  };
  return fake;
}
