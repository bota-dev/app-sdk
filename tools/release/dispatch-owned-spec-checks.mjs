import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const api = 'https://api.github.com/repos/bota-dev/app-sdk';
const workflows = ['validate-owned-specs.yml', 'license-gate.yml', 'semgrep.yml'];
const checks = ['Validate Specs', 'Dependency licenses', 'Scan'];

async function readRef(response) {
  assert.ok(response.body, 'empty publication branch response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert.ok(length <= 16_384, 'publication branch response exceeds the metadata limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function dispatchOwnedSpecsChecks({ commit, branch, token = process.env.GH_TOKEN, fetchImpl = fetch }) {
  assert.ok(/^(?!0{40}$)[0-9a-f]{40}$/.test(commit ?? '')
    && /^publish\/[1-9][0-9]*-[1-9][0-9]*$/.test(branch ?? ''), 'an exact staged commit and publication branch are required');
  assert.ok(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\x00-\x20\x7f]/.test(token),
    'GH_TOKEN supplied from github.token with Actions write is required');
  async function request(path, body) {
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetchImpl(api + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'bota-sdk-specs-publisher' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (method === 'POST') throw new Error('Specs workflow dispatch outcome is uncertain; inspect this exact branch before retrying', { cause: error });
      throw error;
    }
    assert.ok(response.status === (method === 'GET' ? 200 : 204) && !response.redirected,
      `GitHub Specs workflow API failed: HTTP ${response.status}`);
    return method === 'GET' ? readRef(response) : undefined;
  }
  async function verifyRef() {
    const ref = await request(`/git/ref/heads/${branch}`);
    assert.ok(ref.ref === `refs/heads/${branch}` && ref.object?.type === 'commit' && ref.object.sha === commit,
      'publication branch changed; no exact-head check qualification is established');
  }
  await verifyRef();
  // Token pushes suppress push-triggered workflows. Dispatch the fixed, secret-free
  // validators explicitly; their revision input and later check readback bind the SHA.
  for (const workflow of workflows) {
    await request(`/actions/workflows/${workflow}/dispatches`, { ref: branch, inputs: { revision: commit } });
  }
  await verifyRef();
  return { commit, branch, workflows: [...workflows], checks: [...checks] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('usage: dispatch-owned-spec-checks.mjs <exact-commit> <publish/run-attempt>');
  console.log(JSON.stringify(await dispatchOwnedSpecsChecks({ commit: process.argv[2], branch: process.argv[3] })));
}
