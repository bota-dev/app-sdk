import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForOwnedSpecsChecks } from './wait-owned-spec-checks.mjs';

const commit = 'a'.repeat(40);
const complete = () => ['Validate Specs', 'Dependency licenses', 'Scan'].map((name, index) => ({
  id: index + 1, name, head_sha: commit, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success',
}));
const response = check_runs => new Response(JSON.stringify({ total_count: check_runs.length, check_runs }));

test('publication waits for every exact-commit registry check before advancing main', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/bota-dev/app-sdk/commits/${commit}/check-runs?filter=latest&per_page=100`);
    assert.equal(options.redirect, 'error');
    return response(++calls === 1 ? complete().slice(0, 2) : complete());
  };
  assert.equal((await waitForOwnedSpecsChecks({ commit, fetchImpl, sleep: async () => {}, maxAttempts: 2 })).commit, commit);
  assert.equal(calls, 2);
});

test('failed, skipped, substituted and ambiguous checks cannot authorize publication', async () => {
  for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required']) {
    const checks = complete(); checks[0].conclusion = conclusion;
    await assert.rejects(waitForOwnedSpecsChecks({ commit, fetchImpl: async () => response(checks), maxAttempts: 1 }));
  }
  for (const change of [{ head_sha: 'b'.repeat(40) }, { app: { slug: 'other-app' } }]) {
    const checks = complete(); Object.assign(checks[0], change);
    await assert.rejects(waitForOwnedSpecsChecks({ commit, fetchImpl: async () => response(checks), maxAttempts: 1 }));
  }
  await assert.rejects(waitForOwnedSpecsChecks({ commit, fetchImpl: async () => response([...complete(), complete()[0]]), maxAttempts: 1 }));
});

test('lookup uncertainty and invalid commits fail closed without promoting a branch', async () => {
  for (const status of [403, 404, 429, 500]) {
    await assert.rejects(waitForOwnedSpecsChecks({ commit, fetchImpl: async () => new Response('', { status }), maxAttempts: 1 }));
  }
  await assert.rejects(waitForOwnedSpecsChecks({ commit, fetchImpl: async () => response([]), maxAttempts: 1 }));
  await assert.rejects(waitForOwnedSpecsChecks({ commit: '../main', fetchImpl: async () => assert.fail('invalid input reached network') }));
});
