import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const runtimePath = require.resolve('@bota.dev/react-native-app-sdk/runtime');
const { createBotaReactNativeRuntime, BotaRuntimeCompatibilityError } = require(runtimePath);

function adapter(platform = 'ios') {
  return {
    apiVersion: 1,
    device: {
      configured: false,
      async configure() { this.configured = true; },
      async destroy() { this.configured = false; },
      async getState() { return this.configured ? 'ready' : 'uninitialized'; },
      async getCapabilities() { return { platform, bluetooth: true, backgroundScan: false,
        backgroundReconnect: false, nativeFileTransfer: true }; },
      async loadCompatibilityUploadQueue() { return '[]'; },
      async saveCompatibilityUploadQueue() {},
      async stopAllRecordingOperations() {},
    },
  };
}

test('portable entry loads without React Native or a native module registry', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) {
      if (id.startsWith('react-native')) throw new Error('unexpected native import: ' + id);
      return load.call(this, id, ...args);
    };
    const { createBotaReactNativeRuntime, deriveSyncStatus, UPLOAD_RECOVERY_VERSION,
      readClientPresenceObservation } = require(${JSON.stringify(runtimePath)});
    if (typeof deriveSyncStatus !== 'function' || UPLOAD_RECOVERY_VERSION !== 1 ||
      typeof readClientPresenceObservation !== 'function') throw new Error('Missing portable application utilities');
    createBotaReactNativeRuntime({apiVersion: 1, device: {}});
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('two platform implementations keep independent TypeScript manager graphs', async () => {
  const ios = adapter();
  const android = adapter('android');
  const first = createBotaReactNativeRuntime(ios);
  const second = createBotaReactNativeRuntime(android);
  await Promise.all([first.client.configure({}), second.client.configure({})]);
  assert.equal(ios.device.configured, true);
  assert.equal(android.device.configured, true);
  assert.notEqual(first.client.devices, second.client.devices);
  await first.client.destroy();
  assert.equal(ios.device.configured, false);
  assert.equal(second.client.state, 'ready');
  await second.client.destroy();
});

test('a streaming session uses its owning runtime after another runtime is configured', async () => {
  const firstAdapter = adapter();
  const secondAdapter = adapter('android');
  const calls = [];
  for (const bridge of [firstAdapter, secondAdapter]) {
    for (const name of ['onStreamingProgress', 'onStreamingChunkDestinationRequested', 'onStreamingFinalizeRequested']) {
      bridge.device[name] = () => ({ remove() {} });
    }
    for (const name of ['resolveStreamingChunkDestination', 'rejectStreamingChunkDestination',
      'resolveStreamingFinalize', 'rejectStreamingFinalize', 'abortStreaming']) bridge.device[name] = async () => {};
    bridge.device.startStreaming = async () => { calls.push(bridge); return { totalBytes: 42 }; };
  }
  const first = createBotaReactNativeRuntime(firstAdapter);
  const second = createBotaReactNativeRuntime(secondAdapter);
  await first.client.configure({});
  await second.client.configure({});
  const session = first.client.recordings.startStreamingSync(
    { id: 'p', serialNumber: 'EXPECTED' }, '11111111-1111-4111-8111-111111111111',
    { createRecording: async () => ({ recordingId: 'rec_test' }) },
  );
  await new Promise((resolve, reject) => { session.once('completed', resolve); session.once('error', reject); });
  assert.deepEqual(calls, [firstAdapter]);
  await first.client.destroy();
  await second.client.destroy();
});

test('unknown adapter contract fails before touching native code', () => {
  assert.throws(() => createBotaReactNativeRuntime({ apiVersion: 2, device: {} }),
    error => error instanceof BotaRuntimeCompatibilityError && error.code === 'native_contract_unsupported');
});

test('missing optional native operation leaves the supported runtime usable', async () => {
  const runtime = createBotaReactNativeRuntime(adapter());
  await runtime.client.configure({});
  assert.equal(runtime.supports('listPendingRecordings'), false);
  await assert.rejects(runtime.sdk.recordings.listPendingRecordings({}),
    error => error.code === 'native_operation_unavailable' && error.operation === 'listPendingRecordings');
  assert.equal(runtime.client.state, 'ready');
  assert.equal(await runtime.sdk.clientPresence.nextReport('optional'), null);
  await runtime.client.destroy();
});

test('a device-only adapter can configure without a native recording journal', async () => {
  const bridge = adapter();
  delete bridge.device.loadCompatibilityUploadQueue;
  delete bridge.device.saveCompatibilityUploadQueue;
  delete bridge.device.stopAllRecordingOperations;
  const runtime = createBotaReactNativeRuntime(bridge);
  await runtime.client.configure({});
  assert.equal(runtime.client.state, 'ready');
  await assert.rejects(runtime.client.recordings.getStorageInfo({}), error =>
    error.code === 'native_operation_unavailable' && error.operation === 'loadCompatibilityUploadQueue');
  await runtime.client.destroy();
});

test('unsupported encrypted workflow fails before subscriptions or device effects', async () => {
  const bridge = adapter();
  let starts = 0;
  bridge.device.syncEncryptedRecordingV2 = async () => { starts++; };
  const runtime = createBotaReactNativeRuntime(bridge);
  assert.equal(runtime.supports('syncEncryptedRecordingV2'), false);
  await assert.rejects(runtime.sdk.recordings.syncEncryptedRecordingV2({}, {}, async () => ({})),
    error => error.code === 'native_operation_unavailable');
  assert.equal(starts, 0);
});

test('JavaScript reconnect policy rejects a different verified device identity', async () => {
  const bridge = adapter();
  let disconnected = 0;
  bridge.device.reconnect = async () => ({ id: 'p', serialNumber: 'OTHER', connectionState: 'connected', mtu: 185 });
  bridge.device.disconnect = async () => { disconnected++; };
  const runtime = createBotaReactNativeRuntime(bridge);
  await assert.rejects(runtime.sdk.devices.reconnect('EXPECTED'),
    error => error.code === 'device_identity_mismatch');
  assert.equal(disconnected, 1);
});

test('foreground retry policy can change without replacing the native adapter', async () => {
  const bridge = adapter();
  let attempts = 0;
  bridge.device.reconnect = async serialNumber => {
    if (++attempts === 1) throw Object.assign(new Error('temporary link loss'), { retryable: true });
    return { id: 'p', serialNumber, connectionState: 'connected', mtu: 185 };
  };
  bridge.device.disconnect = async () => {};
  const runtime = createBotaReactNativeRuntime(bridge, { reconnect: { maxAttempts: 2, delayMs: 0 } });
  assert.equal((await runtime.sdk.devices.reconnect('EXPECTED')).serialNumber, 'EXPECTED');
  assert.equal(attempts, 2);
});

test('destroy cancels JavaScript backoff without another native reconnect', async () => {
  const bridge = adapter();
  let attempts = 0, notifyAttempt;
  const attempted = new Promise(resolve => { notifyAttempt = resolve; });
  bridge.device.reconnect = async () => {
    attempts++; notifyAttempt();
    throw Object.assign(new Error('temporary loss'), { retryable: true });
  };
  bridge.device.disconnect = async () => {};
  const runtime = createBotaReactNativeRuntime(bridge, { reconnect: { maxAttempts: 3, delayMs: 60_000 } });
  const failed = assert.rejects(runtime.sdk.devices.reconnect('EXPECTED'), error => error.code === 'operation_cancelled');
  await attempted;
  await runtime.sdk.destroy();
  await failed;
  assert.equal(attempts, 1);
});

test('permanent errors never trigger foreground retries', async () => {
  const bridge = adapter();
  let attempts = 0;
  bridge.device.reconnect = async () => { attempts++; throw new Error('authorization failed'); };
  bridge.device.disconnect = async () => {};
  const runtime = createBotaReactNativeRuntime(bridge, { reconnect: { maxAttempts: 3, delayMs: 0 } });
  await assert.rejects(runtime.sdk.devices.reconnect('EXPECTED'), /authorization failed/);
  assert.equal(attempts, 1);
});

test('disconnect listeners are removed and recreated once per runtime lifecycle', async () => {
  const bridge = adapter();
  let listeners = 0;
  bridge.device.onDeviceDisconnected = () => {
    listeners++;
    return { remove() { listeners--; } };
  };
  const runtime = createBotaReactNativeRuntime(bridge);
  assert.equal(listeners, 1);
  await runtime.sdk.destroy();
  assert.equal(listeners, 0);
  await runtime.sdk.configure();
  await runtime.sdk.configure();
  assert.equal(listeners, 1);
  await runtime.sdk.destroy();
  assert.equal(listeners, 0);
});

test('partial managed backend cannot request credentials or start preparation', async () => {
  const bridge = adapter();
  let credentials = 0, prepared = 0;
  bridge.encryptedUploadBackend = { prepare: async () => { prepared++; } };
  const runtime = createBotaReactNativeRuntime(bridge);
  const signal = new AbortController().signal;
  const backend = runtime.createEncryptedUploadV2Backend({
    baseUrl: 'https://example.test/dashboard/projects/proj_test', scopeKey: 'test',
    accountId: 'a', projectId: 'proj_test', endUserId: 'eu_test', environment: 'test', signal,
    getAccessToken: async () => { credentials++; return 'token'; },
  });
  await assert.rejects(backend.sync({}, {}, {}), error => error.code === 'native_operation_unavailable');
  assert.equal(credentials, 0);
  assert.equal(prepared, 0);
  await backend.dispose();
});
