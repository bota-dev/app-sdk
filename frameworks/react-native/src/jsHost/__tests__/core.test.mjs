import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const ota = JSON.parse(readFileSync(new URL('../../../../../protocol/fixtures/ota.json', import.meta.url), 'utf8'));
const core = createGeneratedJsCore();
const cancellation = Array.from({ length: 16 }, (_, index) => index + 1);
const start = generation => ({ version: 1, action: 'start', generation,
  operation: 'Discover', cancellation_id: cancellation, capabilities: ['Ble', 'Timer'],
  command: { DiscoverDevices: { timeout_ms: '100', allow_duplicates: false } } });

test('shared Rust executes as JS when WebAssembly is unavailable', () => {
  const previous = globalThis.WebAssembly;
  try {
    globalThis.WebAssembly = undefined;
    const factory = createGeneratedJsCore();
    assert.equal(factory.codec('protocolMetadata', {}).SERVICE_DEVICE_INFO, '180A');
    const engine = factory.createEngine();
    const response = engine.request(start('1'));
    assert.equal(response.ok, true);
    assert.equal(response.result.status.Running.operation, 'Discover');
    assert.ok(response.result.effects.some(effect => effect.effect.Ble?.StartScan));
    engine.dispose();
  } finally { globalThis.WebAssembly = previous; }
});

test('generated Rust firmware codecs match canonical golden fixture bytes', () => {
  const encoders = {
    firmwareUploadStart: input => core.codec('encodeFirmwareUploadStart', input),
    firmwareDataPacket: input => core.codec('encodeFirmwareData', { sequence: input.sequenceNumber,
      payload: Array.from(Buffer.from(input.payloadHex, 'hex')) }),
    firmwareWindowAck: input => core.codec('encodeFirmwareWindowAck', { sequence: input.sequenceNumber }),
    firmwareUploadVerify: input => core.codec('encodeFirmwareVerify', input),
  };
  let checked = 0;
  for (const fixture of ota.cases) {
    if (!encoders[fixture.operation] || !fixture.expectedHex) continue;
    assert.equal(Buffer.from(encoders[fixture.operation](fixture.input)).toString('hex'), fixture.expectedHex, fixture.name);
    checked++;
  }
  assert.ok(checked >= 3);
});

test('workflow generations retain exact u64 precision and reject their old owner', () => {
  const engine = core.createEngine();
  const response = engine.request(start('9007199254740993'));
  assert.equal(response.ok, true);
  assert.equal(response.result.generation, '9007199254740993');
  assert.equal(engine.request({ version: 1, action: 'cancel', generation: '9007199254740992',
    operation: 'Discover', cancellation_id: cancellation }).ok, false);
  assert.equal(engine.request({ version: 1, action: 'cancel', generation: '9007199254740993',
    operation: 'Discover', cancellation_id: cancellation }).ok, true);
  assert.equal(engine.request(start('9007199254740993')).ok, false);
  engine.dispose();
});

test('a known request cannot accept a callback from the wrong effect family', () => {
  const engine = core.createEngine();
  const response = engine.request(start('1'));
  const timer = response.result.effects.find(effect => effect.effect.Timer?.Schedule);
  assert.ok(timer);
  assert.equal(engine.request({ version: 1, action: 'dispatch', generation: '1', operation: 'Discover',
    cancellation_id: cancellation, event: { request_id: timer.request_id, kind: { Ble: 'WriteCompleted' } } }).ok, false);
  assert.equal(engine.request({ version: 1, action: 'dispatch', generation: '1', operation: 'Discover',
    cancellation_id: cancellation, event: { request_id: timer.request_id,
      kind: { TimerFired: { timer_id: timer.effect.Timer.Schedule.timer_id } } } }).ok, true);
  engine.dispose();
});

test('generated bridge validates core newtypes instead of trusting serde construction', () => {
  const engine = core.createEngine();
  const response = engine.request({ version: 1, action: 'start', generation: '1', cancellation_id: cancellation,
    capabilities: ['Ble', 'Timer', 'Persistence'], command: { Connect: { device: 'bad serial!',
      candidate: { peripheral_id: 'peripheral', name: null, advertised_address: null, rssi: -60 } } } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'invalid_input');
  assert.equal(engine.request({ version: 1, action: 'status' }).result.status, 'Idle');
  engine.dispose();
});

test('separate generated runtime memories cannot share codec or workflow ownership', () => {
  const left = createGeneratedJsCore(), right = createGeneratedJsCore();
  left.codec('hasherNew', { decoderId: 'same' });
  right.codec('hasherNew', { decoderId: 'same' });
  left.codec('hasherUpdate', { decoderId: 'same', bytes: [97, 98, 99] });
  assert.notDeepEqual(left.codec('hasherSnapshot', { decoderId: 'same' }), right.codec('hasherSnapshot', { decoderId: 'same' }));
  left.codec('hasherFree', { decoderId: 'same' });
  right.codec('hasherFree', { decoderId: 'same' });
});

test('disposed engines and oversized RPCs fail before allocation or host work', () => {
  const engine = core.createEngine();
  assert.throws(() => engine.request({ version: 1, action: 'status', input: 'x'.repeat(1024 * 1024) }), /bound/);
  engine.dispose();
  engine.dispose();
  assert.throws(() => engine.request(start('1')), /disposed/);
});

test('factory destruction retires live engines and codec state without double frees', () => {
  const factory = createGeneratedJsCore();
  const engine = factory.createEngine();
  engine.request(start('1'));
  factory.codec('hasherNew', { decoderId: 'retained' });
  factory.dispose();
  factory.dispose();
  engine.dispose();
  assert.throws(() => engine.request(start('2')), /disposed/);
  assert.throws(() => factory.createEngine(), /disposed/);
  assert.throws(() => factory.codec('hasherSnapshot', { decoderId: 'retained' }), /disposed/);
});
