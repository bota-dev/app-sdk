import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { registerSdkRelease, waitForSdkRelease, refreshSdkRelease, verifySdkReceipt, requestSdkService } from './slack-sdk-release.mjs';

const repository = 'bota-dev/app-sdk';
const repositoryId = '1350249290';
const sha = 'a'.repeat(40);
const tagObjectSha = 'b'.repeat(40);
const tag = 'v2.0.0-beta.24';
const digest = 'sha256:' + 'c'.repeat(64);
const roots = ['apple', 'android', 'react-native', 'web', 'flutter'];
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const policy = { enabled: true, repository, repositoryId, unit: 'app-sdk-prod',
  endpoint: 'https://lkum88xsel.execute-api.us-west-2.amazonaws.com',
  publicKey: { id: 'synthetic-key', pem: pair.publicKey.export({ type: 'spki', format: 'pem' }) } };
const event = { name: 'push', repository, repositoryId, refType: 'tag', ref: `refs/tags/${tag}`,
  sha, runId: '900', runAttempt: 1, workflowRef: `${repository}/.github/workflows/release.yml@refs/tags/${tag}` };
const candidateId = `app-sdk-prod:${repositoryId}:900:1`;
const now = () => 1000;
const inventoryBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceRevision: sha,
  files: roots.map(root => ({ path: `${root}-release/file.bin`, byteLength: 1, sha256: 'd'.repeat(64) })) }));
const inventorySha256 = createHash('sha256').update(inventoryBytes).digest('hex');
const sourceNames = [`release-candidate-${sha}`, `apple-package-${sha}`, `android-ci-${sha}`,
  `react-native-ci-${sha}`, `web-ci-${sha}`, `flutter-ci-${sha}`];
const promotion = { schemaVersion: 1, sourceRevision: sha, tag, tagObject: tagObjectSha,
  ciRunId: 100, ciRunAttempt: 2, inventorySha256, artifacts: sourceNames.map((name, index) => ({ id: 10 + index, name, digest })) };
const tagArtifacts = [...roots.map(root => `${root}-release-${tag}`), `release-inputs-${tag}`]
  .map((name, index) => ({ id: 20 + index, name, digest, expired: false,
    workflow_run: { id: 900, repository_id: Number(repositoryId), head_sha: sha } }));

function fixture() {
  const calls = [];
  const states = [];
  const deployments = [];
  const statuses = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === `git/ref/tags/${tag}`) return { object: { type: 'tag', sha: tagObjectSha } };
    if (path === `git/tags/${tagObjectSha}`) return { tag, object: { type: 'commit', sha },
      message: `Source-Revision: ${sha}\nCandidate-Run-ID: 100\nCandidate-Inventory-SHA256: ${inventorySha256}\n` };
    if (path === 'actions/runs/100') return { id: 100, run_attempt: 2, repository: { id: Number(repositoryId), full_name: repository },
      event: 'push', path: '.github/workflows/ci.yml', head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'success' };
    if (path === 'actions/runs/900') return { id: 900, run_attempt: 1, repository: { id: Number(repositoryId), full_name: repository },
      event: 'push', path: '.github/workflows/release.yml', head_sha: sha, head_branch: tag, status: 'in_progress', conclusion: null };
    if (path === 'actions/runs/100/artifacts?per_page=100') return { total_count: 6,
      artifacts: promotion.artifacts.map(item => ({ ...item, expired: false,
        workflow_run: { id: 100, repository_id: Number(repositoryId), head_sha: sha } })) };
    if (path === 'actions/runs/900/artifacts?per_page=100') return { total_count: 6, artifacts: structuredClone(tagArtifacts) };
    if (path.startsWith('deployments?')) return structuredClone(deployments);
    if (path === 'deployments/700/statuses?per_page=100') return structuredClone(statuses);
    if (path === 'deployments/700/statuses' && options.method === 'POST') {
      const status = { id: 701, state: options.body.state };
      statuses.unshift(status);
      return status;
    }
    if (path === 'deployments' && options.method === 'POST') {
      const deployment = { id: 700, environment: 'prod', task: 'sdk-release', sha, ref: sha, payload: options.body.payload };
      deployments.push(deployment);
      return structuredClone(deployment);
    }
    assert.fail(`unexpected API request: ${path}`);
  };
  const options = { activation: true, policy, event, inventoryBytes, promotion: structuredClone(promotion), api,
    persist: async state => states.push(structuredClone(state)) };
  return { calls, states, deployments, statuses, options };
}

const signedReceipt = (expected, patch = {}, headerPatch = {}) => {
  const claims = { ...expected, iss: 'bota-slack-release-control', aud: 'bota-production-executor', iat: 1000, exp: 1300, jti: 'synthetic-receipt', ...patch };
  const input = [{ alg: 'RS256', kid: policy.publicKey.id, typ: 'JWT', ...headerPatch }, claims]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
};
const expectedReceipt = state => ({ repositoryId, unit: 'app-sdk-prod', sha, target: 'prod', candidateId,
  generation: 1, approvalId: 'approval-1', runId: '900', runAttempt: 1, tag, tagObjectSha,
  ciRunId: '100', ciRunAttempt: 2, inventorySha256, requestDeploymentId: state.requestDeploymentId });

test('registers only the annotation-bound original tag tuple and preserves its request identity', async () => {
  const f = fixture();
  const result = await registerSdkRelease(f.options);
  assert.equal(result.phase, 'registered');
  assert.equal(result.requestDeploymentId, '700');
  assert.equal(result.candidateId, candidateId);
  assert.equal(result.payload.ciRunAttempt, 2);
  assert.equal(result.pendingStatus, 'recorded');
  assert.equal(f.statuses[0].state, 'pending');
  assert.deepEqual(result.payload.artifacts.map(item => item.name).sort(), tagArtifacts.map(item => item.name).sort());
  assert.equal(f.states[0].phase, 'intent');
  const write = f.calls.find(call => call.method === 'POST');
  assert.deepEqual(Object.keys(write.body).sort(), ['auto_merge', 'environment', 'payload', 'ref', 'required_contexts', 'task']);
  assert.equal(write.body.auto_merge, false);
  assert.deepEqual(write.body.required_contexts, []);
});

test('reuses an existing exact registration and never blindly repeats an uncertain POST', async () => {
  const f = fixture();
  const state = await registerSdkRelease(f.options);
  f.calls.length = 0;
  assert.equal((await registerSdkRelease({ ...f.options, state })).requestDeploymentId, '700');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  const accepted = fixture();
  const reconciled = await registerSdkRelease({ ...accepted.options, api: async (path, options) => {
    const value = await accepted.options.api(path, options);
    if (path === 'deployments' && options?.method === 'POST') throw new Error('synthetic lost accepted response');
    return value;
  } });
  assert.equal(reconciled.requestDeploymentId, '700');
  assert.equal(accepted.calls.filter(call => call.path === 'deployments' && call.method === 'POST').length, 1);
  const unknown = fixture();
  let writes = 0;
  const api = async (path, options) => {
    if (options?.method === 'POST') { writes++; throw new Error('token=must-not-appear'); }
    return unknown.options.api(path, options);
  };
  await assert.rejects(registerSdkRelease({ ...unknown.options, api }), /registration outcome is unknown/);
  const intent = unknown.states.at(-1);
  await assert.rejects(registerSdkRelease({ ...unknown.options, api, state: intent }), /registration outcome is unknown/);
  assert.equal(writes, 1);
});

test('rejects disabled activation, non-tag executions, changed inventory and source or artifact substitution', async () => {
  for (const patch of [{ activation: false }, { policy: { ...policy, enabled: false } },
    { event: { ...event, name: 'workflow_dispatch' } },
    { event: { ...event, runAttempt: 2 } }, { inventoryBytes: Buffer.from('{}') },
    { promotion: { ...promotion, inventorySha256: '0'.repeat(64) } }, { promotion: { ...promotion, ciRunAttempt: 3 } }]) {
    const f = fixture();
    await assert.rejects(registerSdkRelease({ ...f.options, ...patch }));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
  const f = fixture();
  await assert.rejects(registerSdkRelease({ ...f.options, api: async (path, options) => {
    const value = await f.options.api(path, options);
    if (path === 'actions/runs/900/artifacts?per_page=100') value.artifacts[0].digest = 'sha256:' + '0'.repeat(64);
    return value;
  } }));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('preserves an uncertain pending-status write without repeating it on resume', async () => {
  const f = fixture();
  let pendingWrites = 0;
  const api = async (path, options) => {
    if (path === 'deployments/700/statuses' && options?.method === 'POST') {
      pendingWrites++; throw new Error('synthetic lost status response');
    }
    return f.options.api(path, options);
  };
  await assert.rejects(registerSdkRelease({ ...f.options, api }), /pending status outcome is unknown/);
  const state = f.states.at(-1);
  assert.equal(state.pendingStatus, 'intent');
  await assert.rejects(registerSdkRelease({ ...f.options, api, state }), /pending status outcome is unknown/);
  assert.equal(pendingWrites, 1);
});

test('waits through qualification, obtains fresh OIDC each time, then claims a signed exact SDK tuple', async () => {
  const f = fixture();
  const state = await registerSdkRelease(f.options);
  const requests = [];
  let oidcCount = 0;
  const result = await waitForSdkRelease({ ...f.options, state, now, sleep: async () => {}, maxAttempts: 3,
    getOidc: async () => `fresh-oidc-${++oidcCount}`,
    service: async (path, body, token) => {
      requests.push({ path, body, token });
      if (body.mode === 'status') return requests.length === 1
        ? { status: 202, data: { status: 'pending_qualification', candidateId } }
        : { status: 200, data: { status: 'approved', candidateId, generation: 1, approvalId: 'approval-1' } };
      assert.deepEqual(body, { unit: 'app-sdk-prod', sha, target: 'prod', candidateId, generation: 1, approvalId: 'approval-1' });
      return { status: 200, data: { receipt: signedReceipt(expectedReceipt(state)) } };
    } });
  assert.equal(result.phase, 'approved');
  assert.equal(result.approvalId, 'approval-1');
  assert.equal(oidcCount, 3);
  assert.ok(requests.every(request => request.path === '/executions/claim'));
  assert.ok(!JSON.stringify(result).includes('receipt'));
});

test('rejected, superseded and never-approved candidates cannot proceed to publication', async () => {
  const f = fixture();
  const state = await registerSdkRelease(f.options);
  for (const status of ['rejected', 'superseded', 'pending']) {
    await assert.rejects(waitForSdkRelease({ ...f.options, state, now, sleep: async () => {}, maxAttempts: 1,
      getOidc: async () => 'synthetic-oidc', service: async () => ({ status: 200, data: { status, candidateId, generation: 1 } }) }));
  }
});

test('receipt verification rejects every changed SDK field, expired receipts and untrusted headers', async () => {
  const f = fixture();
  const state = await registerSdkRelease(f.options);
  const expected = expectedReceipt(state);
  assert.equal(verifySdkReceipt(signedReceipt(expected), policy, expected, now()).tag, tag);
  for (const patch of [{ tag: 'v2.0.0-beta.25' }, { tagObjectSha: 'e'.repeat(40) }, { ciRunId: '101' },
    { ciRunAttempt: 3 }, { inventorySha256: 'e'.repeat(64) }, { requestDeploymentId: '701' },
    { runId: '901' }, { runAttempt: 2 }, { generation: 2 }, { exp: 1000 }, { iat: 2000 },
    { repositoryId: '1350249291' }, { unit: 'other-prod' }, { sha: 'f'.repeat(40) }, { target: 'dev' },
    { candidateId: candidateId + '-other' }, { approvalId: 'approval-2' }]) {
    assert.throws(() => verifySdkReceipt(signedReceipt(expected, patch), policy, expected, now()));
  }
  assert.throws(() => verifySdkReceipt(signedReceipt(expected, {}, { jku: 'https://untrusted.invalid/key' }), policy, expected, now()));
  assert.throws(() => verifySdkReceipt(signedReceipt(expected).slice(0, -8) + 'aaaaaaaa', policy, expected, now()));
});

test('refresh retains the frozen approved tuple without rereading CI artifacts or choosing a newer candidate', async () => {
  const f = fixture();
  const registered = await registerSdkRelease(f.options);
  const state = { ...registered, phase: 'approved', generation: 1, approvalId: 'approval-1' };
  const result = await refreshSdkRelease({ ...f.options, state, now,
    api: async () => assert.fail('refresh reread mutable GitHub metadata'), getOidc: async () => 'fresh-oidc',
    service: async (path, body) => {
      assert.equal(path, '/executions/refresh');
      assert.equal(body.candidateId, candidateId);
      return { status: 200, data: { receipt: signedReceipt(expectedReceipt(state)) } };
    } });
  assert.deepEqual(result, state);
  await assert.rejects(refreshSdkRelease({ ...f.options, state, now, event: { ...event, runAttempt: 2 } }));
});

test('missing OIDC and a forged status candidate are rejected before claim', async () => {
  const f = fixture();
  const state = await registerSdkRelease(f.options);
  await assert.rejects(waitForSdkRelease({ ...f.options, state, now, maxAttempts: 1,
    getOidc: async () => '', service: async () => assert.fail('missing OIDC reached the service') }), /OIDC/);
  await assert.rejects(waitForSdkRelease({ ...f.options, state, now, maxAttempts: 1,
    getOidc: async () => 'fresh-oidc', service: async () => ({ status: 200,
      data: { status: 'approved', candidateId: candidateId + '-other', generation: 1, approvalId: 'approval-1' } }) }), /candidate mismatch/);
});

test('service transport caps streamed responses, refuses redirects and never leaks credential errors', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(9_000).fill(32)); if (pulls === 3) controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const options = { policy, path: '/executions/claim', body: { mode: 'status' }, token: 'synthetic-oidc' };
  await assert.rejects(requestSdkService({ ...options, fetchImpl: async (url, request) => {
    assert.equal(new URL(url).origin, policy.endpoint);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, 'Bearer synthetic-oidc');
    return new Response(body, { status: 200 });
  } }), /metadata limit/);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  await assert.rejects(requestSdkService({ ...options, fetchImpl: async () => ({ status: 200, redirected: true }) }), /denied/);
  await assert.rejects(requestSdkService({ ...options, fetchImpl: async () => { throw new Error('synthetic-oidc'); } }),
    error => !error.message.includes('synthetic-oidc'));
  await assert.rejects(requestSdkService({ ...options, body: { value: 'x'.repeat(16_384) },
    fetchImpl: async () => assert.fail('oversized service body was sent') }), /metadata limit/);
});
