import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { BotaJsHostExecutor } = loadSource('executor.ts');
const { createJsEncryptedUploadV2Backend } = loadSource('uploadBackendV2.ts');
const { createManagedEncryptedUploadV2Backend } = loadSource('../encryptedUploadV2Backend.ts');
const OP = '00112233-4455-6677-8899-aabbccddeeff', SESSION = '11112233-4455-6677-8899-aabbccddeeff';
const hash = value => createHash('sha256').update(value).digest();
const hex = value => hash(value).toString('hex');
const authorization = Buffer.alloc(408, 7), receipt = Buffer.alloc(336, 8), manifest = Buffer.alloc(580, 9), ciphertext = Buffer.alloc(900, 10);
const recording = { uuid: '22112233-4455-6677-8899-aabbccddeeff', generation: 3, storageFormat: 3,
  ciphertextLength: '900', ciphertextSha256: hex(ciphertext), startedAtMs: '1704067200123', durationMs: '1000', plaintextLength: '608' };
const evidence = { ciphertext_length: '900', ciphertext_sha256: [...hash(ciphertext)], manifest_length: 580, manifest_sha256: [...hash(manifest)] };
const device = { id: 'selected', serialNumber: 'NOTE000001', deviceType: 'bota_note', firmwareVersion: '1.0.19', isProvisioned: true, mtu: 247 };
const gate = () => { let enter, release; return { entered: new Promise(resolve => { enter = resolve; }), pending: new Promise(resolve => { release = resolve; }), enter, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const core = createGeneratedJsCore(), scope = new AbortController(), owner = new AbortController();
  const journal = new Map(), materials = new Map();
  const f = { core, scope, owner, journal, materials, removes: 0, completes: 0 };
  const context = (operationId = OP, signal = owner.signal) => ({ operation: 'EncryptedUploadV2', generation: '4',
    cancellationId: '01', requestId: '0', ...f.executionContext, operationId, signal });
  const persistence = { namespace: 'a:p:production', async load(key) { return structuredClone(journal.get(key) ?? null); },
    async save(key, value) { journal.set(key, structuredClone(value)); }, async remove(key) {
      if (key.startsWith('managed-encrypted-v2/')) { f.removes++; if (f.removeError) throw f.removeError; if (f.ignoreRemove) return; }
      journal.delete(key);
    } };
  const input = () => ({ operationId: OP, scope: { apiOrigin: 'https://fixture.invalid', apiBasePath: '/v1', scopeKey: 'a:p:production',
    accountId: 'a', projectId: 'p', organizationId: 'org', environment: 'production', endUserId: 'eu_fixture',
    deviceId: 'dev_fixture', bindingGeneration: 6, serialNumber: device.serialNumber, nativeDeviceId: device.id },
    recording, capability: { rawValueHex: '00'.repeat(24), flags: 0x37f } });
  const session = { profile: 'encrypted_upload_v2', session_id: SESSION, owner_revision: 2, policy: 'v2_required',
    authorization_base64: authorization.toString('base64'), authorization_sha256: hex(authorization), expires_at: '2030-01-01T00:00:00Z',
    state: 'published', channel: 'ble', ciphertext_length: 900, ciphertext_sha256: hex(ciphertext), plaintext_length: 608,
    completion_receipt_base64: receipt.toString('base64'), completion_receipt_sha256: hex(receipt) };
  const backend = createJsEncryptedUploadV2Backend({ core, persistence, files: {}, signal: scope.signal, context,
    now: () => 1704067200000, wait: async () => {}, requestCredentials: async () => 'fixture-token', readNonce: async () => '01'.repeat(16),
    registerMaterial(id, value) { materials.set(id, value); return 'fixture-material'; }, unregisterMaterial() { materials.clear(); },
    uploadFile: async () => assert.fail('Unexpected PUT'), fetch: async (url) => ({ url, status: 201,
      async text() { return JSON.stringify(url.endsWith('/recordings') ? { id: 'rec_fixture' } : session); } }) });
  Object.assign(f, { backend, persistence, context, prepare: () => backend.prepare(JSON.stringify(input())),
    confirm: async (current = context()) => { const material = materials.get(OP); await material.finalize(evidence, current);
      await material.completionReceipt(evidence, current); await material.confirmed(current); },
    managed: () => [...journal.entries()].filter(([key]) => key.startsWith('managed-encrypted-v2/')) });
  t.after(async () => { try { await backend.dispose(); await f.executor?.destroy(); } finally { core.dispose(); } });
  return f;
}

test('confirmed managed completion works with a live captured owner signal', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.prepare(); await f.confirm(); await f.backend.complete(OP);
  assert.equal(f.managed().length, 0); assert.equal(f.removes, 1);
});

test('actual generated Completed retirement preserves the confirmed managed completion handoff', { timeout: 5000 }, async t => {
  const f = fixture(t), metadata = f.core.codec('protocolMetadata', {});
  const values = new Map([[metadata.CHAR_SERIAL_NUMBER, Buffer.from(device.serialNumber)], [metadata.CHAR_MODEL_NUMBER, Buffer.from('Bota Note')],
    [metadata.CHAR_FIRMWARE_REVISION, Buffer.from('1.0.19')], [metadata.CHAR_HARDWARE_REVISION, Buffer.from('rev1')], [metadata.CHAR_PAIRING_STATE, Uint8Array.of(2)]]);
  const ports = { platform: 'ios', randomBytes: length => new Uint8Array(length).fill(1), persistence: f.persistence,
    ble: { async scan() { return { async remove() {} }; }, async connect() {}, async disconnect() {}, async discoverServices() {},
      async getMtu() { return 247; }, async read(address) { assert(values.has(address.characteristicUuid)); return Uint8Array.from(values.get(address.characteristicUuid)); },
      async write() {}, async subscribe() { return { async remove() {} }; } } };
  f.executor = new BotaJsHostExecutor(f.core, ports);
  // Real generated ConnectSelected proves the executor terminal-signal mechanism. Synthetic documents
  // and material callbacks here do not attest a full signed V2 transfer or physical confirmation.
  await f.executor.run(async current => {
    f.executionContext = current; await f.prepare(); await f.confirm(current); assert.equal(current.signal.aborted, false);
    return { ConnectSelected: { candidate: { peripheral_id: device.id, name: 'Bota Note', advertised_address: null, rssi: -50 } } };
  }, { operation: 'Connect', operationId: OP });
  assert.equal(f.executionContext.signal.aborted, true, 'The executor terminal fence remains intact');
  await f.backend.complete(OP); assert.equal(f.managed().length, 0); assert.equal(f.removes, 1);
});

test('owner cancellation before confirmed still refuses handoff and preserves the journal', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.prepare();
  const material = f.materials.get(OP), current = f.context();
  await material.finalize(evidence, current); await material.completionReceipt(evidence, current);
  f.owner.abort(); await assert.rejects(material.confirmed(current), { code: 'BOTA_UPLOAD_CANCELLED' });
  await assert.rejects(f.backend.complete(OP), { code: 'BOTA_UPLOAD_STATE' });
  assert.equal(f.managed().length, 1); assert.equal(f.removes, 0);
});

test('explicit cancel scope abort and disposal after confirmed retain their separate refusal authority', { timeout: 5000 }, async t => {
  for (const action of ['cancel', 'scope', 'dispose']) {
    const f = fixture(t); await f.prepare(); await f.confirm();
    if (action === 'cancel') await f.backend.cancel(OP);
    else if (action === 'scope') f.scope.abort();
    else await f.backend.dispose();
    await assert.rejects(f.backend.complete(OP), { code: action === 'cancel' ? 'BOTA_UPLOAD_STATE' : 'BOTA_UPLOAD_CANCELLED' });
    assert.equal(f.managed().length, 1); assert.equal(f.removes, 0);
  }
});

test('genuine journal removal and readback failures remain visible without repeating durable removal', { timeout: 5000 }, async t => {
  for (const mode of ['throw', 'unconfirmed']) {
    const f = fixture(t); await f.prepare(); await f.confirm();
    if (mode === 'throw') f.removeError = new Error('Fixture removal failed'); else f.ignoreRemove = true;
    const matches = error => mode === 'throw' ? error === f.removeError : error.code === 'BOTA_UPLOAD_JOURNAL';
    await assert.rejects(f.backend.complete(OP), matches); await assert.rejects(f.backend.complete(OP), matches);
    assert.equal(f.managed().length, 1); assert.equal(f.removes, 1);
  }
});

test('public wrapper waits for workflow fulfillment and never completes after failed joined cleanup', { timeout: 5000 }, async t => {
  for (const cleanupFails of [false, true]) {
    const f = fixture(t), held = gate(), cleanupError = new Error('Fixture joined cleanup failed');
    const native = { ...f.backend, async complete(id) { f.completes++; return f.backend.complete(id); },
      onCredentialsRequested() { return { remove() {} }; }, async resolveCredentials() {}, async rejectCredentials() {} };
    const recordings = { async syncEncryptedRecordingV2(_device, value, provider) {
      await provider({ operationId: OP, recording: value, capability: { rawValueHex: '00'.repeat(24), flags: 0x37f } });
      await f.confirm(); f.owner.abort(); held.enter(); await held.pending;
      if (cleanupFails) throw cleanupError;
    } };
    const publicBackend = createManagedEncryptedUploadV2Backend(native, recordings, { baseUrl: 'https://fixture.invalid/v1', scopeKey: 'a:p:production',
      accountId: 'a', projectId: 'p', organizationId: 'org', environment: 'production', endUserId: 'eu_fixture', signal: f.scope.signal,
      getAccessToken: async () => 'fixture-token' });
    const run = publicBackend.sync(device, recording, { deviceId: 'dev_fixture', bindingGeneration: 6 }); void run.catch(() => {});
    try {
      await held.entered; await tick(); assert.equal(f.completes, 0); assert.equal(f.managed().length, 1);
      held.release();
      if (cleanupFails) { await assert.rejects(run, error => error === cleanupError); assert.equal(f.completes, 0); assert.equal(f.managed().length, 1); }
      else { assert.deepEqual(await run, { recordingId: 'rec_fixture' }); assert.equal(f.completes, 1); assert.equal(f.managed().length, 0); }
    } finally { held.release(); await Promise.allSettled([run]); await publicBackend.dispose(); }
  }
});
