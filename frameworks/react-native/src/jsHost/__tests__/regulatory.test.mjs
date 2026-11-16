import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';
const { createGeneratedJsCore } = loadSource('core.ts');
const { JsDeviceControls } = loadSource('deviceControls.ts');
const { createBlePlxPort } = loadSource('blePlx.ts');
const vector = JSON.parse(readFileSync(new URL('../../../../../protocol/vectors/country-config-v1.json', import.meta.url), 'utf8'));
const wire = Buffer.from(vector.document.data, 'base64url');
const delivery = () => ({ protocolVersion: 1, bindingGeneration: 7, countryAlpha2: 'CN', countryRevision: '3', expectedFirmwareVersion: '1.2.3', document: vector.document });

test('shared backend vector has the documented purpose-separated tag and cloud signature', () => {
  const publicKey = Buffer.from(vector.cloudPublicKeyHex, 'hex');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(0, 32).toString('base64url'), y: publicKey.subarray(32).toString('base64url') }, format: 'jwk' });
  assert.equal(wire.length, 264);
  assert.equal(wire.toString('hex'), vector.documentHex);
  assert.deepEqual(wire.subarray(12, 16), createHash('sha256').update(publicKey).digest().subarray(0, 4));
  const tag = createHmac('sha256', Buffer.from(vector.input.syntheticCommitmentHex, 'hex')).update('bota/country-config/credential/v1\0').digest();
  assert.deepEqual(wire.subarray(36, 68), tag);
  assert.equal(tag.toString('hex'), vector.expectedCredentialTagHex);
  assert.ok(verify('sha256', Buffer.concat([Buffer.from('bota/country-config/signature/v1\0'), wire.subarray(0, 200)]), { key, dsaEncoding: 'ieee-p1363' }, wire.subarray(200)));
});
function fixture(options = {}) {
  const core = createGeneratedJsCore(), meta = core.codec('protocolMetadata', {}), calls = [];
  const device = { id: 'peripheral', serialNumber: 'SYNTHETIC', mtu: options.mtu ?? 67 };
  const scope = new AbortController(), operation = new AbortController();
  const context = { operation: 'DeviceControl', operationId: 'country-test', requestId: '0', cancellationId: '01'.repeat(16), generation: '1', signal: operation.signal };
  let callback, connection = { device, generation: 'connection-1' };
  const ports = { signal: scope.signal, persistence: { namespace: 'test/country' }, randomBytes: () => Uint8Array.from([7, 0, 0, 0]), ble: {
    async read(address) {
      calls.push(['read', address.characteristicUuid]);
      if (address.characteristicUuid === meta.CHAR_SERIAL_NUMBER) return new Uint8Array(Buffer.from(device.serialNumber));
      if (address.characteristicUuid === meta.CHAR_FIRMWARE_REVISION) return new Uint8Array(Buffer.from(options.firmwareVersion ?? '1.2.3'));
      throw Error('unexpected read');
    },
    async subscribe(address, notify) { assert.equal(address.characteristicUuid, meta.CHAR_TRANSFER_SIGNED_BLOB_V2); calls.push(['subscribe']); if (options.subscribeFailure) throw options.subscribeFailure; callback = notify; return { async remove() { calls.push(['remove']); if (options.removeFailure) throw Error('remove failed'); } }; },
    async write(address, bytes) {
      assert.equal(address.characteristicUuid, meta.CHAR_TRANSFER_SIGNED_BLOB_V2);
      calls.push(['write', address.characteristicUuid, [...bytes]]);
      const failure = options.writeFailure?.(bytes);
      if (failure) throw failure;
      if (options.cancel === 'scope') scope.abort();
      if (options.cancel === 'connection') connection = { device, generation: 'replacement' };
      if (bytes[0] === 98) {
        callback(Uint8Array.from([100, 2, 8, 0, 8, 0, 0, 0, 0, 0])); // Other write ID is ignored.
        callback(Uint8Array.from([100, 2, 7, 0, 7, 0, 0, 0, 0, 0])); // Other kind is ignored.
        callback(Uint8Array.from([100, 2, 8, 0, 7, 0, 0, 0, options.result ?? 0, 0]));
      }
    },
  } };
  if (options.nativeWrite) {
    const write = ports.ble.write;
    const plx = createBlePlxPort({ async writeCharacteristicWithResponseForDevice(peripheralId, serviceUuid, characteristicUuid, base64) {
      await write({ peripheralId, serviceUuid, characteristicUuid }, new Uint8Array(Buffer.from(base64, 'base64')));
      return { value: null };
    } });
    ports.ble.write = (address, value, response, context) => plx.write(address, value, response, context);
  }
  const controls = new JsDeviceControls({ core, ports, connection: () => connection, emit() {}, gatt: (_context, body) => body() });
  return { controls, core, device, context, calls, apply: (value = delivery()) => controls.execute('applyCountryConfiguration', [device, value], context) };
}

test('actual generated Rust uses existing signed-blob framing, firmware qualification and correlated RESULT', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.apply(), { result: 0, bindingGeneration: 7, countryAlpha2: 'CN', countryRevision: '3' });
    const writes = f.calls.filter(c => c[0] === 'write');
    assert.ok(writes.every(c => c[2].length <= 64));
    assert.deepEqual(Buffer.from(writes.filter(c => c[2][0] === 97).flatMap(c => c[2].slice(12))), wire);
    assert.ok(f.calls.findIndex(c => c[0] === 'subscribe') < f.calls.findIndex(c => c[0] === 'write'));
    assert.equal(f.calls.filter(c => c[0] === 'remove').length, 1);
    assert.ok(f.calls.filter(c => c[0] === 'read').length === 2);
  } finally { await f.controls.close(); }
});

test('absent country transport before BEGIN submission does not ABORT or poison later controls', async () => {
  for (const code of ['characteristic_not_found', 'service_not_found']) {
    const failure = Object.assign(new Error('absent GATT endpoint'), { errorCode: code === 'characteristic_not_found' ? 404 : 302 });
    const options = { nativeWrite: true, writeFailure: () => failure };
    const f = fixture(options);
    try {
      let rejection;
      await assert.rejects(f.apply(), error => { rejection = error; return true; });
      assert.equal(f.calls.filter(c => c[0] === 'write').length, 1, 'no ABORT for a locally rejected BEGIN');
      assert.equal(rejection.code, 'country_configuration_unsupported');
      assert.equal(f.calls.filter(c => c[0] === 'remove').length, 1);
      options.writeFailure = undefined;
      assert.equal((await f.apply()).result, 0, 'later control still admitted after firmware becomes available');
    } finally { await f.controls.close(); }
  }
});

test('missing country subscription returns an actionable error without writes', async () => {
  const options = { subscribeFailure: Object.assign(new Error('absent'), { code: 'characteristic_not_found' }) };
  const f = fixture(options);
  try {
    await assert.rejects(f.apply(), { code: 'country_configuration_unsupported' });
    assert.equal(f.calls.filter(c => c[0] === 'write').length, 0);
    options.subscribeFailure = undefined;
    assert.equal((await f.apply()).result, 0);
  } finally { await f.controls.close(); }
});

test('unknown BEGIN failures and missing endpoints after BEGIN preserve uncertain cleanup fencing', async () => {
  for (const mode of ['unknown-begin', 'unmarked-missing-begin', 'missing-after-begin']) {
    const options = { writeFailure: bytes => {
      if (mode === 'missing-after-begin' && bytes[0] === 96) return;
      return Object.assign(new Error('transport failure'), { code: mode === 'unknown-begin' ? 'unknown_error' : 'characteristic_not_found',
        ...(mode === 'missing-after-begin' ? { notSubmitted: true } : {}) });
    } };
    const f = fixture(options);
    try {
      await assert.rejects(f.apply());
      assert.equal(f.calls.filter(c => c[0] === 'write').at(-1)[2][0], 99, 'ABORT still attempted');
      const writes = f.calls.length;
      options.writeFailure = undefined;
      await assert.rejects(f.apply());
      assert.equal(f.calls.length, writes, 'uncertain cleanup blocks reuse');
    } finally { await f.controls.close().catch(() => {}); }
  }
});

test('failed unsubscribe after an absent BEGIN still fences the connection', async () => {
  const options = { removeFailure: true, writeFailure: () => Object.assign(new Error('absent'), { code: 'characteristic_not_found', notSubmitted: true }) };
  const f = fixture(options);
  try {
    await assert.rejects(f.apply(), /remove failed/);
    options.removeFailure = false; options.writeFailure = undefined;
    await assert.rejects(f.apply(), /remove failed/);
  } finally { await f.controls.close().catch(() => {}); }
});

test('stale firmware metadata, small MTU and country metadata mismatch refuse before subscription or write', async () => {
  for (const options of [{ firmwareVersion: '1.2.2' }, { mtu: 66 }, { metadata: true }]) {
    const f = fixture(options);
    try {
      const value = delivery(); if (options.metadata) value.countryRevision = '2';
      await assert.rejects(f.apply(value));
      assert.equal(f.calls.filter(c => c[0] === 'write' || c[0] === 'subscribe').length, 0);
    } finally { await f.controls.close(); }
  }
});

test('device rejection preserves protocol result and cannot produce an applied observation', async () => {
  const f = fixture({ result: 14 });
  try { await assert.rejects(f.apply(), error => error.code === 'protocol_rejected' && error.protocolStatus === 14); }
  finally { await f.controls.close(); }
});

test('generated parser rejects noncanonical signed bytes before any BLE write', async () => {
  const f = fixture();
  try {
    for (const mutate of [
      bytes => { bytes[11] = 1; },
      bytes => { bytes[100] = 1; },
      bytes => { bytes[70] = 0xff; },
      bytes => { bytes.fill(0xff, 232); },
      bytes => { bytes[9] = 3; },
    ]) {
      const changed = Buffer.from(wire); mutate(changed);
      const value = delivery(); value.document = { ...value.document, data: changed.toString('base64url') };
      await assert.rejects(f.apply(value));
    }
    assert.equal(f.calls.filter(c => c[0] === 'write' || c[0] === 'subscribe').length, 0);
  } finally { await f.controls.close(); }
});

test('scope and physical connection retirement stop writes and release the exact subscription', async () => {
  for (const cancel of ['scope', 'connection']) {
    const f = fixture({ cancel });
    try {
      await assert.rejects(f.apply());
      assert.equal(f.calls.filter(c => c[0] === 'write').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'remove').length, 1);
    } finally { await f.controls.close(); }
  }
});

test('all retired regulatory methods fail before BLE I/O', async () => {
  const f = fixture();
  try {
    for (const method of ['readRegulatoryCapabilities', 'readRegulatoryStatus', 'readRegulatoryChallenge', 'applyRegulatoryConfiguration']) {
      await assert.rejects(f.controls.execute(method, [f.device, {}], f.context), error => error.code === 'unsupported_capability');
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.controls.close(); }
});
