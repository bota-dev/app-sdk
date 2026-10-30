import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
const recording = { uuid: '00112233-4455-6677-8899-aabbccddeeff', generation: 1, storageFormat: 3,
  ciphertextLength: '900', ciphertextSha256: 'a'.repeat(64), startedAtMs: '0', durationMs: '0', plaintextLength: '608' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let enter, release;
  return { entered: new Promise(resolve => { enter = resolve; }), pending: new Promise(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}
function observe(promise) {
  const result = { settled: false };
  result.promise = promise.finally(() => { result.settled = true; });
  void result.promise.catch(() => {});
  return result;
}

async function fixture(t, localWifi) {
  const core = createGeneratedJsCore(), metadata = core.codec('protocolMetadata', {});
  const saved = new Map(), events = [], http = [], scope = new AbortController();
  const values = new Map([
    [metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000001')],
    [metadata.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
    [metadata.CHAR_FIRMWARE_REVISION, Buffer.from('1.0.19')],
    [metadata.CHAR_HARDWARE_REVISION, Buffer.from('rev1')],
    [metadata.CHAR_PAIRING_STATE, Uint8Array.of(2)],
    [metadata.CHAR_DEVICE_STATUS, Buffer.from('3200000200000000290004000163', 'hex')],
    [metadata.CHAR_STORAGE_TRANSFER_CAPABILITIES_V2, Uint8Array.from([1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0])],
  ]);
  const f = { core, metadata, saved, events, http, scope, values, statusGate: gate(), httpGate: gate(), holdStatus: false, holdHttp: false, scopeEpoch: 0, fileOpens: 0 };
  const unusedFile = async () => { throw new Error('Unexpected ciphertext IO'); };
  const ports = { localWifi, apiVersion: 1, platform: 'ios', signal: scope.signal,
    checkScope() { if (f.scopeEpoch !== 0) throw new Error('Fixture scope permanently retired'); },
    randomBytes: length => Uint8Array.from({ length }, (_, index) => index + 1),
    files: { async open() { f.fileOpens++; return unusedFile(); }, metadata: unusedFile, append: unusedFile, truncate: unusedFile,
      read: unusedFile, finalize: unusedFile, remove: unusedFile, async flush() {} },
    persistence: { namespace: 'account/project/user', async load(key) { return saved.get(key) ?? null; },
      async save(key, value) { saved.set(key, structuredClone(value)); }, async remove(key) { saved.delete(key); } },
    ble: {
      async scan() { return { async remove() {} }; }, async connect(id) { events.push(['connect', id]); },
      async discoverServices() {}, async disconnect(id) { events.push(['disconnect', id]); }, async getMtu() { return 247; },
      async read(address) {
        events.push(['read', address.characteristicUuid]);
        if (address.characteristicUuid === metadata.CHAR_DEVICE_STATUS && f.holdStatus) {
          f.holdStatus = false; f.statusGate.enter(); await f.statusGate.pending;
        }
        const value = values.get(address.characteristicUuid);
        assert(value, 'Fixture value for requested characteristic'); return Uint8Array.from(value);
      },
      async write(address) { events.push(['write', address.characteristicUuid]); },
      async subscribe() { return { async remove() {} }; },
    },
  };
  const runtime = createBotaReactNativeJsRuntime(ports, { backend: { fetch: async (url, request) => {
    http.push({ url, method: request.method, body: JSON.parse(request.body) }); events.push(['http']);
    if (f.holdHttp) { f.httpGate.enter(); await f.httpGate.pending; }
    return { url, status: 409, async text() { return '{"code":"fixture-conflict"}'; } };
  } }, uploadFile: unusedFile });
  await runtime.sdk.configure({ logLevel: 'none' });
  const device = await runtime.sdk.devices.connect({ id: 'selected', name: 'Bota Note', rssi: -50, discoveredAt: new Date(0) });
  const backend = runtime.createEncryptedUploadV2Backend({ baseUrl: 'https://fixture.invalid/v1', scopeKey: 'fixture-account/project',
    accountId: 'fixture-account', projectId: 'fixture-project', endUserId: 'eu_fixture', environment: 'production',
    signal: scope.signal, getAccessToken: async () => 'fixture-token' });
  Object.assign(f, { ports, runtime, device, backend,
    sync: (value = recording, options = {}) => backend.sync(device, value, { deviceId: 'dev_fixture', bindingGeneration: 6, ...options }),
    managed: () => [...saved.entries()].filter(([key]) => key.startsWith('managed-encrypted-v2/')) });
  t.after(async () => {
    f.statusGate.release(); f.httpGate.release();
    try { await backend.dispose(); await runtime.sdk.destroy(); } finally { core.dispose(); }
  });
  return f;
}

test('v2 workflow waits behind an admitted status read and precedes later ordinary controls', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true; f.holdHttp = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync()), later = observe(f.runtime.sdk.devices.readStatus());
  try {
    await tick();
    assert.equal(sync.settled, false, 'V2 admission must wait rather than reject busy');
    assert.equal(f.managed().length, 0); assert.equal(f.http.length, 0);
    f.statusGate.release(); await prior.promise; await f.httpGate.entered;
    assert.equal(later.settled, false, 'The later ordinary control cannot overtake V2 preparation');
    f.httpGate.release();
    await assert.rejects(sync.promise, { code: 'BOTA_UPLOAD_HTTP_409' }); await later.promise;
    const statusReads = f.events.map((event, index) => event[0] === 'read' && event[1] === f.metadata.CHAR_DEVICE_STATUS ? index : -1).filter(index => index >= 0);
    const createAt = f.events.findIndex(event => event[0] === 'http');
    assert.equal(statusReads.length, 2); assert(statusReads[0] < createAt && createAt < statusReads[1]);
    assert.equal(f.http.length, 1); assert.equal(f.managed().length, 1);
    assert.equal(f.managed()[0][1].phase, 'recording_create_unknown');
  } finally { f.statusGate.release(); f.httpGate.release(); await Promise.allSettled([prior.promise, sync.promise, later.promise]); }
});

test('an active v2 profile owns the lane and refuses unrelated controls and another workflow', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdHttp = true;
  const first = observe(f.sync()); await f.httpGate.entered;
  try {
    await assert.rejects(f.runtime.sdk.devices.readStatus(), { code: 'operation_in_progress' });
    await assert.rejects(f.runtime.sdk.devices.connect({ id: 'other', name: 'Bota Note', rssi: -40, discoveredAt: new Date(0) }), { code: 'operation_in_progress' });
    await assert.rejects(f.sync({ ...recording, uuid: '11112233-4455-6677-8899-aabbccddeeff' }), { code: 'operation_in_progress' });
    assert.equal(f.http.length, 1); assert.equal(f.managed().length, 1);
  } finally { f.httpGate.release(); await assert.rejects(first.promise, { code: 'BOTA_UPLOAD_HTTP_409' }); }
  await f.runtime.sdk.devices.readStatus();
  assert.equal(f.http.length, 1, 'The terminal failure is not retried by later ordinary reads');
});

test('caller cancellation removes a queued v2 admission without journal or HTTP work', { timeout: 5000 }, async t => {
  const f = await fixture(t), caller = new AbortController(); f.holdStatus = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync(recording, { signal: caller.signal }));
  try {
    await tick(); assert.equal(sync.settled, false);
    caller.abort(); await assert.rejects(sync.promise, /cancelled/);
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
    f.statusGate.release(); await prior.promise; await f.runtime.sdk.devices.readStatus();
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  } finally { f.statusGate.release(); await Promise.allSettled([prior.promise, sync.promise]); }
});

test('destroy rejects queued v2 admission and joins the previously submitted ordinary read', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync());
  let destroyed;
  try {
    await tick(); assert.equal(sync.settled, false);
    destroyed = observe(f.runtime.sdk.destroy()); await tick();
    assert.equal(destroyed.settled, false, 'Destroy must join the held OS read');
    await assert.rejects(sync.promise, /cancelled|destroyed/);
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
    f.statusGate.release(); await Promise.allSettled([prior.promise]); await destroyed.promise;
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  } finally { f.statusGate.release(); await Promise.allSettled([prior.promise, sync.promise, destroyed?.promise]); }
});

test('scope abort permanently retires queued v2 work before its profile can run', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync());
  try {
    await tick(); assert.equal(sync.settled, false);
    f.scope.abort(); await assert.rejects(sync.promise, /scope|cancelled/);
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
    f.statusGate.release(); await Promise.allSettled([prior.promise]);
    await assert.rejects(f.sync(), /scope|cancelled/);
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  } finally { f.statusGate.release(); await Promise.allSettled([prior.promise, sync.promise]); }
});

test('a scope A to B to A transition cannot revive an earlier queued v2 intent', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync());
  try {
    await tick(); assert.equal(sync.settled, false);
    f.ports.persistence.namespace = 'account/other/user'; f.scopeEpoch++;
    f.ports.persistence.namespace = 'account/project/user'; f.scopeEpoch++;
    f.statusGate.release(); await Promise.allSettled([prior.promise]);
    await assert.rejects(sync.promise, /scope|cancelled/);
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  } finally { f.statusGate.release(); await Promise.allSettled([prior.promise, sync.promise]); }
});

test('a physical A to B to A reconnect cannot revive the old queued v2 intent', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdStatus = true;
  const prior = observe(f.runtime.sdk.devices.readStatus()); await f.statusGate.entered;
  const sync = observe(f.sync());
  let disconnecting;
  try {
    await tick(); assert.equal(sync.settled, false);
    disconnecting = observe(f.runtime.sdk.devices.disconnect());
    await assert.rejects(sync.promise, /cancelled|identity|connected/);
    f.statusGate.release(); await Promise.allSettled([prior.promise]); await disconnecting.promise;
    f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000002'));
    await f.runtime.sdk.devices.connect({ id: 'replacement', name: 'Bota Note', rssi: -40, discoveredAt: new Date(0) });
    await f.runtime.sdk.devices.disconnect();
    f.values.set(f.metadata.CHAR_SERIAL_NUMBER, Buffer.from('NOTE000001'));
    await f.runtime.sdk.devices.connect({ id: 'selected', name: 'Bota Note', rssi: -40, discoveredAt: new Date(0) });
    await f.runtime.sdk.devices.readStatus();
    assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  } finally { f.statusGate.release(); await Promise.allSettled([prior.promise, sync.promise, disconnecting?.promise]); }
});

test('caller abort during active managed preparation joins late HTTP and retains the unknown-create journal', { timeout: 5000 }, async t => {
  const f = await fixture(t), caller = new AbortController(); f.holdHttp = true;
  const sync = observe(f.sync(recording, { signal: caller.signal })); await f.httpGate.entered;
  const journalKey = f.managed()[0][0];
  try {
    assert.equal(f.managed()[0][1].phase, 'recording_create_unknown');
    caller.abort(); await tick();
    assert.equal(sync.settled, false, 'The submitted HTTP attempt must settle before the public operation returns');
    assert.equal(f.fileOpens, 0); assert.equal(f.http.length, 1);
    f.httpGate.release(); await assert.rejects(sync.promise, /cancelled/);
    assert.equal(f.fileOpens, 0); assert.equal(f.saved.get(journalKey).phase, 'recording_create_unknown');
    assert.equal(f.events.filter(event => event[0] === 'write' && event[1] !== f.metadata.CHAR_TIME_SYNC).length, 0);
    await f.runtime.sdk.devices.readStatus();
    assert.equal(f.http.length, 1, 'Cancellation cannot replay create or start session/PUT');
  } finally { f.httpGate.release(); await Promise.allSettled([sync.promise]); }
});

test('destroy during active managed preparation joins late HTTP before releasing the workflow owner', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.holdHttp = true;
  const sync = observe(f.sync()); await f.httpGate.entered;
  const journalKey = f.managed()[0][0];
  let destroyed;
  try {
    destroyed = observe(f.runtime.sdk.destroy()); await tick();
    assert.equal(destroyed.settled, false); assert.equal(sync.settled, false);
    assert.equal(f.fileOpens, 0); assert.equal(f.http.length, 1);
    f.httpGate.release(); await assert.rejects(sync.promise, /cancelled/); await destroyed.promise;
    assert.equal(f.fileOpens, 0); assert.equal(f.saved.get(journalKey).phase, 'recording_create_unknown');
    assert.equal(f.events.filter(event => event[0] === 'write' && event[1] !== f.metadata.CHAR_TIME_SYNC).length, 0);
    assert.equal(f.http.length, 1, 'Destroy cannot start another request after ownership retires');
  } finally { f.httpGate.release(); await Promise.allSettled([sync.promise, destroyed?.promise]); }
});

test('identity nonce sink and the first generated effect retain one workflow owner through joined cancellation', { timeout: 5000 }, async t => {
  const f = await fixture(t), caller = new AbortController(), firstEffect = gate(), contexts = [];
  const read = f.ports.ble.read, load = f.ports.persistence.load;
  let authorizationCalls = 0, cleanupCalls = 0;
  f.values.set(f.metadata.CHAR_AUTH_NONCE, new Uint8Array(16).fill(2));
  f.ports.ble.read = async (address, context) => {
    if (address.characteristicUuid === f.metadata.CHAR_SERIAL_NUMBER) contexts.push(['identity', context]);
    if (address.characteristicUuid === f.metadata.CHAR_AUTH_NONCE) contexts.push(['nonce', context]);
    return read(address, context);
  };
  f.ports.files.open = async (id, kind, context) => {
    f.fileOpens++; contexts.push(['sink', context]);
    return { id, kind, scope: f.ports.persistence.namespace };
  };
  f.ports.persistence.load = async (key, context) => {
    if (key.startsWith('encrypted-upload-v2/') && context.requestId !== '0') {
      contexts.push(['generated-effect', context]); firstEffect.enter(); await firstEffect.pending;
    }
    return load(key, context);
  };
  const operationId = '11112233-4455-6677-8899-aabbccddeeff';
  const sync = observe(f.runtime.sdk.recordings.syncEncryptedRecordingV2(f.device, recording, async request => {
    assert.equal(request.operationId, operationId);
    assert.equal(await f.runtime.readEncryptedUploadV2AuthNonce(operationId), '02'.repeat(16));
    const materialRegistrationId = f.runtime.registerEncryptedUploadV2Material(operationId, {
      async authorization() { authorizationCalls++; throw new Error('Unexpected authorization after cancellation fence'); },
      async stageCiphertext() { throw new Error('Unexpected PUT'); }, async submitManifest() {}, async finalize() {},
      async completionReceipt() { throw new Error('Unexpected receipt'); },
      async cancel(context) { cleanupCalls++; contexts.push(['cleanup', context]); assert.equal(context.signal.aborted, false); },
    });
    return { profile: 'encrypted_upload_v2', uploadSessionId: '22112233-4455-6677-8899-aabbccddeeff',
      ownerRevision: 1, securityPolicy: 'v2_required', materialRegistrationId };
  }, undefined, { operationId, signal: caller.signal }));
  try {
    await firstEffect.entered;
    const phases = contexts.map(([phase]) => phase).filter((phase, index, all) => index === 0 || phase !== all[index - 1]);
    assert.deepEqual(phases, ['identity', 'nonce', 'sink', 'generated-effect']);
    assert.equal(new Set(contexts.map(([, context]) => context.generation)).size, 1);
    assert.equal(new Set(contexts.map(([, context]) => context.operationId)).size, 1);
    assert(contexts.every(([, context]) => context.operationId === operationId && context.operation === 'TransferRecording'));
    await assert.rejects(f.runtime.sdk.devices.readStatus(), { code: 'operation_in_progress' });
    caller.abort(); await tick(); assert.equal(sync.settled, false, 'Cancellation must join the submitted generated effect');
    firstEffect.release(); await assert.rejects(sync.promise, /cancelled/);
    assert.equal(f.fileOpens, 1); assert.equal(authorizationCalls, 0); assert.equal(cleanupCalls, 1);
    assert.equal(new Set(contexts.map(([, context]) => context.generation)).size, 1);
    assert.equal(f.http.length, 0);
    await f.runtime.sdk.devices.readStatus();
  } finally { firstEffect.release(); await Promise.allSettled([sync.promise]); }
});


test('local WiFi admission refuses missing or insecure ports before provider and file work', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.sync(recording, { transport: 'local_wifi' }), { code: 'native_operation_unavailable' });
  assert.equal(f.http.length, 0); assert.equal(f.fileOpens, 0); assert.equal(f.managed().length, 0);
});
test('local WiFi admission validates secure BLE and actual capabilities before cloud creation', { timeout: 5000 }, async t => {
  let allowed = false, preflights = 0;
  const f = await fixture(t, { async preflight() { preflights++; if (!allowed) throw new Error('Secure link unavailable'); },
    async join() { throw new Error('Must not join during admission'); } });
  const attempt = () => f.sync(recording, { transport: 'local_wifi' });
  await assert.rejects(attempt(), /Secure link unavailable/);
  assert.equal(f.http.length, 0); assert.equal(f.fileOpens, 0); assert.equal(f.managed().length, 0);
  allowed = true;
  f.values.set(f.metadata.CHAR_LOCAL_WIFI_CAPABILITIES, new Uint8Array(16));
  await assert.rejects(attempt()); assert.equal(f.http.length, 0); assert.equal(f.managed().length, 0);
  f.values.set(f.metadata.CHAR_LOCAL_WIFI_CAPABILITIES, Uint8Array.from([2, 2, 16, 0, 31, 0, 0, 0, 3, 0, 185, 0, 182, 0, 182, 0]));
  await assert.rejects(f.sync({ ...recording, markersRequired: true }, { transport: 'local_wifi' }));
  assert.equal(f.http.length, 0);
  await assert.rejects(attempt(), { code: 'BOTA_UPLOAD_HTTP_409' });
  assert.equal(preflights, 3); assert.equal(f.http.length, 1);
  assert.equal(f.http[0].body.upload_method, 'unknown');
  assert.equal(f.http[0].body.recording_uuid, recording.uuid);
  assert.equal(f.fileOpens, 0);
  assert.equal(f.events.filter(event => event[0] === 'write' && event[1] !== f.metadata.CHAR_TIME_SYNC).length, 0);
});
