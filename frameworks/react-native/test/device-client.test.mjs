import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createBotaDeviceSDK } = require('../lib/commonjs/client.js');
const { subscribeToCompatibilityDisconnections } = require(
  '../lib/commonjs/compatibility/runtime.js'
);

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
  let disconnectionHandler = null;
  let statusHandler = null;
  let recordingStateHandler = null;
  let provisioningHandler = null;
  let factoryResetHandler = null;
  let factoryResetPersistenceHandler = null;
  let recordingProgressHandler = null;
  let uploadOwnershipProgressHandler = null;
  let firmwareUpdateProgressHandler = null;
  let deviceLogHandler = null;
  let wifiStatusHandler = null;
  let provisioningResolve = null;
  let provisioningReject = null;
  let factoryResetResolve = null;
  let factoryResetReject = null;
  let factoryResetCommandId = null;
  let factoryResetBindingGeneration = null;
  let factoryResetRequiresPersistence = false;
  let removed = false;
  return {
    calls,
    get removed() {
      return removed;
    },
    emitDiscovery(value) {
      discoveryHandler?.(value);
    },
    emitDisconnection(value) {
      disconnectionHandler?.(value);
    },
    emitStatus(value) {
      statusHandler?.(value);
    },
    emitRecordingState(value) {
      recordingStateHandler?.(value);
    },
    emitWiFiStatus(value) {
      wifiStatusHandler?.(value);
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
      onDeviceDisconnected(handler) {
        disconnectionHandler = handler;
        return {
          remove() {
            disconnectionHandler = null;
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
      onRecordingStateUpdated(handler) {
        recordingStateHandler = handler;
        return {
          remove() {
            recordingStateHandler = null;
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
      onFactoryResetResultPersistenceRequested(handler) {
        factoryResetPersistenceHandler = handler;
        return {
          remove() {
            factoryResetPersistenceHandler = null;
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
      onFirmwareUpdateProgress(handler) {
        firmwareUpdateProgressHandler = handler;
        return {
          remove() {
            firmwareUpdateProgressHandler = null;
          },
        };
      },
      onDeviceLog(handler) {
        deviceLogHandler = handler;
        return {
          remove() {
            deviceLogHandler = null;
          },
        };
      },
      onWiFiStatusUpdated(handler) {
        wifiStatusHandler = handler;
        return {
          remove() {
            wifiStatusHandler = null;
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
      async isProvisioned(device) {
        calls.push(['isProvisioned', device]);
        return true;
      },
      async readPublicKey(device) {
        calls.push(['readPublicKey', device]);
        return 'ab'.repeat(64);
      },
      async readAuthNonce(device) {
        calls.push(['readAuthNonce', device]);
        return 'cd'.repeat(16);
      },
      async setApiEndpoint(device, environment) {
        calls.push(['setApiEndpoint', device, environment]);
      },
      async deliverCertificate(device, certificatePem, privateKeyPem) {
        calls.push(['deliverCertificate', device, certificatePem, privateKeyPem]);
      },
      async deliverBackendPublicKey(device, publicKeyHex) {
        calls.push(['deliverBackendPublicKey', device, publicKeyHex]);
      },
      async writeGrant(device, grantBlob) {
        calls.push(['writeGrant', device, grantBlob]);
      },
      async syncTime(device) {
        calls.push(['syncTime', device]);
      },
      async requestStartRecording(device, grantBlob) {
        calls.push(['requestStartRecording', device, grantBlob]);
        return { success: true };
      },
      async requestStopRecording(device, grantBlob) {
        calls.push(['requestStopRecording', device, grantBlob]);
        return { success: false, error: 'not_recording' };
      },
      async readRecordingState(device) {
        calls.push(['readRecordingState', device]);
        return {
          active: true,
          recordingId: 'recording-1',
          initiatedBy: 'remote',
        };
      },
      async startRecordingStateUpdates(device) {
        calls.push(['startRecordingStateUpdates', device]);
      },
      async stopRecordingStateUpdates() {
        calls.push(['stopRecordingStateUpdates']);
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
        if (requestId === 'factory-reset-request' || requestId === 'factory-reset-persistence') {
          factoryResetReject?.(new Error(message));
        } else {
          provisioningReject?.(new Error(message));
        }
      },
      async deprovision(device, grantBlob) {
        calls.push(['deprovision', device, grantBlob]);
        return { success: false, error: 'invalid_token' };
      },
      async writeConnectionSettings(device, settings) {
        calls.push(['writeConnectionSettings', device, settings]);
      },
      async readConnectionSettings(device) {
        calls.push(['readConnectionSettings', device]);
        return {
          enabledConnections: { wifi: true, cellular: false },
          heartbeatEnabledConnections: { wifi: true, cellular: true },
          uploadNetworkPreference: ['wifi', 'ble'],
          powerManagement: {
            wifiIdleTimeoutSeconds: 0,
            cellularIdleTimeoutSeconds: -1,
          },
          streamingEnabled: false,
          streamingFlushIntervalSeconds: 30,
        };
      },
      async factoryReset(device, commandId, bindingGeneration, requiresPersistence) {
        calls.push(['factoryReset', device, commandId, bindingGeneration, requiresPersistence]);
        factoryResetCommandId = commandId;
        factoryResetBindingGeneration = bindingGeneration;
        factoryResetRequiresPersistence = requiresPersistence;
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
        if (factoryResetRequiresPersistence) {
          queueMicrotask(() => {
            factoryResetPersistenceHandler?.({
              requestId: 'factory-reset-persistence',
              commandId: factoryResetCommandId,
              localRecordingsDeleted: 7,
            });
          });
          return;
        }
        factoryResetResolve?.({
          commandId: factoryResetCommandId,
          bindingGeneration: factoryResetBindingGeneration,
        });
      },
      async resolveFactoryResetResultPersistence(requestId) {
        calls.push(['resolveFactoryResetResultPersistence', requestId]);
        factoryResetResolve?.({
          commandId: factoryResetCommandId,
          bindingGeneration: factoryResetBindingGeneration,
        });
      },
      async resumePendingFactoryReset(device, bindingGeneration, requiresPersistence) {
        calls.push(['resumePendingFactoryReset', device, bindingGeneration, requiresPersistence]);
        if (requiresPersistence) {
          factoryResetCommandId = 'reset-command-1';
          factoryResetBindingGeneration = bindingGeneration;
          return new Promise((resolve, reject) => {
            factoryResetResolve = resolve;
            factoryResetReject = reject;
            queueMicrotask(() => {
              factoryResetPersistenceHandler?.({
                requestId: 'factory-reset-persistence',
                commandId: factoryResetCommandId,
                localRecordingsDeleted: 7,
              });
            });
          });
        }
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
      async updateFirmware(device, image) {
        calls.push(['updateFirmware', device, image]);
        firmwareUpdateProgressHandler?.({
          phase: 'downloading',
          completedUnits: 512_000,
          totalUnits: 1_024_000,
        });
        firmwareUpdateProgressHandler?.({
          phase: 'complete',
          completedUnits: 1_024_000,
          totalUnits: 1_024_000,
        });
      },
      async startDeviceLogs(device) {
        calls.push(['startDeviceLogs', device]);
        deviceLogHandler?.({ message: 'boot pass', isBacklog: true });
      },
      async stopDeviceLogs() {
        calls.push(['stopDeviceLogs']);
      },
      async configureWiFi(device, ssid, password, grantBlob) {
        calls.push(['configureWiFi', device, ssid, password, grantBlob]);
        return { success: true };
      },
      async disconnectWiFi(device) {
        calls.push(['disconnectWiFi', device]);
        return { success: false, error: 'storage_error' };
      },
      async readWiFiStatus(device) {
        calls.push(['readWiFiStatus', device]);
        return { status: 'future_status', signalStrength: 87, ssid: 'Bota' };
      },
      async startWiFiStatusUpdates(device) {
        calls.push(['startWiFiStatusUpdates', device]);
      },
      async stopWiFiStatusUpdates() {
        calls.push(['stopWiFiStatusUpdates']);
      },
      async scanWiFiNetworks(device) {
        calls.push(['scanWiFiNetworks', device]);
        return {
          networks: [
            { ssid: 'Bota', quality: 100, isCurrent: true, isOpen: false },
            { ssid: 'Guest', quality: 50, isCurrent: false, isOpen: true },
          ],
          currentSsid: 'Bota',
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

test('native disconnect events stay private and notify the compatibility owner', () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const errors = [];
  const subscription = subscribeToCompatibilityDisconnections(
    client,
    (error) => errors.push(error?.message)
  );

  fixture.emitDisconnection({ error: 'link lost' });
  subscription.remove();
  fixture.emitDisconnection({ error: 'ignored' });

  assert.deepEqual(errors, ['link lost']);
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
  const deprovision = await client.provisioning.deprovision(connected, 'AQID');
  assert.deepEqual(deprovision, { success: false, error: 'invalid_token' });

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
    ['deprovision', connected, 'AQID'],
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

test('connection settings expand frozen defaults before native normalization', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  await client.provisioning.writeConnectionSettings(connected, {
    enabled_connections: { wifi: true, cellular: false },
    upload_network_preference: ['wifi', 'ble', 'cellular'],
  });

  assert.deepEqual(fixture.calls, [
    [
      'writeConnectionSettings',
      connected,
      {
        enabledConnections: { wifi: true, cellular: false },
        heartbeatEnabledConnections: { wifi: true, cellular: true },
        uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
        powerManagement: {
          wifiIdleTimeoutSeconds: 180,
          cellularIdleTimeoutSeconds: 180,
        },
        streamingEnabled: true,
        streamingFlushIntervalSeconds: 60,
      },
    ],
  ]);
});

test('connection settings reads map the complete native value to the frozen shape', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  const settings = await client.provisioning.readConnectionSettings(connected);

  assert.deepEqual(settings, {
    enabled_connections: { wifi: true, cellular: false },
    heartbeat_enabled_connections: { wifi: true, cellular: true },
    upload_network_preference: ['wifi', 'ble'],
    power_management: {
      wifi_idle_timeout_seconds: 0,
      cellular_idle_timeout_seconds: -1,
    },
    streaming_enabled: false,
    streaming_flush_interval_seconds: 30,
  });
  assert.deepEqual(fixture.calls, [['readConnectionSettings', connected]]);
});

test('device controls preserve typed values and keep packet bytes native', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index);

  assert.equal(await client.controls.isProvisioned(connected), true);
  assert.equal(await client.controls.readPublicKey(connected), 'ab'.repeat(64));
  assert.equal(await client.controls.readAuthNonce(connected), 'cd'.repeat(16));
  await client.controls.setApiEndpoint(connected, 'gamma');
  await client.controls.deliverCertificate(connected, 'cert', 'key');
  await client.controls.deliverBackendPublicKey(connected, publicKey);
  await client.controls.writeGrant(connected, 'AQID');
  await client.controls.syncTime(connected);

  assert.deepEqual(fixture.calls, [
    ['isProvisioned', connected],
    ['readPublicKey', connected],
    ['readAuthNonce', connected],
    ['setApiEndpoint', connected, 'gamma'],
    ['deliverCertificate', connected, 'cert', 'key'],
    [
      'deliverBackendPublicKey',
      connected,
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    ],
    ['writeGrant', connected, 'AQID'],
    ['syncTime', connected],
  ]);
});

test('recording controls preserve typed results and own state subscriptions natively', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const updates = [];

  assert.deepEqual(
    await client.controls.requestStartRecording(connected, 'c3RhcnQ='),
    { success: true }
  );
  assert.deepEqual(
    await client.controls.requestStopRecording(connected, 'c3RvcA=='),
    { success: false, error: 'not_recording' }
  );
  assert.deepEqual(await client.controls.readRecordingState(connected), {
    active: true,
    recordingId: 'recording-1',
    initiatedBy: 'remote',
  });

  const subscription = await client.controls.subscribeToRecordingState(
    connected,
    (state) => updates.push(state)
  );
  fixture.emitRecordingState({ active: false, initiatedBy: 'local' });
  await subscription.remove();
  await subscription.remove();

  assert.deepEqual(updates, [{ active: false, initiatedBy: 'local' }]);
  assert.deepEqual(fixture.calls, [
    ['requestStartRecording', connected, 'c3RhcnQ='],
    ['requestStopRecording', connected, 'c3RvcA=='],
    ['readRecordingState', connected],
    ['startRecordingStateUpdates', connected],
    ['stopRecordingStateUpdates'],
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
    ['factoryReset', connected, 'reset-command-1', 9, false],
    ['resolveFactoryResetGrant', 'factory-reset-request', 'Z3JhbnQ='],
    ['resumePendingFactoryReset', connected, 9, false],
  ]);
});

test('factory reset awaits application result persistence before native completion', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const persisted = [];

  const completion = await client.factoryReset.factoryReset(
    connected,
    { commandId: 'reset-command-1', bindingGeneration: 9 },
    async () => 'Z3JhbnQ=',
    async (result) => {
      persisted.push(result);
    }
  );

  assert.deepEqual(persisted, [{ success: true, localRecordingsDeleted: 7 }]);
  assert.deepEqual(completion, {
    commandId: 'reset-command-1',
    bindingGeneration: 9,
  });
  assert.deepEqual(fixture.calls, [
    ['factoryReset', connected, 'reset-command-1', 9, true],
    ['resolveFactoryResetGrant', 'factory-reset-request', 'Z3JhbnQ='],
    ['resolveFactoryResetResultPersistence', 'factory-reset-persistence'],
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
    ['factoryReset', connected, 'reset-command-1', 9, false],
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

test('firmware update keeps download bytes native and emits typed progress', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const progress = [];

  await client.ota.updateFirmware(
    connected,
    {
      version: '1.0.12',
      sizeBytes: 1_024_000,
      crc32: 0x12345678,
      url: 'https://firmware.bota.dev/update.ufw',
    },
    (value) => progress.push(value)
  );

  assert.deepEqual(progress, [
    {
      phase: 'downloading',
      completedBytes: 512_000,
      totalBytes: 1_024_000,
    },
    {
      phase: 'complete',
      completedBytes: 1_024_000,
      totalBytes: 1_024_000,
    },
  ]);
  assert.deepEqual(fixture.calls, [
    [
      'updateFirmware',
      connected,
      {
        version: '1.0.12',
        sizeUnits: 1_024_000,
        crc32: 0x12345678,
        url: 'https://firmware.bota.dev/update.ufw',
      },
    ],
  ]);
});

test('device log subscription receives only complete native lines and owns teardown', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const lines = [];

  const subscription = await client.logs.subscribe(connected, (line) => {
    lines.push(line);
  });
  await subscription.remove();
  await subscription.remove();

  assert.deepEqual(lines, [
    { level: 'debug', message: 'boot pass', isBacklog: true },
  ]);
  assert.deepEqual(fixture.calls, [
    ['startDeviceLogs', connected],
    ['stopDeviceLogs'],
  ]);
});

test('WiFi configuration keeps encoding native and preserves frozen result values', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);

  const configured = await client.wifi.configure(
    connected,
    { ssid: 'Bota', password: 'secret', securityType: 'WPA2' },
    { grantBlob: 'grant.test', expiresAt: new Date(1_788_200_000_000) }
  );
  const disconnected = await client.wifi.disconnect(connected);

  assert.deepEqual(configured, { success: true });
  assert.deepEqual(disconnected, { success: false, error: 'storage_error' });
  assert.deepEqual(fixture.calls, [
    ['configureWiFi', connected, 'Bota', 'secret', 'grant.test'],
    ['disconnectWiFi', connected],
  ]);
});

test('WiFi status and scan preserve unknown fallback and own status teardown', async () => {
  const fixture = nativeFixture();
  const client = createBotaDeviceSDK(fixture.module);
  const updates = [];

  const status = await client.wifi.readStatus(connected);
  const subscription = await client.wifi.subscribeToStatus(
    connected,
    (value) => updates.push(value)
  );
  fixture.emitWiFiStatus({ status: 'connected', signalStrength: 75, ssid: 'Bota' });
  const scan = await client.wifi.scanNetworks(connected);
  await subscription.remove();
  await subscription.remove();

  assert.deepEqual(status, { status: 'idle', signalStrength: 87, ssid: 'Bota' });
  assert.deepEqual(updates, [{ status: 'connected', signalStrength: 75, ssid: 'Bota' }]);
  assert.deepEqual(scan, {
    networks: [
      { ssid: 'Bota', quality: 100, isCurrent: true, isOpen: false },
      { ssid: 'Guest', quality: 50, isCurrent: false, isOpen: true },
    ],
    currentSsid: 'Bota',
  });
  assert.deepEqual(fixture.calls, [
    ['readWiFiStatus', connected],
    ['startWiFiStatusUpdates', connected],
    ['scanWiFiNetworks', connected],
    ['stopWiFiStatusUpdates'],
  ]);
});
