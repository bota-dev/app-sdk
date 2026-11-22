import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { readUploadCapabilities } = loadSource('capabilityReader.ts');
const { createBlePlxPort } = loadSource('blePlx.ts');
const legacy = { peripheralId: 'device', serviceUuid: 'storage', characteristicUuid: 'legacy' };
const extension = { peripheralId: 'device', serviceUuid: 'extension', characteristicUuid: 'extended' };
const context = () => ({ operationId: 'owner', operation: 'ReadCapabilities', requestId: '1',
  cancellationId: 'captured', generation: '1', signal: new AbortController().signal });

test('production BLE PLX absence errors fall back from an old firmware to its legacy snapshot', async () => {
  for (const errorCode of [302, 404]) {
    const calls = [], bytes = Uint8Array.of(1, 2, 24, 0, 0x7f, 3);
    const port = createBlePlxPort({
      async readCharacteristicForDevice(peripheralId, serviceUuid, characteristicUuid) {
        calls.push({ peripheralId, serviceUuid, characteristicUuid });
        if (serviceUuid === extension.serviceUuid) throw Object.assign(new Error('native endpoint absent'), { errorCode });
        return { value: Buffer.from(bytes).toString('base64') };
      },
    });
    const ctx = context();
    assert.deepEqual(await readUploadCapabilities(address => port.read(address, ctx), legacy, extension), bytes);
    assert.deepEqual(calls, [extension, legacy]);
  }
});

test('production BLE PLX transport failure never falls back to legacy discovery', async () => {
  const failure = Object.assign(new Error('native read failed'), { errorCode: 400 });
  let calls = 0;
  const port = createBlePlxPort({ async readCharacteristicForDevice() { calls++; throw failure; } });
  const ctx = context();
  await assert.rejects(readUploadCapabilities(address => port.read(address, ctx), legacy, extension), error => error === failure);
  assert.equal(calls, 1);
});

test('prefers the whole extended snapshot without merging legacy flags', async () => {
  const calls = [], bytes = new Uint8Array([1, 2, 24, 0, 0x7f, 7]);
  assert.equal(await readUploadCapabilities(async address => { calls.push(address); return bytes; }, legacy, extension), bytes);
  assert.deepEqual(calls, [extension]);
});

test('only explicit absence of the selected extension falls back to legacy', async () => {
  for (const code of ['characteristic_not_found', 'service_not_found']) {
    const calls = [], bytes = new Uint8Array([1, 2, 24, 0, 0x7f, 3]);
    const result = await readUploadCapabilities(async address => {
      calls.push(address);
      if (address === extension) throw Object.assign(new Error('missing'), { code, ...extension });
      return bytes;
    }, legacy, extension);
    assert.equal(result, bytes);
    assert.deepEqual(calls, [extension, legacy]);
  }
});

test('transport errors and absence belonging to another endpoint never downgrade', async () => {
  for (const failure of [new Error('timeout'), Object.assign(new Error('absent'), { code: 'characteristic_not_found',
    ...extension, peripheralId: 'another-device' }), Object.assign(new Error('absent'), {
    code: 'service_not_found', ...extension, serviceUuid: 'another-service' })]) {
    let calls = 0;
    await assert.rejects(readUploadCapabilities(async () => { calls++; throw failure; }, legacy, extension), error => error === failure);
    assert.equal(calls, 1);
  }
});
