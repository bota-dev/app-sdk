import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRecordingEditClient } = require('../lib/commonjs/recordingEdits.js');
const id = '3b81d6ea-693d-4a8b-a4c0-6d842798f002';
const source = recording_id => ({ kind: 'cloud_recording', recording_id, sha256: 'a'.repeat(64) });
const merge = () => ({ operation_id: id, kind: 'merge', mode: 'concatenate_sources', manifest: {
  sources: [source('rec_A'), source('rec_B')], outputs: [{ name: 'Combined' }], processing: 'transcribe_then_summarize' } });
function host() {
  const calls = [], journal = new Map(), controller = new AbortController();
  const response = { operation_id: id, state: 'waiting_for_inputs', outputs: [{ index: 0, recording_id: 'rec_result', status: 'pending' }], required_uploads: [] };
  return { calls, journal, controller, scopeKey: 'user/project/env', signal: controller.signal, checkScope() {},
    async load(key) { return journal.get(key); }, async save(key, value) { journal.set(key, value); },
    async request(method, path, body) { calls.push({ method, path, body }); return { ...response, state: path.endsWith('/finalize') ? 'queued' : response.state }; },
    async inspect() { throw Error('No file should be opened for a cloud merge'); },
    async upload() { throw Error('No upload should be requested for a cloud merge'); },
  };
}
test('saves one edited file with retained ranges and rejects overlapping edits before admission', async () => {
  const h = host(), file = { sha256: 'b'.repeat(64), size_bytes: 844, content_type: 'audio/wav' }, uploads = [];
  const request = { ...merge(), kind: 'edit', mode: 'save_outputs', manifest: { ...merge().manifest,
    sources: [{ ...source('rec_A'), samples: '1000', channels: 1 }], outputs: [{ name: 'Original Copy', file,
      intervals: [{ source_index: 0, start_sample: '100', end_sample: '300' }, { source_index: 0, start_sample: '600', end_sample: '800' }] }] } };
  h.inspect = async () => file;
  h.upload = async handle => { uploads.push(handle); };
  h.request = async (_method, path) => path.endsWith('/upload-attempts') ? { upload_url: 'https://storage.invalid/exact', headers: {} }
    : { operation_id: id, state: path.endsWith('/finalize') ? 'queued' : 'waiting_for_inputs', outputs: [{ index: 0, recording_id: 'rec_result', status: 'pending' }], required_uploads: [{ ...file, target: 'output', index: 0 }] };
  assert.equal((await createRecordingEditClient(h).saveEdit(request, { output_0: 'edited.wav' })).state, 'queued');
  assert.deepEqual(uploads, ['edited.wav']);
  const bad = structuredClone(request); bad.manifest.outputs[0].intervals[1].start_sample = '200';
  await assert.rejects(createRecordingEditClient(host()).saveEdit(bad), /edit intervals/);
  bad.manifest.outputs.push(bad.manifest.outputs[0]);
  await assert.rejects(createRecordingEditClient(host()).saveEdit(bad), /counts/);
});
test('persists exact intent before admission and preserves chosen merge order', async () => {
  const h = host(), client = createRecordingEditClient(h);
  const r = await client.saveEdit(merge());
  assert.equal(r.state, 'queued'); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].path, '');
  assert.deepEqual(h.calls[0].body.manifest.sources.map(s => s.recording_id), ['rec_A', 'rec_B']);
  assert.equal(h.journal.get(id).scope_key, h.scopeKey);
  await assert.rejects(client.saveEdit({ ...merge(), manifest: { ...merge().manifest, sources: [...merge().manifest.sources].reverse() } }), /different content/);
});
test('recovers a lost acceptance using the same operation identity', async () => {
  const h = host(); let fail = true; const request = h.request.bind(h);
  h.request = async (...args) => { if (fail) { fail = false; throw Error('response lost'); } return request(...args); };
  const client = createRecordingEditClient(h);
  await assert.rejects(client.saveEdit(merge()), /response lost/);
  await client.resume(id);
  assert.equal(h.calls[0].body.operation_id, id); assert.equal(h.journal.size, 1);
});
test('rejects changed scope and cancellation before any network or file access', async () => {
  const h = host(), client = createRecordingEditClient(h);
  await client.saveEdit(merge()); h.scopeKey = 'another-user/project/env';
  await assert.rejects(client.resume(id), /scope/);
  const other = host(); other.controller.abort();
  await assert.rejects(createRecordingEditClient(other).saveEdit(merge()), /cancelled/);
  assert.equal(other.calls.length, 0);
});
test('checks every finished file identity before uploading any split output', async () => {
  const h = host(); let uploads = 0;
  h.inspect = async handle => ({ sha256: handle === 'first' ? 'b'.repeat(64) : 'c'.repeat(64), size_bytes: 480044 });
  h.upload = async () => { uploads++; };
  const file = { sha256: 'b'.repeat(64), size_bytes: 480044, content_type: 'audio/wav' };
  const request = { ...merge(), kind: 'split', mode: 'save_outputs', manifest: { ...merge().manifest,
    sources: [{ ...source('rec_A'), samples: '480000', channels: 1 }], outputs: [
      { name: 'First', file, intervals: [{ source_index: 0, start_sample: '0', end_sample: '240000' }] },
      { name: 'Second', file, intervals: [{ source_index: 0, start_sample: '240000', end_sample: '480000' }] },
    ] } };
  await assert.rejects(createRecordingEditClient(h).saveEdit(request, { output_0: 'first', output_1: 'second' }), /file changed/);
  assert.equal(uploads, 0); assert.equal(h.calls.length, 0);
});
test('saved replay recovers even when its local files have been removed', async () => {
  const h = host(), client = createRecordingEditClient(h);
  const file = { sha256: 'a'.repeat(64), size_bytes: 96044, content_type: 'audio/wav' };
  const request = { ...merge(), manifest: { ...merge().manifest, sources: [0,1].map(i => ({ kind: 'local_artifact',
    artifact_id: `${i}b81d6ea-693d-4a8b-a4c0-6d842798f002`, sha256: file.sha256, samples: '48000', channels: 1, file })) } };
  h.journal.set(id, { version: 1, scope_key: h.scopeKey, request, files: {} });
  h.request = async () => ({ operation_id: id, state: 'saved', outputs: [{ index: 0, recording_id: 'rec_result', status: 'uploaded' }], required_uploads: [] });
  h.inspect = async () => { throw Error('Local file no longer exists'); };
  assert.equal((await client.resume(id)).state, 'saved');
});
test('uploads ordered local merge inputs without editing media in the SDK', async () => {
  const h = host(), uploaded = [], a = { sha256: 'a'.repeat(64), size_bytes: 96044, content_type: 'audio/wav' }, b = { ...a, sha256: 'b'.repeat(64) };
  const input = { ...merge(), manifest: { ...merge().manifest, sources: [a,b].map((file,i) => ({ kind: 'local_artifact', artifact_id: `${i}b81d6ea-693d-4a8b-a4c0-6d842798f002`, sha256: file.sha256, samples: '48000', channels: 1, file })) } };
  h.inspect = async handle => handle === 'a' ? a : b;
  h.upload = async (handle, grant) => { assert.equal(grant.headers['Content-Type'], 'audio/wav'); uploaded.push(handle); };
  h.request = async (_method, path) => path.endsWith('/upload-attempts') ? { upload_url: 'https://storage.invalid/exact', headers: { 'Content-Type': 'audio/wav' } }
    : { operation_id: id, state: path.endsWith('/finalize') ? 'queued' : 'waiting_for_inputs', outputs: [{ index: 0, recording_id: 'rec_result', status: 'pending' }], required_uploads: [a,b].map((f,index) => ({ ...f, target: 'input', index })) };
  assert.equal((await createRecordingEditClient(h).saveEdit(input, { input_0: 'a', input_1: 'b' })).state, 'queued');
  assert.deepEqual(uploaded, ['a','b']);
});
