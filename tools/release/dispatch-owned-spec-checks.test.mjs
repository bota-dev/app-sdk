import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchOwnedSpecsChecks } from './dispatch-owned-spec-checks.mjs';

const commit = 'a'.repeat(40);
const branch = 'publish/12345-1';
const workflows = ['validate-owned-specs.yml', 'license-gate.yml', 'semgrep.yml'];
const checks = ['Validate Specs', 'Dependency licenses', 'Scan'];

function fixture({ refs = [commit], denied = null } = {}) {
  const calls = [];
  let refIndex = 0;
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    calls.push({ method: options.method, path: target.pathname, body: options.body });
    if (options.method === 'GET') {
      assert.equal(target.pathname, `/repos/bota-dev/app-sdk/git/ref/heads/${branch}`);
      return new Response(JSON.stringify({ ref: `refs/heads/${branch}`,
        object: { type: 'commit', sha: refs[Math.min(refIndex++, refs.length - 1)] } }), { status: 200 });
    }
    assert.equal(options.method, 'POST');
    assert.ok(workflows.some(name => target.pathname === `/repos/bota-dev/app-sdk/actions/workflows/${name}/dispatches`));
    assert.deepEqual(JSON.parse(options.body), { ref: branch, inputs: { revision: commit } });
    if (denied) return new Response('', { status: denied });
    return new Response(null, { status: 204 });
  };
  return { calls, options: { commit, branch, token: 'synthetic-token', fetchImpl } };
}

test('dispatches only the approved workflows at the exact app-sdk branch revision', async () => {
  const run = fixture();
  assert.deepEqual(await dispatchOwnedSpecsChecks(run.options), { commit, branch, workflows, checks });
  assert.deepEqual(run.calls.filter(call => call.method === 'POST').map(call => call.path),
    workflows.map(name => `/repos/bota-dev/app-sdk/actions/workflows/${name}/dispatches`));
  assert.equal(run.calls.filter(call => call.method === 'GET').length, 2);
});

test('rejects invalid commits, publication refs and missing tokens before requesting GitHub', async () => {
  for (const input of [{ commit: '0'.repeat(40) }, { commit: 'main' }, { branch: 'main' },
    { branch: 'publish/1-1?other=1' }, { branch: 'refs/heads/publish/1-1' }, { token: '' }, { token: 'invalid token' }]) {
    const run = fixture();
    await assert.rejects(dispatchOwnedSpecsChecks({ ...run.options, ...input }));
    assert.equal(run.calls.length, 0);
  }
});

test('rejects branch drift before dispatch and after the accepted requests', async () => {
  for (const refs of [['b'.repeat(40)], [commit, 'b'.repeat(40)]]) {
    const run = fixture({ refs });
    await assert.rejects(dispatchOwnedSpecsChecks(run.options), /branch changed/);
    assert.equal(run.calls.filter(call => call.method === 'POST').length, refs.length === 1 ? 0 : 3);
  }
});

test('fails on permission and uncertain dispatch results without repeating a write', async () => {
  const denied = fixture({ denied: 403 });
  await assert.rejects(dispatchOwnedSpecsChecks(denied.options), /HTTP 403/);
  assert.equal(denied.calls.filter(call => call.method === 'POST').length, 1);
  const uncertain = fixture();
  let writes = 0;
  await assert.rejects(dispatchOwnedSpecsChecks({ ...uncertain.options,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') { writes++; throw new Error('synthetic lost response'); }
      return uncertain.options.fetchImpl(url, options);
    } }), /outcome is uncertain/);
  assert.equal(writes, 1);
});

test('caps streamed ref metadata and cancels the unread remainder before dispatching', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(9_000).fill(32));
      if (pulls === 3) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const run = fixture();
  await assert.rejects(dispatchOwnedSpecsChecks({ ...run.options,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET', 'an oversized ref response authorized a write');
      return new Response(body, { status: 200 });
    } }), /metadata limit/);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
