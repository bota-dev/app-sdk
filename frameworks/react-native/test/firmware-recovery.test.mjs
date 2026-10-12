import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createBotaReactNativeRuntime } = require('@bota.dev/react-native-app-sdk/runtime');
const device = { id: 'p', serialNumber: 'EXPECTED', deviceType: 'bota_note', firmwareVersion: '1.0.18',
  isProvisioned: true, connectionState: 'connected', mtu: 185 };
const image = { version: '1.0.19', sizeBytes: 42, crc32: 123, url: 'https://example.test/image' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  let report;
  const calls = [], phases = [];
  const bridge = {
    onFirmwareUpdateProgress(callback) { report = callback; return { remove() { calls.push('remove'); } }; },
    async updateFirmware() { report({ phase: 'rebooting', completedUnits: 42, totalUnits: 42 }); throw new Error('lost reboot connection'); },
    async cancelFirmwareUpdate() { calls.push('cancel'); },
    async disconnect() { calls.push('disconnect'); },
    async destroy() { calls.push('destroy'); },
    async reconnect(serial, options) { calls.push(['reconnect', serial, options]); return { ...device, firmwareVersion: image.version }; },
  };
  const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: bridge },
    { firmwareRecovery: { timeoutMs: 1000, delayMs: 0 } });
  return { bridge, runtime, calls, phases, report: event => report(event),
    run: () => runtime.sdk.ota.updateFirmware(device, image, event => phases.push(event.phase)) };
}

test('an older native reboot failure recovers in JavaScript using exact fresh version evidence', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.phases, ['rebooting', 'reconnecting', 'complete']);
  assert.equal(f.calls[0], 'remove');
  const [, serial, budgets] = f.calls[1];
  assert.equal(serial, device.serialNumber);
  assert.ok(budgets.scanTimeoutMs + budgets.connectionTimeoutMs <= 1000);
});

test('transfer/verification failure cannot enter post-reboot recovery', async () => {
  const f = fixture();
  f.bridge.updateFirmware = async () => { f.report({ phase: 'verifying', completedUnits: 42, totalUnits: 42 }); throw new Error('CRC rejected'); };
  await assert.rejects(f.run(), /CRC rejected/);
  assert.deepEqual(f.calls, ['remove']);
  assert.equal(f.phases.includes('complete'), false);
});

test('wrong fresh identity is disconnected and cannot establish installed firmware', async () => {
  const f = fixture();
  f.bridge.reconnect = async () => ({ ...device, serialNumber: 'OTHER', firmwareVersion: image.version });
  await assert.rejects(f.run(), error => error.code === 'device_identity_mismatch');
  assert.deepEqual(f.calls, ['remove', 'disconnect']);
  assert.equal(f.phases.includes('complete'), false);
});

test('a fresh wrong version fails without retransmitting the image', async () => {
  const f = fixture();
  f.bridge.reconnect = async () => device;
  await assert.rejects(f.run(), error => error.code === 'firmware_version_mismatch');
  assert.equal(f.phases.includes('complete'), false);
});

test('explicit permanent failures do not trigger read-back recovery', async () => {
  const f = fixture();
  f.bridge.updateFirmware = async () => {
    f.report({ phase: 'rebooting', completedUnits: 42, totalUnits: 42 });
    throw Object.assign(new Error('permanent'), { retryable: false });
  };
  await assert.rejects(f.run(), /permanent/);
  assert.deepEqual(f.calls, ['remove']);
});

test('cancel coalesces native cleanup and waits for its exact recovery attempt', async () => {
  const f = fixture(), entered = deferred(), reconnect = deferred();
  f.bridge.reconnect = () => { entered.resolve(); return reconnect.promise; };
  f.bridge.disconnect = async () => { f.calls.push('disconnect'); reconnect.reject(new Error('disconnected')); };
  const run = assert.rejects(f.run(), error => error.code === 'operation_cancelled');
  await entered.promise;
  await Promise.all([f.runtime.sdk.ota.cancelFirmwareUpdate(), f.runtime.sdk.ota.cancelFirmwareUpdate()]);
  await run;
  assert.deepEqual(f.calls, ['remove', 'cancel', 'disconnect']);
  assert.equal(f.phases.includes('complete'), false);
});

test('cancel still disconnects its recovery owner when native OTA cancellation rejects', async () => {
  const f = fixture(), entered = deferred(), reconnect = deferred();
  f.bridge.reconnect = () => { entered.resolve(); return reconnect.promise; };
  f.bridge.cancelFirmwareUpdate = async () => { throw new Error('cancel failed'); };
  f.bridge.disconnect = async () => { f.calls.push('disconnect'); reconnect.reject(new Error('disconnected')); };
  const run = assert.rejects(f.run(), error => error.code === 'operation_cancelled');
  await entered.promise;
  await assert.rejects(f.runtime.sdk.ota.cancelFirmwareUpdate(), /cancel failed/);
  await run;
  assert.deepEqual(f.calls, ['remove', 'disconnect']);
  await assert.rejects(f.runtime.sdk.devices.disconnect(), error => error.code === 'operation_in_progress');
  await f.runtime.sdk.destroy();
  assert.deepEqual(f.calls, ['remove', 'disconnect', 'destroy']);
});

test('manual connection changes cannot steal the JavaScript firmware recovery owner', async () => {
  const f = fixture(), started = deferred(), native = deferred();
  f.bridge.updateFirmware = () => { started.resolve(); return native.promise; };
  const run = f.run();
  await started.promise;
  await assert.rejects(f.runtime.sdk.devices.disconnect(), error => error.code === 'operation_in_progress');
  native.resolve();
  await run;
  assert.deepEqual(f.calls, ['remove']);
});

test('time spent in native post-verification recovery consumes the same deadline', async () => {
  const f = fixture();
  const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: f.bridge },
    { firmwareRecovery: { timeoutMs: 1, delayMs: 0 } });
  f.bridge.updateFirmware = async () => {
    f.report({ phase: 'reconnecting', completedUnits: 42, totalUnits: 42 });
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('native budget consumed');
  };
  await assert.rejects(runtime.sdk.ota.updateFirmware(device, image), /native budget consumed/);
  assert.deepEqual(f.calls, ['remove']);
});

test('late progress delivery cannot create a fresh JavaScript recovery budget', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let elapsed = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => elapsed } });
  try {
    const f = fixture();
    const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: f.bridge },
      { firmwareRecovery: { timeoutMs: 20, delayMs: 0 } });
    f.bridge.updateFirmware = async () => {
      elapsed = 25;
      f.report({ phase: 'rebooting', completedUnits: 42, totalUnits: 42 });
      throw new Error('delayed event');
    };
    await assert.rejects(runtime.sdk.ota.updateFirmware(device, image), /delayed event/);
    assert.deepEqual(f.calls, ['remove']);
  } finally {
    Object.defineProperty(globalThis, 'performance', previous);
  }
});
