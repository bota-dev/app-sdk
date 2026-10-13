import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { JsFileEffects } = loadSource('fileEffects.ts');
const scope = 'account/project/user';
const context = { operationId: 'operation', operation: 'TransferRecording', requestId: '1',
  generation: '1', cancellationId: '01', signal: new AbortController().signal,
  async emit() {}, addCleanup() {} };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function filesFixture() {
  const calls = [];
  const handles = new Map();
  const sizes = new Map();
  const files = {
    async open(id, kind) {
      calls.push(['open', id]);
      if (!handles.has(id)) {
        handles.set(id, { id, kind, scope }); sizes.set(id, '0');
      }
      return handles.get(id);
    },
    async metadata(handle) { return { durableUnits: sizes.get(handle.id) }; },
    async truncate(handle, size) { calls.push(['truncate', size]); sizes.set(handle.id, size); },
    async append(handle, offset, value) {
      calls.push(['append', offset, value]);
      const durableUnits = (BigInt(offset) + BigInt(value instanceof Uint8Array ? value.length : 3)).toString();
      sizes.set(handle.id, durableUnits);
      return { durableUnits };
    },
    async finalize(handle, checksum) {
      calls.push(['finalize', checksum]);
      return { durableUnits: sizes.get(handle.id), localPath: `/private/${handle.id}` };
    },
    async remove(handle) { calls.push(['remove', handle.id]); },
    async read(_handle, offset, maximum) { calls.push(['read', offset, maximum]); return Uint8Array.of(1, 2, 3); },
  };
  return { calls, files, sizes, handles };
}

test('sink append returns durable evidence only after the port proves persistence', async () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  await effects.recordingSink({ Truncate: { sink_id: 'sink', completed_units: '0' } }, context);
  const durable = deferred();
  const append = fixture.files.append;
  fixture.files.append = async (...args) => { await durable.promise; return append(...args); };
  let completed = false;
  const writing = effects.recordingSink({ Append: { sink_id: 'sink', sequence: 0, payload: [7, 8] } }, context)
    .then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  durable.resolve();
  assert.deepEqual(await writing, { RecordingSinkAppendCompleted: { durable_units: '2' } });
  assert.deepEqual(await effects.recordingSink({ Finalize: { sink_id: 'sink', expected_crc32: 17 } }, context),
    { RecordingSinkFinalized: { durable_units: '2' } });
  assert.equal((await effects.result('sink', context)).localPath, '/private/recording/sink');
  assert.equal(fixture.calls.some(call => call[0] === 'remove'), false);
});

test('recreated sink reopens the exact logical file and uses the core-proven truncate boundary', async () => {
  const fixture = filesFixture();
  const first = new JsFileEffects(fixture.files, scope);
  await first.recordingSink({ Append: { sink_id: 'sink', sequence: 0, payload: [1, 2, 3, 4] } }, context);
  const resumed = new JsFileEffects(fixture.files, scope);
  await resumed.recordingSink({ Truncate: { sink_id: 'sink', completed_units: '2' } }, context);
  await resumed.recordingSink({ Append: { sink_id: 'sink', sequence: 1, payload: [5] } }, context);
  assert.equal((await resumed.result('sink', context)).durableUnits, '3');
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'open'), [['open', 'recording/sink'], ['open', 'recording/sink']]);
});

test('opaque ciphertext append transfers a scoped handle without materializing JS bytes', async () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  const handle = { id: 'packet', kind: 'protected_packet', scope, byteLength: '3' };
  await effects.recordingSink({ Append: { sink_id: 'sink', sequence: 0, opaque_payload: handle } }, context);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'append')[2], handle);
  await assert.rejects(effects.recordingSink({ Append: { sink_id: 'sink', sequence: 1,
    opaque_payload: { ...handle, scope: 'foreign' } } }, context), error => error.code === 'foreign_protected_handle');
});

test('file integrity failure is returned to the shared core and cannot imply successful finalization', async () => {
  const fixture = filesFixture();
  fixture.files.finalize = async () => { throw Object.assign(new Error('checksum'), { code: 'integrity_failed' }); };
  const effects = new JsFileEffects(fixture.files, scope);
  assert.equal(await effects.recordingSink({ Finalize: { sink_id: 'sink', expected_crc32: 7 } }, context),
    'RecordingSinkIntegrityFailed');
  assert.equal(fixture.calls.some(call => call[0] === 'remove'), false);
});

test('foreign files and non-monotonic durable evidence cannot enter a sink callback', async () => {
  const fixture = filesFixture();
  fixture.files.open = async () => ({ id: 'sink', kind: 'file', scope: 'foreign' });
  const effects = new JsFileEffects(fixture.files, scope);
  await assert.rejects(effects.recordingSink({ Truncate: { sink_id: 'sink', completed_units: '0' } }, context),
    error => error.code === 'foreign_file_handle');
});

test('firmware chunk reads retain exact u64 offsets and the core bound', async () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  const handle = { id: 'firmware', kind: 'firmware', scope };
  fixture.sizes.set(handle.id, '9007199254741000');
  effects.registerFirmware('9007199254740993', handle);
  assert.deepEqual(await effects.firmwareBlob({ ReadChunk: { download_id: '9007199254740993',
    offset: '9007199254740994', max_length: 4 } }, { ...context, operation: 'UpdateFirmware' }),
  { FirmwareChunkRead: { download_id: '9007199254740993', offset: '9007199254740994', bytes: [1, 2, 3] } });
  assert.deepEqual(fixture.calls.find(call => call[0] === 'read'), ['read', '9007199254740994', 4]);
  fixture.files.read = async () => new Uint8Array(5);
  await assert.rejects(effects.firmwareBlob({ ReadChunk: { download_id: '9007199254740993',
    offset: '9007199254740994', max_length: 4 } }, context), error => error.code === 'invalid_firmware_read_bound');
});

test('firmware metadata prevents reads beyond the exact verified blob', async () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  fixture.sizes.set('firmware', '2');
  effects.registerFirmware('1', { id: 'firmware', kind: 'firmware', scope });
  await assert.rejects(effects.firmwareBlob({ ReadChunk: { download_id: '1', offset: '3', max_length: 1 } }, context),
    error => error.code === 'invalid_firmware_read_bound');
  assert.equal(fixture.calls.length, 0);
});

test('registered file handle identity cannot be repointed by later caller mutation', async () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  const handle = { id: 'firmware', kind: 'firmware', scope };
  fixture.sizes.set(handle.id, '3');
  effects.registerFirmware('1', handle);
  handle.id = 'foreign'; handle.scope = 'foreign';
  await effects.firmwareBlob({ ReadChunk: { download_id: '1', offset: '0', max_length: 3 } }, context);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'read'), ['read', '0', 3]);
});

test('append rejects overstated and understated durable progress before the core may ACK', async (t) => {
  for (const durableUnits of ['1', '3']) await t.test(durableUnits, async () => {
    const fixture = filesFixture();
    fixture.files.append = async () => ({ durableUnits });
    const effects = new JsFileEffects(fixture.files, scope);
    await assert.rejects(effects.recordingSink({ Append: { sink_id: 'sink', sequence: 0, payload: [1, 2] } }, context),
      error => error.code === 'durable_file_mismatch');
    assert.equal(effects.peek('sink').durableUnits, '0');
  });
});

test('releasing a firmware registration preserves its recovery file', () => {
  const fixture = filesFixture();
  const effects = new JsFileEffects(fixture.files, scope);
  effects.registerFirmware('1', { id: 'firmware', kind: 'firmware', scope });
  effects.releaseFirmware('1');
  effects.registerFirmware('1', { id: 'replacement', kind: 'firmware', scope });
  assert.equal(fixture.calls.length, 0);
});
