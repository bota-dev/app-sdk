import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
const require = createRequire(import.meta.url);
const { createManagedProtectedStreamingStatusBackend: managed } = require('../lib/commonjs/protectedStreamingStatus.js');
const native = { async readProtectedStreamingStatus(_id, json) { const q = JSON.parse(json); const r = await globalThis.fetch(q.url, { method: 'GET', headers: { Authorization: `Bearer ${q.token}`, 'X-Organization-Id': q.organizationId }, redirect: 'error' }); if (r.status !== 200) throw new Error('native redacted error'); return r.text(); }, async cancelProtectedStreamingStatus() {} };
const create = config => managed(native, config);
const Module = require('node:module');
const originalLoad = Module._load;
let publicCreate;
try {
  Module._load = function (id, ...args) {
    if (id === 'react-native') return { TurboModuleRegistry: { get: name => name === 'BotaUploadV2Backend' ? native : null } };
    return originalLoad.call(this, id, ...args);
  };
  publicCreate = require('../lib/commonjs/index.js').createProtectedStreamingStatusBackend;
} finally { Module._load = originalLoad; }
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const identity = { recordingId: 'rec_test', sessionId: '12345678-1234-4234-8234-123456789012', recordingGeneration: 3, writerEpoch: '1' };
const status = { profile: 'recording_markers_stream_v1', recording_id: identity.recordingId, session_id: identity.sessionId,
  recording_generation: 3, writer_epoch: '1', revision: '9007199254740993', received_count: 2,
  contiguous_sequence: 1, state: 'open', expected_count: null, authorization_expired: false };
function fixture() {
  const lifetime = new AbortController(), calls = [];
  const config = { baseUrl: 'https://api.example/dashboard/projects/proj_a', organizationId: 'org_a',
    signal: lifetime.signal, getAccessToken: async () => 'cognito-token' };
  globalThis.fetch = async (...args) => { calls.push(args); return new Response(JSON.stringify(status), { status: 200 }); };
  return { lifetime, config, calls, create: () => create(config) };
}
test('public status backend performs exact scoped GET and preserves int64 decimal strings', async () => {
  const f = fixture(), backend = publicCreate(f.config);
  assert.deepEqual(await backend.getStatus(identity), { ...identity, profile: status.profile, revision: status.revision,
    receivedCount: 2, contiguousSequence: 1, state: 'open', expectedCount: null, authorizationExpired: false });
  assert.equal(f.calls[0][0], `https://api.example/dashboard/projects/proj_a/recordings/rec_test/streaming-status?session_id=${identity.sessionId}`);
  assert.equal(f.calls[0][1].method, 'GET');
  assert.equal(f.calls[0][1].headers.Authorization, 'Bearer cognito-token');
  assert.equal(f.calls[0][1].headers['X-Organization-Id'], 'org_a');
  assert.equal(f.calls[0][1].redirect, 'error');
  backend.dispose();
  await assert.rejects(backend.getStatus(identity), /cancelled/);
});
test('configuration and target are captured; late logout cannot publish a response', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  f.config.getAccessToken = () => gate;
  const backend = f.create(), target = { ...identity }, pending = backend.getStatus(target);
  f.config.baseUrl = 'https://evil.example/v1'; target.recordingId = 'rec_other';
  release('cognito-token'); await pending;
  assert.match(f.calls[0][0], /api\.example.*rec_test/);
  globalThis.fetch = async () => { f.lifetime.abort(); return new Response(JSON.stringify(status)); };
  await assert.rejects(backend.getStatus(identity), /cancelled/);
});
test('logout during token refresh sends no request', async () => {
  const f = fixture();
  f.config.getAccessToken = async () => { f.lifetime.abort(); return 'late-token'; };
  await assert.rejects(f.create().getStatus(identity), /cancelled/);
  assert.equal(f.calls.length, 0);
});
test('request abort suppresses stale results even when transport ignores cancellation', async () => {
  const f = fixture(), local = new AbortController();
  globalThis.fetch = async () => { local.abort(); return new Response(JSON.stringify(status)); };
  await assert.rejects(f.create().getStatus(identity, local.signal), /cancelled/);
});
test('strict status decoder rejects foreign identities, unsafe integers and impossible metadata states', async () => {
  const f = fixture(), backend = f.create();
  const changes = [ { profile: 'other' }, { recording_id: 'rec_other' }, { session_id: '87654321-1234-4234-8234-123456789012' },
    { recording_generation: 4 }, { writer_epoch: '2' }, { writer_epoch: 1 }, { revision: 1 }, { revision: '01' },
    { revision: '9223372036854775808' }, { received_count: -1 }, { received_count: 65536 },
    { received_count: 1.5 }, { contiguous_sequence: 3 }, { expected_count: 1 }, { state: 'completed' },
    { state: 'sealed', expected_count: 2 }, { state: 'sealing', expected_count: null },
    { authorization_expired: 'false' }, { authorization: 'opaque-must-not-cross' } ];
  for (const change of changes) {
    globalThis.fetch = async () => new Response(JSON.stringify({ ...status, ...change }));
    await assert.rejects(backend.getStatus(identity), /Invalid protected streaming status/);
  }
});
test('sealed and expired are metadata only; no write, finalize or cleanup operation exists', async () => {
  const f = fixture(), backend = f.create();
  globalThis.fetch = async () => new Response(JSON.stringify({ ...status, state: 'sealed', contiguous_sequence: 2,
    expected_count: 2, authorization_expired: true }));
  const result = await backend.getStatus(identity);
  assert.equal(result.state, 'sealed'); assert.equal(result.authorizationExpired, true);
  assert.deepEqual(Object.keys(backend).sort(), ['dispose', 'getStatus']);
});
test('permission, absence and server errors never fall back or echo server secrets', async () => {
  for (const code of [401, 403, 404, 409, 503]) {
    const f = fixture();
    globalThis.fetch = async (...args) => { f.calls.push(args); return new Response('sensitive-server-body', { status: code }); };
    await assert.rejects(f.create().getStatus(identity), err => err.message === 'Protected streaming status request failed');
    assert.equal(f.calls.length, 1);
  }
});
test('rejects insecure endpoints, path traversal, token/header injection and large responses', async () => {
  for (const baseUrl of ['http://api.example/v1', 'https://user:pass@api.example/v1', 'https://api.example/v1?token=x', 'https://api.example/v1#x']) {
    const f = fixture(); assert.throws(() => create({ ...f.config, baseUrl }), /configuration/);
  }
  const f = fixture();
  await assert.rejects(f.create().getStatus({ ...identity, recordingId: '../other' }), /identity/);
  f.config.getAccessToken = async () => 'token\r\ninjected: value';
  await assert.rejects(f.create().getStatus(identity), /credentials/);
  assert.equal(f.calls.length, 0);
  f.config.getAccessToken = async () => 'token';
  globalThis.fetch = async () => new Response(' '.repeat(16_385));
  await assert.rejects(f.create().getStatus(identity), /Invalid protected streaming status/);
});

test('new admission revision zero remains readable without authorizing completion', async () => {
  const f = fixture();
  globalThis.fetch = async () => new Response(JSON.stringify({ ...status, revision: '0', received_count: 0, contiguous_sequence: 0 }));
  const result = await f.create().getStatus(identity);
  assert.equal(result.revision, '0'); assert.equal(result.state, 'open');
  await assert.rejects(f.create().getStatus({ ...identity, writerEpoch: '0' }), /identity/);
});
test('dispose cancels the exact in-flight native read and rejects late success', async () => {
  const f = fixture(), cancelled = [];
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const originalRead = native.readProtectedStreamingStatus, originalCancel = native.cancelProtectedStreamingStatus;
  try {
    let activeId;
    native.readProtectedStreamingStatus = async id => { activeId = id; started(); await gate; return JSON.stringify(status); };
    native.cancelProtectedStreamingStatus = async id => { cancelled.push(id); };
    const backend = publicCreate(f.config), result = backend.getStatus(identity);
    await entered; backend.dispose(); finish();
    await assert.rejects(result, /cancelled/);
    assert.deepEqual(cancelled, [activeId]);
  } finally { native.readProtectedStreamingStatus = originalRead; native.cancelProtectedStreamingStatus = originalCancel; }
});
