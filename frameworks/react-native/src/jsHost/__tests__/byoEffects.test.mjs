import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsByoEffects, JsByoBleLink } = loadSource('byoEffects.ts');
const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const SESSION = '11111111-2222-3333-4444-555555555555';
const SUCCESSOR = '22222222-3333-4444-5555-666666666666';
const CIPHERTEXT = Buffer.alloc(300, 3);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => Uint8Array.from(Buffer.from(JSON.stringify(value)));
function input(extra = {}) {
  return { operationId: 'byo-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', mode: 'sync',
    device: { id: 'ble-1', serialNumber: 'BOTA1', connectionState: 'connected', mtu: 247 },
    recording: { uuid: UUID, generation: 1 }, scope: { baseUrl: 'https://proxy.example/v1/',
      scopeKey: 'account/project/production', organizationId: 'org_1', projectId: 'prj_1',
      environment: 'production', deviceId: 'dev_1', bindingGeneration: 1 }, ...extra };
}
function contextDocument(extra = {}) {
  return { organization_id: 'org_1', project_id: 'prj_1', device_id: 'dev_1', environment: 'production',
    binding_generation: 1, device_assignment_generation: 1, policy_revision: '1', recording_uuid: UUID,
    recording_generation: 1, channel: 'ble', upload_session_id: SESSION, recording_id: 'rec_1',
    configuration_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', configuration_revision: 1,
    destination_ref: 'dest_1', owner_revision: 1, ciphertext_length: CIPHERTEXT.length,
    ciphertext_sha256: hash(CIPHERTEXT), ...extra };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(url, status, value) { return { url, status, async text() { return JSON.stringify(value); } }; }
function fixture(extra = {}) {
  const core = createGeneratedJsCore(); const journal = new Map(); const files = new Map(); const operations = [];
  const owner = new AbortController(); const ctx = { operationId: input().operationId, operation: 'ByoUpload', requestId: '0',
    cancellationId: '01'.repeat(16), generation: '1', signal: owner.signal };
  const publicResult = []; const uploaded = []; let owned = false;
  const persistence = { namespace: 'account/project/production', async load(key) { return journal.get(key) ?? null; },
    async save(key, value) { journal.set(key, structuredClone(value)); }, async remove(key) { journal.delete(key); } };
  const filePort = { async open(id) { if (!files.has(id)) files.set(id, Buffer.alloc(0)); return { id, scope: persistence.namespace, kind: 'file' }; },
    async create() { throw new Error('unexpected create'); }, async truncate(handle, size) { files.set(handle.id, files.get(handle.id).subarray(0, Number(size))); },
    async append(handle, offset, bytes) { assert.equal(Number(offset), files.get(handle.id).length); files.set(handle.id, Buffer.concat([files.get(handle.id), Buffer.from(bytes)])); return { durableUnits: String(files.get(handle.id).length) }; },
    async read(handle, offset, maximum) { return Uint8Array.from(files.get(handle.id).subarray(Number(offset), Number(offset) + maximum)); },
    async metadata(handle) { return { durableUnits: String(files.get(handle.id).length) }; }, async flush() {}, async finalize() {},
    async remove(handle) { files.delete(handle.id); } };
  const link = { async refresh() { operations.push('refresh'); }, setLive(live) { operations.push(`live:${live}`); },
    async call(operation, bytes) {
      operations.push(operation);
      if (operation === 1) return encoded({ upload_modes: extra.live ? ['whole_file', 'http_segments', 'ws_relay'] : ['whole_file'] });
      if (operation === 2) return encoded({ recording_uuid: UUID, recording_generation: 1, ciphertext_length: CIPHERTEXT.length, ciphertext_sha256: hash(CIPHERTEXT) });
      if (operation === 3) return encoded({ manifest: { ciphertext_length: CIPHERTEXT.length, ciphertext_sha256: hash(CIPHERTEXT) } });
      if (operation === 4 || operation === 10) return Uint8Array.from(CIPHERTEXT);
      if (operation === 5) return Uint8Array.from(Buffer.alloc(32, 4));
      if (operation === 6) { assert.ok([...journal.values()].some(value => value.recovery?.phase === 'CleanupPending')); return new Uint8Array(); }
      if (operation === 9) return encoded({ recording_uuid: UUID, recording_generation: 1, ciphertext_length: CIPHERTEXT.length, ciphertext_sha256: hash(CIPHERTEXT), closed: true, failed: false, overflow: false, retained_offset: 0, stream_selected: operations.filter(v => v === 9).length > 1 });
      if ([11, 12, 13].includes(operation)) return new Uint8Array();
      if (operation === 8) return encoded({ next: 0, recording: { recording_uuid: UUID, recording_generation: 1 } });
      throw new Error(`unexpected operation ${operation}`);
    } };
  const defaultFetch = async (url, request) => {
    assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.Authorization, 'Bearer app-token');
    if (url.endsWith('/capabilities')) return response(url, 200, { data: { destination: { kind: 'customer' }, upload_modes: extra.ws ? ['whole_file', 'http_segments', 'ws_relay'] : ['whole_file', 'http_segments'] } });
    if (url.endsWith('/byo-uploads') || url.endsWith('/byo-streams')) {
      assert.ok([...journal.values()].some(value => value.selected_customer === true && value.create_request));
      return response(url, 200, { data: { context: contextDocument() } });
    }
    if (url.endsWith('/prepare')) return response(url, 200, { data: { authorization: { configuration_sha256: 'ab'.repeat(32) }, status: {} } });
    if (url.endsWith('/upload')) return response(url, 200, { data: { status: {}, upload: { method: 'PUT', url: 'https://storage.example/key', headers: { 'content-type': 'application/octet-stream' } } } });
    if (url.endsWith('/complete')) return response(url, 200, { data: { receipt: { signature: 'verified-by-device' } } });
    if (url.endsWith('/grants')) return response(url, 200, { data: { result: { state: 'confirmed', segment: JSON.parse(request.body) } } });
    if (url.endsWith(`/byo-streams/${SESSION}`)) return response(url, 200, { data: { phase: 'open' } });
    if (url.endsWith('/handoff')) return response(url, 200, { data: { successor: contextDocument({ upload_session_id: SUCCESSOR, owner_revision: 2 }), handoff_mode: JSON.parse(request.body).mode } });
    throw new Error(`unexpected URL ${url}`);
  };
  const options = { core, persistence, files: filePort, fetch: extra.fetch ? (url, request) => extra.fetch(url, request, defaultFetch) : defaultFetch,
    async uploadFile(target, handle) { assert.equal(target.url, 'https://storage.example/key'); assert.deepEqual(files.get(handle.id), CIPHERTEXT); uploaded.push(handle.id); },
    async requestCredentials() { return 'app-token'; }, randomBytes(length) { return Uint8Array.from(Buffer.alloc(length, 10)); },
    now() { return 1000; }, async wait() {},
    async withDevice(_device, _operationId, _live, _signal, body) {
      assert.equal(owned, false); owned = true;
      try { return await body(ctx, link); } finally { owned = false; }
    }, ...extra.options };
  const effects = createJsByoEffects(options);
  return { effects, core, journal, files, operations, owner, ctx, uploaded, publicResult, defaultFetch, persistence, get owned() { return owned; } };
}

test('generated Rust BYO batch performs bytes in JS and receipt-gates device cleanup', async () => {
  const previous = globalThis.WebAssembly;
  try {
    globalThis.WebAssembly = undefined;
    const f = fixture(); const result = JSON.parse(await f.effects.syncByo(JSON.stringify(input())));
    assert.deepEqual(result, { recordingId: 'rec_1', uploadSessionId: SESSION });
    assert.deepEqual(f.operations.filter(value => typeof value === 'number'), [1, 2, 3, 4, 5, 6]);
    assert.equal(f.uploaded.length, 1); assert.equal(f.files.size, 0);
    assert.equal([...f.journal.values()][0].recovery.phase, 'Complete'); await f.effects.dispose();
  } finally { globalThis.WebAssembly = previous; }
});

test('generated Rust catalog exposes only full recording metadata', async () => {
  const f = fixture(); const result = JSON.parse(await f.effects.syncByo(JSON.stringify(input({ mode: 'list', recording: null }))));
  assert.deepEqual(result, [{ uuid: UUID, generation: 1 }]); assert.deepEqual(f.operations, ['refresh', 8]);
});

test('initial generated rejection performs no physical BYO acquisition', async () => {
  let claimed = 0;
  const f = fixture({ options: { async withDevice() { claimed++; throw new Error('Unexpected physical owner'); } } });
  const insecure = { ...input().scope, baseUrl: 'http://proxy.example/v1/' };
  await assert.rejects(f.effects.syncByo(JSON.stringify(input({ mode: 'unknown' }))), { code: 'invalid_input' });
  await assert.rejects(f.effects.syncByo(JSON.stringify(input({ scope: insecure }))), { code: 'invalid_input' });
  assert.equal(claimed, 0);
  assert.equal(f.operations.length, 0);
  assert.equal(f.journal.size, 0);
  await f.effects.dispose();
});

test('BYO transfer requires installed file flush before physical IO and catalog remains available', async () => {
  let claimed = 0;
  const transfer = fixture({ options: { files: {}, async withDevice() { claimed++; throw new Error('Unexpected physical owner'); } } });
  await assert.rejects(transfer.effects.syncByo(JSON.stringify(input())), { code: 'unsupported_capability' });
  await assert.rejects(transfer.effects.syncByo(JSON.stringify(input({ mode: 'stream' }))), { code: 'unsupported_capability' });
  assert.equal(claimed, 0);
  assert.equal(transfer.journal.size, 0);
  await transfer.effects.dispose();
  const catalog = fixture({ options: { files: {} } });
  assert.deepEqual(JSON.parse(await catalog.effects.syncByo(JSON.stringify(input({ mode: 'list', recording: null })))),
    [{ uuid: UUID, generation: 1 }]);
  await catalog.effects.dispose();
});

test('live HTTP segments reconcile fenced assembled successor without another PUT', async () => {
  const f = fixture({ live: true }); const result = JSON.parse(await f.effects.syncByo(JSON.stringify(input({ mode: 'stream' }))));
  assert.equal(result.uploadSessionId, SUCCESSOR); assert.equal(f.uploaded.length, 0);
  assert.ok(f.operations.includes('live:true')); assert.ok(f.operations.includes('live:false'));
  assert.ok(f.operations.indexOf(13) < f.operations.indexOf(5));
});

test('owner cancellation during transient HTTP aborts and cannot schedule a retry', async () => {
  const started = deferred(); const reply = deferred(); let requests = 0; let waits = 0; let submittedSignal;
  const f = fixture({ fetch: async (url, request) => { requests++; submittedSignal = request.signal; started.resolve(); await reply.promise; return response(url, 503, { error: { code: 'temporary' } }); },
    options: { async wait() { waits++; } } });
  const work = f.effects.syncByo(JSON.stringify(input())); await started.promise; f.owner.abort();
  assert.equal(submittedSignal.aborted, true); reply.resolve(); await assert.rejects(work);
  assert.equal(requests, 1); assert.equal(waits, 0); assert.equal(f.owned, false);
});

test('already dispatched CREATE drains and durably commits returned owner after cancellation', async () => {
  const started = deferred(); const reply = deferred();
  const f = fixture({ fetch: async (url, request, normal) => {
    if (!url.endsWith('/byo-uploads')) return normal(url, request);
    started.resolve(); await reply.promise; return response(url, 200, { data: { context: contextDocument() } });
  } });
  const work = f.effects.syncByo(JSON.stringify(input())); await started.promise; f.owner.abort();
  reply.resolve(); await assert.rejects(work);
  assert.ok([...f.journal.values()].some(value => value.context?.upload_session_id === SESSION));
  assert.equal(f.operations.includes(3), false); assert.equal(f.operations.includes(6), false);
});

test('failed receipt persistence preserves source and emits no device confirmation', async () => {
  const f = fixture();
  const save = f.persistence.save;
  f.persistence.save = async (key, value, ctx) => { if (value.recovery?.phase === 'ReceiptVerified') throw Object.assign(new Error('durability failed'), { code: 'persistence_failed' }); return save(key, value, ctx); };
  await assert.rejects(f.effects.syncByo(JSON.stringify(input())));
  assert.equal(f.operations.includes(5), true); assert.equal(f.operations.includes(6), false);
  assert.equal(f.files.size, 1); assert.equal([...f.journal.values()][0].recovery.phase, 'Verifying');
  await f.effects.dispose();
});

test('cancelled CREATE cannot save through a changed persistence namespace', async () => {
  const started = deferred(); const reply = deferred();
  const f = fixture({ fetch: async (url, request, normal) => { if (!url.endsWith('/byo-uploads')) return normal(url, request); started.resolve(); await reply.promise; return response(url, 200, { data: { context: contextDocument() } }); } });
  const work = f.effects.syncByo(JSON.stringify(input())); await started.promise;
  f.persistence.namespace = 'another/project'; f.owner.abort(); reply.resolve(); await assert.rejects(work);
  assert.equal([...f.journal.values()].some(value => value.context), false);
});

test('socket abort joins its receive and one OS close before releasing the physical owner', async () => {
  const receiveStarted = deferred(); const received = deferred(); const closed = deferred(); let closeCalls = 0;
  const f = fixture({ live: true, ws: true, options: { async openSocket() {
    return { protocol: 'bota-byo-stream-v1', async send() {}, receive() { receiveStarted.resolve(); return received.promise; }, close() { closeCalls++; return closed.promise; } };
  } } });
  const work = f.effects.syncByo(JSON.stringify(input({ mode: 'stream' }))); await receiveStarted.promise;
  f.owner.abort(); const cancelled = f.effects.cancelByo(input().operationId);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.owned, true); assert.equal(closeCalls, 1);
  closed.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.owned, true);
  received.reject(new Error('socket closed')); await assert.rejects(work); await cancelled;
  assert.equal(f.owned, false); assert.equal(closeCalls, 1); assert.equal(f.operations.includes(6), false);
});

function frame(operation, requestId, payload, { status = 0, offset = 0, total = payload.length } = {}) {
  const bytes = Buffer.alloc(12 + payload.length); bytes.set([0x71, 3, operation, status]); bytes.writeUInt32LE(requestId, 4); bytes.writeUInt16LE(offset, 8); bytes.writeUInt16LE(total, 10); Buffer.from(payload).copy(bytes, 12); return Uint8Array.from(bytes);
}
function linkFixture(extra = {}) {
  const core = createGeneratedJsCore(); const controller = new AbortController(); let listener;
  const ctx = { operationId: 'byo-owner', operation: 'ByoUpload', requestId: '0', cancellationId: '01'.repeat(16), generation: '1', signal: controller.signal };
  const writes = []; const cleanupErrors = []; let removed = 0;
  const ble = { async subscribe(address, onValue) { assert.equal(address.serviceUuid, 'B07A0004-0000-1000-8000-00805F9B34FB'); listener = onValue; return { async remove() { removed++; if (extra.removeFailure) throw new Error('unsubscribe failed'); } }; },
    async write(_address, bytes) { writes.push(Uint8Array.from(bytes)); if (extra.write) return extra.write(bytes, listener); listener(frame(bytes[2], Buffer.from(bytes).readUInt32LE(4), [])); } };
  const link = new JsByoBleLink({ core, ble, peripheralId: 'ble-1', maximumWriteBytes: 64, context: ctx,
    checkOwner() {}, async gatt(_ctx, body) { return body(); }, async refresh() {}, onCleanupFailure(error) { cleanupErrors.push(error); } });
  return { link, controller, ctx, writes, cleanupErrors, get removed() { return removed; } };
}
test('BYO BLE rejects future request identity and joins subscription cleanup', async () => {
  const f = linkFixture({ async write(bytes, listener) { listener(frame(bytes[2], Buffer.from(bytes).readUInt32LE(4) + 1, [])); } });
  await f.link.start(); await assert.rejects(f.link.call(8)); await f.link.close(); assert.equal(f.removed, 1);
});
test('BYO release uses fresh captured cleanup lease and only ABORT before unsubscribe', async () => {
  const f = linkFixture(); await f.link.start(); f.controller.abort();
  await f.link.release({ ...f.ctx, signal: new AbortController().signal });
  assert.deepEqual(f.writes.map(bytes => bytes[2]), [7]); assert.equal(f.removed, 1);
});
test('BYO failed unsubscribe is reported and remains retryable cleanup', async () => {
  const f = linkFixture({ removeFailure: true }); await f.link.start(); await assert.rejects(f.link.release({ ...f.ctx, signal: new AbortController().signal }));
  assert.equal(f.cleanupErrors.length, 1); assert.equal(f.removed, 1);
});
test('BYO signed/context/socket helpers reject mismatched authorities in generated Rust', () => {
  const f = fixture();
  assert.throws(() => f.core.codec('validateByoPut', { target: { method: 'PUT', url: 'https://storage.example/key', headers: { Authorization: 'must-not-forward' } } }));
  assert.throws(() => f.core.codec('acceptByoContextResult', { id: UUID, challengeBase64: 'x', bytes: Array.from(encoded({ data: { context_id: SESSION, challenge_base64: 'x', state: 'pending' } })) }));
  assert.throws(() => f.core.codec('acceptByoSocketReady', { session: SESSION, protocol: 'other', bytes: Array.from(encoded({ type: 'ready', session_id: SESSION })) }));
});
