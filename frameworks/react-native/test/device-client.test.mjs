import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createBotaDeviceSDK } = require('../lib/commonjs/client.js');

const discovered = {
  id: 'peripheral-1',
  name: 'Bota Pin',
  deviceType: 'bota_pin',
  firmwareVersion: '1.0.11',
  macAddress: 'aabbccddeeff',
  pairingState: 'unpaired',
  rssi: -42,
  discoveredAtMs: 1_788_200_000_000,
};

const connected = {
  id: 'peripheral-1',
  serialNumber: 'EVFXXW67KP',
  deviceType: 'bota_pin',
  firmwareVersion: '1.0.11',
  isProvisioned: false,
  connectionState: 'connected',
  mtu: 247,
};

const status = {
  batteryLevel: 72,
  batteryMv: 3_842,
  storageTotalMb: 8_192,
  storageUsedMb: 512,
  state: 'idle',
  pendingRecordings: 2,
  lastTimeSyncAtMs: 1_788_200_000_000,
  signalStrength: 4,
  flags: {
    charging: false,
    lowBattery: false,
    storageFull: false,
    wifiConnected: true,
    lteConnected: false,
    syncActive: false,
  },
  timestamp: 1_788_200_000,
  lteStatus: 'off',
  lteSignalQuality: 99,
  wifiStatus: 'connected',
  modemInfo: {
    imei: '234108029872409',
    roaming: false,
  },
};

function nativeFixture() {
  const calls = [];
  let discoveryHandler = null;
  let statusHandler = null;
  let provisioningHandler = null;
  let factoryResetHandler = null;
  let recordingProgressHandler = null;
  let uploadOwnershipProgressHandler = null;
  let provisioningResolve = null;
  let provisioningReject = null;
  let factoryResetResolve = null;
  let factoryResetReject = null;
  let removed = false;
  return {
    calls,
    get removed() {
      return removed;
    },
    emitDiscovery(value) {
      discoveryHandler?.(value);
    },
    emitStatus(value) {
      statusHandler?.(value);
    },
    module: {
      async configure() {},
      async destroy() {},
      async getCapabilities() {
        return {};
      },
      async getState() {
        return 'ready';
      },
      onDeviceDiscovered(handler) {
        discoveryHandler = handler;
        return {
          remove() {
            removed = true;
            discoveryHandler = null;
          },
        };
      },
      onDeviceStatusUpdated(handler) {
        statusHandler = handler;
        return {
          remove() {
            statusHandler = null;
          },
        };
      },
      onProvisioningMaterialRequested(handler) {
        provisioningHandler = handler;
        return {
          remove() {
            provisioningHandler = null;
          },
        };
      },
      onFactoryResetGrantRequested(handler) {
        factoryResetHandler = handler;
        return {
          remove() {
            factoryResetHandler = null;
          },
        };
      },
      onRecordingTransferProgress(handler) {
        recordingProgressHandler = handler;
        return {
          remove() {
            recordingProgressHandler = null;
          },
        };
      },
      onUploadOwnershipProgress(handler) {
        uploadOwnershipProgressHandler = handler;
        return {
          remove() {
            uploadOwnershipProgressHandler = null;
          },
        };
      },
      async startScan(timeoutMs, allowDuplicates) {
        calls.push(['startScan', timeoutMs, allowDuplicates]);
      },
      async stopScan() {
        calls.push(['stopScan']);
      },
      async connectSelected(device) {
        calls.push(['connectSelected', device]);
        return connected;
      },
      async reconnect(serialNumber, options) {
        calls.push(['reconnect', serialNumber, options]);
        return { ...connected, serialNumber };
      },
      async disconnect() {
        calls.push(['disconnect']);
      },
      async readStatus() {
        calls.push(['readStatus']);
        return status;
      },
      async startStatusUpdates() {
        calls.push(['startStatusUpdates']);
      },
      async stopStatusUpdates() {
        calls.push(['stopStatusUpdates']);
      },
      async provision(device) {
        calls.push(['provision', device]);
        queueMicrotask(() => {
          provisioningHandler?.({
            requestId: 'material-request',
            serialNumber: device.serialNumber,
            nonce: '00112233',
            devicePublicKey: 'aabbccdd',
          });
        });
        return new Promise((resolve, reject) => {
          provisioningResolve = resolve;
          provisioningReject = reject;
        });
      },
      async resolveProvisioningMaterial(requestId, material) {
        calls.push(['resolveProvisioningMaterial', requestId, material]);
        provisioningResolve?.();
      },
      async rejectApplicationMaterial(requestId, message) {
        calls.push(['rejectApplicationMaterial', requestId, message]);
        if (requestId === 'factory-reset-request') {
          factoryResetReject?.(new Error(message));
        } else {
          provisioningReject?.(new Error(message));
        }
      },
      async deprovision(device) {
        calls.push(['deprovision', device]);
      },
      async factoryReset(device, commandId, bindingGeneration) {
        calls.push(['factoryReset', device, commandId, bindingGeneration]);
        queueMicrotask(() => {
          factoryResetHandler?.({
            requestId: 'factory-reset-request',
            serialNumber: device.serialNumber,
            nonce: '44556677',
            commandId,
            bindingGeneration,
          });
        });
        return new Promise((resolve, reject) => {
          factoryResetResolve = resolve;
          factoryResetReject = reject;
        });
      },
      async resolveFactoryResetGrant(requestId, grantBlob) {
        calls.push(['resolveFactoryResetGrant', requestId, grantBlob]);
        factoryResetResolve?.({
          commandId: 'reset-command-1',
          bindingGeneration: 9,
        });
      },
      async resumePendingFactoryReset(device, bindingGeneration) {
        calls.push(['resumePendingFactoryReset', device, bindingGeneration]);
        return {
          commandId: 'reset-command-1',
          bindingGeneration,
        };
      },
      async listRecordings(device) {
        calls.push(['listRecordings', device]);
        return [
          {
            uuid: 'recording-1',
            startedAtMs: 1_788_200_000_000,
            durationMs: 12_000,
            fileSize: 48_000,
            codec: 'opus_16k',
            isEncrypted: true,
          },
        ];
      },
      async syncRecording(device, recording) {
        calls.push(['syncRecording', device, recording]);
        recordingProgressHandler?.({ completedUnits: 24_000, totalUnits: 48_000 });
        return '/tmp/bota-recordings/recording-1.ogg';
      },
      async observeUploadOwnership(device, request) {
        calls.push(['observeUploadOwnership', device, request]);
        uploadOwnershipProgressHandler?.({
          completedUnits: 32_000,
          totalUnits: 48_000,
        });
        return {
          kind: 'bluetooth_fallback',
          recordingUuid: request.recordingUuid,
          uploadId: request.uploadId,
          destinationId: request.destinationId,
        };
      },
    },
  };
}

test('device scan maps native discovery and owns its subscription', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const devices = [];

  const subscription = await client.devices.startScan(
    { timeout: 5_000, allowDuplicates: true },
    (device) => devices.push(device)
  );
  fixture.emitDiscovery(discovered);

  assert.deepEqual(fixture.calls, [['startScan', 5_000, true]]);
  assert.equal(devices[0].id, 'peripheral-1');
  assert.deepEqual(
    devices[0].discoveredAt,
    new Date(1_788_200_000_000)
  );

  subscription.remove();
  assert.equal(fixture.removed, true);
});

test('device scan preserves the frozen JavaScript filters', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const devices = [];

  await client.devices.startScan(
    {
      deviceTypes: ['bota_note'],
      pairingState: 'paired',
      minRssi: -50,
    },
    (device) => devices.push(device)
  );
  fixture.emitDiscovery(discovered);
  fixture.emitDiscovery({
    ...discovered,
    id: 'note-weak',
    deviceType: 'bota_note',
    pairingState: 'paired',
    rssi: -70,
  });
  fixture.emitDiscovery({
    ...discovered,
    id: 'note-ready',
    deviceType: 'bota_note',
    pairingState: 'paired',
    rssi: -48,
  });

  assert.deepEqual(devices.map((device) => device.id), ['note-ready']);
});

test('device connection delegates selected identity and strict reconnect separately', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const selected = {
    id: discovered.id,
    name: discovered.name,
    deviceType: discovered.deviceType,
    firmwareVersion: discovered.firmwareVersion,
    macAddress: discovered.macAddress,
    pairingState: discovered.pairingState,
    rssi: discovered.rssi,
    discoveredAt: new Date(discovered.discoveredAtMs),
  };

  assert.equal((await client.devices.connect(selected)).serialNumber, 'EVFXXW67KP');
  assert.equal(
    (await client.devices.reconnect('C8SU2XXWHI', { scanTimeout: 7_000 })).serialNumber,
    'C8SU2XXWHI'
  );
  await client.devices.disconnect();

  assert.deepEqual(fixture.calls, [
    ['connectSelected', discovered],
    [
      'reconnect',
      'C8SU2XXWHI',
      {
        scanTimeoutMs: 7_000,
        connectionTimeoutMs: 10_000,
      },
    ],
    ['disconnect'],
  ]);
});

test('device status reads and subscriptions map dates and own native teardown', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const updates = [];

  const current = await client.devices.readStatus();
  const subscription = await client.devices.subscribeToStatus((value) => {
    updates.push(value);
  });
  fixture.emitStatus({ ...status, lastTimeSyncAtMs: undefined });
  await subscription.remove();
  await subscription.remove();

  assert.deepEqual(current.lastTimeSyncAt, new Date(1_788_200_000_000));
  assert.equal(updates[0].lastTimeSyncAt, null);
  assert.deepEqual(fixture.calls, [
    ['readStatus'],
    ['startStatusUpdates'],
    ['stopStatusUpdates'],
  ]);
});

test('provisioning resolves nonce-bound native material and supports remove-only deprovision', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  await client.provisioning.provision(connected, async (request) => {
    assert.deepEqual(request, {
      serialNumber: 'EVFXXW67KP',
      nonce: '00112233',
      devicePublicKey: 'aabbccdd',
    });
    return {
      apiEndpoint: 'https://api.bota.dev',
      deviceToken: 'dtok_example',
      mtu: 247,
    };
  });
  await client.provisioning.deprovision(connected);

  assert.deepEqual(fixture.calls, [
    ['provision', connected],
    [
      'resolveProvisioningMaterial',
      'material-request',
      {
        apiEndpoint: 'https://api.bota.dev',
        deviceToken: 'dtok_example',
        mtu: 247,
      },
    ],
    ['deprovision', connected],
  ]);
});

test('provisioning rejects native material requests when the application provider fails', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  await assert.rejects(
    client.provisioning.provision(connected, async () => {
      throw new Error('backend material unavailable');
    }),
    /backend material unavailable/
  );

  assert.deepEqual(fixture.calls, [
    ['provision', connected],
    [
      'rejectApplicationMaterial',
      'material-request',
      'backend material unavailable',
    ],
  ]);
});

test('factory reset resolves a nonce-bound grant and resumes only the exact generation', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  const completion = await client.factoryReset.factoryReset(
    connected,
    { commandId: 'reset-command-1', bindingGeneration: 9 },
    async (request) => {
      assert.deepEqual(request, {
        serialNumber: 'EVFXXW67KP',
        nonce: '44556677',
        commandId: 'reset-command-1',
        bindingGeneration: 9,
      });
      return 'Z3JhbnQ=';
    }
  );
  const resumed = await client.factoryReset.resumePendingFactoryReset(
    connected,
    9
  );

  assert.deepEqual(completion, {
    commandId: 'reset-command-1',
    bindingGeneration: 9,
  });
  assert.deepEqual(resumed, completion);
  assert.deepEqual(fixture.calls, [
    ['factoryReset', connected, 'reset-command-1', 9],
    ['resolveFactoryResetGrant', 'factory-reset-request', 'Z3JhbnQ='],
    ['resumePendingFactoryReset', connected, 9],
  ]);
});

test('factory reset rejects its native request when the application grant provider fails', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  await assert.rejects(
    client.factoryReset.factoryReset(
      connected,
      { commandId: 'reset-command-1', bindingGeneration: 9 },
      async () => {
        throw new Error('factory reset grant unavailable');
      }
    ),
    /factory reset grant unavailable/
  );

  assert.deepEqual(fixture.calls, [
    ['factoryReset', connected, 'reset-command-1', 9],
    [
      'rejectApplicationMaterial',
      'factory-reset-request',
      'factory reset grant unavailable',
    ],
  ]);
});

test('recording list and sync preserve metadata, progress, and native file ownership', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const progress = [];

  const recordings = await client.recordings.listRecordings(connected);
  const path = await client.recordings.syncRecording(
    connected,
    recordings[0],
    (value) => progress.push(value)
  );

  assert.deepEqual(recordings, [
    {
      uuid: 'recording-1',
      startedAt: new Date(1_788_200_000_000),
      durationMs: 12_000,
      fileSizeBytes: 48_000,
      codec: 'opus_16k',
      isEncrypted: true,
    },
  ]);
  assert.equal(path, '/tmp/bota-recordings/recording-1.ogg');
  assert.deepEqual(progress, [{ completedBytes: 24_000, totalBytes: 48_000 }]);
  assert.deepEqual(fixture.calls, [
    ['listRecordings', connected],
    [
      'syncRecording',
      connected,
      {
        uuid: 'recording-1',
        startedAtMs: 1_788_200_000_000,
        durationMs: 12_000,
        fileSize: 48_000,
        codec: 'opus_16k',
        isEncrypted: true,
      },
    ],
  ]);
});

test('upload ownership exposes only the native decision and low-volume progress', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const progress = [];
  const request = {
    recordingUuid: 'recording-1',
    uploadId: 'upload-1',
    destinationId: 'destination-1',
  };

  const result = await client.recordings.observeUploadOwnership(
    connected,
    request,
    (value) => progress.push(value)
  );

  assert.deepEqual(result, {
    kind: 'bluetooth_fallback',
    recordingUuid: 'recording-1',
    uploadId: 'upload-1',
    destinationId: 'destination-1',
  });
  assert.deepEqual(progress, [{ completedBytes: 32_000, totalBytes: 48_000 }]);
  assert.deepEqual(fixture.calls, [
    ['observeUploadOwnership', connected, request],
  ]);
});
