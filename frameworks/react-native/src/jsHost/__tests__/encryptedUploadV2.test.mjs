import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadSource } from './loadSource.mjs';

const { JsEncryptedUploadV2Host, JsEncryptedUploadV2Catalog, JsUploadContextExchange } = loadSource('encryptedUploadV2.ts');

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let journal = null;
  const calls = [];
  const cleanups = [];
  const controller = new AbortController();
  const context = { operation: 'TransferRecording', operationId: 'transfer-1', requestId: '1',
    generation: '1', cancellationId: '01'.repeat(16), signal: controller.signal,
    async emit() { throw new Error('Checkpoint handler must return an exact-request event'); },
    addCleanup(cleanup) { cleanups.push(cleanup); } };
  const request = { device: 'BOTA-001', owner_revision: 7, recording_generation: 3 };
  const persistence = { namespace: 'account/project/enduser/production',
    async load(key) { calls.push(['load', key]); return journal; },
    async save(key, value) { calls.push(['save', key]); journal = value; },
    async remove(key) { calls.push(['remove', key]); journal = null; } };
  const files = { async truncate(handle, offset) { calls.push(['truncate', handle.id, offset]); },
    async remove() { throw new Error('Checkpoint host must never delete files'); } };
  const core = { codec(name, input) {
    calls.push(['codec', name]);
    if (name === 'validateEncryptedUploadV2HostIdentity') {
      if (input.effect?.LoadCheckpoint?.owner_revision === 99) throw Object.assign(new Error('identity_mismatch'), { code: 'identity_mismatch' });
      return null;
    }
    if (name === 'normalizeEncryptedUploadV2Checkpoint') {
      if (input.checkpoint !== null && input.checkpoint.owner_revision !== input.request.owner_revision) {
        throw Object.assign(new Error('identity_mismatch'), { code: 'identity_mismatch' });
      }
      return input.checkpoint;
    }
    throw new Error(`Unexpected codec ${name}`);
  } };
  let currentOwner = true;
  const host = new JsEncryptedUploadV2Host({ core, ports: { persistence, files }, request,
    journalKey: 'BOTA-001/recording-1/generation-3/upload-session-1/owner-7',
    sink: { id: 'sink-1', kind: 'file', scope: persistence.namespace },
    checkOwner() { if (!currentOwner) throw Object.assign(new Error('stale_host_owner'), { code: 'stale_host_owner' }); } });
  const checkpoint = { owner_revision: 7, next_ciphertext_offset: '9007199254740993',
    checkpoint_revision: 8, prefix_sha256: [1, 2, 3] };
  return { host, context, controller, checkpoint, persistence, files, core, calls, cleanups,
    setJournal(value) { journal = value; }, setCurrent(value) { currentOwner = value; } };
}

test('checkpoint save acknowledges only a durable readable replacement and keeps decimal offsets', async () => {
  const f = fixture();
  assert.deepEqual(await f.host.handle({ SaveCheckpoint: { checkpoint: f.checkpoint } }, f.context),
    { EncryptedUploadV2: 'CheckpointSaved' });
  assert.deepEqual(await f.host.handle({ LoadCheckpoint: {} }, { ...f.context, requestId: '2' }),
    { EncryptedUploadV2: { CheckpointLoaded: f.checkpoint } });
  assert.deepEqual(f.calls.filter(call => ['save', 'load'].includes(call[0])).map(call => call[0]), ['save', 'load', 'load']);
  assert.equal(f.cleanups.length, 1);
  await f.host.close();
});

test('a storage read-back mismatch cannot acknowledge a checkpoint', async () => {
  const f = fixture();
  f.persistence.load = async () => null;
  await assert.rejects(f.host.handle({ SaveCheckpoint: { checkpoint: f.checkpoint } }, f.context),
    { code: 'checkpoint_commit_mismatch' });
  await f.host.close();
});

test('storage cannot mutate receiver evidence while returning the expected coordinator checkpoint', async () => {
  const f = fixture();
  const save = f.persistence.save;
  f.persistence.save = async (key, value) => {
    value.receiverCheckpoint = { revision: 900, next_ciphertext_offset: '0' };
    await save(key, value);
  };
  await assert.rejects(f.host.handle({ SaveCheckpoint: { checkpoint: f.checkpoint } }, f.context),
    { code: 'checkpoint_commit_mismatch' });
  await f.host.close();
});

test('cross-scope and cross-owner checkpoints are rejected before workflow continuation', async () => {
  const f = fixture();
  f.setJournal({ version: 1, scope: 'other/project', checkpoint: f.checkpoint });
  await assert.rejects(f.host.handle({ LoadCheckpoint: {} }, f.context), { code: 'checkpoint_scope_mismatch' });
  f.setJournal({ version: 1, scope: f.persistence.namespace, checkpoint: { ...f.checkpoint, owner_revision: 99 } });
  await assert.rejects(f.host.handle({ LoadCheckpoint: {} }, f.context), { code: 'identity_mismatch' });
  await f.host.close();
});

test('Rust identity rejection precedes any checkpoint mutation', async () => {
  const f = fixture();
  await assert.rejects(f.host.handle({ LoadCheckpoint: { owner_revision: 99 } }, f.context), { code: 'identity_mismatch' });
  assert.equal(f.calls.some(call => ['load', 'save', 'remove', 'truncate'].includes(call[0])), false);
  await f.host.close();
});

test('sink truncation carries an opaque scoped handle and exact decimal offset', async () => {
  const f = fixture();
  assert.deepEqual(await f.host.handle({ TruncateSink: { sink_id: 'sink-1', next_ciphertext_offset: '9007199254740993' } }, f.context),
    { EncryptedUploadV2: 'SinkTruncated' });
  assert.deepEqual(f.calls.find(call => call[0] === 'truncate'), ['truncate', 'sink-1', '9007199254740993']);
  await f.host.close();
});

test('cancellation joins submitted persistence and suppresses a stale success event', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.persistence.save = async () => { entered.resolve(); await release.promise; };
  const pending = f.host.handle({ SaveCheckpoint: { checkpoint: f.checkpoint } }, f.context);
  await entered.promise;
  f.controller.abort();
  const closing = f.host.close();
  release.resolve();
  await assert.rejects(pending, { code: 'stale_host_owner' });
  await closing;
  assert.equal(f.calls.filter(call => call[0] === 'load').length, 0);
});

test('old operation generations and changed physical owners cannot delete a checkpoint', async () => {
  const f = fixture();
  await f.host.handle({ LoadCheckpoint: {} }, f.context);
  await assert.rejects(f.host.handle({ DeleteCheckpoint: {} }, { ...f.context, generation: '2' }), { code: 'stale_host_owner' });
  f.setCurrent(false);
  await assert.rejects(f.host.handle({ DeleteCheckpoint: {} }, f.context), { code: 'stale_host_owner' });
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  await f.host.close();
});

test('metadata deletion and Abort preserve the physical device and opaque recording sink', async () => {
  const f = fixture();
  assert.equal(await f.host.handle({ DeleteCheckpoint: {} }, f.context), null);
  assert.equal(await f.host.handle({ AbortV2: { material_id: 'material-1' } }, f.context), null);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'truncate'), false);
  await f.host.close();
});

test('protected transfer effects fail closed without invoking protected-byte or deletion ports', async () => {
  const f = fixture();
  for (const kind of ['PrepareSession', 'StartTransfer', 'RepairWindow', 'AcknowledgeWindow',
    'StageArtifacts', 'AwaitCompletionReceipt', 'ConfirmWithReceipt']) {
    await assert.rejects(f.host.handle({ [kind]: {} }, f.context), { code: 'encrypted_upload_v2_protected_host_unavailable' });
  }
  assert.equal(f.calls.some(call => ['load', 'save', 'remove', 'truncate'].includes(call[0])), false);
  await f.host.close();
});

function catalogFixture() {
  const calls = [];
  const listeners = new Map();
  const controller = new AbortController();
  const context = { operation: 'ListRecordings', operationId: 'list-1', requestId: '1',
    generation: '4', cancellationId: '04'.repeat(16), signal: controller.signal };
  const catalog = { entries: [{ uuid: 'rust-recording', generation: 3, ciphertextLength: '9007199254740993', ciphertextSha256: 'rust-hash' }], listRevision: 8 };
  let current = true;
  const core = { codec(name, input) {
    calls.push(['codec', name, input]);
    if (name === 'protocolMetadata') return { SERVICE_BOTA_STORAGE: 'storage',
      CHAR_RECORDING_LIST_V2: 'list', CHAR_RECORDING_TRANSFER_V2: 'data',
      CHAR_TRANSFER_CONTROL_V2: 'control', operationTimeoutMs: 1000 };
    if (name === 'decodeEncryptedUploadV2Catalog') return input.bytes[0] === 7 ? catalog : null;
    if (name === 'decodeEncryptedUploadV2CatalogError') return [9, 10].includes(input.bytes[0])
      ? { code: 'protocol_rejected', retryable: false, protocolStatus: input.bytes[0] === 10 ? 3 : 14 } : null;
    if (name === 'planEncryptedUploadV2Catalog') {
      if (input.attempt === 1 && input.previousError === null) return { command: [201], includeMarkers: true };
      if (input.attempt === 2 && input.previousError?.code === 'protocol_rejected' && input.previousError?.protocolStatus === 3) return { command: [202], includeMarkers: false };
      throw new Error('Rust refused LIST fallback');
    }
    if (name === 'resetEncryptedUploadV2Catalog') return null;
    throw new Error(`Unexpected catalog codec ${name}`);
  } };
  const ble = {
    async subscribe(address, callback) {
      calls.push(['subscribe', address.characteristicUuid]);
      listeners.set(address.characteristicUuid, callback);
      callback(Uint8Array.of(7)); // Before command, this stale startup value must be ignored.
      return { async remove() { calls.push(['remove', address.characteristicUuid]); listeners.delete(address.characteristicUuid); } };
    },
    async write(address, bytes, withResponse) {
      calls.push(['write', address.characteristicUuid, [...bytes], withResponse]);
      listeners.get('data')?.(Uint8Array.of(1)); // Rust owns the decision to ignore an older-session error.
      listeners.get('list')?.(Uint8Array.of(2));
      listeners.get('list')?.(Uint8Array.of(7));
    },
  };
  const reader = new JsEncryptedUploadV2Catalog({ core, ports: { ble }, peripheralId: 'peripheral-1',
    gatt: (_context, body) => body(), checkOwner() {
      if (!current) throw Object.assign(new Error('stale_host_owner'), { code: 'stale_host_owner' });
    } });
  return { reader, core, ble, calls, listeners, context, controller, catalog, setCurrent(value) { current = value; } };
}

test('v2 catalog installs both channels before LIST and returns only Rust-validated metadata', async () => {
  const f = catalogFixture();
  assert.deepEqual(await f.reader.read(f.context, '9007199254740993'), f.catalog);
  assert.deepEqual(f.calls.filter(call => ['subscribe', 'write', 'remove'].includes(call[0])),
    [['subscribe', 'list'], ['subscribe', 'data'], ['write', 'control', [201], true], ['remove', 'data'], ['remove', 'list']]);
  const decode = f.calls.filter(call => call[0] === 'codec' && call[1] === 'decodeEncryptedUploadV2Catalog');
  assert.deepEqual(decode.map(call => call[2].bytes), [[], [2], [7]]);
  assert.equal(decode[0][2].transportSessionId, '9007199254740993');
  assert.equal(f.calls.at(-1)[1], 'resetEncryptedUploadV2Catalog');
});

test('v2 catalog surfaces Rust LIST rejection with its exact protocol status', async () => {
  const f = catalogFixture();
  f.ble.write = async () => { f.listeners.get('data')(Uint8Array.of(9)); };
  await assert.rejects(f.reader.read(f.context, '7'), { code: 'protocol_rejected', protocolStatus: 14 });
  assert.deepEqual(f.calls.filter(call => call[0] === 'remove').map(call => call[1]), ['data', 'list']);
});

test('Rust admits a single basic LIST retry only after marked LIST subscriptions settle', async () => {
  const f = catalogFixture();
  const write = f.ble.write;
  f.ble.write = async (address, bytes, response) => {
    if (bytes[0] === 201) { f.calls.push(['write-marked']); f.listeners.get('data')(Uint8Array.of(10)); }
    else await write(address, bytes, response);
  };
  assert.deepEqual(await f.reader.read(f.context, '7'), f.catalog);
  assert.deepEqual(f.calls.filter(call => ['subscribe', 'remove', 'write-marked', 'write'].includes(call[0])).map(call => call[0]),
    ['subscribe', 'subscribe', 'write-marked', 'remove', 'remove', 'subscribe', 'subscribe', 'write', 'remove', 'remove']);
  assert.equal(f.calls.find(call => call[0] === 'write')[2][0], 202);
});

test('catalog transport failure during subscription prevents LIST and removes the exact acquired subscription', async () => {
  const f = catalogFixture();
  const failure = new Error('subscription disconnected');
  f.ble.subscribe = async (address, _callback, _context, onError) => {
    f.calls.push(['subscribe', address.characteristicUuid]); onError(failure);
    return { async remove() { f.calls.push(['remove', address.characteristicUuid]); } };
  };
  await assert.rejects(f.reader.read(f.context, '7'), error => error === failure);
  assert.deepEqual(f.calls.filter(call => ['subscribe', 'remove', 'write'].includes(call[0])), [['subscribe', 'list'], ['remove', 'list']]);
});

test('v2 catalog joins a pending LIST write before cancellation cleanup', async () => {
  const f = catalogFixture();
  const entered = deferred();
  const release = deferred();
  f.ble.write = async () => { entered.resolve(); await release.promise; };
  const pending = f.reader.read(f.context, '7');
  await entered.promise;
  f.controller.abort();
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  release.resolve();
  await assert.rejects(pending, { code: 'operation_cancelled' });
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 2);
});

test('v2 catalog cleans a late subscription without LIST after cancellation during startup', async () => {
  const f = catalogFixture();
  const entered = deferred();
  const release = deferred();
  f.ble.subscribe = async () => {
    entered.resolve();
    await release.promise;
    return { async remove() { f.calls.push(['remove', 'late-list']); } };
  };
  const pending = f.reader.read(f.context, '7');
  await entered.promise;
  f.controller.abort();
  release.resolve();
  await assert.rejects(pending, { code: 'operation_cancelled' });
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
});

test('v2 catalog rejects changed physical ownership and preserves exact decoder cleanup', async () => {
  const f = catalogFixture();
  f.ble.write = async () => { f.setCurrent(false); f.listeners.get('list')(Uint8Array.of(7)); };
  await assert.rejects(f.reader.read(f.context, '7'), { code: 'stale_host_owner' });
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 2);
  const initialized = f.calls.find(call => call[1] === 'decodeEncryptedUploadV2Catalog');
  assert.equal(f.calls.at(-1)[2].decoderId, initialized[2].decoderId);
});

function protectedFixture({ repair = false, blockSave = false, blockAppend = false, timeout = 1000 } = {}) {
  const calls = [];
  const cleanupFailures = [];
  const saved = deferred(), saveRelease = deferred(), appended = deferred(), appendRelease = deferred();
  const completed = deferred();
  const listeners = new Map();
  const controller = new AbortController();
  const scope = 'account/project/user/production';
  const sink = { id: 'sink', kind: 'file', scope };
  const buffers = new Map([['sink', Buffer.alloc(0)]]);
  const hash = value => [...createHash('sha256').update(value).digest()];
  const ciphertext = Buffer.from('abcd');
  const manifest = Buffer.alloc(580);
  const request = { device: 'BOTA-001', recording: Array(16).fill(2), recording_generation: 3,
    upload_session_uuid: Array(16).fill(1), owner_revision: 7, transport_session_id: '9',
    sink_id: 'sink', material_id: 'material', window_packets: 4, data_payload_bytes: 8,
    ciphertext_length: '4', ciphertext_sha256: hash(ciphertext), capabilities: { maximum_missing_sequences: 4,
      maximum_signed_blob_bytes: 1024, durable_checkpoint_interval_blocks: 8 } };
  const native = { revision: 1, next_ciphertext_offset: '4', prefix_sha256: hash(ciphertext), highest_contiguous_sequence: 1 };
  const evidence = { ciphertext_length: '4', ciphertext_sha256: hash(ciphertext), manifest_length: 580,
    manifest_sha256: hash(manifest), block_count: 1 };
  let journal = null;
  let contextState = 0;
  let terminal = false;
  const hashers = new Map();
  const core = { codec(name, input) {
    calls.push(['codec', name, input]);
    switch (name) {
      case 'protocolMetadata': return { SERVICE_BOTA_STORAGE: 'storage', CHAR_TRANSFER_CONTROL_V2: 'control',
        CHAR_RECORDING_TRANSFER_V2: 'data', CHAR_TRANSFER_SIGNED_BLOB_V2: 'signed', CHAR_UPLOAD_CONTEXT_V2: 'context', operationTimeoutMs: timeout };
      case 'validateEncryptedUploadV2HostIdentity': return null;
      case 'normalizeEncryptedUploadV2Checkpoint': return input.checkpoint;
      case 'validateEncryptedUploadV2Authorization': return { blobKind: 1, markersRequired: false, sha256: Array(32).fill(7) };
      case 'validateEncryptedUploadV2Receipt': return { blobKind: 2, sha256: Array(32).fill(8) };
      case 'encodeUploadContextBegin': return [50];
      case 'acceptUploadContextSnapshot': return input.expectedState === contextState ? [contextState] : null;
      case 'validateUploadContextDocument': return null;
      case 'planEncryptedUploadV2SignedBlob': return { frames: [[31, input.blobKind], [32, input.blobKind]], abortFrame: [33, input.blobKind] };
      case 'acceptEncryptedUploadV2SignedBlobResult': return 'accepted';
      case 'planEncryptedUploadV2Opening': return [input.checkpoint ? 22 : 20];
      case 'acceptEncryptedUploadV2Opening': return input.bytes[0] === 23 ? 'resume_rejected' : 'opened';
      case 'initialEncryptedUploadV2ReceiverCheckpoint': return { revision: 0, next_ciphertext_offset: '0', prefix_sha256: hash(Buffer.alloc(0)), highest_contiguous_sequence: null };
      case 'createEncryptedUploadV2Receiver': terminal = false; return { receiverId: 1 };
      case 'startEncryptedUploadV2Receiver': return { InspectSink: { request_id: '1', prefix_length: '0', flush: false } };
      case 'receiveEncryptedUploadV2Receiver':
        if (terminal) throw new Error('receiver retired');
        if (input.bytes[0] === 5) return { Control: { frame: [43] } };
        if (input.bytes[0] === 2) return { AppendCiphertext: { request_id: '2', offset: '0', bytes: [...ciphertext] } };
        if (input.bytes[0] === 4) return { InspectSink: { request_id: '5', prefix_length: '4', flush: true } };
        return 'None';
      case 'applyEncryptedUploadV2Receiver': {
        const fields = Object.values(input.event)[0];
        if (fields.request_id === '2') return { InspectSink: { request_id: '3', prefix_length: '4', flush: true } };
        if (fields.request_id === '3') return { PersistCheckpoint: { request_id: '4', checkpoint: native } };
        if (fields.request_id === '4') return { Control: { frame: [42] } };
        if (fields.request_id === '5') return { Complete: { manifest: [...manifest], evidence, marker_evidence: null } };
        return 'None';
      }
      case 'decodeEncryptedUploadV2Transfer': return [2, 5].includes(input.bytes[0])
        ? { kind: 'window_end', checkpointRevision: 1, nextCiphertextOffset: '4', prefixSha256: hash(ciphertext), lastSequence: 1 }
        : input.bytes[0] === 43 ? { kind: 'window_ack', missingSequences: [2] } : { kind: 'data' };
      case 'planEncryptedUploadV2Confirm': return [60];
      case 'acceptEncryptedUploadV2Confirm': return null;
      case 'planEncryptedUploadV2Abort': return [61];
      case 'cancelEncryptedUploadV2Receiver': terminal = true; return null;
      case 'freeEncryptedUploadV2Receiver': terminal = true; return null;
      case 'hasherNew': hashers.set(input.decoderId, []); return null;
      case 'hasherUpdate': hashers.get(input.decoderId).push(...input.bytes); return null;
      case 'hasherSnapshot': return { sha256: hash(Buffer.from(hashers.get(input.decoderId))) };
      case 'hasherFree': hashers.delete(input.decoderId); return null;
      case 'encryptedUploadV2Failure': return { EncryptedUploadV2: { Failed: { error: input } } };
    }
    throw new Error(`Missing protected fixture codec ${name}`);
  } };
  const ports = { persistence: { namespace: scope,
    async load() { calls.push(['load']); return journal; },
    async save(_key, value) { calls.push(['save']); saved.resolve(); if (blockSave) await saveRelease.promise; journal = value; },
    async remove() { calls.push(['remove-checkpoint']); journal = null; } },
    randomBytes: length => Uint8Array.from({ length }, () => 1),
    files: { async open(id) { if (!buffers.has(id)) buffers.set(id, Buffer.alloc(0)); return { id, kind: 'file', scope }; },
      async metadata(handle) { return { durableUnits: buffers.get(handle.id).length.toString() }; },
      async truncate(handle, length) { buffers.set(handle.id, buffers.get(handle.id).subarray(0, Number(length))); calls.push(['truncate', length]); },
      async append(handle, offset, value) { calls.push(['append', offset]); appended.resolve(); if (blockAppend) await appendRelease.promise;
        buffers.set(handle.id, Buffer.concat([buffers.get(handle.id).subarray(0, Number(offset)), Buffer.from(value)]));
        return { durableUnits: buffers.get(handle.id).length.toString() }; },
      async flush() { calls.push(['flush']); },
      async read(handle, offset, count) { calls.push(['read-file', offset, count]); return Uint8Array.from(buffers.get(handle.id).subarray(Number(offset), Number(offset) + count)); },
      async remove() { throw new Error('No device or local-file deletion before verified completion'); } },
    ble: { async read() { return Uint8Array.of(contextState); },
      async subscribe(address, notify) { calls.push(['subscribe', address.characteristicUuid]); listeners.set(address.characteristicUuid, notify);
        return { async remove() { calls.push(['unsubscribe', address.characteristicUuid]); listeners.delete(address.characteristicUuid); } }; },
      async write(address, value) {
        calls.push(['write', address.characteristicUuid, [...value]]);
        if (value[0] === 50) contextState = 1;
        if (value[0] === 32) { if (value[1] === 3) contextState = 2; if (value[1] === 4) contextState = 3; listeners.get('signed')(Uint8Array.of(34)); }
        if (value[0] === 20) { listeners.get('data')(Uint8Array.of(21)); listeners.get('data')(Uint8Array.of(1)); listeners.get('data')(Uint8Array.of(repair ? 5 : 2)); }
        if (value[0] === 22) listeners.get('data')(Uint8Array.of(23));
        if (value[0] === 43) { listeners.get('data')(Uint8Array.of(6)); listeners.get('data')(Uint8Array.of(2)); }
        if (value[0] === 42) { listeners.get('data')(Uint8Array.of(3)); listeners.get('data')(Uint8Array.of(4)); }
      } },
  };
  const material = { async authorization() { return Uint8Array.of(77); },
    uploadContext: { async challenge() { return Uint8Array.of(78); }, async result() { return Uint8Array.of(79); } },
    async stageCiphertext() { calls.push(['stage']); }, async submitManifest() { calls.push(['manifest']); },
    async finalize() { calls.push(['finalize']); }, async completionReceipt() { calls.push(['receipt']); return Uint8Array.of(80); },
    async confirmed() { calls.push(['confirmed']); }, async cancel() { calls.push(['cancel']); } };
  let host;
  let work = Promise.resolve();
  const events = [];
  const context = { operation: 'TransferRecording', operationId: 'transfer', requestId: 'start', generation: '1',
    cancellationId: '01'.repeat(16), signal: controller.signal, addCleanup() {}, async emit(value) {
      events.push({ requestId: this.requestId, value });
      const staged = value.EncryptedUploadV2?.WindowStaged;
      if (staged) work = work.then(async () => {
        if (staged.missing_sequences.length) await host.handle({ RepairWindow: { missing_sequences: staged.missing_sequences } }, { ...context, requestId: 'repair' });
        else {
          await host.handle({ SaveCheckpoint: { checkpoint: staged.checkpoint } }, { ...context, requestId: 'save' });
          await host.handle({ AcknowledgeWindow: { checkpoint: staged.checkpoint } }, { ...context, requestId: 'ack' });
        }
      });
      if (value.EncryptedUploadV2?.TransferCompleted) completed.resolve(value.EncryptedUploadV2.TransferCompleted);
      if (value.EncryptedUploadV2?.Failed) completed.resolve(value);
    } };
  host = new JsEncryptedUploadV2Host({ core, ports, request, sink, journalKey: 'exact-session', material,
    peripheralId: 'peripheral', maximumWriteBytes: 244, gatt: (_context, body) => body(),
    checkOwner(ctx) { if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); },
    onCleanupFailure(error) { cleanupFailures.push(error); } });
  return { host, core, ports, material, context, controller, request, evidence, native, calls, events, buffers,
    saved, saveRelease, appended, appendRelease, completed, cleanupFailures,
    setJournal(value) { journal = value; }, settled() { return work; } };
}

test('marker file restart replaces only an exact retained prefix and flushes before acknowledgement', async () => {
  const { createGeneratedJsCore } = loadSource('core.ts');
  const generated = createGeneratedJsCore();
  for (const retained of [Buffer.from([1, 2]), Buffer.from([9, 2])]) {
    const f = protectedFixture();
    const codec = f.core.codec;
    f.core.codec = (name, input) => name === 'planEncryptedUploadV2MarkerFileRecovery' ? generated.codec(name, input) : codec(name, input);
    await f.host.handle({ LoadCheckpoint: {} }, f.context);
    const document = Buffer.from([1, 2, 3, 4]);
    const path = `${f.host.key}/marker/0`;
    f.buffers.set(path, retained);
    const action = { AppendMarkerDocument: { request_id: '99', document_index: 0, document_count: 1,
      document: [...document], document_sha256: [...createHash('sha256').update(document).digest()] } };
    if (retained[0] === 1) {
      await f.host.applyAction(action, f.context);
      assert.deepEqual(f.buffers.get(path), document);
      assert.ok(f.calls.some(call => call[0] === 'truncate' && call[1] === '0'));
      assert.ok(f.calls.some(call => call[0] === 'flush'));
      assert.equal(f.host.markers.length, 1);
    } else {
      await assert.rejects(f.host.applyAction(action, f.context), { code: 'integrity_failed' });
      assert.equal(f.calls.some(call => call[0] === 'truncate'), false);
      assert.equal(f.host.markers.length, 0);
    }
    await f.host.close();
  }
  generated.dispose();
});

test('protected pump maps Rust persistence through coordinator Save/ACK and completes without a fabricated CONFIRM ACK', async () => {
  const f = protectedFixture({ blockSave: true });
  const prepared = await f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await f.host.handle({ StartTransfer: { request: f.request, checkpoint: null, authorization_sha256: prepared.EncryptedUploadV2.SessionPrepared.authorization_sha256 } }, f.context);
  await f.saved.promise;
  assert.equal(f.calls.some(call => call[0] === 'write' && call[2][0] === 42), false);
  f.saveRelease.resolve();
  assert.deepEqual(await f.completed.promise, f.evidence);
  await f.settled();
  await f.host.handle({ StageArtifacts: { sink_id: 'sink', material_id: 'material', evidence: f.evidence } }, f.context);
  const receipt = await f.host.handle({ AwaitCompletionReceipt: { material_id: 'material', evidence: f.evidence } }, f.context);
  assert.deepEqual(await f.host.handle({ ConfirmWithReceipt: { material_id: 'material', receipt_sha256: receipt.EncryptedUploadV2.CompletionReceiptAccepted.receipt_sha256 } }, f.context),
    { EncryptedUploadV2: 'RecordingConfirmed' });
  assert.deepEqual(f.calls.filter(call => ['stage', 'manifest', 'finalize', 'receipt', 'confirmed'].includes(call[0])).map(call => call[0]),
    ['stage', 'manifest', 'finalize', 'receipt', 'confirmed']);
  assert.deepEqual([...f.buffers.get('sink')], [...Buffer.from('abcd')]);
  assert.equal(f.calls.some(call => call[0] === 'write' && call[2][0] === 61), false);
  assert.equal(f.calls.filter(call => call[0] === 'read-file').length, 1);
  await f.host.close();
});

test('Rust repair action is routed to the exact Repair request before restored Start request accepts completion', async () => {
  const f = protectedFixture({ repair: true });
  const prepared = await f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await f.host.handle({ StartTransfer: { request: f.request, checkpoint: null, authorization_sha256: prepared.EncryptedUploadV2.SessionPrepared.authorization_sha256 } }, f.context);
  assert.deepEqual(await f.completed.promise, f.evidence);
  await f.settled();
  const windows = f.events.filter(item => item.value.EncryptedUploadV2?.WindowStaged);
  assert.deepEqual(windows.map(item => item.requestId), ['start', 'repair']);
  assert.equal(f.events.find(item => item.value.EncryptedUploadV2?.TransferCompleted).requestId, 'start');
  assert.deepEqual(f.calls.filter(call => call[0] === 'write' && [43, 42].includes(call[2][0])).map(call => call[2]), [[43], [42]]);
  await f.host.close();
});

test('abort joins a submitted ciphertext append before unsubscribe, preserves bytes, and sends no checkpoint ACK', async () => {
  const f = protectedFixture({ blockAppend: true });
  const prepared = await f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await f.host.handle({ StartTransfer: { request: f.request, checkpoint: null, authorization_sha256: prepared.EncryptedUploadV2.SessionPrepared.authorization_sha256 } }, f.context);
  await f.appended.promise;
  f.controller.abort();
  const pending = f.host.handle({ AbortV2: { material_id: 'material' } }, { ...f.context, signal: new AbortController().signal });
  assert.equal(f.calls.some(call => call[0] === 'unsubscribe' && call[1] === 'data'), false);
  f.appendRelease.resolve();
  await pending;
  assert.equal(f.calls.some(call => call[0] === 'write' && call[2][0] === 42), false);
  assert.equal(f.calls.filter(call => call[0] === 'unsubscribe' && call[1] === 'data').length, 1);
  await f.host.close();
});

test('context deadline suppresses a late provider document without emitting authorization or transfer effects', async () => {
  const f = protectedFixture({ timeout: 25 });
  const entered = deferred(), release = deferred();
  f.material.uploadContext.challenge = async () => { entered.resolve(); return release.promise; };
  const pending = f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await entered.promise;
  await assert.rejects(pending, { code: 'timeout' });
  const bytes = Uint8Array.of(77, 88, 99);
  release.resolve(bytes);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...bytes], [0, 0, 0]);
  assert.equal(f.calls.some(call => call[0] === 'write' && call[1] === 'signed'), false);
  await f.host.close();
});

test('catalog cleanup failure invokes shared owner retention and blocks a second read without BLE IO', async () => {
  const f = catalogFixture();
  const failure = new Error('unsubscribe_failed');
  let retained;
  const reader = new JsEncryptedUploadV2Catalog({ core: f.core, ports: { ble: {
    ...f.ble, async subscribe(address, callback) {
      const original = await f.ble.subscribe(address, callback);
      return { async remove() { await original.remove(); throw failure; } };
    },
  } }, peripheralId: 'peripheral', checkOwner() {}, gatt: (_context, body) => body(),
    onCleanupFailure(error) { retained = error; } });
  await assert.rejects(reader.read(f.context, '7'), error => error === failure);
  assert.equal(retained, failure);
  const before = f.calls.length;
  await assert.rejects(reader.read(f.context, '8'), error => error === failure);
  assert.equal(f.calls.length, before);
});

test('managed and BYO reuse one context exchanger over only BLE/random ports with exact generation fencing', async () => {
  const f = protectedFixture();
  const exchanger = new JsUploadContextExchange({ core: f.core, ports: { ble: f.ports.ble, randomBytes: f.ports.randomBytes },
    peripheralId: 'physical', maximumWriteBytes: 244, maximumSignedBlobBytes: 1024,
    gatt: (_context, body) => body(), checkOwner() {} });
  await exchanger.refresh(f.material.uploadContext, f.context);
  await exchanger.sendSignedBlob(1, Uint8Array.of(77), f.context);
  const before = f.calls.length;
  await assert.rejects(async () => exchanger.sendSignedBlob(1, Uint8Array.of(77), { ...f.context, generation: '2' }), { code: 'stale_host_owner' });
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.some(call => ['load', 'save', 'read-file', 'stage'].includes(call[0])), false);
  await exchanger.close();
  await f.host.close();
});

test('a broken random port cannot spin indefinitely or write a context command', async () => {
  const f = protectedFixture();
  const exchanger = new JsUploadContextExchange({ core: f.core, ports: { ble: f.ports.ble, randomBytes: length => new Uint8Array(length) },
    peripheralId: 'physical', maximumWriteBytes: 244, maximumSignedBlobBytes: 1024,
    gatt: (_context, body) => body(), checkOwner() {} });
  await assert.rejects(exchanger.refresh(f.material.uploadContext, f.context), { code: 'invalid_entropy' });
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  await exchanger.close();
  await f.host.close();
});

test('a failed attempted CONFIRM is ownership-unknown and cannot issue an ABORT', async () => {
  const f = protectedFixture();
  const prepared = await f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await f.host.handle({ StartTransfer: { request: f.request, checkpoint: null, authorization_sha256: prepared.EncryptedUploadV2.SessionPrepared.authorization_sha256 } }, f.context);
  await f.completed.promise; await f.settled();
  const receipt = await f.host.handle({ AwaitCompletionReceipt: { material_id: 'material', evidence: f.evidence } }, f.context);
  const failure = new Error('write result lost');
  const write = f.ports.ble.write;
  f.ports.ble.write = async (address, value) => {
    if (value[0] === 60) { f.calls.push(['confirm-attempt']); throw failure; }
    return write(address, value);
  };
  await assert.rejects(f.host.handle({ ConfirmWithReceipt: { material_id: 'material', receipt_sha256: receipt.EncryptedUploadV2.CompletionReceiptAccepted.receipt_sha256 } }, f.context),
    error => error.code === 'upload_ownership_unknown' && error.cause === failure);
  await f.host.handle({ AbortV2: { material_id: 'material' } }, f.context);
  assert.equal(f.calls.some(call => call[0] === 'write' && call[2][0] === 61), false);
  assert.equal(f.calls.some(call => call[0] === 'confirmed'), false);
  await f.host.close();
});

test('manifest reconciliation prevents an unnecessary ciphertext PUT before submission', async () => {
  const f = protectedFixture();
  const prepared = await f.host.handle({ PrepareSession: { material_id: 'material' } }, f.context);
  await f.host.handle({ StartTransfer: { request: f.request, checkpoint: null, authorization_sha256: prepared.EncryptedUploadV2.SessionPrepared.authorization_sha256 } }, f.context);
  await f.completed.promise; await f.settled();
  f.material.reconcileStaging = async () => { f.calls.push(['reconcile']); return false; };
  await f.host.handle({ StageArtifacts: { sink_id: 'sink', material_id: 'material', evidence: f.evidence } }, f.context);
  assert.deepEqual(f.calls.filter(call => ['stage', 'manifest', 'reconcile'].includes(call[0])).map(call => call[0]), ['reconcile', 'manifest']);
  await f.host.close();
});

test('generated Rust coordinator and receiver complete canonical ciphertext over primitive BLE and durable files', async () => {
  const { createGeneratedJsCore } = loadSource('core.ts');
  const { BotaJsHostExecutor } = loadSource('executor.ts');
  const core = createGeneratedJsCore();
  const metadata = core.codec('protocolMetadata', {});
  const vectors = JSON.parse(readFileSync(new URL('../../../../../protocol/vectors/encrypted-upload-v2.json', import.meta.url), 'utf8'));
  const vector = name => Buffer.from(vectors.cases.find(value => value.name === name).inputHex, 'hex');
  const ciphertext = vector('storage-partial-block'), manifest = vector('manifest-hpke');
  const digest = value => createHash('sha256').update(value).digest();
  const session = 18838586676582n;
  const capability = vector('capability'); capability.writeUInt32LE(383, 4);
  const request = { device: 'C8SU2XXWHI', recording: [...Buffer.from('00112233445566778899aabbccddeeff', 'hex')],
    recording_generation: 9, storage_format: 3, upload_session_uuid: [...Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex')],
    owner_revision: 3, transport_session_id: session.toString(), material_id: 'material', sink_id: 'sink',
    selection: { policy: 'V2Required', profile: 'EncryptedUploadV2' }, capabilities: core.codec('decodeEncryptedUploadV2Capabilities', { bytes: [...capability] }),
    window_packets: 16, data_payload_bytes: 216, ciphertext_length: '330', ciphertext_sha256: [...digest(ciphertext)] };
  const calls = [], saved = new Map(), listeners = new Map(), buffers = new Map([['sink', Buffer.alloc(0)]]);
  const scope = 'account/project/user/production', sink = { id: 'sink', kind: 'file', scope };
  let attempt = 0, contextState = 0;
  // This is a simulated firmware producer. Production parses and frames only through Rust.
  const frame = (type, size) => { const value = Buffer.alloc(size); value[0] = type; value[1] = 2; value.writeBigUInt64LE(session, 4); return value; };
  const notify = value => listeners.get(metadata.CHAR_RECORDING_TRANSFER_V2)(Uint8Array.from(value));
  const streamWindow = () => {
    const ack = vector('ble-start-ack'); ack.writeUInt16LE(216, 90); notify(ack);
    let sequence = 0;
    for (let offset = 0; offset < ciphertext.length; offset += 216) {
      const chunk = ciphertext.subarray(offset, offset + 216), data = frame(0x41, 28 + chunk.length);
      data.writeUInt32LE(++sequence, 12); data.writeBigUInt64LE(BigInt(offset), 16); data.writeUInt16LE(chunk.length, 24); chunk.copy(data, 28); notify(data);
    }
    const end = frame(0x42, 68); end.writeUInt32LE(1, 12); end.writeUInt32LE(1, 16); end.writeUInt32LE(sequence, 20);
    end.writeBigUInt64LE(330n, 24); digest(ciphertext).copy(end, 32); end.writeUInt32LE(1, 64); notify(end);
  };
  const streamManifest = () => {
    for (let offset = 0; offset < manifest.length; offset += 128) {
      const chunk = manifest.subarray(offset, offset + 128), data = frame(0x43, 52 + chunk.length);
      data.writeUInt16LE(manifest.length, 12); data.writeUInt16LE(offset, 14); data.writeUInt16LE(chunk.length, 16);
      digest(manifest).copy(data, 20); chunk.copy(data, 52); notify(data);
    }
    const eof = frame(0x44, 92); eof.writeUInt32LE(2, 12); eof.writeUInt32LE(1, 16); eof.writeBigUInt64LE(330n, 20);
    digest(ciphertext).copy(eof, 28); digest(manifest).copy(eof, 60); notify(eof);
  };
  const document = (magic, size) => { const bytes = Buffer.alloc(size); bytes.write(magic); bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(size, 10); return bytes; };
  const ports = { platform: 'test', randomBytes: length => new Uint8Array(length).fill(1),
    persistence: { namespace: scope, async load(key) { return saved.get(key) ?? null; },
      async save(key, value) { calls.push('durable-checkpoint'); saved.set(key, value); }, async remove(key) { saved.delete(key); } },
    files: { async open(id) { return { id, scope, kind: 'file' }; }, async flush() {},
      async truncate(handle, length) { buffers.set(handle.id, buffers.get(handle.id).subarray(0, Number(length))); },
      async metadata(handle) { return { durableUnits: buffers.get(handle.id).length.toString() }; },
      async append(handle, offset, bytes) { buffers.set(handle.id, Buffer.concat([buffers.get(handle.id).subarray(0, Number(offset)), Buffer.from(bytes)])); return { durableUnits: buffers.get(handle.id).length.toString() }; },
      async read(handle, offset, count) { return Uint8Array.from(buffers.get(handle.id).subarray(Number(offset), Number(offset) + count)); },
      async remove() { throw new Error('Physical/local deletion is outside this transfer test'); } },
    ble: { async subscribe(address, callback) { listeners.set(address.characteristicUuid, callback); return { async remove() { calls.push('unsubscribe'); listeners.delete(address.characteristicUuid); } }; },
      async read() { const payload = contextState === 1 ? Buffer.alloc(16, 7) : contextState === 2 ? Buffer.alloc(116, 8) : Buffer.alloc(0);
        const bytes = Buffer.alloc(12 + payload.length); bytes[0] = 0x66; bytes[1] = 2; bytes[2] = contextState;
        bytes.writeUInt32LE(attempt, 4); bytes.writeUInt16LE(payload.length, 10); payload.copy(bytes, 12); return bytes; },
      async write(address, bytes) {
        if (address.characteristicUuid === metadata.CHAR_UPLOAD_CONTEXT_V2) { attempt = Buffer.from(bytes).readUInt32LE(4); contextState = 1; return; }
        if (address.characteristicUuid === metadata.CHAR_TRANSFER_SIGNED_BLOB_V2) {
          if (bytes[0] === vector('ble-blob-commit')[0]) {
            const result = vector('ble-blob-result'); result[2] = bytes[2]; Buffer.from(bytes).copy(result, 4, 4, 8); result.writeUInt16LE(0, 8);
            if (bytes[2] === 3) contextState = 2; if (bytes[2] === 4) contextState = 3;
            listeners.get(metadata.CHAR_TRANSFER_SIGNED_BLOB_V2)(Uint8Array.from(result));
          }
          return;
        }
        const parsed = core.codec('decodeEncryptedUploadV2Transfer', { bytes: [...bytes] });
        calls.push(parsed.kind);
        if (parsed.kind === 'start') streamWindow();
        if (parsed.kind === 'window_ack') { assert.equal(saved.size, 1); assert.equal(parsed.missingSequences.length, 0); streamManifest(); }
      },
    } };
  const material = { async authorization() { return Uint8Array.from(vector('authorization-development')); },
    uploadContext: { async challenge() { return Uint8Array.from(document('BOTACTXQ', 196)); }, async result() { return Uint8Array.from(document('BOTACTXR', 264)); } },
    async reconcileStaging(bytes) { assert.deepEqual(Buffer.from(bytes), manifest); calls.push('reconcile-manifest'); return true; },
    async stageCiphertext(handle) { assert.deepEqual(buffers.get(handle.id), ciphertext); calls.push('ciphertext-put'); },
    async submitManifest(bytes) { assert.deepEqual(Buffer.from(bytes), manifest); calls.push('manifest-submit'); },
    async finalize() { calls.push('finalize'); }, async completionReceipt() { calls.push('receipt'); return Uint8Array.from(vector('completion-receipt')); },
    async confirmed() { calls.push('confirmed'); }, async cancel() { calls.push('cancel'); } };
  const executor = new BotaJsHostExecutor(core, ports);
  const host = new JsEncryptedUploadV2Host({ core, ports, request, sink, journalKey: 'canonical-transfer', material,
    peripheralId: 'physical', maximumWriteBytes: 244, gatt: (context, body) => executor.gatt(context, body), checkOwner: context => executor.check(context) });
  executor.registerHandler('EncryptedUploadV2', host.handle);
  const result = await executor.run({ TransferEncryptedRecording: { request } }, { operation: 'TransferRecording', operationId: 'canonical',
    capabilities: ['Ble', 'Persistence', 'Progress', 'HostMaterial', 'RecordingSink', 'NetworkTransfer'] });
  assert.ok(result.notifications.some(value => value.Completed));
  assert.deepEqual(calls.filter(value => ['durable-checkpoint', 'window_ack', 'reconcile-manifest', 'ciphertext-put', 'manifest-submit', 'finalize', 'receipt', 'confirm', 'confirmed'].includes(value)),
    ['durable-checkpoint', 'window_ack', 'reconcile-manifest', 'ciphertext-put', 'manifest-submit', 'finalize', 'receipt', 'confirm', 'confirmed']);
  assert.equal(calls.includes('abort'), false);
  assert.equal(calls.includes('cancel'), false);
  assert.equal(listeners.size, 0);
  await executor.destroy();
});
