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

function nativeFixture() {
  const calls = [];
  let discoveryHandler = null;
  let removed = false;
  return {
    calls,
    get removed() {
      return removed;
    },
    emitDiscovery(value) {
      discoveryHandler?.(value);
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
