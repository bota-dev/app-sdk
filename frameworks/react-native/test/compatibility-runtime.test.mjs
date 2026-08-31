import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateFixtureCase } from '../../../tools/baseline/compare-react-native.mjs';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const {
  BLE_ERROR_STORAGE_KEY_UNAVAILABLE,
} = require('../lib/commonjs/ble/constants.js');
const { DeviceLogDecoder } = require('../lib/commonjs/ble/deviceLogs.js');
const { deriveSyncStatus } = require('../lib/commonjs/sync/syncStatus.js');
const {
  BluetoothError,
  BotaError,
  TransferError,
  isBotaError,
} = require('../lib/commonjs/utils/errors.js');

const logPacket = (sequence, flags, text) => {
  const payload = Buffer.from(text, 'utf8');
  const packet = Buffer.alloc(payload.length + 3);
  packet.writeUInt16LE(sequence, 0);
  packet[2] = flags;
  payload.copy(packet, 3);
  return packet;
};

test('compatibility errors preserve stable names, codes, and ownership', () => {
  const unavailable = BluetoothError.unavailable();
  const encrypted = TransferError.deviceError(
    'recording-id',
    BLE_ERROR_STORAGE_KEY_UNAVAILABLE
  );

  assert.ok(unavailable instanceof BotaError);
  assert.equal(unavailable.name, 'BluetoothError');
  assert.equal(unavailable.code, 'BLUETOOTH_UNAVAILABLE');
  assert.equal(encrypted.code, 'STORAGE_KEY_UNAVAILABLE');
  assert.equal(encrypted.recordingUuid, 'recording-id');
  assert.equal(isBotaError(encrypted), true);
  assert.equal(isBotaError(new Error('outside SDK')), false);
});

test('device log decoder preserves split UTF-8 lines and sequence recovery', () => {
  const decoder = new DeviceLogDecoder();

  assert.deepEqual(decoder.push(logPacket(10, 0, 'partial')), []);
  assert.deepEqual(decoder.push(logPacket(12, 0, 'fresh\n')), [
    { level: 'debug', message: 'fresh', isBacklog: false },
  ]);
  assert.deepEqual(decoder.push(logPacket(13, 0x01, 'old\r\n')), [
    { level: 'debug', message: 'old', isBacklog: true },
  ]);
});

test('device log decoder matches every canonical compatibility fixture', () => {
  const suite = JSON.parse(
    readFileSync(
      resolve(workspaceRoot, 'protocol/fixtures/device-logs.json'),
      'utf8'
    )
  );

  for (const fixtureCase of suite.cases.filter(
    (entry) => entry.operation === 'decodeDeviceLogs'
  )) {
    assert.doesNotThrow(() =>
      evaluateFixtureCase(fixtureCase, { DeviceLogDecoder })
    );
  }
});

test('sync status preserves transport precedence and preference order', () => {
  const base = {
    appDriving: { active: true, currentIndex: 2, total: 5 },
    bleConnected: true,
    device: {
      syncActive: true,
      isRecording: false,
      wifiConnected: true,
      lteConnected: false,
      wifiAttempting: false,
      lteAttempting: false,
      streamingEnabled: false,
    },
  };

  assert.deepEqual(deriveSyncStatus(base), {
    kind: 'wifi_upload',
    channel: 'WiFi',
    currentIndex: 2,
    total: 5,
    label: 'Uploading 2/5 via WiFi...',
    shortLabel: 'WiFi uploading 2/5',
  });
  assert.equal(
    deriveSyncStatus({
      ...base,
      device: {
        ...base.device,
        isRecording: true,
        streamingEnabled: true,
        uploadPreference: ['ble', 'wifi', 'cellular'],
        enabledConnections: { wifi: true, cellular: false },
      },
    }).channel,
    'Bluetooth'
  );
});
