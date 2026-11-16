import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { JsDeviceControls } = loadSource('deviceControls.ts');
const ssid = 'Audit-Network';
const connected = Buffer.concat([Buffer.from([2, 80, Buffer.byteLength(ssid)]), Buffer.from(ssid)]);

// Only BLE I/O is simulated: codec dispatch, cryptography, subscriptions and
// terminal cleanup use the same generated runtime and host as the mobile app.
function fixture(t, version = 3, beforeReceipt) {
  const vector = JSON.parse(readFileSync(new URL(
    `../../../../../protocol/wifi-config-v${version}.vector.json`, import.meta.url), 'utf8'));
  const r = vector.response;
  t.mock.method(Date, 'now', () => Date.parse(r.expires_at) - 1000);
  const core = createGeneratedJsCore();
  const meta = core.codec('protocolMetadata', {});
  const device = { id: 'wifi-fixture', serialNumber: r.serial_number, mtu: 185 };
  const controller = new AbortController();
  const context = { operation: 'DeviceControl', operationId: 'wifi', requestId: '0',
    cancellationId: '01'.repeat(16), generation: '1', signal: controller.signal };
  const listeners = new Set(), events = [];
  const notify = bytes => { for (const callback of [...listeners]) callback(bytes); };
  const receipt = Buffer.from(vector.successHex, 'hex');
  const ble = {
    async read(address) {
      if (address.characteristicUuid === meta.CHAR_SERIAL_NUMBER) return Buffer.from(r.serial_number);
      if (address.characteristicUuid === meta.CHAR_AUTH_NONCE) return Buffer.from(r.auth_nonce, 'hex');
      if (address.characteristicUuid === meta.CHAR_WIFI_STATUS) return connected;
      return Uint8Array.from(version === 2 ? [0xb2, 2, 7, 0, 253, 1, 126, 0] : [0xb2, 3, 7, 0, 29, 2, 126, 0]);
    },
    async subscribe(address, callback) {
      assert.equal(address.characteristicUuid, meta.CHAR_WIFI_STATUS);
      listeners.add(callback);
      return { async remove() { listeners.delete(callback); } };
    },
    async write(address) {
      if (address.characteristicUuid === meta.CHAR_WIFI_CREDENTIAL) {
        beforeReceipt?.(notify);
        notify(receipt);
      }
    },
  };
  const controls = new JsDeviceControls({ core, ports: { ble, persistence: { namespace: 'wifi-test' } },
    connection: () => ({ device, generation: '1' }), gatt: (_ctx, body) => body(),
    emit: (name, value) => events.push({ name, value }) });
  t.after(async () => { await controls.close(); core.dispose(); });
  const grant = { format: r.format, grantBlob: r.envelope_base64, keyBase64: r.key_base64,
    requestId: r.request_id, authNonce: r.auth_nonce, action: r.action, serialNumber: r.serial_number,
    bindingGeneration: r.binding_generation, expiresAt: r.expires_at };
  return { core, controls, device, context, controller, listeners, events, notify, receipt, ble, meta, grant,
    observe: () => controls.execute('startWiFiStatusUpdates', [device], context),
    configure: () => controls.execute('configureSecureWiFi', [device, ssid, '', JSON.stringify(grant)], context) };
}

test('generated WiFi notification codec is reachable, separates receipts and rejects malformed status', t => {
  const f = fixture(t);
  assert.deepEqual(f.core.codec('decodeWiFiStatusEvent', { bytes: [...connected] }),
    f.core.codec('decodeWiFiStatus', { bytes: [...connected] }));
  assert.equal(f.core.codec('decodeWiFiStatusEvent', { bytes: [...f.receipt] }), null);
  assert.throws(() => f.core.codec('decodeWiFiStatusEvent', { bytes: [2, 80, 32, 65] }));
});

for (const version of [2, 3]) for (const order of ['before', 'after']) {
  test(`v${version} authenticated receipt preserves status subscription (${order} connection notification)`, async t => {
    const f = fixture(t, version, order === 'before' ? notify => notify(connected) : undefined);
    await f.observe();
    assert.equal((await f.configure()).success, true);
    assert.equal(f.listeners.size, 1, 'only the temporary receipt listener is removed');
    if (order === 'after') f.notify(connected);
    assert.equal(f.events.length, 1, 'receipt must not become a connection event');
    assert.equal(f.events[0].name, 'onWiFiStatusUpdated');
    assert.equal(f.events[0].value.status, 'connected');
    assert.equal(f.events[0].value.ssid, ssid);
    f.notify(Buffer.from([4]));
    assert.equal(f.events[1].value.status, 'disconnected');
    await f.controls.execute('stopWiFiStatusUpdates', [], f.context);
    f.notify(connected);
    assert.equal(f.events.length, 2, 'stopped observers cannot publish late status');
    assert.equal(f.listeners.size, 0);
  });
}

test('receipt alone never fabricates connected state and a later failure remains visible', async t => {
  const f = fixture(t);
  await f.observe();
  assert.equal((await f.configure()).success, true);
  assert.deepEqual(f.events, []);
  f.notify(Buffer.from([3]));
  assert.equal(f.events[0].value.status, 'failed');
});

test('connected status without SSID does not invent the submitted network', async t => {
  const f = fixture(t);
  await f.observe();
  await f.configure();
  f.notify(Buffer.from([2]));
  assert.equal(f.events[0].value.status, 'connected');
  assert.ok(f.events[0].value.ssid == null);
});

test('tampered receipt fails authentication without retiring the independent status observer', async t => {
  const f = fixture(t);
  await f.observe();
  f.receipt[28] ^= 1;
  await assert.rejects(f.configure(), error => error.code === 'integrity_failed');
  assert.equal(f.listeners.size, 1);
  f.notify(connected);
  assert.equal(f.events[0].value.ssid, ssid);
});

test('retired observer ignores late WiFi status even if transport removal is pending', async t => {
  const f = fixture(t);
  await f.observe();
  f.controller.abort();
  f.notify(connected);
  assert.deepEqual(f.events, []);
});

for (const platform of ['android', 'ios']) test(`${platform} public DeviceManager delivers decoded WiFi status after secure setup`,
  { timeout: 10000 }, async t => {
    const f = fixture(t), saved = new Map(), statuses = [];
    const read = f.ble.read;
    f.ble.read = async address => {
      const identity = new Map([[f.meta.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
        [f.meta.CHAR_FIRMWARE_REVISION, Buffer.from('1.0.20')],
        [f.meta.CHAR_HARDWARE_REVISION, Buffer.from('test')],
        [f.meta.CHAR_PAIRING_STATE, Uint8Array.of(2)]]);
      return identity.get(address.characteristicUuid) ?? read(address);
    };
    const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
    const runtime = createBotaReactNativeJsRuntime({ apiVersion: 1, platform,
      randomBytes: length => Uint8Array.from({ length }, (_, i) => i + 1),
      persistence: { namespace: `wifi-integration/${platform}`,
        async load(key) { return saved.get(key) ?? null; }, async save(key, value) { saved.set(key, value); },
        async remove(key) { saved.delete(key); } },
      ble: { ...f.ble, async connect() {}, async disconnect() {}, async discoverServices() {},
        async getMtu() { return 185; }, async hasService() { return true; },
        async scan() { return { async remove() {} }; } },
    });
    t.after(() => runtime.client.destroy());
    await runtime.client.configure({ logLevel: 'none', backgroundSyncEnabled: false });
    const manager = runtime.client.devices;
    const device = await manager.connect({ id: f.device.id, rssi: -40, discoveredAt: new Date() });
    assert.equal(device.capabilities.wifiUpload, true);
    const subscription = manager.subscribeToWiFiStatus(device.id, value => statuses.push(value));
    const result = await manager.configureSecureWiFi(device.id, { ssid, password: '' }, f.grant);
    assert.equal(result.success, true);
    assert.equal(f.listeners.size, 1);
    assert.deepEqual(statuses, []);
    f.notify(connected);
    assert.equal(statuses[0].status, 'connected');
    assert.equal(statuses[0].ssid, ssid);
    assert.equal(manager.getCachedWiFiStatus(device.serialNumber).ssid, ssid);
    subscription.remove();
  });
