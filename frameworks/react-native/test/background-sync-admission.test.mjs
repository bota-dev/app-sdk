import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createBotaClient } = loadSource('../BotaClient.ts');
const canonical = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const device = { id: 'ble-one', serialNumber: 'SERIAL', connectionState: 'connected' };
const recording = { uuid: '00112233-4455-6677-8899-aabbccddeeff', startedAt: new Date(0), durationMs: 1000, fileSizeBytes: 4, codec: 'opus_16k' };
const task = (status = 'pending') => ({ id: '11111111-1111-4111-8111-111111111111', recordingId: 'rec_one',
  deviceId: device.id, recordingUuid: recording.uuid, recoveryScope: 'account/project/production',
  localPath: '/owned/recording', uploadUrl: '', status, retryCount: 5, nextAttemptAt: 1,
  createdAt: new Date(0), updatedAt: new Date(0), fileSizeBytes: 4, relayUpload: false });
const uploadInfo = { recordingId: 'rec_one', recoveryScope: 'account/project/production',
  uploadUrl: 'https://upload.example/file', complete: async () => {} };

function fixture(rows) {
  const f = { persisted: canonical(rows), saves: [], providerCalls: 0, uploads: 0, releases: 0, confirms: 0, configured: false };
  const adapter = { devices: {}, ota: { async cancelFirmwareUpdate() {} },
    async configure() { f.configured = true; }, async getState() { return 'ready'; },
    async getCapabilities() { return { bluetooth: true }; }, async destroy() {},
    recordings: {
      async loadUploadQueue() { return structuredClone(f.persisted); },
      async saveUploadQueue(rows) { f.persisted = canonical(rows); f.saves.push(structuredClone(f.persisted)); },
      async uploadRecordingFile() { f.uploads++; }, async releaseRecordingFile() { f.releases++; },
      async confirmRecording() { f.confirms++; }, async cancelRecordingUpload() {}, async destroyCompatibilityOperations() {},
    },
  };
  f.client = createBotaClient(adapter);
  f.provider = async () => { f.providerCalls++; return { ...uploadInfo }; };
  return f;
}

test('public configure false restores a due queue without automatic recovery before or after timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const f = fixture([task()]), initial = structuredClone(f.persisted);
  try {
    await f.client.configure({ backgroundSyncEnabled: false, uploadRecoveryProvider: f.provider });
    await turn();
    assert.equal(f.providerCalls, 0); assert.equal(f.uploads, 0); assert.equal(f.releases, 0);
    t.mock.timers.tick(28 * 60 * 60 * 1000); await turn();
    assert.equal(f.providerCalls, 0); assert.equal(f.uploads, 0); assert.equal(f.releases, 0);
    assert.deepEqual(f.persisted, initial); assert.deepEqual(f.saves, [initial], 'canonical restore remains durable');
    assert.equal(f.client.isInitialized, true);
  } finally { await f.client.destroy(); }
});

test('public configure false retains completed-file cleanup until an explicit operation', async () => {
  const f = fixture([task('completed')]), initial = structuredClone(f.persisted);
  try {
    await f.client.configure({ backgroundSyncEnabled: false, uploadRecoveryProvider: f.provider }); await turn();
    assert.equal(f.releases, 0); assert.equal(f.providerCalls, 0); assert.deepEqual(f.persisted, initial);
    await f.client.recordings.clearCompletedUploads();
    assert.equal(f.releases, 1); assert.deepEqual(f.persisted, []);
  } finally { await f.client.destroy(); }
});

test('public configure false preserves explicit retained sync and its exact confirmation', async () => {
  const f = fixture([task()]);
  try {
    await f.client.configure({ backgroundSyncEnabled: false, uploadRecoveryProvider: f.provider }); await turn();
    const progress = [];
    for await (const value of f.client.recordings.syncRecording(device, recording, { ...uploadInfo })) progress.push(value);
    assert.equal(f.providerCalls, 0); assert.equal(f.uploads, 1); assert.equal(f.releases, 1); assert.equal(f.confirms, 1);
    assert.equal(progress.at(-1).stage, 'completed'); assert.equal(f.persisted[0].status, 'completed');
  } finally { await f.client.destroy(); }
});

test('default and explicit true retain automatic recovery and completed-file release', async () => {
  for (const backgroundSyncEnabled of [undefined, true]) {
    const completed = { ...task('completed'), id: '22222222-2222-4222-8222-222222222222' };
    const f = fixture([task(), completed]);
    try {
      await f.client.configure({ ...(backgroundSyncEnabled === undefined ? {} : { backgroundSyncEnabled }), uploadRecoveryProvider: f.provider });
      for (let count = 0; count < 20 && f.releases < 2; count++) await turn();
      assert.equal(f.providerCalls, 1); assert.equal(f.uploads, 1); assert.equal(f.releases, 2);
      assert.equal(f.persisted[0].status, 'completed');
    } finally { await f.client.destroy(); }
  }
});
