import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { BotaClient } = require('../lib/commonjs/BotaClient.js');
const { DeviceManager } = require('../lib/commonjs/managers/DeviceManager.js');
const { setCompatibilityClientForTesting } = require('../lib/commonjs/compatibility/runtime.js');
const report = { schemaVersion: 1, sessionId: 'session', sequence: 1, platform: 'android', sdkPackage: '@bota.dev/react-native-app-sdk', sdkVersion: 'candidate' };
afterEach(() => setCompatibilityClientForTesting(null));

test('compatibility presence is available before configuration and returns unavailable', async () => {
  assert.equal(await BotaClient.clientPresence.nextReport('device'), null);
});

test('DeviceManager maps native presence without exposing native field names and drops late destruction', async () => {
  let resolve;
  setCompatibilityClientForTesting({ clientPresence: { nextReport: async () => report }, devices: {} });
  const manager = new DeviceManager();
  assert.deepEqual(await manager.clientPresence.nextReport('device'), {
    schema_version: 1, session_id: 'session', sequence: 1, platform: 'android',
    sdk_package: '@bota.dev/react-native-app-sdk', sdk_version: 'candidate',
  });
  setCompatibilityClientForTesting(null);
  await manager.destroy();
  assert.equal(await manager.clientPresence.nextReport('device'), null);
  setCompatibilityClientForTesting({ clientPresence: { nextReport: () => new Promise(r => { resolve = r; }) }, devices: {} });
  const late = new DeviceManager();
  const pending = late.clientPresence.nextReport('device');
  await late.destroy(); resolve(report);
  assert.equal(await pending, null);
});

test('fresh observation rejects reconnect and scope changes during the BLE read', async () => {
  const { readClientPresenceObservation } = require('../lib/commonjs/clientPresence.js');
  const base = { schema_version: 1, session_id: 'old', sequence: 1, platform: 'android', sdk_package: 'sdk', sdk_version: 'version' };
  let current = true; let session = 'old'; let reads = 0;
  const presence = { nextReport: async () => ({ ...base, session_id: session }) };
  const observe = readStatus => readClientPresenceObservation({ presence, deviceId: 'd', isCurrent: () => current, readStatus });
  assert.equal(await observe(async () => { session = 'new'; return {}; }), null);
  assert.equal(await observe(async () => { current = false; return {}; }), null);
  assert.equal(await observe(async () => { reads++; return {}; }), null);
  assert.equal(reads, 0);
  current = true;
  assert.deepEqual(await observe(async () => ({ battery: 80 })), { status: { battery: 80 }, clientContext: { ...base, session_id: 'new' } });
});
