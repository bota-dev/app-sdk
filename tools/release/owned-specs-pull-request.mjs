import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { canonicalPodspec, ownedSpecPath } from './owned-cocoapods.mjs';

const repository = 'bota-dev/cocoapods-specs';
const api = `https://api.github.com/repos/${repository}`;
const SHA = /^(?!0{40}$)[0-9a-f]{40}$/;
const branchPattern = /^publish\/[1-9][0-9]*-[1-9][0-9]*$/;
const pathPattern = /^Specs\/(BotaAppSDK|BotaAppleSDK)\/([^/]+)\/\1\.podspec\.json$/;
const prUrl = number => `https://github.com/${repository}/pull/${number}`;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function waitForOwnedSpecsPullRequest({
  commit, branch, token = process.env.BOTA_COCOAPODS_SPECS_TOKEN,
  fetchImpl = fetch, maxAttempts = 120,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onWait = () => {},
}) {
  assert.ok(SHA.test(commit ?? '') && branchPattern.test(branch ?? ''), 'an exact staged commit and publication branch are required');
  assert.ok(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\x00-\x20\x7f]/.test(token),
    'BOTA_COCOAPODS_SPECS_TOKEN with repository Contents/Pull requests write is required');
  assert.ok(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 120, 'invalid PR wait bound');
  const deadline = Date.now() + 60 * 60_000;

  async function request(path, body) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Specs PR was not merged before the bounded deadline');
    const response = await fetchImpl(api + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bota-sdk-specs-publisher' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== (body === undefined ? 200 : 201) || response.redirected) {
      throw Object.assign(new Error(`GitHub Specs PR API failed: HTTP ${response.status}`), { status: response.status });
    }
    assert.ok(!response.headers.get('link')?.includes('rel="next"'), 'incomplete paginated Specs PR response');
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 1024 * 1024, 'Specs PR API response exceeds the metadata limit');
    return JSON.parse(text);
  }

  function identity(pr) {
    assert.ok(Number.isSafeInteger(pr?.number) && pr.number > 0
      && pr.head?.sha === commit && pr.head.ref === branch && pr.base?.ref === 'main'
      && pr.head.repo?.full_name === repository && pr.base.repo?.full_name === repository
      && Number.isSafeInteger(pr.head.repo.id) && pr.head.repo.id > 0 && pr.head.repo.id === pr.base.repo.id,
    'Specs PR source, repository or base binding changed');
    return pr.number;
  }

  async function existing() {
    // No base filter: a changed base must be rejected, rather than hidden by a new PR creation.
    const prs = await request(`/pulls?state=all&head=${encodeURIComponent(`bota-dev:${branch}`)}&per_page=100`);
    assert.ok(Array.isArray(prs) && prs.length <= 1, 'ambiguous Specs publication PRs');
    if (prs.length) identity(prs[0]);
    return prs[0];
  }

  let selected = await existing();
  if (!selected) {
    const ref = await request(`/git/ref/heads/${branch}`);
    assert.ok(ref.object?.type === 'commit' && ref.object.sha === commit, 'staged publication branch changed');
    try {
      selected = await request('/pulls', {
        title: 'Publish immutable CocoaPods metadata', head: branch, base: 'main',
        body: `Publish the metadata staged at ${commit}.\n\nThis PR requires independent review and the registry checks. The SDK publisher never approves or merges it.`,
      });
    } catch (error) {
      // A lost create response can still have created the PR. Reconcile once, never blindly POST again.
      if (error.status && error.status !== 422 && error.status < 500) throw error;
      selected = await existing();
      if (!selected) throw new Error('Specs PR creation outcome is unconfirmed; inspect the publication branch before retrying', { cause: error });
    }
  }
  const number = identity(selected);
  onWait(`Review and merge CocoaPods metadata: ${prUrl(number)}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pr = await request(`/pulls/${number}`);
    identity(pr);
    if (pr.merged === true) {
      assert.ok(pr.state === 'closed' && SHA.test(pr.merge_commit_sha ?? ''), 'merged Specs PR identity is incomplete');
      const reviews = await request(`/pulls/${number}/reviews?per_page=100`);
      assert.ok(Array.isArray(reviews) && Number.isSafeInteger(pr.user?.id), 'invalid Specs PR review metadata');
      const decisions = new Map();
      for (const review of reviews) {
        assert.ok(Number.isSafeInteger(review.id) && Number.isSafeInteger(review.user?.id), 'invalid Specs PR review identity');
        if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
        const previous = decisions.get(review.user.id);
        if (!previous || review.id > previous.id) decisions.set(review.user.id, review);
      }
      assert.ok([...decisions.values()].some(review => review.state === 'APPROVED'
        && review.commit_id === commit && review.user.id !== pr.user.id), 'merged Specs PR lacks a source-bound independent approval');
      const files = await request(`/pulls/${number}/files?per_page=100`);
      assert.ok(Array.isArray(files) && files.length === 1 && files[0].status === 'added'
        && SHA.test(files[0].sha ?? '') && pathPattern.test(files[0].filename ?? ''),
      'Specs publication must retain a single added canonical version file');
      const path = files[0].filename;
      const version = pathPattern.exec(path)[2];
      assert.equal(ownedSpecPath(version), path, 'Specs publication path and SDK identity disagree');
      const contentPath = path.split('/').map(encodeURIComponent).join('/');
      async function contents(revision) {
        const item = await request(`/contents/${contentPath}?ref=${revision}`);
        assert.ok(item.type === 'file' && item.path === path && item.encoding === 'base64'
          && SHA.test(item.sha ?? '') && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 65_536
          && typeof item.content === 'string', 'invalid retained Specs file metadata');
        const bytes = Buffer.from(item.content, 'base64');
        assert.equal(bytes.byteLength, item.size, 'retained Specs byte count differs');
        return { ...item, bytes };
      }
      const staged = await contents(commit);
      assert.equal(staged.sha, files[0].sha, 'PR file differs from the exact staged commit');
      const spec = JSON.parse(staged.bytes.toString('utf8'));
      assert.equal(canonicalPodspec({ spec, sdkVersion: version, artifactChecksum: spec.source?.sha256 }),
        staged.bytes.toString('utf8'), 'staged Specs metadata is not canonical');
      const retained = await contents(pr.merge_commit_sha);
      assert.ok(retained.sha === staged.sha && retained.bytes.equals(staged.bytes), 'merged commit changed the staged Specs bytes');
      return { pullRequest: number, url: prUrl(number), commit, mergeCommit: pr.merge_commit_sha, specPath: path, blob: staged.sha };
    }
    assert.equal(pr.state, 'open', `Specs PR was closed without merging: ${prUrl(number)}`);
    if (attempt + 1 < maxAttempts) {
      onWait(`Waiting for independent Specs PR approval and merge (${attempt + 1}/${maxAttempts}): ${prUrl(number)}`);
      await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error(`Specs PR was not merged within the bounded wait; retain the branch and inspect ${prUrl(number)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('usage: owned-specs-pull-request.mjs <exact-commit> <publish/run-attempt>');
  console.log(JSON.stringify(await waitForOwnedSpecsPullRequest({ commit: process.argv[2], branch: process.argv[3], onWait: console.log })));
}
