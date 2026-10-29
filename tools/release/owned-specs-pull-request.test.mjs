import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPodspec, ownedSpecPath } from './owned-cocoapods.mjs';
import { waitForOwnedSpecsPullRequest } from './owned-specs-pull-request.mjs';

const commit = 'a'.repeat(40);
const mergedCommit = 'b'.repeat(40);
const blob = 'c'.repeat(40);
const branch = 'publish/12345-1';
const version = '2.0.0-beta.24';
const file = ownedSpecPath(version);
const archive = 'd'.repeat(64);
const spec = { name: 'BotaAppSDK', module_name: 'BotaAppSDK', version,
  license: { type: 'Apache-2.0' },
  source: { http: `https://github.com/bota-dev/app-sdk/releases/download/v${version}/BotaAppSDK.cocoapods.zip`, sha256: archive } };
const bytes = canonicalPodspec({ spec, sdkVersion: version, artifactChecksum: archive });
const repository = { id: 123, full_name: 'bota-dev/app-sdk' };
const pr = (changes = {}) => ({ number: 7, state: 'open', merged: false, user: { id: 1 },
  head: { sha: commit, ref: branch, repo: repository }, base: { ref: 'main', repo: repository }, ...changes });
const merged = () => pr({ state: 'closed', merged: true, merge_commit_sha: mergedCommit });
const approved = () => ({ id: 10, user: { id: 2 }, state: 'APPROVED', commit_id: commit });
const contents = (changes = {}) => ({ type: 'file', path: file, sha: blob, size: Buffer.byteLength(bytes),
  encoding: 'base64', content: Buffer.from(bytes).toString('base64'), ...changes });

function scenario({ lists = [[]], polls = [merged()], postError = null, files = [{ filename: file, status: 'added', sha: blob }],
  reviews = [approved()], staged = contents(), retained = contents() } = {}) {
  const calls = [];
  const messages = [];
  let listCount = 0;
  let pollCount = 0;
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com', 'token was sent to another host');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    const method = options.method ?? 'GET';
    calls.push({ method, path: target.pathname, body: options.body });
    let value;
    let status = 200;
    if (target.pathname.endsWith('/pulls') && method === 'GET') value = lists[Math.min(listCount++, lists.length - 1)];
    else if (target.pathname.endsWith('/git/ref/heads/' + branch)) value = { object: { type: 'commit', sha: commit } };
    else if (target.pathname.endsWith('/pulls') && method === 'POST') {
      if (postError) throw postError;
      assert.deepEqual(JSON.parse(options.body), {
        title: 'Publish immutable CocoaPods metadata', head: branch, base: 'main',
        body: `Publish the metadata staged at ${commit}.\n\nThis PR requires independent review and the registry checks. The SDK publisher never approves or merges it.`,
      });
      value = pr(); status = 201;
    } else if (target.pathname.endsWith('/pulls/7')) value = polls[Math.min(pollCount++, polls.length - 1)];
    else if (target.pathname.endsWith('/pulls/7/files')) value = files;
    else if (target.pathname.endsWith('/pulls/7/reviews')) value = reviews;
    else if (target.pathname.endsWith('/contents/' + file)) value = target.searchParams.get('ref') === commit ? staged : retained;
    else assert.fail('Unexpected API route: ' + target.pathname);
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const options = { commit, branch, token: 'synthetic-test-token', fetchImpl,
    sleep: async () => {}, maxAttempts: 3, onWait: message => messages.push(message) };
  return { calls, messages, options };
}

test('creates one source-bound PR, waits for external merge and verifies retained metadata', async () => {
  const run = scenario({ polls: [pr(), merged()] });
  const result = await waitForOwnedSpecsPullRequest(run.options);
  assert.equal(result.pullRequest, 7);
  assert.equal(result.mergeCommit, mergedCommit);
  assert.equal(result.specPath, file);
  assert.equal(result.blob, blob);
  assert.match(run.messages[0], /https:\/\/github\.com\/bota-dev\/app-sdk\/pull\/7/);
  assert.equal(run.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(run.calls.every(call => call.method === 'GET' || call.path.endsWith('/pulls')),
    'publisher attempted to approve or merge a PR');
});

test('reuses an existing exact PR and reconciles an uncertain create without creating twice', async () => {
  for (const config of [
    { lists: [[pr()]] },
    { lists: [[], [pr()]], postError: new Error('synthetic connection reset') },
  ]) {
    const run = scenario(config);
    assert.equal((await waitForOwnedSpecsPullRequest(run.options)).pullRequest, 7);
    assert.ok(run.calls.filter(call => call.method === 'POST').length <= 1);
  }
});

test('rejects closed unmerged PRs and source, repository or base drift', async () => {
  for (const changed of [
    pr({ state: 'closed', merged: false }),
    pr({ head: { sha: 'e'.repeat(40), ref: branch, repo: repository } }),
    pr({ head: { sha: commit, ref: 'other', repo: repository } }),
    pr({ head: { sha: commit, ref: branch, repo: { id: 456, full_name: 'other/specs' } } }),
    pr({ base: { ref: 'other', repo: repository } }),
    pr({ base: { ref: 'main', repo: { id: 456, full_name: 'other/specs' } } }),
  ]) {
    const run = scenario({ lists: [[changed]], polls: [changed] });
    await assert.rejects(waitForOwnedSpecsPullRequest(run.options));
  }
  const ambiguous = scenario({ lists: [[pr(), pr({ number: 8 })]] });
  await assert.rejects(waitForOwnedSpecsPullRequest(ambiguous.options), /ambiguous/);
});

test('requires a source-bound approval from someone other than the PR author', async () => {
  for (const reviews of [[], [{ ...approved(), user: { id: 1 } }], [{ ...approved(), state: 'DISMISSED' }],
    [{ ...approved(), commit_id: 'e'.repeat(40) }],
    [approved(), { ...approved(), id: 11, state: 'CHANGES_REQUESTED' }]]) {
    const run = scenario({ reviews });
    await assert.rejects(waitForOwnedSpecsPullRequest(run.options), /independent approval/);
  }
  const commented = scenario({ reviews: [approved(), { ...approved(), id: 11, state: 'COMMENTED' }] });
  assert.equal((await waitForOwnedSpecsPullRequest(commented.options)).pullRequest, 7);
});

test('rejects extra files, occupied-version edits and substituted merged metadata', async () => {
  for (const files of [[], [{ filename: file, status: 'modified', sha: blob }],
    [{ filename: '../other', status: 'added', sha: blob }],
    [{ filename: file, status: 'added', sha: blob }, { filename: 'README.md', status: 'modified', sha: blob }]]) {
    const run = scenario({ files });
    await assert.rejects(waitForOwnedSpecsPullRequest(run.options), /single added/);
  }
  for (const retained of [contents({ sha: 'e'.repeat(40) }), contents({ content: Buffer.from('{}\n').toString('base64'), size: 3 }),
    contents({ type: 'symlink' }), contents({ path: 'other' })]) {
    const run = scenario({ retained });
    await assert.rejects(waitForOwnedSpecsPullRequest(run.options));
  }
});

test('invalid inputs, missing authority and bounded waits fail without merging', async () => {
  for (const changes of [{ commit: '../main' }, { branch: 'main' }, { branch: 'publish/1-1?other=1' },
    { token: '' }, { maxAttempts: 121 }]) {
    const run = scenario();
    await assert.rejects(waitForOwnedSpecsPullRequest({ ...run.options, ...changes }));
    assert.equal(run.calls.length, 0);
  }
  const pending = scenario({ polls: [pr()] });
  await assert.rejects(waitForOwnedSpecsPullRequest({ ...pending.options, maxAttempts: 1 }), /not merged/);
  assert.ok(pending.calls.every(call => !/\/merge$|\/reviews$/.test(call.path) || call.method === 'GET'));
  const denied = scenario();
  await assert.rejects(waitForOwnedSpecsPullRequest({ ...denied.options,
    fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/);
});

test('stops reading an oversized streamed API response and releases its body', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(600_000).fill(32));
      if (pulls === 3) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const run = scenario();
  await assert.rejects(waitForOwnedSpecsPullRequest({ ...run.options,
    fetchImpl: async () => new Response(body, { status: 200 }) }), /metadata limit/);
  assert.equal(pulls, 2, 'the reader consumed beyond the first chunk that exceeded the bound');
  assert.equal(cancelled, true, 'the remaining response body was not cancelled');
  assert.equal(body.locked, false, 'the response reader lock was not released');
});
