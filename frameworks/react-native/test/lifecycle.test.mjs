import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  BotaNativeModuleError,
  createBotaDeviceSDK,
} = require('../lib/commonjs/client.js');

test('missing native code fails only when a lifecycle operation is invoked', async () => {
  const client = createBotaDeviceSDK(null);

  await assert.rejects(client.getCapabilities(), (error) => {
    assert.ok(error instanceof BotaNativeModuleError);
    assert.equal(error.code, 'native_module_unavailable');
    return true;
  });
});

test('configure delegates the exact low-volume configuration', async () => {
  const calls = [];
  const nativeModule = {
    async configure(configuration) {
      calls.push(['configure', configuration]);
    },
    async destroy() {},
    async getCapabilities() {
      return {};
    },
    async getState() {
      return 'ready';
    },
  };
  const client = createBotaDeviceSDK(nativeModule);
  const configuration = {
    applicationSupportDirectory: '/native/app-support',
    logLevel: 'debug',
  };

  await client.configure(configuration);

  assert.deepEqual(calls, [['configure', configuration]]);
});

test('destroy and state queries delegate to the linked native module', async () => {
  const calls = [];
  const capabilities = {
    backgroundReconnect: true,
    backgroundScan: false,
    bluetooth: true,
    nativeFileTransfer: true,
    platform: 'ios',
  };
  const nativeModule = {
    async configure() {},
    async destroy() {
      calls.push('destroy');
    },
    async getCapabilities() {
      calls.push('getCapabilities');
      return capabilities;
    },
    async getState() {
      calls.push('getState');
      return 'ready';
    },
  };
  const client = createBotaDeviceSDK(nativeModule);

  assert.deepEqual(await client.getCapabilities(), capabilities);
  assert.equal(await client.getState(), 'ready');
  await client.destroy();

  assert.deepEqual(calls, ['getCapabilities', 'getState', 'destroy']);
});
