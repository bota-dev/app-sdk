import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { DeviceManager } = require('../lib/commonjs/managers/DeviceManager.js');
const { setCompatibilityClientForTesting } = require(
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

function createFakeClient() {
  let onDiscovered;
  let onWiFiStatus;
  let onDeviceStatus;
  const fake = {
    scanSubscriptionRemovals: 0,
    stopScanCalls: 0,
    wifiStatusSubscriptionRemovals: 0,
    deviceStatusSubscriptionRemovals: 0,
    wifiConfiguration: null,
    controlCalls: [],
    emitDiscovered: (device) => onDiscovered?.(device),
    emitWiFiStatus: (status) => onWiFiStatus?.(status),
    emitDeviceStatus: (status) => onDeviceStatus?.(status),
  };

  fake.client = {
    devices: {
      async startScan(_options, callback) {
        onDiscovered = callback;
        return { remove: () => { fake.scanSubscriptionRemovals += 1; } };
      },
      async stopScan() { fake.stopScanCalls += 1; },
      async connect() { return connectedDevice; },
      async reconnect() { return connectedDevice; },
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
    logs: { async subscribe() { throw new Error('unused'); } },
    provisioning: {
      async provision() {},
      async deprovision() {},
      async readConnectionSettings() { throw new Error('unused'); },
      async writeConnectionSettings() {},
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
    },
    factoryReset: {},
    recordings: {},
    ota: {},
    async configure() {},
    async destroy() {},
    async getCapabilities() { return {}; },
    async getState() { return 'ready'; },
  };
  return fake;
}
