import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createJsUploadBackend } = loadSource('backend.ts');
const { createManagedProtectedStreamingStatusBackend } = loadSource('../protectedStreamingStatus.ts');
const identity = { recordingId: 'rec_test', sessionId: '12345678-1234-4234-8234-123456789012', recordingGeneration: 3, writerEpoch: '1' };
const status = { profile: 'recording_markers_stream_v1', recording_id: identity.recordingId,
  session_id: identity.sessionId, recording_generation: 3, writer_epoch: '1', revision: '0',
  received_count: 0, contiguous_sequence: 0, state: 'open', expected_count: null, authorization_expired: false };
const base = 'https://customer.example/dashboard/projects/proj_a';
const url = `${base}/recordings/${identity.recordingId}/streaming-status?session_id=${identity.sessionId}`;
const request = JSON.stringify({ url, token: 'app-token', organizationId: 'org_a' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const response = (address, value = status, code = 200) => ({ status: code, url: address,
  async text() { return typeof value === 'string' ? value : JSON.stringify(value); } });

test('unchanged public wrapper reads revision zero through exact scoped JS HTTPS', async () => {
  const calls = [];
  const lifetime = new AbortController();
  const adapter = createJsUploadBackend({ fetch: async (address, init) => {
    calls.push([address, init]); return response(address);
  } });
  const backend = createManagedProtectedStreamingStatusBackend(adapter, { baseUrl: base, organizationId: 'org_a',
    signal: lifetime.signal, async getAccessToken() { return 'app-token'; } });
  assert.deepEqual(await backend.getStatus(identity), { ...identity, profile: status.profile, revision: '0',
    receivedCount: 0, contiguousSequence: 0, state: 'open', expectedCount: null, authorizationExpired: false });
  assert.equal(calls[0][0], url);
  assert.deepEqual(calls[0][1].headers, { Accept: 'application/json', Authorization: 'Bearer app-token', 'X-Organization-Id': 'org_a' });
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].method, 'GET');
  backend.dispose(); await adapter.dispose();
});

test('outer authoritative decoder still rejects foreign generation and writer identity', async () => {
  for (const mutation of [{ recording_generation: 4 }, { writer_epoch: '2' }, { revision: '01' },
    { revision: '9223372036854775808' }, { state: 'sealed', expected_count: 1 }]) {
    const adapter = createJsUploadBackend({ fetch: async address => response(address, { ...status, ...mutation }) });
    const backend = createManagedProtectedStreamingStatusBackend(adapter, { baseUrl: base,
      signal: new AbortController().signal, async getAccessToken() { return 'app-token'; } });
    await assert.rejects(backend.getStatus(identity), /Invalid protected streaming status/);
    backend.dispose(); await adapter.dispose();
  }
});

test('read-only transport rejects redirects and redacts server/network error details without retries', async () => {
  for (const kind of ['redirect', 401, 403, 404, 409, 503, 'network']) {
    let calls = 0;
    const adapter = createJsUploadBackend({ fetch: async address => {
      calls++;
      if (kind === 'network') throw new Error('secret-token-in-network-error');
      if (kind === 'redirect') return { ...response('https://foreign.example/status'), redirected: true };
      return response(address, 'secret-server-body', kind);
    } });
    await assert.rejects(adapter.readProtectedStreamingStatus('read', request), error =>
      error.code === 'status_request_failed' && !error.message.includes('secret'));
    assert.equal(calls, 1);
    await adapter.dispose();
  }
});

test('insecure URL, traversal, unknown input and header injection fail before HTTP', async () => {
  let calls = 0;
  const adapter = createJsUploadBackend({ fetch: async address => { calls++; return response(address); } });
  for (const mutation of [{ url: url.replace('https:', 'http:') }, { url: url.replace('/rec_test/', '/../rec_test/') },
    { url: url + '&other=1' }, { token: 'token\r\ninjected' }, { organizationId: 'org\nunsafe' }, { extra: 'field' }]) {
    await assert.rejects(adapter.readProtectedStreamingStatus('read', JSON.stringify({ ...JSON.parse(request), ...mutation })),
      error => error.code === 'invalid_status_request');
  }
  assert.equal(calls, 0);
  await adapter.dispose();
});

test('cancel fences ignored transport results and retains the original request ID until I/O settles', async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const adapter = createJsUploadBackend({ fetch: async address => {
    calls++; if (calls === 1) { entered.resolve(); await release.promise; } return response(address);
  } });
  const reading = adapter.readProtectedStreamingStatus('exact-request', request);
  const rejection = assert.rejects(reading, error => error.code === 'operation_cancelled');
  await entered.promise;
  let settled = false;
  const cancellation = adapter.cancelProtectedStreamingStatus('exact-request').then(() => { settled = true; });
  await rejection;
  await assert.rejects(adapter.readProtectedStreamingStatus('exact-request', request), error => error.code === 'invalid_status_request');
  assert.equal(settled, false);
  release.resolve(); await cancellation;
  assert.deepEqual(JSON.parse(await adapter.readProtectedStreamingStatus('exact-request', request)), status);
  await adapter.dispose();
});

test('permanent scope invalidation cancels active reads and prevents a return to the old scope', async () => {
  const lifetime = new AbortController();
  const entered = deferred();
  const release = deferred();
  let checks = 0;
  const adapter = createJsUploadBackend({ signal: lifetime.signal, checkScope() { checks++; },
    fetch: async address => { entered.resolve(); await release.promise; return response(address); } });
  const reading = adapter.readProtectedStreamingStatus('read', request);
  const rejection = assert.rejects(reading, error => error.code === 'operation_cancelled');
  await entered.promise; lifetime.abort(); await rejection;
  release.resolve(); await adapter.dispose();
  await assert.rejects(adapter.readProtectedStreamingStatus('next', request), error => error.code === 'operation_cancelled');
  assert.ok(checks >= 2);
});

test('bounded streaming response cancels the exact reader before an oversized body can escape', async () => {
  let reads = 0, cancelled = 0, unlocked = 0;
  const adapter = createJsUploadBackend({ fetch: async address => ({ ...response(address), body: { getReader() {
    return { async read() { reads++; return { done: false, value: new Uint8Array(16385) }; },
      async cancel() { cancelled++; }, releaseLock() { unlocked++; } };
  } } }) });
  await assert.rejects(adapter.readProtectedStreamingStatus('read', request), error => error.code === 'status_request_failed');
  assert.equal(reads, 1); assert.equal(cancelled, 1); assert.equal(unlocked, 1);
  await adapter.dispose();
});

test('unknown/opaque server fields and excessive UTF-8 bytes never cross the scalar adapter', async () => {
  for (const body of [{ ...status, authorization: 'protected-blob' }, { ...status, state: {} },
    { ...status, received_count: true }, { ...status, state: 'é'.repeat(81) }, ' '.repeat(16385)]) {
    const adapter = createJsUploadBackend({ fetch: async address => response(address, body) });
    await assert.rejects(adapter.readProtectedStreamingStatus('read', request), error => error.code === 'status_request_failed');
    await adapter.dispose();
  }
});

test('fresh credentials settle only the exact request and late cancelled responses cannot revive it', async () => {
  const adapter = createJsUploadBackend({ fetch: async address => response(address) });
  const events = [];
  const subscription = adapter.onCredentialsRequested(event => { events.push(event); });
  const lifetime = new AbortController();
  const first = adapter.requestCredentials('operation-a', lifetime.signal);
  const rejection = assert.rejects(first, error => error.code === 'operation_cancelled');
  lifetime.abort(); await rejection;
  await adapter.resolveCredentials(events[0].requestId, 'late-token');
  const second = adapter.requestCredentials('operation-b');
  assert.notEqual(events[1].requestId, events[0].requestId);
  assert.equal(events[1].operationId, 'operation-b');
  await adapter.resolveCredentials(events[1].requestId, 'fresh-token');
  assert.equal(await second, 'fresh-token');
  subscription.remove(); await adapter.dispose();
});

test('credential/header failures and scope callback errors expose only stable redacted codes', async () => {
  const adapter = createJsUploadBackend({ fetch: async address => response(address) });
  const subscription = adapter.onCredentialsRequested(event => { void adapter.resolveCredentials(event.requestId, 'token\nsecret'); });
  await assert.rejects(adapter.requestCredentials('operation'), error => error.code === 'credentials_rejected' && !error.message.includes('secret'));
  subscription.remove(); await adapter.dispose();
  const scoped = createJsUploadBackend({ checkScope() { throw new Error('private-customer-detail'); }, fetch: async address => response(address) });
  await assert.rejects(scoped.readProtectedStreamingStatus('read', request), error => error.code === 'scope_changed' && !error.message.includes('private'));
  await scoped.dispose();
});
