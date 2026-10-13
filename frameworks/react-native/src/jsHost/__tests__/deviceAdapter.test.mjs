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
const writesBeyondTimeSync = f => f.calls.filter(call => Array.isArray(call) && call[0] === 'write'
  && call[1].characteristicUuid !== f.metadata.CHAR_TIME_SYNC);

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
    if (address.characteristicUuid === f.metadata.CHAR_DEVICE_TOKEN) notify(Uint8Array.of(0));
  };
  const requests = [];
  f.adapter.onProvisioningMaterialRequested(value => {
    requests.push(value);
    void f.adapter.resolveProvisioningMaterial(value.requestId, { apiEndpoint: String.fromCharCode(1), deviceToken: 'token', mtu: 247 });
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
