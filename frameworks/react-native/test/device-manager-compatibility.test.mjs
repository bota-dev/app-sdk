import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { DeviceManager } = require('../lib/commonjs/managers/DeviceManager.js');
const {
  reportCompatibilityDisconnection,
  setCompatibilityClientForTesting,
} = require(
  '../lib/commonjs/compatibility/runtime.js'
);

afterEach(() => setCompatibilityClientForTesting(null));

test('internal DeviceManager preserves scan and selected-device lifecycle', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  const events = [];
  manager.on('scanStarted', () => events.push('scanStarted'));
  manager.on('deviceDiscovered', (device) => events.push(['discovered', device.id]));
  manager.on('connectionStateChanged', (id, state) => events.push([id, state]));
  manager.on('deviceConnected', (device) => events.push(['connected', device.id]));
  manager.on('scanStopped', () => events.push('scanStopped'));

  await manager.startScan({ minRssi: -70 });
  fake.emitDiscovered(discoveredDevice);
  assert.deepEqual(manager.getDiscoveredDevices(), [discoveredDevice]);

  const connected = await manager.connect(discoveredDevice);
  assert.deepEqual(connected, connectedDevice);
  assert.deepEqual(manager.getConnectedDevices(), [connectedDevice]);
  assert.equal(manager.isConnected(connectedDevice.id), true);

  manager.stopScan();
  manager.stopScan();
  await tick();

  assert.deepEqual(events, [
    'scanStarted',
    ['discovered', discoveredDevice.id],
    [discoveredDevice.id, 'connecting'],
    [discoveredDevice.id, 'connected'],
    ['connected', connectedDevice.id],
    'scanStopped',
  ]);
  assert.equal(fake.scanSubscriptionRemovals, 1);
  assert.equal(fake.stopScanCalls, 1);
});

test('internal DeviceManager preserves WiFi lookup, cache, and idempotent teardown', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);

  const cacheEvents = [];
  const cacheSubscription = manager.onCachedDeviceStateChanged((serial, patch, state) => {
    cacheEvents.push([serial, patch, state]);
  });

  assert.deepEqual(
    await manager.configureWiFi(
      connectedDevice.id,
      { ssid: 'Bota', password: 'secret', securityType: 'WPA2' },
      { grantBlob: 'grant.test', expiresAt: new Date(0) }
    ),
    { success: true }
  );
  assert.deepEqual(await manager.getWiFiStatus(connectedDevice.id), wifiStatus);
  assert.deepEqual(manager.getCachedWiFiStatus(connectedDevice.serialNumber), wifiStatus);

  const statusSubscription = manager.subscribeToWiFiStatus(
    connectedDevice.id,
    (status) => cacheEvents.push(['callback', status])
  );
  await tick();
  fake.emitWiFiStatus({ status: 'disconnected' });
  statusSubscription.remove();
  statusSubscription.remove();
  cacheSubscription.remove();
  await tick();

  assert.deepEqual(fake.wifiConfiguration, {
    device: connectedDevice,
    credentials: { ssid: 'Bota', password: 'secret', securityType: 'WPA2' },
    grant: { grantBlob: 'grant.test', expiresAt: new Date(0) },
  });
  assert.equal(fake.wifiStatusSubscriptionRemovals, 1);
  assert.equal(cacheEvents.at(-1)[0], 'callback');
  assert.deepEqual(
    manager.getCachedWiFiStatus(connectedDevice.serialNumber),
    { status: 'disconnected', signalStrength: 87, ssid: 'Bota' }
  );
});

test('internal DeviceManager status subscriptions and destroy release native ownership once', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);
  const values = [];

  const remove = manager.subscribeToStatus(connectedDevice, (status) => values.push(status));
  await tick();
  fake.emitDeviceStatus(deviceStatus);
  remove();
  remove();
  manager.destroy();
  manager.destroy();
  await tick();

  assert.deepEqual(values, [deviceStatus]);
  assert.equal(fake.deviceStatusSubscriptionRemovals, 1);
  assert.equal(fake.stopScanCalls, 0);
});

test('internal DeviceManager delegates frozen provisioning and control commands', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);
  const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index);

  assert.equal(await manager.isProvisioned(connectedDevice), true);
  assert.equal(await manager.readPublicKey(connectedDevice), 'ab'.repeat(64));
  assert.equal(await manager.readAuthNonce(connectedDevice), 'cd'.repeat(16));
  await manager.setApiEndpoint(connectedDevice, 'gamma');
  await manager.deliverCert(connectedDevice, 'cert', 'key');
  await manager.deliverBackendPubkey(connectedDevice, publicKey);
  await manager.writeGrant(connectedDevice, 'AQID');
  await manager.syncTime(connectedDevice.id);
  await manager.provision(connectedDevice, 'dtok_example', 'gamma');
  assert.deepEqual(
    await manager.deprovision(connectedDevice, 'AQID'),
    { success: true }
  );

  assert.deepEqual(fake.controlCalls, [
    ['isProvisioned', connectedDevice],
    ['readPublicKey', connectedDevice],
    ['readAuthNonce', connectedDevice],
    ['setApiEndpoint', connectedDevice, 'gamma'],
    ['deliverCertificate', connectedDevice, 'cert', 'key'],
    ['deliverBackendPublicKey', connectedDevice, publicKey],
    ['writeGrant', connectedDevice, 'AQID'],
    ['syncTime', connectedDevice],
  ]);
  assert.deepEqual(fake.provisioningCalls, [
    [
      'provision',
      connectedDevice,
      {
        apiEndpointCode: 2,
        deviceToken: 'dtok_example',
        mtu: connectedDevice.mtu,
      },
    ],
    ['deprovision', connectedDevice, 'AQID'],
  ]);
});

test('internal DeviceManager covers remaining status, settings, log, WiFi, and cache methods', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();

  await manager.initialize();
  await manager.connect(discoveredDevice);
  assert.deepEqual(manager.getKnownBleIds(), {
    [connectedDevice.serialNumber]: connectedDevice.id,
  });
  assert.deepEqual(await manager.getStatus(connectedDevice), deviceStatus);
  assert.deepEqual(
    await manager.readConnectionSettings(connectedDevice),
    connectionSettings
  );
  await manager.writeConnectionSettings(connectedDevice, connectionSettings);
  assert.deepEqual(fake.connectionSettingsWrites, [
    [connectedDevice, connectionSettings],
  ]);
  assert.deepEqual(await manager.disconnectWiFi(connectedDevice.id), {
    success: true,
  });
  assert.deepEqual(await manager.scanWiFiNetworks(connectedDevice), {
    networks: [],
    currentSsid: null,
  });

  const stopLogs = await manager.subscribeToDeviceLogs(
    connectedDevice,
    () => undefined
  );
  stopLogs();
  stopLogs();
  await tick();
  assert.equal(fake.logSubscriptionRemovals, 1);

  manager.updateCachedDeviceState(connectedDevice.serialNumber, {
    wifiStatus,
  });
  assert.deepEqual(
    manager.getCachedDeviceState(connectedDevice.serialNumber)?.wifiStatus,
    wifiStatus
  );
  manager.clearCachedDeviceState(connectedDevice.serialNumber);
  assert.equal(manager.getCachedDeviceState(connectedDevice.serialNumber), null);
  manager.updateCachedDeviceState(connectedDevice.serialNumber, {
    wifiStatus,
  });
  manager.clearAllCachedDeviceStates();
  assert.equal(manager.getCachedDeviceState(connectedDevice.serialNumber), null);
  manager.destroy();
});

test('internal DeviceManager recovers ALREADY_PAIRED with nonce-bound deprovision', async () => {
  const fake = createFakeClient();
  fake.provisioningFailures.push(Object.assign(new Error('already paired'), {
    protocolStatus: 4,
  }));
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);
  const nonces = [];

  await manager.provision(connectedDevice, 'dtok_retry', 'production', {
    fetchDeprovisionGrant: async (nonce) => {
      nonces.push(nonce);
      return 'retry-grant';
    },
  });

  assert.deepEqual(nonces, ['cd'.repeat(16)]);
  assert.deepEqual(fake.provisioningCalls, [
    [
      'provision',
      connectedDevice,
      { apiEndpointCode: 1, deviceToken: 'dtok_retry', mtu: connectedDevice.mtu },
    ],
    ['deprovision', connectedDevice, 'retry-grant'],
    [
      'provision',
      connectedDevice,
      { apiEndpointCode: 1, deviceToken: 'dtok_retry', mtu: connectedDevice.mtu },
    ],
  ]);
});

test('internal DeviceManager preserves recording grant overloads and pending state precedence', async () => {
  const fake = createFakeClient();
  const command = deferred();
  fake.startRecordingResult = command.promise;
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);

  const start = manager.requestStartRecording(connectedDevice, 'start-grant');
  const pendingState = manager.getRecordingState(connectedDevice);
  assert.equal(fake.recordingStateReadCalls, 0);
  command.resolve({ success: true });

  assert.deepEqual(await start, { success: true });
  assert.deepEqual(await pendingState, recordingState);
  assert.equal(fake.recordingStateReadCalls, 1);

  const stop = await manager.requestStopRecording(
    connectedDevice,
    async (nonce) => `stop-grant:${nonce}`
  );
  assert.deepEqual(stop, { success: false, error: 'not_recording' });
  assert.deepEqual(fake.recordingControlCalls, [
    ['requestStartRecording', connectedDevice, 'start-grant'],
    ['requestStopRecording', connectedDevice, `stop-grant:${'cd'.repeat(16)}`],
  ]);
  assert.deepEqual(fake.controlCalls.at(-1), ['readAuthNonce', connectedDevice]);
});

test('internal DeviceManager caches recording state and falls back to frozen idle state', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);

  assert.deepEqual(await manager.getRecordingState(connectedDevice), recordingState);
  fake.recordingStateError = new Error('read failed');
  assert.deepEqual(await manager.getRecordingState(connectedDevice), recordingState);

  const uncachedFake = createFakeClient();
  uncachedFake.recordingStateError = new Error('read failed');
  setCompatibilityClientForTesting(uncachedFake.client);
  const uncachedManager = new DeviceManager();
  await uncachedManager.connect(discoveredDevice);
  assert.deepEqual(await uncachedManager.getRecordingState(connectedDevice), {
    active: false,
    initiatedBy: 'local',
  });
});

test('internal DeviceManager recording subscriptions are synchronous and release native ownership once', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);
  const values = [];

  const remove = manager.subscribeToRecordingState(
    connectedDevice,
    (state) => values.push(state)
  );
  assert.equal(typeof remove, 'function');
  await tick();
  fake.emitRecordingState(recordingState);
  remove();
  remove();
  await tick();

  assert.deepEqual(values, [recordingState]);
  assert.equal(fake.recordingStateSubscriptionRemovals, 1);
});

test('internal DeviceManager preserves authenticated reset and reinstall resume results', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);
  const persisted = [];

  const reset = await manager.bleFactoryReset(
    connectedDevice,
    'reset-grant',
    async (result) => persisted.push(['reset', result])
  );
  const resumed = await manager.resumeBleFactoryReset(
    connectedDevice,
    async (result) => persisted.push(['resume', result])
  );

  assert.deepEqual(reset, { success: true, localRecordingsDeleted: 7 });
  assert.deepEqual(resumed, { success: true, localRecordingsDeleted: 7 });
  assert.deepEqual(persisted, [
    ['reset', { success: true, localRecordingsDeleted: 7 }],
    ['resume', { success: true, localRecordingsDeleted: 7 }],
  ]);
  assert.equal(fake.factoryResetCalls[0][0], 'factoryReset');
  assert.equal(fake.factoryResetCalls[0][2].bindingGeneration, 0);
  assert.equal(fake.factoryResetCalls[0][3], 'reset-grant');
  assert.equal(fake.factoryResetCalls[1][0], 'resumePendingFactoryReset');
  assert.equal(fake.factoryResetCalls[1][2], 0);
});

test('internal DeviceManager maps factory-reset firmware rejection to frozen result', async () => {
  const fake = createFakeClient();
  fake.factoryResetFailure = Object.assign(new Error('rejected'), {
    protocolStatus: 1,
  });
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);

  const result = await manager.bleFactoryReset(
    connectedDevice,
    'reset-grant',
    async () => assert.fail('rejected reset must not persist')
  );

  assert.deepEqual(result, { success: false, error: 'invalid_token' });
});

test('internal DeviceManager serializes reconnects and shares duplicate serial attempts', async () => {
  const fake = createFakeClient();
  const first = deferred();
  fake.reconnectImplementation = async (serialNumber) => {
    if (serialNumber === 'FIRST') await first.promise;
    return {
      ...connectedDevice,
      id: `device-${serialNumber}`,
      serialNumber,
    };
  };
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();

  const firstAttempt = manager.reconnect('FIRST');
  const duplicateAttempt = manager.reconnect('FIRST');
  const secondAttempt = manager.reconnect('SECOND');
  await tick();

  assert.deepEqual(fake.reconnectCalls, ['FIRST']);
  assert.equal(fake.maximumReconnectsInFlight, 1);
  first.resolve();
  assert.deepEqual(await firstAttempt, await duplicateAttempt);
  assert.equal((await secondAttempt).serialNumber, 'SECOND');
  assert.deepEqual(fake.reconnectCalls, ['FIRST', 'SECOND']);
  assert.equal(fake.maximumReconnectsInFlight, 1);
});

test('internal DeviceManager auto reconnect starts immediately and user disconnect pauses it', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();

  manager.enableAutoReconnect('EVFXXW67KP');
  await tick();
  await tick();
  assert.deepEqual(fake.reconnectCalls, ['EVFXXW67KP']);

  await manager.disconnect(connectedDevice);
  await tick();
  assert.deepEqual(fake.reconnectCalls, ['EVFXXW67KP']);
  manager.disableAutoReconnect();
  manager.destroy();
});

test('internal DeviceManager restarts auto reconnect after a native link loss', async () => {
  const fake = createFakeClient();
  const reconnect = deferred();
  fake.reconnectImplementation = async () => reconnect.promise;
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  const disconnects = [];
  manager.on('deviceDisconnected', (deviceId, error) => {
    disconnects.push([deviceId, error?.message]);
  });

  await manager.connect(discoveredDevice);
  manager.enableAutoReconnect(connectedDevice.serialNumber);
  await tick();
  reportCompatibilityDisconnection(fake.client, new Error('link lost'));
  await tick();

  assert.deepEqual(disconnects, [[connectedDevice.id, 'link lost']]);
  assert.equal(manager.isConnected(connectedDevice.id), false);
  assert.deepEqual(fake.reconnectCalls, [connectedDevice.serialNumber]);
  assert.equal(fake.deviceStatusSubscriptionRemovals, 1);

  reconnect.resolve(connectedDevice);
  await tick();
  await tick();
  assert.equal(manager.isConnected(connectedDevice.id), true);
  manager.destroy();
});

test('internal DeviceManager refuses the deprecated unauthenticated reset opcode', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new DeviceManager();
  await manager.connect(discoveredDevice);

  await assert.rejects(
    manager.factoryReset(connectedDevice),
    (error) => error.code === 'INVALID_TOKEN'
  );
  assert.deepEqual(fake.factoryResetCalls, []);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const discoveredDevice = {
  id: 'selected',
  name: 'Bota Note',
  deviceType: 'bota_note',
  firmwareVersion: '1.0.17',
  macAddress: null,
  pairingState: 'paired',
  rssi: -50,
  discoveredAt: new Date(1_000),
};

const connectedDevice = {
  id: 'selected',
  serialNumber: 'EVFXXW67KP',
  deviceType: 'bota_note',
  firmwareVersion: '1.0.17',
  isProvisioned: true,
  connectionState: 'connected',
  mtu: 247,
};

const wifiStatus = { status: 'connected', signalStrength: 87, ssid: 'Bota' };

const deviceStatus = {
  batteryLevel: 80,
  storageTotalMb: 1024,
  storageUsedMb: 128,
  state: 'idle',
  pendingRecordings: 0,
  lastTimeSyncAt: null,
  flags: {
    charging: false,
    lowBattery: false,
    storageFull: false,
    wifiConnected: true,
    lteConnected: false,
    syncActive: false,
  },
  timestamp: 1,
};

const recordingState = {
  active: true,
  recordingId: '00112233-4455-6677-8899-aabbccddeeff',
  initiatedBy: 'remote',
};

const connectionSettings = {
  enabled_connections: { wifi: true, cellular: false },
  heartbeat_enabled_connections: { wifi: true, cellular: false },
  upload_network_preference: ['wifi', 'ble'],
  power_management: {
    wifi_idle_timeout_seconds: 180,
    cellular_idle_timeout_seconds: 0,
  },
  streaming_enabled: false,
  streaming_flush_interval_seconds: 60,
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

function createFakeClient() {
  let onDiscovered;
  let onWiFiStatus;
  let onDeviceStatus;
  let onRecordingState;
  const fake = {
    scanSubscriptionRemovals: 0,
    stopScanCalls: 0,
    wifiStatusSubscriptionRemovals: 0,
    deviceStatusSubscriptionRemovals: 0,
    logSubscriptionRemovals: 0,
    recordingStateSubscriptionRemovals: 0,
    recordingStateReadCalls: 0,
    recordingStateError: null,
    recordingState: recordingState,
    startRecordingResult: Promise.resolve({ success: true }),
    stopRecordingResult: Promise.resolve({ success: false, error: 'not_recording' }),
    recordingControlCalls: [],
    wifiConfiguration: null,
    controlCalls: [],
    provisioningCalls: [],
    provisioningFailures: [],
    connectionSettingsWrites: [],
    factoryResetCalls: [],
    factoryResetFailure: null,
    reconnectCalls: [],
    reconnectsInFlight: 0,
    maximumReconnectsInFlight: 0,
    reconnectImplementation: null,
    emitDiscovered: (device) => onDiscovered?.(device),
    emitWiFiStatus: (status) => onWiFiStatus?.(status),
    emitDeviceStatus: (status) => onDeviceStatus?.(status),
    emitRecordingState: (state) => onRecordingState?.(state),
  };

  fake.client = {
    devices: {
      async startScan(_options, callback) {
        onDiscovered = callback;
        return { remove: () => { fake.scanSubscriptionRemovals += 1; } };
      },
      async stopScan() { fake.stopScanCalls += 1; },
      async connect() { return connectedDevice; },
      async reconnect(serialNumber) {
        fake.reconnectCalls.push(serialNumber);
        fake.reconnectsInFlight += 1;
        fake.maximumReconnectsInFlight = Math.max(
          fake.maximumReconnectsInFlight,
          fake.reconnectsInFlight
        );
        try {
          if (fake.reconnectImplementation) {
            return await fake.reconnectImplementation(serialNumber);
          }
          return { ...connectedDevice, serialNumber };
        } finally {
          fake.reconnectsInFlight -= 1;
        }
      },
      async disconnect() {},
      async readStatus() { return deviceStatus; },
      async subscribeToStatus(callback) {
        onDeviceStatus = callback;
        return {
          async remove() { fake.deviceStatusSubscriptionRemovals += 1; },
        };
      },
    },
    wifi: {
      async configure(device, credentials, grant) {
        fake.wifiConfiguration = { device, credentials, grant };
        return { success: true };
      },
      async disconnect() { return { success: true }; },
      async readStatus() { return wifiStatus; },
      async subscribeToStatus(_device, callback) {
        onWiFiStatus = callback;
        return {
          async remove() { fake.wifiStatusSubscriptionRemovals += 1; },
        };
      },
      async scanNetworks() { return { networks: [], currentSsid: null }; },
    },
    logs: {
      async subscribe() {
        return {
          async remove() { fake.logSubscriptionRemovals += 1; },
        };
      },
    },
    provisioning: {
      async provision(device, provider) {
        const request = {
          serialNumber: device.serialNumber,
          nonce: 'cd'.repeat(16),
          devicePublicKey: 'ab'.repeat(64),
        };
        const material = await provider(request);
        fake.provisioningCalls.push([
          'provision',
          device,
          {
            apiEndpointCode: material.apiEndpoint.charCodeAt(0),
            deviceToken: material.deviceToken,
            mtu: material.mtu,
          },
        ]);
        const failure = fake.provisioningFailures.shift();
        if (failure) throw failure;
      },
      async deprovision(device, grantBlob) {
        fake.provisioningCalls.push(['deprovision', device, grantBlob]);
        return { success: true };
      },
      async readConnectionSettings() { return connectionSettings; },
      async writeConnectionSettings(device, settings) {
        fake.connectionSettingsWrites.push([device, settings]);
      },
    },
    controls: {
      async isProvisioned(device) {
        fake.controlCalls.push(['isProvisioned', device]);
        return true;
      },
      async readPublicKey(device) {
        fake.controlCalls.push(['readPublicKey', device]);
        return 'ab'.repeat(64);
      },
      async readAuthNonce(device) {
        fake.controlCalls.push(['readAuthNonce', device]);
        return 'cd'.repeat(16);
      },
      async setApiEndpoint(device, environment) {
        fake.controlCalls.push(['setApiEndpoint', device, environment]);
      },
      async deliverCertificate(device, certificatePem, privateKeyPem) {
        fake.controlCalls.push(['deliverCertificate', device, certificatePem, privateKeyPem]);
      },
      async deliverBackendPublicKey(device, publicKey) {
        fake.controlCalls.push(['deliverBackendPublicKey', device, publicKey]);
      },
      async writeGrant(device, grantBlob) {
        fake.controlCalls.push(['writeGrant', device, grantBlob]);
      },
      async syncTime(device) {
        fake.controlCalls.push(['syncTime', device]);
      },
      async requestStartRecording(device, grantBlob) {
        fake.recordingControlCalls.push(['requestStartRecording', device, grantBlob]);
        return fake.startRecordingResult;
      },
      async requestStopRecording(device, grantBlob) {
        fake.recordingControlCalls.push(['requestStopRecording', device, grantBlob]);
        return fake.stopRecordingResult;
      },
      async readRecordingState() {
        fake.recordingStateReadCalls += 1;
        if (fake.recordingStateError) throw fake.recordingStateError;
        return fake.recordingState;
      },
      async subscribeToRecordingState(_device, callback) {
        onRecordingState = callback;
        return {
          async remove() { fake.recordingStateSubscriptionRemovals += 1; },
        };
      },
    },
    factoryReset: {
      async factoryReset(device, options, provider, persistResult) {
        const grant = await provider({
          serialNumber: device.serialNumber,
          nonce: 'ef'.repeat(16),
          commandId: options.commandId,
          bindingGeneration: options.bindingGeneration,
        });
        fake.factoryResetCalls.push(['factoryReset', device, options, grant]);
        if (fake.factoryResetFailure) throw fake.factoryResetFailure;
        await persistResult?.({ success: true, localRecordingsDeleted: 7 });
        return options;
      },
      async resumePendingFactoryReset(device, bindingGeneration, persistResult) {
        fake.factoryResetCalls.push([
          'resumePendingFactoryReset',
          device,
          bindingGeneration,
        ]);
        await persistResult?.({ success: true, localRecordingsDeleted: 7 });
        return { commandId: 'resumed-reset', bindingGeneration };
      },
    },
    recordings: {},
    ota: {},
    async configure() {},
    async destroy() {},
    async getCapabilities() { return {}; },
    async getState() { return 'ready'; },
  };
  return fake;
}
