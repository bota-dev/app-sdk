import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { BotaClient } = require('../lib/commonjs/BotaClient.js');
const { DeviceManager } = require('../lib/commonjs/managers/DeviceManager.js');
const { OTAManager } = require('../lib/commonjs/managers/OTAManager.js');
const { RecordingManager } = require('../lib/commonjs/managers/RecordingManager.js');
const { setCompatibilityClientForTesting } = require(
  '../lib/commonjs/compatibility/runtime.js'
);

afterEach(async () => {
  await BotaClient.destroy();
  BotaClient.setLogHandler(null);
  BotaClient.setLogLevel('warn');
  setCompatibilityClientForTesting(null);
});

test('BotaClient keeps managers unavailable before configuration', async () => {
  assert.equal(BotaClient.state, 'uninitialized');
  assert.equal(BotaClient.config, null);
  assert.equal(BotaClient.isInitialized, false);
  for (const accessor of ['devices', 'recordings', 'ota']) {
    assert.throws(
      () => BotaClient[accessor],
      (error) => error.name === 'SdkError' && error.code === 'NOT_INITIALIZED'
    );
  }
  await assert.rejects(
    BotaClient.waitForBluetooth(),
    (error) => error.name === 'SdkError' && error.code === 'NOT_INITIALIZED'
  );
});

test('BotaClient coalesces configure and creates one ready manager graph', async () => {
  const gate = deferred();
  const fake = createFakeClient({ configureGate: gate.promise });
  setCompatibilityClientForTesting(fake.client);
  const stateChanges = [];
  const bluetoothChanges = [];
  BotaClient.on('stateChanged', (state) => stateChanges.push(state));
  BotaClient.on('bluetoothStateChanged', (state) => bluetoothChanges.push(state));

  const first = BotaClient.configure({ environment: 'gamma', logLevel: 'debug' });
  const second = BotaClient.configure({ environment: 'production' });
  await nextTurn();
  assert.equal(fake.configureCalls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(fake.configureCalls, [{ logLevel: 'debug' }]);
  assert.equal(BotaClient.state, 'ready');
  assert.equal(BotaClient.bluetoothState, 'poweredOn');
  assert.equal(BotaClient.isBluetoothReady, true);
  assert.equal(BotaClient.isInitialized, true);
  assert.deepEqual(BotaClient.config, {
    environment: 'gamma',
    backgroundSyncEnabled: true,
    wifiOnlyUpload: false,
    logLevel: 'debug',
    debug: false,
  });
  assert.ok(BotaClient.devices instanceof DeviceManager);
  assert.ok(BotaClient.recordings instanceof RecordingManager);
  assert.ok(BotaClient.ota instanceof OTAManager);
  assert.strictEqual(BotaClient.devices, BotaClient.devices);
  assert.deepEqual(stateChanges, ['initializing', 'ready']);
  assert.deepEqual(bluetoothChanges, ['poweredOn']);
  await BotaClient.waitForBluetooth(1);
});

test('BotaClient replaces the manager graph when reconfigured', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  await BotaClient.configure({ environment: 'development' });
  const firstGraph = [BotaClient.devices, BotaClient.recordings, BotaClient.ota];

  await BotaClient.configure({ environment: 'production', wifiOnlyUpload: true });

  assert.equal(fake.configureCalls.length, 2);
  assert.equal(fake.destroyCalls, 1);
  assert.notStrictEqual(BotaClient.devices, firstGraph[0]);
  assert.notStrictEqual(BotaClient.recordings, firstGraph[1]);
  assert.notStrictEqual(BotaClient.ota, firstGraph[2]);
  assert.equal(BotaClient.config?.environment, 'production');
  assert.equal(BotaClient.config?.wifiOnlyUpload, true);
});

test('BotaClient serializes configure and coalesced destroy ownership', async () => {
  const configureGate = deferred();
  const destroyGate = deferred();
  const fake = createFakeClient({
    configureGate: configureGate.promise,
    destroyGate: destroyGate.promise,
  });
  setCompatibilityClientForTesting(fake.client);

  const configure = BotaClient.configure();
  const firstDestroy = BotaClient.destroy();
  const secondDestroy = BotaClient.destroy();
  await nextTurn();
  assert.equal(fake.destroyCalls, 0);
  configureGate.resolve();
  await configure;
  await nextTurn();
  assert.equal(fake.destroyCalls, 1);
  destroyGate.resolve();
  await Promise.all([firstDestroy, secondDestroy]);

  assert.equal(BotaClient.state, 'uninitialized');
  assert.equal(BotaClient.config, null);
  assert.equal(fake.destroyCalls, 1);
});

test('BotaClient preserves configure calls queued after destroy', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);

  const firstConfigure = BotaClient.configure({ environment: 'development' });
  const destroy = BotaClient.destroy();
  const finalConfigure = BotaClient.configure({ environment: 'production' });
  await Promise.all([firstConfigure, destroy, finalConfigure]);

  assert.equal(fake.configureCalls.length, 2);
  assert.equal(fake.destroyCalls, 1);
  assert.equal(BotaClient.state, 'ready');
  assert.equal(BotaClient.config?.environment, 'production');
});

test('BotaClient preserves runtime log level and handler behavior', async () => {
  const fake = createFakeClient();
  setCompatibilityClientForTesting(fake.client);
  const entries = [];
  BotaClient.setLogHandler((entry) => entries.push(entry));

  await BotaClient.configure({ logLevel: 'debug' });
  BotaClient.setLogLevel('error');

  assert.equal(BotaClient.config?.logLevel, 'error');
  assert.ok(entries.some((entry) => (
    entry.level === 'info' && entry.message === '[BotaClient] SDK configured successfully'
  )));
  assert.ok(entries.every((entry) => entry.timestamp instanceof Date));
});

function createFakeClient({ configureGate, destroyGate } = {}) {
  const fake = {
    configureCalls: [],
    destroyCalls: 0,
    state: 'uninitialized',
  };
  fake.client = {
    devices: {},
    ota: {
      async cancelFirmwareUpdate() {},
    },
    recordings: {
      async loadUploadQueue() {
        return [];
      },
      async destroyCompatibilityOperations() {},
    },
    async configure(configuration) {
      fake.configureCalls.push(configuration);
      fake.state = 'initializing';
      await configureGate;
      fake.state = 'ready';
    },
    async destroy() {
      fake.destroyCalls += 1;
      await destroyGate;
      fake.state = 'uninitialized';
    },
    async getCapabilities() {
      return { bluetooth: true };
    },
    async getState() {
      return fake.state;
    },
  };
  return fake;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}
