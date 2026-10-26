import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsDeviceAdapter } = loadSource('deviceAdapter.ts');

function fixture(options = {}) {
  const core = createGeneratedJsCore();
  const metadata = core.codec('protocolMetadata', {});
  const calls = [];
  const saved = new Map();
  const values = new Map([
    [metadata.CHAR_SERIAL_NUMBER, Buffer.from('C8SU2XXWHI')],
    [metadata.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
    [metadata.CHAR_FIRMWARE_REVISION, Buffer.from('1.2.3')],
    [metadata.CHAR_HARDWARE_REVISION, Buffer.from('rev1')],
    [metadata.CHAR_PAIRING_STATE, Uint8Array.of(2)],
  ]);
  const unusedFile = async () => { throw new Error('Unexpected file IO'); };
  const ports = { apiVersion: 1, platform: 'ios', randomBytes: length => Uint8Array.from({ length }, (_, index) => index + 1),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.files ? { files: { open: unusedFile, metadata: unusedFile, append: unusedFile, truncate: unusedFile,
      read: unusedFile, finalize: unusedFile, remove: unusedFile, ...options.files } } : {}),
    ...(options.network ? { network: options.network } : {}),
    persistence: { namespace: 'account/project/user', async load(key) { return saved.get(key) ?? null; },
      async save(key, value) { saved.set(key, value); }, async remove(key) { saved.delete(key); } },
    ble: {
      async scan() { return { async remove() { calls.push('stop-scan'); } }; },
      async connect(id) { calls.push(['connect', id]); }, async discoverServices(id) { calls.push(['discover', id]); },
      async disconnect(id) { calls.push(['disconnect', id]); }, async getMtu() { return 247; },
      async read(address) { calls.push(['read', address]); const value = values.get(address.characteristicUuid);
        if (!value) throw new Error(`No fixture for ${address.characteristicUuid}`); return Uint8Array.from(value); },
      async write(address, bytes) { calls.push(['write', address, Array.from(bytes)]); },
      async subscribe() { return { async remove() {} }; },
    },
  };
  return { core, calls, saved, values, metadata, ports, adapter: createJsDeviceAdapter(core, ports, options.adapterOptions) };
}
for (const serialMatches of [true, false]) {
  test(`system-connected nonadvertising candidate ${serialMatches ? 'reconnects after' : 'is rejected by'} Rust serial verification`,
    { timeout: 5000 }, async () => {
      const f = fixture(), expected = 'C8SU2XXWHI', connects = [], reads = [], disconnects = [];
      if (!serialMatches) f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('OTHER00001'));
      const { createBlePlxPort } = loadSource('blePlx.ts');
      const peripheral = { id: 'system-note', name: 'Bota Note', rssi: null, mtu: 247,
        async discoverAllServicesAndCharacteristics() { return this; } };
      f.ports.ble = createBlePlxPort({
        startDeviceScan() {}, stopDeviceScan() {},
        async connectedDevices() { return [peripheral]; },
        async connectToDevice(id) { connects.push(id); return peripheral; },
        async cancelDeviceConnection(id) { disconnects.push(id); return peripheral; },
        async requestMTUForDevice() { return peripheral; },
        async readCharacteristicForDevice(_id, _service, characteristic) {
          reads.push(characteristic);
          const value = f.values.get(characteristic);
          if (!value) throw new Error(`No fixture for ${characteristic}`);
          return { value: Buffer.from(value).toString('base64') };
        },
        async writeCharacteristicWithResponseForDevice() { return {}; },
        onDeviceDisconnected() { return { remove() {} }; },
        monitorCharacteristicForDevice() { return { remove() {} }; },
        cancelTransaction() {},
      });
      try {
        await f.adapter.configure({});
        const reconnecting = f.adapter.reconnect(expected, { scanTimeoutMs: 10, connectionTimeoutMs: 1000 });
        if (serialMatches) {
          const device = await reconnecting;
          assert.equal(device.serialNumber, expected);
          assert.equal(device.id, peripheral.id);
        } else {
          await assert.rejects(reconnecting, error => error.code === 'device_not_found');
          assert.deepEqual(disconnects, [peripheral.id]);
        }
        assert.deepEqual(connects, [peripheral.id]);
        assert.equal(reads[0], f.metadata.CHAR_SERIAL_NUMBER);
      } finally { await f.adapter.destroy(); f.core.dispose(); }
    });
}

const writesBeyondTimeSync = f => f.calls.filter(call => Array.isArray(call) && call[0] === 'write'
  && call[1].characteristicUuid !== f.metadata.CHAR_TIME_SYNC);

function controlFixture(options = {}) {
  const f = fixture(options);
  f.values.set(f.metadata.CHAR_DEVICE_STATUS, Buffer.from('3200000200000000290004000163', 'hex'));
  const settings = f.core.codec('decodeConnectionSettings', { bytes: [2, 3, 1, 2, 3, 18, 18, 0, 60, 131, 0, 0] });
  const gate = () => {
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    return { entered, pending, release, enter };
  };
  return { ...f, settings, gate };
}

async function connectionOwnershipFixture(t, { samePeripheral = false } = {}) {
  const f = controlFixture(), observers = new Map(), removed = [], statusReads = [];
  const oldSerial = 'PIN0000001', nextSerial = 'NOTE000001';
  const oldId = 'pin', nextId = samePeripheral ? oldId : 'note';
  let selectedSerial = oldSerial;
  const read = f.ports.ble.read;
  f.ports.ble.read = async (address, ...args) => {
    const serial = address.peripheralId === nextId && (!samePeripheral || selectedSerial === nextSerial) ? nextSerial : oldSerial;
    if (address.characteristicUuid === f.metadata.CHAR_SERIAL_NUMBER) return Buffer.from(serial);
    if (address.characteristicUuid === f.metadata.CHAR_MODEL_NUMBER) return Buffer.from(serial === oldSerial ? 'bota_pin' : 'bota_note');
    if (address.characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) {
      const bytes = Buffer.from(f.values.get(f.metadata.CHAR_DEVICE_STATUS));
      bytes[0] = serial === oldSerial ? 23 : 91;
      statusReads.push(address.peripheralId);
      return bytes;
    }
    return read(address, ...args);
  };
  f.ports.ble.observeDisconnect = async (id, listener) => {
    observers.set(id, listener);
    return { async remove() { if (observers.get(id) === listener) observers.delete(id); } };
  };
  f.ports.ble.disconnect = async id => { f.calls.push(['disconnect', id]); observers.get(id)?.(); };
  f.ports.ble.scan = async (_duplicates, candidate) => {
    candidate({ peripheral_id: nextId, name: 'Bota Note', advertised_address: null, rssi: -50 });
    return { async remove() {} };
  };
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  await runtime.client.configure({ logLevel: 'none', backgroundSyncEnabled: false });
  const manager = runtime.client.devices;
  manager.on('deviceDisconnected', id => removed.push(id));
  t.after(async () => {
    await manager.pauseAutoReconnect().catch(() => {});
    for (const device of manager.getConnectedDevices()) await manager.disconnect(device).catch(() => {});
    await runtime.client.destroy().catch(() => {});
    await f.adapter.destroy().catch(() => {});
    f.core.dispose();
  });
  return { ...f, runtime, manager, observers, removed, statusReads, oldId, nextId, oldSerial, nextSerial,
    connectOld: () => manager.connect({ id: oldId, rssi: -50, discoveredAt: new Date(0) }),
    connectNext: method => {
      selectedSerial = nextSerial;
      return method === 'reconnect' ? manager.reconnect(nextSerial, { scanTimeout: 1_000 })
        : manager.connect({ id: nextId, rssi: -50, discoveredAt: new Date(0) });
    } };
}

for (const method of ['connect', 'reconnect']) {
  test(`real manager ${method} replacement retires the previous link before publishing the new owner`, { timeout: 5000 }, async t => {
    const f = await connectionOwnershipFixture(t), old = await f.connectOld();
    const lateDisconnect = f.observers.get(old.id);
    const current = await f.connectNext(method);
    assert.deepEqual(f.manager.getConnectedDevices(), [current]);
    assert.equal(f.manager.isConnected(old.id), false);
    assert.deepEqual(f.removed, [old.id]);
    const before = f.calls.length;
    await assert.rejects(f.manager.getStatus(old), error => error.code === 'NOT_CONNECTED');
    await assert.rejects(f.manager.disconnect(old), error => error.code === 'NOT_CONNECTED');
    assert.equal(f.calls.length, before, 'stale handles must not read or disconnect the replacement');
    lateDisconnect();
    assert.deepEqual(f.manager.getConnectedDevices(), [current], 'a late old callback cannot retire the replacement');
    assert.equal((await f.manager.getStatus(current)).batteryLevel, 91);
    assert.deepEqual(f.statusReads, [current.id]);
    await f.manager.disconnect(current);
    assert.deepEqual(f.manager.getConnectedDevices(), []);
  });
}

test('real manager rejects a stale serial when a replacement reuses the peripheral ID', { timeout: 5000 }, async t => {
  const f = await connectionOwnershipFixture(t, { samePeripheral: true }), old = await f.connectOld();
  const current = await f.connectNext('connect'), before = f.calls.length;
  await assert.rejects(f.manager.getStatus(old), error => error.code === 'NOT_CONNECTED');
  await assert.rejects(f.manager.disconnect(old), error => error.code === 'NOT_CONNECTED');
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.manager.getConnectedDevices(), [current]);
});

test('failed new adoption leaves the already released previous device retired', { timeout: 5000 }, async t => {
  const f = await connectionOwnershipFixture(t), old = await f.connectOld();
  const connect = f.ports.ble.connect;
  f.ports.ble.connect = async (id, context) => { if (id === f.nextId) throw new Error('synthetic new connection failure'); await connect(id, context); };
  await assert.rejects(f.connectNext('connect'));
  assert.deepEqual(f.manager.getConnectedDevices(), []);
  assert.deepEqual(f.removed, [old.id]);
  await assert.rejects(f.manager.getStatus(old), error => error.code === 'NOT_CONNECTED');
});

test('intentional replacement does not enqueue an automatic reconnect to the departed serial', { timeout: 5000 }, async t => {
  const f = await connectionOwnershipFixture(t);
  await f.connectOld();
  f.manager.enableAutoReconnect(f.oldSerial);
  // An ordinary read joins the actual watchdog setup before replacement starts.
  await f.manager.getStatus(f.manager.getConnectedDevices()[0]);
  const current = await f.connectNext('connect');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.manager.getConnectedDevices(), [current]);
  assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'connect').map(value => value[1]), [f.oldId, f.nextId]);
  assert.deepEqual(f.removed, [f.oldId]);
});

test('failed replacement cleanup never publishes a new connection or pretends the previous disconnect succeeded', { timeout: 5000 }, async t => {
  const f = await connectionOwnershipFixture(t), old = await f.connectOld();
  const failure = new Error('synthetic old disconnect failure');
  f.ports.ble.disconnect = async () => { throw failure; };
  await assert.rejects(f.connectNext('connect'));
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.manager.getConnectedDevices(), [old]);
  assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === 'connect' && value[1] === f.nextId), false);
});

test('manager disconnect rechecks its captured owner after asynchronous subscription removal', async () => {
  const { DeviceManager } = loadSource('../managers/DeviceManager.ts');
  const { withCompatibilityClient, reportCompatibilityDisconnection } = loadSource('../compatibility/runtime.ts');
  const old = { id: 'old', serialNumber: 'OLD0000001', connectionState: 'connected' };
  const next = { id: 'next', serialNumber: 'NEXT000001', connectionState: 'connected' };
  let release, entered, current, disconnects = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const removing = new Promise(resolve => { entered = resolve; });
  const client = { devices: {
    async connect(device) { if (current) reportCompatibilityDisconnection(client); current = device; return device; },
    async disconnect() { disconnects++; current = undefined; },
    async subscribeToStatus() { return { async remove() { entered(); await blocked; } }; },
  } };
  const manager = withCompatibilityClient(client, () => new DeviceManager());
  try {
    await manager.connect(old);
    manager.subscribeToStatus(old, () => {});
    const disconnecting = manager.disconnect(old);
    const rejected = assert.rejects(disconnecting, error => error.code === 'NOT_CONNECTED');
    await removing;
    await manager.connect(next);
    release(); await rejected;
    assert.equal(disconnects, 0);
    assert.deepEqual(manager.getConnectedDevices(), [next]);
  } finally { release(); manager.destroy(); }
});

test('actual runtime log unsubscribe joins scope-retired STOP and destruction without false cleanup failure', { timeout: 5000 }, async () => {
  const scope = new AbortController(), f = controlFixture({ signal: scope.signal });
  const submitted = f.gate(), removed = f.gate();
  const write = f.ports.ble.write;
  f.ports.ble.write = async (...args) => {
    await write(...args);
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_LOG_CONTROL && args[1][0] === 0) {
      submitted.enter(); await submitted.pending;
    }
  };
  f.ports.ble.subscribe = async address => ({ async remove() {
    if (address.characteristicUuid === f.metadata.CHAR_DEVICE_LOG_DATA) {
      removed.enter(); await removed.pending;
    }
  } });
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  let destruction;
  try {
    await runtime.client.configure({ logLevel: 'none' });
    const device = await runtime.client.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    const subscription = await runtime.sdk.logs.subscribe(device, () => {});
    const unsubscribing = subscription.remove();
    const cancelled = assert.rejects(unsubscribing, error => ['scope_changed', 'operation_cancelled', 'stale_host_owner'].includes(error.code));
    await submitted.entered;
    scope.abort();
    let settled = false;
    destruction = runtime.client.destroy().finally(() => { settled = true; });
    void destruction.catch(() => {});
    submitted.release(); await removed.entered;
    assert.equal(settled, false, 'destroy must join the captured monitor removal');
    removed.release(); await cancelled; await destruction;
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'disconnect').length, 1);
  } finally {
    submitted.release(); removed.release();
    await destruction?.catch(() => {}); await runtime.client.destroy().catch(() => {});
    await f.adapter.destroy(); f.core.dispose();
  }
});

test('real DeviceManager observes retired log removals and preserves genuine cleanup failures', { timeout: 5000 }, async () => {
  for (const mode of ['unsubscribe', 'destroy', 'remove-failure', 'remove-cancelled-failure', 'remove-scope_changed-failure', 'disconnect-failure']) {
    const scope = new AbortController(), f = controlFixture({ signal: scope.signal }), submitted = f.gate();
    const failure = Object.assign(new Error(`synthetic ${mode}`), {
      code: mode === 'remove-cancelled-failure' ? 'cancelled' : mode === 'remove-scope_changed-failure' ? 'scope_changed' : 'cleanup_incomplete' });
    const write = f.ports.ble.write;
    f.ports.ble.write = async (...args) => {
      await write(...args);
      if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_LOG_CONTROL && args[1][0] === 0) {
        submitted.enter(); await submitted.pending;
      }
    };
    f.ports.ble.subscribe = async address => ({ async remove() {
      if (mode.startsWith('remove-') && address.characteristicUuid === f.metadata.CHAR_DEVICE_LOG_DATA) throw failure;
    } });
    if (mode === 'disconnect-failure') f.ports.ble.disconnect = async () => { throw failure; };
    const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
    const runtime = createBotaReactNativeJsRuntime(f.ports), logs = [];
    let destruction;
    try {
      await runtime.client.configure({ logLevel: 'debug' });
      runtime.client.setLogHandler(entry => logs.push(entry));
      const device = await runtime.client.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
      const unsubscribe = await runtime.client.devices.subscribeToDeviceLogs(device, () => {});
      if (mode !== 'destroy') { unsubscribe(); await submitted.entered; }
      scope.abort();
      destruction = runtime.client.destroy(); void destruction.catch(() => {});
      submitted.release();
      if (mode.endsWith('failure')) await assert.rejects(destruction, error => error === failure);
      else await destruction;
      await new Promise(resolve => setImmediate(resolve));
      if (mode.startsWith('remove-')) assert(logs.some(entry => entry.level === 'error' && entry.message.includes('device log subscription')));
    } finally {
      submitted.release(); await destruction?.catch(() => {}); await runtime.client.destroy().catch(() => {});
      runtime.client.setLogHandler(null); await f.adapter.destroy(); f.core.dispose();
    }
  }
});

test('reconnect joins timed-out late connection IO and exact disconnect before verifying the next candidate', { timeout: 5000 }, async () => {
  for (const holdDisconnect of [false, true]) {
  const f = controlFixture(), connecting = f.gate(), disconnecting = f.gate();
  const submitted = [];
  f.ports.ble.scan = async (_duplicates, candidate) => {
    for (const id of ['timed-out', 'next-probe']) candidate({ peripheral_id: id, name: 'Bota Note', advertised_address: null, rssi: id === 'timed-out' ? -40 : -50 });
    return { async remove() {} };
  };
  const connect = f.ports.ble.connect, disconnect = f.ports.ble.disconnect;
  f.ports.ble.connect = async (...args) => {
    submitted.push(['connect', args[0]]);
    if (args[0] === 'timed-out') { connecting.enter(); await connecting.pending; }
    await connect(...args);
  };
  f.ports.ble.disconnect = async (...args) => {
    submitted.push(['disconnect', args[0]]);
    if (args[0] === 'timed-out') { disconnecting.enter(); if (holdDisconnect) await disconnecting.pending; }
    await disconnect(...args);
  };
  let running;
  try {
    await f.adapter.configure({});
    running = f.adapter.reconnect('C8SU2XXWHI', { scanTimeoutMs: 1, connectionTimeoutMs: 10 });
    void running.catch(() => {});
    await connecting.entered;
    await new Promise(resolve => setTimeout(resolve, 30));
    connecting.release();
    await Promise.race([disconnecting.entered, running]);
    if (holdDisconnect) {
      assert.deepEqual(submitted, [['connect', 'timed-out'], ['disconnect', 'timed-out']]);
      assert.equal(f.saved.has('connection/C8SU2XXWHI'), false);
    }
    disconnecting.release();
    const device = await running;
    assert.equal(device.id, 'next-probe'); assert.equal(device.serialNumber, 'C8SU2XXWHI');
    assert.deepEqual(submitted, [['connect', 'timed-out'], ['disconnect', 'timed-out'], ['connect', 'next-probe']]);
  } finally {
    connecting.release(); disconnecting.release(); await running?.catch(() => {});
    await f.adapter.destroy(); f.core.dispose();
  }
  }
});

test('timed-out reconnect cleanup failure prevents another candidate and retains uncertain teardown', { timeout: 5000 }, async () => {
  const f = controlFixture(), connecting = f.gate(); const submitted = [];
  const failure = Object.assign(new Error('Exact timed-out link cleanup failed'), { code: 'cleanup_incomplete' });
  f.ports.ble.scan = async (_duplicates, candidate) => {
    for (const id of ['timed-out', 'next-probe']) candidate({ peripheral_id: id, name: 'Bota Note', advertised_address: null, rssi: id === 'timed-out' ? -40 : -50 });
    return { async remove() {} };
  };
  f.ports.ble.connect = async id => { submitted.push(id); connecting.enter(); await connecting.pending; };
  f.ports.ble.disconnect = async () => { throw failure; };
  let running;
  try {
    await f.adapter.configure({});
    running = f.adapter.reconnect('C8SU2XXWHI', { scanTimeoutMs: 1, connectionTimeoutMs: 10 });
    const rejected = assert.rejects(running, error => error === failure);
    await connecting.entered;
    await new Promise(resolve => setTimeout(resolve, 30));
    connecting.release(); await rejected;
    assert.deepEqual(submitted, ['timed-out']);
    assert.equal(f.saved.has('connection/C8SU2XXWHI'), false);
    await assert.rejects(f.adapter.syncTime({ id: 'next-probe', serialNumber: 'C8SU2XXWHI' }), { code: 'cleanup_incomplete' });
    await assert.rejects(f.adapter.destroy(), error => error === failure);
  } finally { connecting.release(); await running?.catch(() => {}); await f.adapter.destroy().catch(() => {}); f.core.dispose(); }
});

test('real DeviceManager watchdog startup orders initial reads and settings behind monitor readiness', { timeout: 5000 }, async () => {
  const f = controlFixture();
  const monitor = f.gate();
  const subscribe = f.ports.ble.subscribe;
  f.ports.ble.subscribe = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { monitor.enter(); await monitor.pending; }
    return subscribe(...args);
  };
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  let reading, writing;
  try {
    await runtime.client.configure({ logLevel: 'none' });
    const device = await runtime.client.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    runtime.client.devices.enableAutoReconnect(device.serialNumber);
    await monitor.entered;
    reading = runtime.client.devices.getStatus(device);
    writing = runtime.client.devices.writeConnectionSettings(device, {
      enabled_connections: { wifi: true, cellular: true },
      heartbeat_enabled_connections: { wifi: true, cellular: true },
      upload_network_preference: ['wifi', 'ble', 'cellular'],
      power_management: { cellular_idle_timeout_seconds: 180, wifi_idle_timeout_seconds: 180 },
      streaming_enabled: false, streaming_flush_interval_seconds: 60,
    });
    // Both failures are observed immediately on the preceding single-claim implementation.
    void reading.catch(() => {}); void writing.catch(() => {});
    monitor.release();
    const [status] = await Promise.all([reading, writing]);
    assert.equal(status.batteryLevel, 50);
    assert.equal(writesBeyondTimeSync(f).filter(call => call[1].characteristicUuid === f.metadata.CHAR_DEVICE_SETTINGS).length, 1);
  } finally {
    monitor.release(); await Promise.allSettled([reading, writing]);
    await runtime.client.destroy(); await f.adapter.destroy(); f.core.dispose();
  }
});

test('ordinary control FIFO captures mutation arguments and orders read settings and subscription IO', { timeout: 5000 }, async () => {
  const f = controlFixture();
  const held = f.gate();
  const read = f.ports.ble.read;
  f.ports.ble.read = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { held.enter(); await held.pending; }
    return read(...args);
  };
  let reading, writing, watching;
  try {
    await f.adapter.configure({});
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    reading = f.adapter.readStatus(); await held.entered;
    const requested = { ...device }, settings = structuredClone(f.settings);
    writing = f.adapter.writeConnectionSettings(requested, settings);
    watching = f.adapter.startStatusUpdates();
    void writing.catch(() => {}); void watching.catch(() => {});
    requested.id = 'foreign'; requested.serialNumber = 'OTHERDEVICE'; settings.enabledConnections.wifi = false;
    assert.equal(writesBeyondTimeSync(f).length, 0);
    held.release(); await Promise.all([reading, writing, watching]);
    const writes = writesBeyondTimeSync(f).filter(call => call[1].characteristicUuid === f.metadata.CHAR_DEVICE_SETTINGS);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0][2], f.core.codec('encodeConnectionSettings', { settings: f.settings, model: 'note' }));
    assert.equal(writes[0][1].peripheralId, 'selected');
  } finally { held.release(); await Promise.allSettled([reading, writing, watching]); await f.adapter.destroy(); f.core.dispose(); }
});

test('ordinary controls refuse a workflow at submission even when it finishes before the next microtask', { timeout: 5000 }, async () => {
  const f = controlFixture();
  try {
    await f.adapter.configure({});
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    await f.adapter.startScan(10_000, false);
    const rejected = assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
    await f.adapter.stopScan(); await rejected;
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write').length, 1);
  } finally { await f.adapter.destroy(); f.core.dispose(); }
});

test('discovery publishes only the structured manufacturer model, never a local-name inference', async () => {
  const f = fixture();
  const devices = [];
  f.ports.ble.advertisementMetadata = id => id === 'note' ? { deviceType: 'bota_note', serialSuffix: '67KP' } : undefined;
  f.ports.ble.scan = async (_duplicates, candidate) => {
    candidate({ peripheral_id: 'note', name: 'Bota Note 67KP', advertised_address: null, rssi: -40 });
    candidate({ peripheral_id: 'legacy-name', name: 'Bota Note FAKE', advertised_address: null, rssi: -50 });
    return { async remove() {} };
  };
  const subscription = f.adapter.onDeviceDiscovered(value => devices.push(value));
  try {
    await f.adapter.configure({});
    await f.adapter.startScan(1_000, false);
    assert.equal(devices[0].deviceType, 'bota_note');
    assert.equal(devices[0].name, 'Bota Note 67KP');
    assert.equal(devices[1].deviceType, undefined);
  } finally {
    await f.adapter.stopScan().catch(() => {});
    subscription.remove();
    await f.adapter.destroy();
    f.core.dispose();
  }
});

test('ordinary controls cannot queue behind connection identity adoption', { timeout: 5000 }, async () => {
  const f = controlFixture(); const held = f.gate(); const write = f.ports.ble.write;
  f.ports.ble.write = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_TIME_SYNC) { held.enter(); await held.pending; }
    return write(...args);
  };
  let connecting;
  try {
    await f.adapter.configure({});
    connecting = f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    await held.entered;
    const rejected = assert.rejects(f.adapter.syncTime({ id: 'selected', serialNumber: 'C8SU2XXWHI' }), { code: 'operation_in_progress' });
    held.release(); await connecting; await rejected;
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write').length, 1);
  } finally { held.release(); await connecting?.catch(() => {}); await f.adapter.destroy(); f.core.dispose(); }
});

test('ordinary control admission bounds pending work while preserving every accepted call', { timeout: 5000 }, async () => {
  const f = controlFixture(); const held = f.gate(); const read = f.ports.ble.read;
  f.ports.ble.read = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { held.enter(); await held.pending; }
    return read(...args);
  };
  let reading; const queued = [];
  try {
    await f.adapter.configure({});
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    reading = f.adapter.readStatus(); await held.entered;
    for (let index = 0; index < 32; index++) queued.push(f.adapter.syncTime(device));
    await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write').length, 1);
    held.release(); await Promise.all([reading, ...queued]);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write').length, 33);
  } finally { held.release(); await Promise.allSettled([reading, ...queued]); await f.adapter.destroy(); f.core.dispose(); }
});

test('disconnect destroy and logout reject queued writes and STOP before joining ignored active cancellation', { timeout: 5000 }, async () => {
  for (const mode of ['disconnect', 'destroy', 'logout']) {
    const scope = new AbortController();
    const f = controlFixture({ signal: scope.signal }); const held = f.gate(); const read = f.ports.ble.read;
    f.ports.ble.read = async (...args) => {
      if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { held.enter(); await held.pending; }
      return read(...args);
    };
    let reading, teardown;
    try {
      await f.adapter.configure({});
      const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
      await f.adapter.startStatusUpdates();
      reading = f.adapter.readStatus(); const readRejected = assert.rejects(reading); await held.entered;
      const code = mode === 'logout' ? 'scope_changed' : 'operation_cancelled';
      const writeRejected = assert.rejects(f.adapter.writeConnectionSettings(device, f.settings), { code });
      const stopRejected = assert.rejects(f.adapter.stopStatusUpdates(), { code });
      let settled = false;
      if (mode === 'logout') scope.abort();
      teardown = (mode === 'disconnect' ? f.adapter.disconnect() : f.adapter.destroy()).then(() => { settled = true; });
      await Promise.all([writeRejected, stopRejected]);
      assert.equal(settled, false, `${mode} must still join the submitted read`);
      assert.equal(writesBeyondTimeSync(f).length, 0);
      held.release(); await teardown; await readRejected;
      assert.equal(settled, true);
    } finally { held.release(); await Promise.allSettled([reading, teardown]); await f.adapter.destroy(); f.core.dispose(); }
  }
});

test('physical generation loss rejects queued mutations before a replacement can reuse the same peripheral', { timeout: 5000 }, async () => {
  const f = controlFixture(); const held = f.gate(); const read = f.ports.ble.read;
  let onDisconnect;
  f.ports.ble.observeDisconnect = async (_id, callback) => { onDisconnect = callback; return { async remove() {} }; };
  f.ports.ble.read = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { held.enter(); await held.pending; }
    return read(...args);
  };
  let reading;
  try {
    await f.adapter.configure({});
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    const oldDisconnect = onDisconnect;
    reading = f.adapter.readStatus(); const rejected = assert.rejects(reading); await held.entered;
    const writeRejected = assert.rejects(f.adapter.writeConnectionSettings(device, f.settings), { code: 'operation_cancelled' });
    oldDisconnect(); await writeRejected;
    assert.equal(writesBeyondTimeSync(f).length, 0);
    held.release(); await rejected;
    const replacement = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    oldDisconnect(); await f.adapter.syncTime(replacement);
    assert.equal(writesBeyondTimeSync(f).length, 0);
  } finally { held.release(); await reading?.catch(() => {}); await f.adapter.destroy(); f.core.dispose(); }
});

test('uncertain ordinary cleanup poisons queued and future controls without replaying mutations', { timeout: 5000 }, async () => {
  const f = controlFixture(); const held = f.gate(); const read = f.ports.ble.read;
  const failure = Object.assign(new Error('Submitted read ownership uncertain'), { code: 'cleanup_incomplete' });
  f.ports.ble.read = async (...args) => {
    if (args[0].characteristicUuid === f.metadata.CHAR_DEVICE_STATUS) { held.enter(); await held.pending; throw failure; }
    return read(...args);
  };
  let reading;
  try {
    await f.adapter.configure({});
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    reading = f.adapter.readStatus(); const rejected = assert.rejects(reading, error => error === failure); await held.entered;
    const queued = assert.rejects(f.adapter.writeConnectionSettings(device, f.settings), { code: 'cleanup_incomplete' });
    held.release(); await Promise.all([rejected, queued]);
    await assert.rejects(f.adapter.syncTime(device), { code: 'cleanup_incomplete' });
    assert.equal(writesBeyondTimeSync(f).length, 0);
    await assert.rejects(f.adapter.destroy(), error => error === failure);
  } finally { held.release(); await reading?.catch(() => {}); await f.adapter.destroy().catch(() => {}); f.core.dispose(); }
});

test('restarted uploads reopen the original shared task/sink UUID and preserve older unmatched files', async () => {
  for (const sharedIdentity of [true, false]) {
    const durableFiles = new Map(), opened = [], uploads = [];
    const sinkId = '11111111-2222-4333-8444-555555555555';
    const taskId = sharedIdentity ? sinkId : 'older-independent-task';
    const options = { fetch: async () => { throw new Error('No cloud completion belongs to this file-only fixture'); },
      uploadFile: async (_target, handle, _context, progress) => { uploads.push(handle.id); progress?.('4', '4'); } };
    const f = fixture({ adapterOptions: options, files: {
      async open(logicalId, kind) {
        opened.push(logicalId);
        if (!durableFiles.has(logicalId)) durableFiles.set(logicalId, new Uint8Array());
        return { id: logicalId, kind, scope: 'account/project/user' };
      },
      async metadata(handle) { return { localPath: `owned-opaque-file:${handle.id}`, durableUnits: String(durableFiles.get(handle.id).length) }; },
      async append(handle, _offset, bytes) { durableFiles.set(handle.id, bytes.slice()); return { durableUnits: String(bytes.length) }; },
      async remove() { throw new Error('Retained files must not be deleted by upload admission'); },
    } });
    let restarted;
    try {
      await f.adapter.configure({ logLevel: 'none' });
      const file = await f.ports.files.open(`recording/${sinkId}`, 'file');
      await f.ports.files.append(file, '0', Uint8Array.of(1, 2, 3, 4));
      const localPath = (await f.ports.files.metadata(file)).localPath;
      await f.adapter.saveCompatibilityUploadQueue(JSON.stringify([{ id: taskId, recordingId: 'rec_existing', deviceId: 'ble-selected',
        recordingUuid: '11111111-0000-0000-0000-000000000000', localPath, fileSizeBytes: 4, status: 'pending', retryCount: 0,
        createdAt: '2026-10-15T17:00:00Z', updatedAt: '2026-10-15T17:00:00Z' }]));
      const queueBefore = await f.adapter.loadCompatibilityUploadQueue();
      await f.adapter.destroy();
      restarted = createJsDeviceAdapter(f.core, f.ports, options);
      await restarted.configure({ logLevel: 'none' });
      const request = { taskId: `${taskId}_attempt`, recordingId: 'rec_existing', deviceId: 'ble-selected', localPath,
        fileSizeBytes: 4, uploadUrl: 'https://storage.example.test/owned-file' };
      if (sharedIdentity) {
        await restarted.uploadRecordingFile(request);
        assert.deepEqual(uploads, [`recording/${sinkId}`]);
        assert.deepEqual(opened, [`recording/${sinkId}`, `recording/${sinkId}`]);
      } else {
        await assert.rejects(restarted.uploadRecordingFile(request), error => error.code === 'foreign_file_handle');
        assert.equal(uploads.length, 0);
        assert.equal(durableFiles.get(`recording/${taskId}`).length, 0);
      }
      assert.deepEqual(durableFiles.get(`recording/${sinkId}`), Uint8Array.of(1, 2, 3, 4));
      assert.equal(await restarted.loadCompatibilityUploadQueue(), queueBefore);
    } finally { await restarted?.destroy(); await f.adapter.destroy(); f.core.dispose(); }
  }
});

test('generated adoption joins automatic UTC time sync before publishing the public connection', { timeout: 5000 }, async () => {
  const f = fixture();
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = f.ports.ble.write;
  f.ports.ble.write = async (address, bytes, response, context) => {
    await write(address, bytes, response, context);
    if (address.characteristicUuid === f.metadata.CHAR_TIME_SYNC) { start(); await gate; }
  };
  let connected = 0, connecting;
  try {
    await runtime.client.configure({ logLevel: 'none' });
    runtime.client.devices.on('deviceConnected', () => { connected++; });
    connecting = runtime.client.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    await Promise.race([started, connecting]);
    assert.equal(connected, 0);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write'
      && call[1].characteristicUuid === f.metadata.CHAR_TIME_SYNC).length, 1);
    release();
    await connecting;
    assert.equal(connected, 1);
  } finally { release(); await connecting?.catch(() => {}); await runtime.client.destroy(); await f.adapter.destroy(); f.core.dispose(); }
});

test('generated adoption remains best effort when settled legacy firmware rejects the time write', async () => {
  const f = fixture();
  let attempted = 0;
  f.ports.ble.write = async address => {
    assert.equal(address.characteristicUuid, f.metadata.CHAR_TIME_SYNC);
    attempted++;
    throw new Error('Legacy firmware has no TIME_SYNC characteristic');
  };
  try {
    await f.adapter.configure({ logLevel: 'none' });
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    assert.equal(attempted, 1);
    assert.equal(device.serialNumber, 'C8SU2XXWHI');
    assert.ok(await f.adapter.nextClientPresence('selected'));
  } finally { await f.adapter.destroy(); f.core.dispose(); }
});

test('automatic time sync cannot swallow uncertain cleanup or admit a replacement owner', async () => {
  const f = fixture();
  const failure = Object.assign(new Error('Time write cancellation uncertain'), { code: 'cleanup_incomplete' });
  f.ports.ble.write = async address => {
    assert.equal(address.characteristicUuid, f.metadata.CHAR_TIME_SYNC);
    throw failure;
  };
  await f.adapter.configure({ logLevel: 'none' });
  await assert.rejects(f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 }));
  assert.equal(await f.adapter.nextClientPresence('selected'), null);
  await assert.rejects(f.adapter.syncTime({ id: 'selected', serialNumber: 'C8SU2XXWHI' }), { code: 'cleanup_incomplete' });
  await assert.rejects(f.adapter.destroy(), { code: 'cleanup_incomplete' });
  f.core.dispose();
});

test('scope cancellation during automatic time sync waits for submitted IO and publishes no connection', { timeout: 5000 }, async () => {
  const f = fixture();
  const scope = new AbortController();
  f.ports.signal = scope.signal;
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.ports.ble.write = async address => {
    assert.equal(address.characteristicUuid, f.metadata.CHAR_TIME_SYNC);
    start(); await gate;
  };
  let connected = 0, settled = false, connecting;
  try {
    await runtime.client.configure({ logLevel: 'none' });
    runtime.client.devices.on('deviceConnected', () => { connected++; });
    connecting = runtime.client.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    const rejected = assert.rejects(connecting).then(() => { settled = true; });
    await Promise.race([started, connecting]);
    scope.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(connected, 0);
    release();
    await rejected;
    assert.equal(connected, 0);
    assert.deepEqual(runtime.client.devices.getConnectedDevices(), []);
  } finally { release(); await connecting?.catch(() => {}); await runtime.client.destroy(); await f.adapter.destroy(); f.core.dispose(); }
});

test('real generated connection workflow verifies physical serial and builds native-compatible DTOs', async () => {
  const f = fixture();
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', name: 'Bota spoofable', rssi: -60, discoveredAtMs: 0 });
  assert.deepEqual(device, { id: 'selected', serialNumber: 'C8SU2XXWHI', deviceType: 'Bota Note', firmwareVersion: '1.2.3',
    hardwareRevision: 'rev1', isProvisioned: true, connectionState: 'connected', mtu: 247 });
  assert.equal(f.saved.get('connection/C8SU2XXWHI').candidate.peripheral_id, 'selected');
  const presence = await f.adapter.nextClientPresence('selected');
  assert.equal(presence.platform, 'ios');
  assert.equal(await f.adapter.nextClientPresence('other'), null);
  await f.adapter.disconnect();
  assert.equal(await f.adapter.nextClientPresence('selected'), null);
  await f.adapter.destroy();
});

test('incompatible installed ports fail before constructing an engine or acquiring resources', () => {
  let engines = 0;
  assert.throws(() => createJsDeviceAdapter({ createEngine() { engines++; }, codec() { throw new Error('unused'); } },
    { apiVersion: 2 }), { code: 'host_contract_unsupported' });
  assert.equal(engines, 0);
});

test('the generated runtime factory executes public device operations without WebAssembly or NativeModules', async () => {
  const f = fixture();
  const previousWasm = globalThis.WebAssembly, previousNative = globalThis.NativeModules;
  let runtime;
  try {
    globalThis.WebAssembly = undefined;
    globalThis.NativeModules = new Proxy({}, { get() { throw new Error('Full native Bota SDK must not be consulted'); } });
    const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
    runtime = createBotaReactNativeJsRuntime(f.ports);
    await runtime.sdk.configure({ logLevel: 'none' });
    const device = await runtime.sdk.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    await runtime.sdk.controls.syncTime(device);
    assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'write'));
    assert.equal(runtime.supports('syncRecording'), false);
    await runtime.sdk.destroy();
    runtime = undefined;
  } finally {
    await runtime?.sdk.destroy();
    globalThis.WebAssembly = previousWasm;
    globalThis.NativeModules = previousNative;
    await f.adapter.destroy();
    f.core.dispose();
  }
});

test('a custom public JS provider can register material under its exact operation and cancellation fences it before device IO', { timeout: 5000 }, async () => {
  const f = fixture({ files: { async flush() {} } });
  const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  f.values.set(f.metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2,
    Uint8Array.from([1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0]));
  const controller = new AbortController();
  const operationId = '11112233-4455-6677-8899-aabbccddeeff';
  let registrationId;
  try {
    await runtime.sdk.configure({ logLevel: 'none' });
    const device = await runtime.sdk.devices.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
    await assert.rejects(runtime.sdk.recordings.syncEncryptedRecordingV2(device, {
      uuid: '00112233-4455-6677-8899-aabbccddeeff', generation: 9, ciphertextLength: '330',
      ciphertextSha256: '33'.repeat(32), storageFormat: 3,
    }, async request => {
      assert.equal(request.operationId, operationId);
      registrationId = runtime.registerEncryptedUploadV2Material(operationId, {
        async authorization() { throw new Error('Cancelled material must not be used'); },
        async stageCiphertext() { throw new Error('Cancelled ciphertext must not be uploaded'); },
        async submitManifest() {}, async finalize() {}, async completionReceipt() { throw new Error('No receipt'); },
      });
      controller.abort();
      return { profile: 'encrypted_upload_v2', uploadSessionId: '22112233-4455-6677-8899-aabbccddeeff',
        ownerRevision: 1, securityPolicy: 'v2_required', materialRegistrationId: registrationId };
    }, undefined, { operationId, signal: controller.signal }));
    assert.match(registrationId, /^js-material\//);
    assert.equal(writesBeyondTimeSync(f).length, 0);
    assert.throws(() => runtime.registerEncryptedUploadV2Material(operationId, {}), { code: 'stale_material_request' });
    await runtime.releaseEncryptedUploadV2Material(registrationId);
  } finally { await runtime.sdk.destroy(); await f.adapter.destroy(); f.core.dispose(); }
});

test('offline compatibility retry reopens the original queued file identity before upload and exact completed cleanup', async () => {
  const opens = [], uploads = [], removes = [];
  const f = fixture({ files: {
    async open(id, kind) { opens.push(id); return { id, kind, scope: 'account/project/user' }; },
    async metadata() { return { durableUnits: '4', localPath: 'owned-file' }; },
    async remove(handle) { removes.push(handle.id); },
  }, adapterOptions: {
    async fetch(url) { return { status: 200, url, async text() { return '{}'; } }; },
    async uploadFile(target, handle, _context, progress) { uploads.push({ target, handle }); progress?.('4', '4'); },
  } });
  const task = { id: 'base-id', recordingId: 'rec_1', deviceId: 'dev_1', localPath: 'owned-file', fileSizeBytes: 4,
    status: 'pending', retryCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  try {
    await f.adapter.configure({ logLevel: 'none' });
    await f.adapter.saveCompatibilityUploadQueue(JSON.stringify([task]));
    await f.adapter.uploadRecordingFile({ taskId: 'base-id_attempt', recordingId: 'rec_1', deviceId: 'dev_1',
      localPath: 'owned-file', fileSizeBytes: 4, uploadUrl: 'https://storage.example.test/object?signature=1' });
    assert.deepEqual(opens, ['recording/base-id']);
    assert.equal(uploads[0].handle.id, 'recording/base-id');
    await assert.rejects(f.adapter.releaseRecordingFile('base-id', 'owned-file'));
    assert.equal(removes.length, 0);
    await f.adapter.saveCompatibilityUploadQueue(JSON.stringify([{ ...task, status: 'completed' }]));
    await f.adapter.releaseRecordingFile('base-id', 'owned-file');
    assert.deepEqual(removes, ['recording/base-id']);
    assert.equal(writesBeyondTimeSync(f).length, 0);
  } finally { await f.adapter.destroy(); f.core.dispose(); }
});

test('destroy closes new device admission while captured file upload cancellation is still draining', { timeout: 5000 }, async () => {
  let entered, sawAbort, release;
  const uploaded = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { sawAbort = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const f = fixture({ files: {
    async open(id, kind) { return { id, kind, scope: 'account/project/user' }; },
    async metadata() { return { durableUnits: '4', localPath: 'owned-file' }; },
  }, adapterOptions: {
    async fetch(url) { return { status: 200, url, async text() { return '{}'; } }; },
    async uploadFile(_target, _handle, context) {
      context.signal.addEventListener('abort', sawAbort, { once: true });
      entered(); await cleanup;
    },
  } });
  let destruction;
  try {
    await f.adapter.configure({ logLevel: 'none' });
    const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
    await f.adapter.saveCompatibilityUploadQueue(JSON.stringify([{ id: 'base-id', recordingId: 'rec_1',
      deviceId: 'dev_1', localPath: 'owned-file', fileSizeBytes: 4, status: 'pending', retryCount: 0,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]));
    const upload = f.adapter.uploadRecordingFile({ taskId: 'base-id_attempt', recordingId: 'rec_1', deviceId: 'dev_1',
      localPath: 'owned-file', fileSizeBytes: 4, uploadUrl: 'https://storage.example.test/object?signature=1' });
    const uploadRejected = assert.rejects(upload);
    await uploaded;
    let destroyed = false;
    destruction = f.adapter.destroy().then(() => { destroyed = true; });
    await aborted;
    assert.equal(destroyed, false);
    const calls = f.calls.length;
    await assert.rejects(async () => f.adapter.syncTime(device), error =>
      ['not_configured', 'runtime_destroyed'].includes(error.code));
    await assert.rejects(f.adapter.configure({ logLevel: 'none' }), { code: 'runtime_destroyed' });
    assert.equal(f.calls.length, calls);
    release();
    await Promise.all([destruction, uploadRejected]);
    assert.equal(destroyed, true);
  } finally { release(); await destruction?.catch(() => {}); await f.adapter.destroy(); f.core.dispose(); }
});

function byoAdapterFixture(options = {}) {
  const f = fixture();
  const listeners = new Map();
  f.ports.ble.subscribe = async (address, callback) => {
    listeners.set(address.characteristicUuid, callback);
    return { async remove() { f.calls.push(['remove-byo-subscription', address.characteristicUuid]); listeners.delete(address.characteristicUuid); } };
  };
  f.ports.ble.write = async (address, bytes) => {
    f.calls.push(['write', address, [...bytes]]);
    if (address.characteristicUuid === f.metadata.CHAR_DEVICE_COMMAND) await options.grant?.();
    if (address.characteristicUuid === f.metadata.CHAR_RECORDING_CONTROL) listeners.get(f.metadata.CHAR_RECORDING_STATUS)(new Uint8Array(18));
    if (address.characteristicUuid === f.metadata.CHAR_TRANSFER_CONTROL_V2) {
      const reply = Buffer.alloc(12);
      reply.set([0x71, 3, bytes[2], 0]);
      reply.writeUInt32LE(Buffer.from(bytes).readUInt32LE(4), 4);
      listeners.get(f.metadata.CHAR_RECORDING_TRANSFER_V2)(Uint8Array.from(reply));
    }
  };
  return f;
}

test('a BYO live lease permits shared-policy Stop Recording and keeps unrelated controls exclusive', { timeout: 5000 }, async () => {
  const f = byoAdapterFixture();
  let entered, release;
  const active = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  const live = f.adapter.withByoDevice(device, 'byo-live-owner', true, controller.signal, async () => { entered(); await gate; return 'finished'; });
  try {
    await Promise.race([active, live]);
    const count = f.calls.length;
    await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
    assert.equal(f.calls.length, count);
    assert.deepEqual(await f.adapter.requestStopRecording(device, Buffer.alloc(171, 1).toString('base64')), { success: true });
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[1].characteristicUuid === f.metadata.CHAR_RECORDING_CONTROL).length, 1);
    release(); assert.equal(await live, 'finished');
    const abort = f.core.codec('byoHostPolicy', { mode: 'sync', selectedLive: false }).releaseOperation;
    assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[1].characteristicUuid === f.metadata.CHAR_TRANSFER_CONTROL_V2)
      .map(call => call[2][2]), [abort]);
  } finally { release(); await live.catch(() => {}); await f.adapter.destroy(); f.core.dispose(); }
});

test('BYO cancellation joins an already submitted borrowed grant and suppresses its Stop Recording command', { timeout: 5000 }, async () => {
  let entered, release, grantEntered, grantRelease;
  const active = new Promise(resolve => { entered = resolve; });
  const bodyGate = new Promise(resolve => { release = resolve; });
  const grant = new Promise(resolve => { grantEntered = resolve; });
  const grantGate = new Promise(resolve => { grantRelease = resolve; });
  const f = byoAdapterFixture({ async grant() { grantEntered(); await grantGate; } });
  const controller = new AbortController();
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  const live = f.adapter.withByoDevice(device, 'byo-cancelled-owner', true, controller.signal, async () => { entered(); await bodyGate; });
  void live.catch(() => {});
  try {
    await Promise.race([active, live]);
    const stopping = f.adapter.requestStopRecording(device, Buffer.alloc(171, 1).toString('base64'));
    const rejectedStop = assert.rejects(stopping);
    await Promise.race([grant, stopping]);
    controller.abort(); release();
    await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
    grantRelease(); await rejectedStop; await assert.rejects(live);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[1].characteristicUuid === f.metadata.CHAR_RECORDING_CONTROL).length, 0);
  } finally { release(); grantRelease(); await live.catch(() => {}); await f.adapter.destroy(); f.core.dispose(); }
});

function otaFixture(options = {}) {
  const imageBytes = Uint8Array.of(1, 2, 3);
  const storage = new Map();
  const registrations = [], unregisters = [], observers = new Map();
  let f, notifyStatus, failStatus, rebooted = false, storedAttempts = 0;
  const files = {
    async open(id, kind) { const handle = { id, kind, scope: 'account/project/user' }; storage.set(id, imageBytes); return handle; },
    async metadata(handle) { return { durableUnits: String(storage.get(handle.id).length) }; },
    async read(handle, offset, maximum) { return storage.get(handle.id).slice(Number(offset), Number(offset) + maximum); },
    async append() { throw new Error('Unexpected append'); }, async truncate() {}, async finalize() { throw new Error('Unexpected finalize'); }, async remove() {},
  };
  const network = {
    async registerDownload(id, url, handle, context) { registrations.push({ id, url, handle, context }); await options.register?.(); },
    async unregister(id, context) { unregisters.push({ id, context }); await options.unregister?.(); },
    async download(_id, progress) { progress('3', '3'); return { crc32: 0x11223344 }; },
    async upload() { throw new Error('Unexpected upload'); },
  };
  f = fixture({ files, network, adapterOptions: options.adapterOptions });
  const start = f.core.codec('encodeFirmwareUploadStart', { size: 3 })[0];
  const verify = f.core.codec('encodeFirmwareVerify', { crc32: 0x11223344 })[0];
  const data = f.core.codec('encodeFirmwareData', { sequence: 0, payload: [...imageBytes] })[0];
  f.ports.ble.observeDisconnect = async (id, callback) => {
    observers.set(id, callback);
    return { async remove() { f.calls.push(['remove-observer', id]); if (observers.get(id) === callback) observers.delete(id); } };
  };
  f.ports.ble.subscribe = async (address, callback, _context, onError) => {
    assert.equal(address.characteristicUuid, f.metadata.CHAR_TRANSFER_STATUS);
    notifyStatus = callback; failStatus = onError;
    return { async remove() { f.calls.push(['remove-status']); } };
  };
  f.ports.ble.scan = async (_duplicates, candidate) => {
    const id = options.samePeripheral || options.connect ? 'original' : 'rebooted';
    queueMicrotask(() => candidate({ peripheral_id: id, name: 'Bota Note', advertised_address: null, rssi: -40 }));
    return { async remove() { f.calls.push(['remove-scan']); } };
  };
  f.ports.ble.connect = async id => {
    f.calls.push(['connect', id]);
    if (rebooted && id === 'original') {
      storedAttempts++;
      if (options.connect) await options.connect();
      if (!options.samePeripheral) throw new Error('Stored peripheral no longer available');
    }
  };
  f.ports.ble.discoverServices = async id => {
    f.calls.push(['discover', id]);
    if (rebooted && options.lateOldDisconnect && id === 'original') observers.get('original')?.('delayed old-link disconnect');
  };
  f.ports.ble.write = async (address, bytes) => {
    f.calls.push(['write', address, [...bytes]]);
    if (bytes[0] === start) {
      if (options.beforeVerifyDisconnect) observers.get('original')('disconnected before verification');
      else notifyStatus(Uint8Array.from(f.core.codec('encodeOtaStatus', { command: start, result: 0, sequence: null })));
    }
    if (bytes[0] === verify) notifyStatus(Uint8Array.from(f.core.codec('encodeOtaStatus', { command: verify, result: 0, sequence: null })));
  };
  f.adapter.onFirmwareUpdateProgress(value => {
    if (value.phase === 'rebooting') {
      rebooted = true;
      f.values.set(f.metadata.CHAR_FIRMWARE_REVISION, Buffer.from('9.0.0'));
      if (options.monitorFailure) failStatus(Object.assign(new Error('stream closed for reboot'), { platformCode: -7 }));
      else observers.get('original')();
    }
  });
  return { ...f, registrations, unregisters, observers, image: { version: '9.0.0', sizeUnits: 3,
    crc32: 0x11223344, url: 'https://firmware.example.test/firmware.bin' }, data,
    storedAttempts: () => storedAttempts };
}

test('generated OTA routes an expected reboot disconnect, adopts a changed peripheral, and never retransmits verified bytes', async () => {
  const f = otaFixture();
  const progress = [];
  f.adapter.onFirmwareUpdateProgress(value => progress.push(value));
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  const oldObserver = f.observers.get('original');
  await f.adapter.updateFirmware(device, f.image);
  assert.equal(f.storedAttempts(), 0); // Rust discovers candidates before probing stale OS identities.
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[2][0] === f.data).length, 1);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(f.unregisters.length, 1);
  assert.equal(f.unregisters[0].context.signal.aborted, false);
  assert.equal(await f.adapter.nextClientPresence('original'), null);
  assert.ok(await f.adapter.nextClientPresence('rebooted'));
  oldObserver('late event for former connection');
  assert.ok(await f.adapter.nextClientPresence('rebooted'));
  await f.adapter.syncTime({ ...device, id: 'rebooted', firmwareVersion: '9.0.0' });
  assert.equal(f.calls.at(-1)[1].peripheralId, 'rebooted');
  await f.adapter.destroy();
});

test('a verified status-monitor failure enters the same generated recovery path without cancelling OTA', async () => {
  const f = otaFixture({ monitorFailure: true });
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  await f.adapter.updateFirmware(device, f.image);
  assert.ok(await f.adapter.nextClientPresence('rebooted'));
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[2][0] === f.data).length, 1);
  await f.adapter.destroy();
});

test('monitor-triggered recovery retires old observers before reconnect reuses the same peripheral ID', async () => {
  const f = otaFixture({ monitorFailure: true, samePeripheral: true, lateOldDisconnect: true });
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  const originalObserver = f.observers.get('original');
  await f.adapter.updateFirmware(device, f.image);
  assert.ok(await f.adapter.nextClientPresence('original'));
  originalObserver('retired generation');
  assert.ok(await f.adapter.nextClientPresence('original'));
  await f.adapter.destroy();
});

test('a disconnect before firmware verification fails without reconnect or a complete event', async () => {
  const f = otaFixture({ beforeVerifyDisconnect: true });
  const progress = [];
  f.adapter.onFirmwareUpdateProgress(value => progress.push(value));
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  await assert.rejects(f.adapter.updateFirmware(device, f.image), { code: 'not_connected' });
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'connect').length, 1);
  assert.equal(progress.some(value => value.phase === 'complete' || value.phase === 'reconnecting'), false);
  assert.equal(f.unregisters.length, 1);
  await f.adapter.destroy();
});

test('firmware registration failure joins unregister before settling and leaves no transferable registration', async () => {
  let entered, release;
  const cleaning = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const failure = new Error('register failed after acquiring the request');
  const f = otaFixture({ async register() { throw failure; }, async unregister() { entered(); await gate; } });
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  const running = f.adapter.updateFirmware(device, f.image);
  const rejected = assert.rejects(running, error => error === failure);
  await Promise.race([cleaning, running]);
  await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
  release(); await rejected;
  assert.equal(f.unregisters.length, 1);
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});

test('fresh post-reboot identity mismatch cannot emit complete or retain the replacement connection', async () => {
  const f = otaFixture();
  const read = f.ports.ble.read;
  let firmwareReads = 0;
  f.ports.ble.read = async (address, context) => {
    if (address.peripheralId === 'rebooted' && address.characteristicUuid === f.metadata.CHAR_FIRMWARE_REVISION && ++firmwareReads > 1) {
      return Uint8Array.from(Buffer.from('8.0.0'));
    }
    return read(address, context);
  };
  const progress = [];
  f.adapter.onFirmwareUpdateProgress(value => progress.push(value));
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  await assert.rejects(f.adapter.updateFirmware(device, f.image), { code: 'identity_mismatch' });
  assert.equal(progress.some(value => value.phase === 'complete'), false);
  assert.equal(await f.adapter.nextClientPresence('rebooted'), null);
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'disconnect' && call[1] === 'rebooted'));
  await f.adapter.destroy();
});

test('shortened recovery deadline retains ownership until ignored connection cancellation and cleanup settle', { timeout: 5000 }, async () => {
  let entered, release;
  const connecting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = otaFixture({ adapterOptions: { firmwareRecoveryTimeoutMs: 20 }, async connect() { entered(); await gate; } });
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'original', rssi: -50, discoveredAtMs: 0 });
  const running = f.adapter.updateFirmware(device, f.image);
  const rejected = assert.rejects(running, { code: 'timeout' });
  await Promise.race([connecting, running]);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
  assert.equal(f.unregisters.length, 0);
  release(); await rejected;
  assert.equal(f.unregisters.length, 1);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'write' && call[2][0] === f.data).length, 1);
  await f.adapter.destroy();
});

test('the generated core and JS controls refuse identity changes before a command write', async () => {
  const f = fixture();
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('DIFFERENT'));
  await assert.rejects(f.adapter.syncTime(device), error => error.code === 'identity_mismatch');
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});

test('scan startup errors propagate before a public subscription is accepted', async () => {
  const f = fixture();
  await f.adapter.configure({ logLevel: 'none' });
  await assert.rejects(f.adapter.startScan(-1, false));
  assert.equal(f.calls.length, 0);
  await f.adapter.destroy();
});

test('generated provisioning waits for exact application material and subscribes before endpoint/token writes', async () => {
  const f = fixture();
  f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
  f.values.set(f.metadata.CHAR_PK_D, new Uint8Array(64).fill(3));
  let notify;
  f.ports.ble.subscribe = async (address, callback) => {
    f.calls.push(['subscribe', address.characteristicUuid]); notify = callback;
    callback(Uint8Array.of(0)); // A startup snapshot cannot complete the provisioning workflow.
    return { async remove() { f.calls.push(['remove-provisioning']); notify = undefined; } };
  };
  const write = f.ports.ble.write;
  f.ports.ble.write = async (address, bytes, response, context) => {
    await write(address, bytes, response, context);
    if (address.characteristicUuid === 'B07A000A-0001-1000-8000-00805F9B34FB') notify(Uint8Array.of(0));
  };
  const requests = [];
  f.adapter.onProvisioningMaterialRequested(value => {
    requests.push(value);
    void f.adapter.resolveProvisioningMaterial(value.requestId, { apiEndpoint: String.fromCharCode(1), deviceToken: '', credentialEnvelope: Buffer.concat([Buffer.from('BOTATOK1'), Buffer.alloc(222)]).toString('base64url'), mtu: 247 });
  });
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  await f.adapter.provision(device);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].nonce, '02'.repeat(16));
  assert.equal(requests[0].devicePublicKey, '03'.repeat(64));
  const subset = f.calls.filter(call => Array.isArray(call) && ['subscribe', 'write', 'remove-provisioning'].includes(call[0]) && (call[0] !== 'write' || call[1].characteristicUuid !== f.metadata.CHAR_TIME_SYNC));
  assert.equal(subset[0][0], 'subscribe');
  assert.deepEqual(subset[1][2], [1]);
  assert.equal(subset.at(-1)[0], 'remove-provisioning');
  await f.adapter.destroy();
});

for (const encrypted of [false, true]) {
  test(`public RN runtime provisions ${encrypted ? 'encrypted' : 'plaintext'} credentials through the client bridge`,
    { timeout: 5000 }, async () => {
      const f = fixture();
      f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
      f.values.set(f.metadata.CHAR_PK_D, new Uint8Array(64).fill(3));
      const credential = encrypted
        ? Buffer.concat([Buffer.from('BOTATOK1'), Buffer.alloc(222)])
        : Buffer.from('dtok_synthetic_bridge_regression');
      const characteristic = encrypted ? 'B07A000A-0001-1000-8000-00805F9B34FB'
        : f.metadata.CHAR_DEVICE_TOKEN;
      let notify;
      f.ports.ble.subscribe = async (address, callback) => {
        if (address.characteristicUuid === f.metadata.CHAR_PROVISIONING_RESULT) notify = callback;
        return { async remove() { notify = undefined; } };
      };
      const write = f.ports.ble.write;
      f.ports.ble.write = async (address, bytes, response, context) => {
        await write(address, bytes, response, context);
        if (address.characteristicUuid === characteristic && bytes[0] + 1 === bytes[1]) {
          notify(Uint8Array.of(0));
        }
      };
      const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
      const runtime = createBotaReactNativeJsRuntime(f.ports);
      try {
        await runtime.client.configure({ logLevel: 'none', backgroundSyncEnabled: false });
        const manager = runtime.client.devices;
        const device = await manager.connect({ id: 'selected', rssi: -50, discoveredAt: new Date(0) });
        if (encrypted) await manager.provisionEnvelope(device, credential.toString('base64url'), 'development');
        else await manager.provision(device, credential.toString('ascii'), 'development');
        const writes = writesBeyondTimeSync(f);
        assert.deepEqual(writes.map(call => call[1].characteristicUuid), [f.metadata.CHAR_API_ENDPOINT, characteristic]);
        assert.deepEqual(writes[0][2], [0]);
        assert.deepEqual(writes[1][2], [0, 1, ...credential]);
      } finally {
        await runtime.client.destroy();
        await f.adapter.destroy();
        f.core.dispose();
      }
    });
}

test('cancelling a provisioning callback rejects its late response and emits no protected command', async () => {
  const f = fixture();
  f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
  f.values.set(f.metadata.CHAR_PK_D, new Uint8Array(64).fill(3));
  let resolve;
  const requested = new Promise(yes => { resolve = yes; });
  f.adapter.onProvisioningMaterialRequested(resolve);
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  const running = f.adapter.provision(device);
  const rejection = assert.rejects(running);
  const request = await requested;
  await f.adapter.stopAllRecordingOperations();
  await rejection;
  await assert.rejects(f.adapter.resolveProvisioningMaterial(request.requestId,
    { apiEndpoint: String.fromCharCode(1), deviceToken: 'late', mtu: 247 }), { code: 'stale_material_request' });
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});

test('read response subscription errors stop startup before the command and settle exact cleanup', async () => {
  const f = fixture();
  const failure = new Error('disconnected during subscription');
  let removals = 0;
  f.ports.ble.subscribe = async (_address, _callback, _context, onError) => {
    onError(failure); return { async remove() { removals++; } };
  };
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  await assert.rejects(f.adapter.listRecordings(device), error => error === failure);
  assert.equal(removals, 1);
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});

test('failed response teardown poisons the executor and prevents reuse with zero additional IO', async () => {
  const f = fixture();
  const failure = new Error('unsubscribe failed');
  let notify;
  f.ports.ble.subscribe = async (_address, callback) => { notify = callback; return { async remove() { throw failure; } }; };
  f.ports.ble.write = async () => notify(new Uint8Array());
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  await assert.rejects(f.adapter.listRecordings(device), error => error === failure);
  const count = f.calls.length;
  await assert.rejects(f.adapter.syncTime(device), { code: 'cleanup_incomplete' });
  assert.equal(f.calls.length, count);
  await assert.rejects(f.adapter.destroy(), error => error === failure);
});

test('profile nonce reads stay inside the captured exclusive lease and cancellation joins provider draining', { timeout: 5000 }, async () => {
  let resolveRequest, resolveDrain, releaseDrain;
  const requested = new Promise(resolve => { resolveRequest = resolve; });
  const draining = new Promise(resolve => { resolveDrain = resolve; });
  const drainGate = new Promise(resolve => { releaseDrain = resolve; });
  let drainCount = 0;
  const f = fixture({ files: { async flush() {} }, adapterOptions: {
    async drainMaterial(operationId, context) {
      drainCount++;
      assert.equal(operationId, 'v2-operation');
      assert.equal(context.signal.aborted, false);
      resolveDrain(); await drainGate;
    },
  } });
  f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
  f.values.set(f.metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2,
    Uint8Array.from([1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0]));
  f.adapter.onEncryptedUploadV2ProfileRequested(resolveRequest);
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  const running = f.adapter.syncEncryptedRecordingV2(device, { uuid: '00112233-4455-6677-8899-aabbccddeeff',
    generation: 9, ciphertextLength: '330', ciphertextSha256: '33'.repeat(32), storageFormat: 3 }, 'v2-operation');
  const rejection = assert.rejects(running, { code: 'operation_cancelled' });
  const request = await Promise.race([requested, running]);
  assert.equal(await f.adapter.readNonce('v2-operation'), '02'.repeat(16));
  const lease = f.adapter.context('v2-operation');
  assert.equal(f.adapter.profileContext('v2-operation').generation, lease.generation);
  const count = f.calls.length;
  await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
  assert.equal(f.calls.length, count);
  assert.throws(() => f.adapter.registerMaterial('foreign', {}), { code: 'stale_material_request' });
  const cancelling = f.adapter.cancelEncryptedRecordingV2('v2-operation');
  await draining;
  await assert.rejects(f.adapter.syncTime(device), { code: 'operation_in_progress' });
  await assert.rejects(f.adapter.resolveEncryptedUploadV2Profile(request.requestId, {}), { code: 'stale_material_request' });
  assert.equal(drainCount, 1);
  releaseDrain(); await cancelling; await rejection;
  assert.throws(() => f.adapter.context('v2-operation'), { code: 'stale_material_request' });
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});

test('factory reset saves the exact generation journal and waits for the application before its device receipt', async () => {
  const f = fixture();
  f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
  let notify, resolvePersistence;
  const persistence = new Promise(resolve => { resolvePersistence = resolve; });
  const writes = [];
  f.ports.ble.subscribe = async (_address, callback) => { notify = callback; return { async remove() { notify = undefined; } }; };
  f.ports.ble.write = async (_address, value) => {
    if (_address.characteristicUuid === f.metadata.CHAR_TIME_SYNC) return;
    writes.push([...value]);
    if (value.length === 5) notify(Uint8Array.of(0, 3, 0));
  };
  f.adapter.onFactoryResetGrantRequested(value => {
    const grant = Buffer.alloc(179); grant.writeUInt32BE(value.bindingGeneration);
    void f.adapter.resolveFactoryResetGrant(value.requestId, grant.toString('base64'));
  });
  f.adapter.onFactoryResetResultPersistenceRequested(resolvePersistence);
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  const running = f.adapter.factoryReset(device, 'reset-command', 7, true);
  const request = await Promise.race([persistence, running]);
  assert.equal(request.localRecordingsDeleted, 3);
  assert.deepEqual(f.saved.get(`reset-owner/${device.serialNumber}`), { serialNumber: device.serialNumber,
    commandId: 'reset-command', bindingGeneration: '7', result: { result_code: 0, deleted_recording_count: 3 } });
  assert.deepEqual(writes.map(value => value.length), [179, 5]);
  await f.adapter.resolveFactoryResetResultPersistence(request.requestId);
  assert.deepEqual(await running, { commandId: 'reset-command', bindingGeneration: 7 });
  assert.deepEqual(writes.map(value => value.length), [179, 5, 1]);
  assert.equal(f.saved.has(`reset-owner/${device.serialNumber}`), false);
  await f.adapter.destroy();
});

test('factory reset recovery refuses a journal from another binding generation without writes or deletion', async () => {
  const f = fixture();
  const journal = { serialNumber: 'C8SU2XXWHI', commandId: 'old-command', bindingGeneration: '7',
    result: { result_code: 0, deleted_recording_count: 3 } };
  f.saved.set('reset-owner/C8SU2XXWHI', journal);
  await f.adapter.configure({ logLevel: 'none' });
  const device = await f.adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  await assert.rejects(f.adapter.resumePendingFactoryReset(device, 8, true), { code: 'identity_mismatch' });
  assert.equal(f.saved.get('reset-owner/C8SU2XXWHI'), journal);
  assert.equal(writesBeyondTimeSync(f).length, 0);
  await f.adapter.destroy();
});
