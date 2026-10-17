import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsDeviceAdapter } = loadSource('deviceAdapter.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const recording = { uuid: '00112233-4455-6677-8899-aabbccddeeff', generation: 1, storageFormat: 3,
  ciphertextLength: '600', ciphertextSha256: '02'.repeat(32), startedAtMs: '0', durationMs: '0', plaintextLength: '100' };
function gate() {
  let enter, release;
  return { entered: new Promise(resolve => { enter = resolve; }), pending: new Promise(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}
function tracked(promise) {
  const result = { settled: false };
  result.promise = promise.finally(() => { result.settled = true; });
  void result.promise.catch(() => {});
  return result;
}
async function fixture(t, { v2 = false } = {}) {
  const core = createGeneratedJsCore(), metadata = core.codec('protocolMetadata', {});
  const events = [], saved = new Map(), listeners = new Map(), scope = new AbortController();
  const values = new Map([
    [metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000001')], [metadata.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
    [metadata.CHAR_FIRMWARE_REVISION, Buffer.from('1.0.19')], [metadata.CHAR_HARDWARE_REVISION, Buffer.from('rev1')],
    [metadata.CHAR_PAIRING_STATE, Uint8Array.of(2)],
    [metadata.CHAR_DEVICE_STATUS, Buffer.from('3200000200000000290004000163', 'hex')],
    [metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2, Uint8Array.from([1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0])],
  ]);
  const f = { core, metadata, values, events, saved, listeners, scope, status: gate(), removal: gate(), holdStatus: false,
    holdRemoval: false, permanentScopeEpoch: 0 };
  const unused = async () => { throw new Error('Unexpected file or network IO'); };
  const ports = { apiVersion: 1, platform: 'ios', signal: scope.signal,
    checkScope() { if (f.permanentScopeEpoch !== 0) throw new Error('Fixture scope retired'); },
    randomBytes: length => Uint8Array.from({ length }, (_, index) => index + 1),
    files: { open: unused, metadata: unused, append: unused, truncate: unused, read: unused, finalize: unused, remove: unused, async flush() {} },
    persistence: { namespace: 'account/project/user', async load(key) { return saved.get(key) ?? null; },
      async save(key, value) { saved.set(key, value); }, async remove(key) { saved.delete(key); } },
    ble: {
      async scan() { return { async remove() {} }; }, async connect(id) { events.push(['connect', id]); },
      async discoverServices() {}, async disconnect(id) { events.push(['disconnect', id]); }, async getMtu() { return 247; },
      async read(address) {
        events.push(['read', address.characteristicUuid, address.peripheralId]);
        if (address.characteristicUuid === metadata.CHAR_DEVICE_STATUS && f.holdStatus) {
          f.holdStatus = false; f.status.enter(); await f.status.pending;
        }
        if (!v2 && address.characteristicUuid === metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2) {
          throw Object.assign(new Error('Fixture absent optional capability'), { code: 'characteristic_not_found', ...address });
        }
        assert(values.has(address.characteristicUuid)); return Uint8Array.from(values.get(address.characteristicUuid));
      },
      async subscribe(address, callback) {
        events.push(['subscribe', address.characteristicUuid]); listeners.set(address.characteristicUuid, callback);
        return { async remove() {
          events.push(['remove-start', address.characteristicUuid]);
          if (f.holdRemoval && address.characteristicUuid === metadata.CHAR_RECORDING_TRANSFER_V2) {
            f.holdRemoval = false; f.removal.enter(); await f.removal.pending;
          }
          if (f.removalError && address.characteristicUuid === metadata.CHAR_RECORDING_TRANSFER_V2) throw f.removalError;
          listeners.delete(address.characteristicUuid); events.push(['remove-end', address.characteristicUuid]);
        } };
      },
      async write(address, bytes) {
        events.push(['write', address.characteristicUuid, address.peripheralId]);
        if (address.characteristicUuid === metadata.CHAR_TRANSFER_CONTROL) listeners.get(metadata.CHAR_RECORDING_LIST)?.(new Uint8Array());
        if (address.characteristicUuid === metadata.CHAR_TRANSFER_CONTROL_V2) {
          const command = core.codec('decodeEncryptedUploadV2Transfer', { bytes: [...bytes] });
          assert(['list', 'marked_list'].includes(command.kind));
          // Device-origin frames follow generated protocol.rs offsets; the public encoder correctly admits app commands only.
          const entry = Buffer.alloc(96), end = Buffer.alloc(52), session = BigInt(command.transportSessionId);
          entry.set([0x48, 2]); entry.writeBigUInt64LE(session, 4); entry.set(Buffer.from(recording.uuid.replaceAll('-', ''), 'hex'), 12);
          entry.writeUInt32LE(1, 28); entry[32] = 3; entry[33] = 2;
          entry.writeBigUInt64LE(100n, 48); entry.writeBigUInt64LE(600n, 56); entry.fill(2, 64);
          end.set([0x49, 2]); end.writeBigUInt64LE(session, 4); end.writeUInt32LE(1, 12); end.writeUInt32LE(3, 16);
          end.set(createHash('sha256').update(entry.subarray(12)).digest(), 20);
          listeners.get(metadata.CHAR_RECORDING_LIST_V2)?.(entry); listeners.get(metadata.CHAR_RECORDING_LIST_V2)?.(end);
        }
      },
    },
  };
  const adapter = createJsDeviceAdapter(core, ports);
  await adapter.configure({ logLevel: 'none' });
  const device = await adapter.connectSelected({ id: 'selected', rssi: -50, discoveredAtMs: 0 });
  Object.assign(f, { ports, adapter, device, catalog: () => adapter.listPendingRecordings(device),
    catalogWrites: () => events.filter(event => event[0] === 'write' && event[1] === metadata.CHAR_TRANSFER_CONTROL) });
  t.after(async () => { f.status.release(); f.removal.release(); try {
    if (f.removalError) await assert.rejects(adapter.destroy(), error => error === f.removalError); else await adapter.destroy();
  } finally { core.dispose(); } });
  return f;
}

test('catalog waits behind admitted status, snapshots its target and precedes the next ordinary control', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = tracked(f.adapter.readStatus()); await f.status.entered;
  const callerDevice = { ...f.device }, catalog = tracked(f.adapter.listPendingRecordings(callerDevice)), later = tracked(f.adapter.readStatus());
  try {
    callerDevice.id = 'foreign'; callerDevice.serialNumber = 'OTHER00001';
    await tick(); assert.equal(catalog.settled, false); assert.equal(later.settled, false);
    assert.equal(f.catalogWrites().length, 0); assert.equal(f.listeners.size, 0);
    f.status.release(); await prior.promise; assert.deepEqual(await catalog.promise, []); await later.promise;
    const status = f.events.flatMap((event, index) => event[0] === 'read' && event[1] === f.metadata.CHAR_DEVICE_STATUS ? [index] : []);
    const list = f.events.findIndex(event => event[0] === 'write' && event[1] === f.metadata.CHAR_TRANSFER_CONTROL);
    assert(status[0] < list && list < status[1]); assert.equal(f.catalogWrites().length, 1);
    assert.equal(f.catalogWrites()[0][2], 'selected'); assert.equal(f.listeners.size, 0);
    assert.equal([...f.saved.keys()].some(key => key.includes('encrypted-v2')), false);
  } finally { f.status.release(); await Promise.allSettled([prior.promise, catalog.promise, later.promise]); }
});

test('queued catalog retains actual Rust v2 decoding and holds its owner through joined monitor cleanup', { timeout: 5000 }, async t => {
  const f = await fixture(t, { v2: true }); f.holdRemoval = true;
  const catalog = tracked(f.catalog()); await f.removal.entered;
  const later = tracked(f.adapter.readStatus());
  try {
    await tick(); assert.equal(catalog.settled, false); assert.equal(later.settled, false);
    f.removal.release(); const rows = await catalog.promise; await later.promise;
    assert.equal(rows.length, 1); assert.equal(rows[0].profile, 'encrypted_upload_v2');
    assert.equal(rows[0].encrypted.uuid, recording.uuid); assert.equal(rows[0].encrypted.generation, 1);
    assert.equal(rows[0].encrypted.storageFormat, 3); assert.equal(rows[0].encrypted.ciphertextLength, '600'); assert.equal(rows[0].encrypted.ciphertextSha256, '02'.repeat(32));
    assert.equal(f.listeners.size, 0);
    assert.equal((await f.catalog())[0].encrypted.uuid, recording.uuid, 'The completed exact decoder must be reset for the next catalog');
    assert.equal(f.listeners.size, 0);
  } finally { f.removal.release(); await Promise.allSettled([catalog.promise, later.promise]); }
});

test('destroy rejects a queued catalog before subscription and joins the already submitted status read', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = tracked(f.adapter.readStatus()); await f.status.entered;
  const catalog = tracked(f.catalog()), destroy = tracked(f.adapter.destroy());
  try {
    await assert.rejects(catalog.promise, /cancelled|destroyed/); await tick(); assert.equal(destroy.settled, false);
    assert.equal(f.catalogWrites().length, 0); assert.equal(f.listeners.size, 0);
    f.status.release(); await Promise.allSettled([prior.promise]); await destroy.promise;
    assert.equal(f.catalogWrites().length, 0);
  } finally { f.status.release(); await Promise.allSettled([prior.promise, catalog.promise, destroy.promise]); }
});

test('a permanently retired A to B to A scope cannot revive a queued catalog', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = tracked(f.adapter.readStatus()); await f.status.entered;
  const catalog = tracked(f.catalog());
  try {
    f.ports.persistence.namespace = 'account/other/user'; f.permanentScopeEpoch++;
    f.ports.persistence.namespace = 'account/project/user'; f.permanentScopeEpoch++;
    f.scope.abort(); await assert.rejects(catalog.promise, /scope|cancelled/);
    f.status.release(); await Promise.allSettled([prior.promise]);
    assert.equal(f.catalogWrites().length, 0); assert.equal(f.listeners.size, 0);
  } finally { f.status.release(); await Promise.allSettled([prior.promise, catalog.promise]); }
});

test('a physical A to B to A reconnect never dispatches a queued catalog from the old link', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = tracked(f.adapter.readStatus()); await f.status.entered;
  const catalog = tracked(f.catalog()), disconnect = tracked(f.adapter.disconnect());
  try {
    await assert.rejects(catalog.promise, /cancelled|identity|connected/);
    f.status.release(); await Promise.allSettled([prior.promise]); await disconnect.promise;
    f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000002'));
    await f.adapter.connectSelected({ id: 'replacement', rssi: -40, discoveredAtMs: 0 }); await f.adapter.disconnect();
    f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000001'));
    await f.adapter.connectSelected({ id: 'selected', rssi: -40, discoveredAtMs: 0 });
    assert.equal(f.catalogWrites().length, 0); assert.equal(f.listeners.size, 0);
    assert.deepEqual(await f.catalog(), [], 'A newly admitted current catalog remains usable');
  } finally { f.status.release(); await Promise.allSettled([prior.promise, catalog.promise, disconnect.promise]); }
});

test('destroy joins active catalog monitor removal before returning or releasing the lane', { timeout: 5000 }, async t => {
  const f = await fixture(t, { v2: true }); f.holdRemoval = true;
  const catalog = tracked(f.catalog()); await f.removal.entered;
  const destroy = tracked(f.adapter.destroy());
  try {
    await tick(); assert.equal(catalog.settled, false); assert.equal(destroy.settled, false);
    f.removal.release(); await assert.rejects(catalog.promise, error => ['operation_cancelled', 'stale_host_owner'].includes(error.code)); await destroy.promise;
    assert.equal(f.listeners.size, 0); assert.equal(f.events.filter(event => event[0] === 'remove-end').length, 3);
  } finally { f.removal.release(); await Promise.allSettled([catalog.promise, destroy.promise]); }
});

test('genuine catalog monitor cleanup failure remains visible and poisons later admission', { timeout: 5000 }, async t => {
  const f = await fixture(t, { v2: true }); f.removalError = new Error('Fixture monitor removal failed');
  await assert.rejects(f.catalog(), error => error === f.removalError);
  const writes = f.catalogWrites().length;
  await assert.rejects(f.adapter.readStatus(), { code: 'cleanup_incomplete' });
  await assert.rejects(f.catalog(), { code: 'cleanup_incomplete' });
  assert.equal(f.catalogWrites().length, writes);
});
