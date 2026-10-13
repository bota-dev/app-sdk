import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { JsStreamingEffects } = loadSource('streamingEffects.ts');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await tick(); assert.ok(predicate()); }

function fixture() {
  const controller = new AbortController(), cleanups = [], calls = [], events = [], codecs = [];
  const storage = new Map();
  let effects;
  const fixture = { controller, cleanups, calls, events, codecs, storage, autoDestination: true,
    autoFinalize: true, current: true, upload: async () => {} };
  const core = { codec(name, input) {
    codecs.push([name, input]);
    if (name === 'streamingAcceptedUnits') return String(BigInt(input.ciphertextLength) - (input.encrypted ? 16n : 0n));
    if (name === 'encodeStreamingRelayChunk') return input.sequence === 0
      ? [...input.ephemeralPublicKey, ...input.salt, ...input.ciphertext] : [...input.ciphertext];
    if (name === 'streamingUploadPolicy') return { attempts: 3, retryDelaysMs: [0, 0], allowGap: input.encrypted && input.sequence > 0 };
    throw new Error(name);
  } };
  const files = {
    async open(id, kind) { calls.push(['open', id]); storage.set(id, new Uint8Array()); return { id, kind, scope: 'scope' }; },
    async truncate(handle, size) { calls.push(['truncate', size]); storage.set(handle.id, storage.get(handle.id).slice(0, Number(size))); },
    async append(handle, offset, bytes) {
      calls.push(['append', offset, bytes.length]);
      const previous = storage.get(handle.id);
      assert.equal(String(previous.length), offset);
      storage.set(handle.id, new Uint8Array([...previous, ...bytes]));
      return { durableUnits: String(previous.length + bytes.length) };
    },
    async read(handle, offset, maximum) { calls.push(['read', offset, maximum]); return storage.get(handle.id).slice(Number(offset), Number(offset) + maximum); },
    async remove(handle, context) { calls.push(['remove', handle.id, context.signal.aborted]); storage.delete(handle.id); },
  };
  effects = new JsStreamingEffects({ core, files, namespace: 'scope', now: () => 100,
    checkOwner() { if (!fixture.current) throw Object.assign(new Error('stale'), { code: 'stale_owner' }); },
    emit(name, value) {
      events.push([name, value]);
      if (name === 'onStreamingChunkDestinationRequested' && fixture.autoDestination) {
        queueMicrotask(() => effects.resolveStreamingChunkDestination(value.requestId, {
          url: `https://customer.test/chunk/${value.sequence}`, method: value.encrypted ? 'POST' : 'PUT',
          contentType: 'application/octet-stream', bearerToken: 'token',
        }).catch(error => { fixture.responseError = error; }));
      }
      if (name === 'onStreamingFinalizeRequested' && fixture.autoFinalize) {
        queueMicrotask(() => effects.resolveStreamingFinalize(value.requestId).catch(error => { fixture.responseError = error; }));
      }
    },
    async upload(destination, body, context) { calls.push(['upload', destination, body.slice()]); await fixture.upload(destination, body, context); },
  });
  effects.register('op', { serialNumber: 'SERIAL', sessionId: 'session', recordingUuid: 'UUID', recordingId: 'rec',
    chunkSizeBytes: 65536, flushIntervalMs: 0 });
  const context = { operationId: 'op', operation: 'TransferRecording', requestId: '9007199254740993',
    generation: '9007199254740994', cancellationId: '01', signal: controller.signal,
    addCleanup(action) { cleanups.push(action); }, async emit() {} };
  return { ...fixture, effects, files, core, context, state: fixture,
    effect(kind, fields = {}) { return { [kind]: { sink_id: 'session', ...fields } }; } };
}

test('plaintext uses durable bounded chunks and server acknowledgement precedes finalized evidence and cleanup', async () => {
  const f = fixture();
  const accepted = await f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0,
    payload: Array(65539).fill(7) }), f.context);
  assert.deepEqual(accepted, { StreamingSinkAccepted: { received_units: '65539' } });
  assert.deepEqual(f.calls.filter(call => call[0] === 'read').map(call => call.slice(1)), [['0', 65536]]);
  f.state.autoFinalize = false;
  let finalized = false;
  const finishing = f.effects.handler(f.effect('FinalizeStreaming', { encrypted: false,
    expected_chunks: 0, total_units: '65539' }), { ...f.context, requestId: '2' }).then(result => { finalized = true; return result; });
  await until(() => f.events.some(([name]) => name === 'onStreamingFinalizeRequested'));
  assert.equal(finalized, false);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  assert.throws(() => f.effects.result('session'), error => error.code === 'streaming_not_finalized');
  const event = f.events.at(-1)[1];
  assert.deepEqual({ ...event, requestId: undefined }, { requestId: undefined, sessionId: 'session', totalChunks: 2,
    durationMs: 0, fileSizeBytes: 65539, encrypted: false });
  await f.effects.resolveStreamingFinalize(event.requestId);
  assert.deepEqual(await finishing, { StreamingSinkFinalized: { uploaded_chunks: 2, total_units: '65539' } });
  assert.deepEqual(f.effects.result('session'), { totalBytes: 65539 });
  assert.deepEqual(f.calls.filter(call => call[0] === 'read').map(call => call.slice(1)), [['0', 65536], ['65536', 3]]);
  f.controller.abort();
  await f.cleanups[0]();
  assert.equal(f.calls.at(-1)[0], 'remove');
  assert.equal(f.calls.at(-1)[2], false);
  await f.effects.release('session');
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
});

test('encrypted framing, accepted units and tolerated gaps use shared codecs and exact expected finalizer chunks', async () => {
  const f = fixture();
  f.state.upload = async destination => { if (destination.url.endsWith('/2')) throw new Error('network secret'); };
  assert.deepEqual(await f.effects.handler(f.effect('BeginStreamingEncrypted', {
    ephemeral_public_key: Array(32).fill(2), salt: Array(4).fill(3) }), f.context),
  { StreamingSinkAccepted: { received_units: '0' } });
  await f.effects.handler(f.effect('AppendStreamingEncrypted', { sequence: 0, payload: Array(18).fill(4) }), { ...f.context, requestId: '2' });
  const accepted = await f.effects.handler(f.effect('AppendStreamingEncrypted', { sequence: 2, payload: Array(19).fill(5) }), { ...f.context, requestId: '3' });
  assert.deepEqual(accepted, { StreamingSinkAccepted: { received_units: '5' } });
  const first = f.calls.find(call => call[0] === 'upload');
  assert.equal(first[2].length, 54);
  assert.deepEqual([...first[2].slice(0, 36)], [...Array(32).fill(2), ...Array(4).fill(3)]);
  assert.equal(f.events.filter(([name, value]) => name === 'onStreamingChunkDestinationRequested' && value.sequence === 2).length, 3);
  assert.deepEqual(await f.effects.handler(f.effect('FinalizeStreaming', { encrypted: true, expected_chunks: 3, total_units: '5' }),
    { ...f.context, requestId: '4' }), { StreamingSinkFinalized: { uploaded_chunks: 1, total_units: '5' } });
  assert.equal(f.events.at(-1)[1].totalChunks, 3);
  assert.ok(f.codecs.some(([name]) => name === 'encodeStreamingRelayChunk'));
  assert.ok(f.codecs.some(([name, input]) => name === 'streamingAcceptedUnits' && input.encrypted));
  await f.effects.release('session');
});

test('cancellation joins submitted HTTP work before discard removes the staging file', async () => {
  const f = fixture(), blocked = deferred(), started = deferred();
  f.state.upload = async () => { started.resolve(); await blocked.promise; };
  const writing = f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: Array(65536).fill(1) }), f.context);
  const rejected = assert.rejects(writing, error => error.code === 'operation_cancelled');
  await started.promise;
  f.controller.abort();
  let cleaned = false;
  const discard = f.effects.handler(f.effect('DiscardStreaming'), { ...f.context, requestId: '2',
    signal: new AbortController().signal }).then(() => { cleaned = true; });
  await tick();
  assert.equal(cleaned, false);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  blocked.resolve();
  await rejected; await discard;
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  await f.cleanups[0]();
});

test('late or wrong-kind application callbacks cannot revive a cancelled streaming request', async () => {
  const f = fixture();
  f.state.autoDestination = false;
  const writing = f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: Array(65536).fill(1) }), f.context);
  const rejected = assert.rejects(writing, error => error.code === 'operation_cancelled');
  await until(() => f.events.length === 1);
  const requestId = f.events[0][1].requestId;
  await assert.rejects(f.effects.resolveStreamingFinalize(requestId), error => error.code === 'stale_streaming_request');
  f.controller.abort();
  await rejected;
  await assert.rejects(f.effects.resolveStreamingChunkDestination(requestId,
    { url: 'https://customer.test', method: 'PUT', contentType: 'audio/ogg' }), error => error.code === 'stale_streaming_request');
  assert.equal(f.calls.some(call => call[0] === 'upload'), false);
  await f.cleanups[0]();
});

test('overstated file durability and foreign handles cannot produce accepted sink evidence', async (t) => {
  await t.test('durability', async () => {
    const f = fixture();
    f.files.append = async () => ({ durableUnits: '2' });
    await assert.rejects(f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [1] }), f.context),
      error => error.code === 'durable_file_mismatch');
    assert.equal(f.events.length, 0);
    await f.cleanups[0]();
  });
  await t.test('scope', async () => {
    const f = fixture();
    f.files.open = async () => ({ id: 'foreign', kind: 'file', scope: 'foreign' });
    await assert.rejects(f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [1] }), f.context),
      error => error.code === 'foreign_file_handle');
    assert.equal(f.calls.length, 0);
  });
});

test('periodic partial flush is serialized and joined before session release', async () => {
  const f = fixture(), started = deferred(), blocked = deferred();
  await f.effects.release('session');
  f.effects.register('op', { serialNumber: 'SERIAL', sessionId: 'session', recordingUuid: 'UUID', recordingId: 'rec',
    chunkSizeBytes: 65536, flushIntervalMs: 1 });
  f.state.upload = async () => { started.resolve(); await blocked.promise; };
  await f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [7, 8, 9] }), f.context);
  await started.promise;
  let released = false;
  const releasing = f.effects.release('session').then(() => { released = true; });
  await tick();
  assert.equal(released, false);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  blocked.resolve();
  await releasing;
  assert.equal(f.calls.filter(call => call[0] === 'upload').length, 1);
  assert.equal(f.calls.at(-1)[0], 'remove');
});

test('scope and generation replacement fence callbacks and cleanup identities', async () => {
  const f = fixture();
  await f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [1] }), f.context);
  await assert.rejects(f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 1, payload: [2] }),
    { ...f.context, generation: '9007199254740995' }), error => error.code === 'operation_cancelled');
  await assert.rejects(f.effects.handler(f.effect('DiscardStreaming'), { ...f.context, generation: '9007199254740995' }),
    error => error.code === 'streaming_identity_mismatch');
  f.state.current = false;
  await assert.rejects(f.effects.handler(f.effect('FinalizeStreaming', { encrypted: false, expected_chunks: 0, total_units: '1' }), f.context),
    error => error.code === 'stale_owner');
  await f.cleanups[0]();
});

test('normal sink operations delegate and finalizer failure cannot produce success evidence', async () => {
  const f = fixture();
  const composed = f.effects.recordingSink(async effect => ({ delegated: effect }));
  assert.deepEqual(await composed({ Discard: { sink_id: 'ordinary' } }, f.context), { delegated: { Discard: { sink_id: 'ordinary' } } });
  await f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [1] }), f.context);
  f.state.autoFinalize = false;
  const waiting = f.effects.handler(f.effect('FinalizeStreaming', { encrypted: false, expected_chunks: 0, total_units: '1' }), f.context);
  const rejected = assert.rejects(waiting, error => error.code === 'streaming_finalize_rejected' && !error.message.includes('secret'));
  await until(() => f.events.at(-1)?.[0] === 'onStreamingFinalizeRequested');
  await f.effects.rejectStreamingFinalize(f.events.at(-1)[1].requestId, 'secret');
  await rejected;
  assert.throws(() => f.effects.result('session'), error => error.code === 'streaming_not_finalized');
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  await f.cleanups[0]();
});

test('cleanup failure remains observable and cannot be falsely retried as clean', async () => {
  const f = fixture();
  await f.effects.handler(f.effect('AppendStreamingPlaintext', { sequence: 0, payload: [1] }), f.context);
  f.files.remove = async () => { throw new Error('durable cleanup failed'); };
  await assert.rejects(f.cleanups[0](), /durable cleanup failed/);
  await assert.rejects(f.effects.release('session'), /durable cleanup failed/);
});
