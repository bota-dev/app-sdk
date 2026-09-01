import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { OTAManager } = require('../lib/commonjs/managers/OTAManager.js');
const { setCompatibilityClientForTesting } = require(
  '../lib/commonjs/compatibility/runtime.js'
);

const originalFetch = globalThis.fetch;
const originalXMLHttpRequest = globalThis.XMLHttpRequest;

afterEach(() => {
  setCompatibilityClientForTesting(null);
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
  MockXMLHttpRequest.instances = [];
});

test('OTAManager checks the CDN and emits only a newer semantic version', async () => {
  const fake = createFakeOTAClient();
  setCompatibilityClientForTesting(fake.client);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return firmware;
      },
    };
  };
  const manager = new OTAManager(fake.deviceManager, 'https://cdn.example/fw');
  const progress = [];
  const available = [];
  manager.on('progress', (deviceId, value) => progress.push([deviceId, value]));
  manager.on('updateAvailable', (value) => available.push(value));

  assert.equal(await manager.checkForUpdate(device), firmware);
  assert.deepEqual(requests, [
    'https://cdn.example/fw/latest?device_type=bota_note&current=1.0.9',
  ]);
  assert.deepEqual(progress, [
    ['device-1', { stage: 'checking', progress: 0 }],
  ]);
  assert.deepEqual(available, [firmware]);

  globalThis.fetch = async () => ({ ok: false, status: 404 });
  assert.equal(await manager.checkForUpdate(device), null);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...firmware, version: '1.0.9.0' };
    },
  });
  assert.equal(await manager.checkForUpdate(device), null);
});

test('OTAManager downloads an ArrayBuffer and preserves byte progress', async () => {
  const fake = createFakeOTAClient();
  setCompatibilityClientForTesting(fake.client);
  globalThis.XMLHttpRequest = MockXMLHttpRequest;
  const manager = new OTAManager(fake.deviceManager);
  const progress = [];

  const download = manager.downloadFirmware(firmware, (loaded, total) => {
    progress.push([loaded, total]);
  });
  const request = MockXMLHttpRequest.instances[0];
  assert.deepEqual(request.opened, ['GET', firmware.url]);
  assert.equal(request.responseType, 'arraybuffer');
  assert.equal(request.sent, 1);
  request.onprogress?.({ loaded: 64, total: 0, lengthComputable: false });
  const bytes = new ArrayBuffer(firmware.size);
  request.status = 200;
  request.response = bytes;
  request.onload?.();

  assert.equal(await download, bytes);
  assert.deepEqual(progress, [[64, firmware.size]]);
});

test('OTAManager keeps performUpdate native and translates phases', async () => {
  const fake = createFakeOTAClient();
  setCompatibilityClientForTesting(fake.client);
  const manager = new OTAManager(fake.deviceManager);
  const progress = [];
  const completed = [];
  manager.on('progress', (_deviceId, value) => progress.push(value));
  manager.on('completed', (deviceId, version) => completed.push([deviceId, version]));

  await manager.performUpdate(device, firmware, 'ota-grant');

  assert.deepEqual(fake.calls.slice(0, 2).map((call) => call[0]), [
    'writeGrant',
    'updateFirmware',
  ]);
  assert.deepEqual(fake.image, {
    version: firmware.version,
    sizeBytes: firmware.size,
    crc32: 0,
    url: firmware.url,
  });
  assert.deepEqual(progress.map((value) => value.stage), [
    'downloading',
    'preparing',
    'updating',
    'verifying',
    'restarting',
    'restarting',
    'completed',
  ]);
  assert.deepEqual(completed, [['device-1', firmware.version]]);

  manager.destroy();
  manager.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.cancelCount, 1);
  assert.equal(manager.listenerCount('progress'), 0);
});

const device = {
  id: 'device-1',
  serialNumber: 'EVFXXW67KP',
  deviceType: 'bota_note',
  firmwareVersion: '1.0.9',
  isProvisioned: true,
  connectionState: 'connected',
  mtu: 247,
};

const firmware = {
  version: '1.0.10',
  url: 'https://s3.example/update.ufw',
  checksum: 'd'.repeat(64),
  releaseNotes: 'Stability fixes',
  size: 256,
};

function createFakeOTAClient() {
  const fake = {
    calls: [],
    image: null,
    cancelCount: 0,
  };
  fake.deviceManager = {
    async writeGrant(_device, grantBlob) {
      fake.calls.push(['writeGrant', grantBlob]);
    },
  };
  fake.client = {
    ota: {
      async updateFirmware(_device, image, onProgress) {
        fake.calls.push(['updateFirmware']);
        fake.image = image;
        for (const phase of [
          'downloading',
          'awaiting_device',
          'transferring',
          'verifying',
          'rebooting',
          'reconnecting',
          'complete',
        ]) {
          onProgress?.({ phase, completedBytes: 50, totalBytes: 100 });
        }
      },
      async cancelFirmwareUpdate() {
        fake.cancelCount += 1;
      },
    },
  };
  return fake;
}

class MockXMLHttpRequest {
  static instances = [];

  status = 0;
  response = null;
  responseType = '';
  onprogress = null;
  onload = null;
  onerror = null;
  onabort = null;
  opened = null;
  sent = 0;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method, url) {
    this.opened = [method, url];
  }

  send() {
    this.sent += 1;
  }
}
