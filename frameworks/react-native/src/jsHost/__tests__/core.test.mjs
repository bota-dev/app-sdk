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

test('generated provisioning relays an opaque envelope only through the credential characteristic', () => {
  const engine = core.createEngine();
  const context = { version: 1, generation: '1', operation: 'Provision', cancellation_id: cancellation };
  const step = input => {
    const response = engine.request({ ...context, ...input });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result.effects;
  };
  const complete = (request, kind) => step({ action: 'dispatch', event: { request_id: request.request_id, kind } });
  const ble = (effects, name) => {
    const request = effects.find(item => item.effect.Ble?.[name]);
    assert.ok(request, `expected ${name}`);
    return request;
  };
  try {
    let effects = step({ action: 'start', capabilities: ['Ble', 'Timer', 'Persistence', 'HostMaterial'],
      command: { Provision: { device: 'EVFXXW67KP', material_id: 'encrypted-bind' } } });
    effects = complete(ble(effects, 'Read'), { Ble: { ReadCompleted: { value: Array(16).fill(17) } } });
    effects = complete(ble(effects, 'Read'), { Ble: { ReadCompleted: { value: Array(64).fill(34) } } });
    const material = effects.find(item => item.effect.HostMaterial?.PrepareProvisioning);
    assert.ok(material);
    const envelope = Buffer.alloc(230); envelope.write('BOTATOK1');
    effects = complete(material, { ProvisioningMaterialPrepared: { material: {
      api_endpoint: [0], device_token: [], credential_envelope: [...envelope], mtu: 23,
    } } });
    const subscribe = ble(effects, 'Subscribe');
    effects = complete(subscribe, { Ble: { Subscribed: { characteristic_uuid: subscribe.effect.Ble.Subscribe.characteristic_uuid } } });
    effects = complete(ble(effects, 'Write'), { Ble: 'WriteCompleted' });
    const received = [];
    for (let index = 0; index < 15; index++) {
      const request = ble(effects, 'Write');
      const write = request.effect.Ble.Write;
      assert.equal(write.service_uuid, 'B07A000A-0000-1000-8000-00805F9B34FB');
      assert.equal(write.characteristic_uuid, 'B07A000A-0001-1000-8000-00805F9B34FB');
      assert.deepEqual(write.payload.slice(0, 2), [index, 15]);
      received.push(...write.payload.slice(2));
      effects = complete(request, { Ble: 'WriteCompleted' });
    }
    assert.deepEqual(Buffer.from(received), envelope);
    assert.equal(effects.some(item => item.effect.Ble?.Write), false);
  } finally { engine.dispose(); }
});

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

test('Find revision 2 keeps wire sizes and reports explicit reasons without changing legacy results', () => {
  const metadata=core.codec('protocolMetadata',{});
  assert.equal(metadata.CHAR_FIND_CHALLENGE,'B07A0009-0005-1000-8000-00805F9B34FB');
  const caps=core.codec('decodeFindCapabilities',{bytes:[2,31,30,10,1,0,0,0]});
  assert.equal(caps.protocolVersion,2);assert.equal(caps.bindingReady,true);assert.equal(caps.supported,true);
  const id='01'.repeat(16);
  const bytes=core.codec('encodeFindControl',{protocolVersion:2,action:'stop',durationSeconds:0,requestId:id});
  assert.deepEqual(bytes,[2,2,0,0,...Array(16).fill(1)]);
  const status=[2,0,2,1,...Array(16).fill(1),0,0,0,0];
  const decoded=core.codec('decodeFindStatus',{bytes:status,requestId:id});
  assert.equal(decoded.error,'device_busy');assert.equal(decoded.reason,'low_battery');
  status[3]=2;assert.equal(core.codec('decodeFindStatus',{bytes:status}).reason,'battery_unavailable');
  status[0]=1;status[3]=0;assert.equal(core.codec('decodeFindStatus',{bytes:status}).reason,null);
  const confirmation=Buffer.alloc(184);confirmation.write('BOTABND1');confirmation[8]=1;
  assert.equal(core.codec('encodeFindBinding',{grantBlob:confirmation.toString('base64'),capacity:193}).length,184);
  const ack=Buffer.alloc(104);ack.write('BOTABAK1');
  assert.equal(core.codec('decodeFindBindingAck',{bytes:[...ack]}),ack.toString('base64'));
});

test('Find revision 2 control agrees with the shared fixed server/firmware vector', () => {
  const v=JSON.parse(readFileSync(new URL('../../../../../protocol/find-authorization/find-revision-2.json',import.meta.url),'utf8'));
  const control=core.codec('encodeFindControl',{protocolVersion:2,action:'start',durationSeconds:10,requestId:v.requestIdHex});
  assert.equal(Buffer.from(control).toString('hex'),v.controlHex);
  assert.equal(core.codec('encodeFindGrant',{grantBlob:v.grantBlob,capacity:193}).length,193);
});

test('actual generated Rust core refuses plaintext material before subscribing or writing', () => {
  const engine = core.createEngine();
  const context = { version: 1, generation: '1', operation: 'Provision', cancellation_id: cancellation };
  const step = input => {
    const response = engine.request({ ...context, ...input });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result.effects;
  };
  const complete = (request, kind) => step({ action: 'dispatch', event: { request_id: request.request_id, kind } });
  try {
    let effects = step({ action: 'start', capabilities: ['Ble', 'Timer', 'Persistence', 'HostMaterial'],
      command: { Provision: { device: 'EVFXXW67KP', material_id: 'retired-bind' } } });
    effects = complete(effects.find(e => e.effect.Ble?.Read), { Ble: { ReadCompleted: { value: Array(16).fill(17) } } });
    effects = complete(effects.find(e => e.effect.Ble?.Read), { Ble: { ReadCompleted: { value: Array(64).fill(34) } } });
    effects = complete(effects.find(e => e.effect.HostMaterial?.PrepareProvisioning), { ProvisioningMaterialPrepared: { material: {
      api_endpoint: [0], device_token: [...Buffer.from('dtok_retired')], credential_envelope: null, mtu: 185,
    } } });
    assert.ok(effects.some(e => e.effect.Notify?.Failed), 'plaintext must fail in the generated core');
    assert.equal(effects.some(e => e.effect.Ble?.Subscribe || e.effect.Ble?.Write), false);
  } finally { engine.dispose(); }
});
