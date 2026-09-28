import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const repository = 'bota-dev/app-sdk';
const platforms = { apple: 'apple-package', android: 'android-ci',
  'react-native': 'react-native-ci', web: 'web-ci', flutter: 'flutter-ci' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validPath = path => typeof path === 'string' && path.split('/').every(part =>
  /^[A-Za-z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..');

function annotation(message, key, pattern) {
  const values = message.split(/\r?\n/).filter(line => line.startsWith(`${key}:`));
  assert.equal(values.length, 1, `missing or ambiguous annotation ${key}`);
  const value = values[0].slice(key.length + 2);
  assert.ok(pattern.test(value), `invalid annotation ${key}`);
  return value;
}

function validRun(run, source, workflow) {
  return run?.repository?.full_name === repository && run.head_sha === source
    && run.head_branch === 'main' && run.event === 'push'
    && run.path === `.github/workflows/${workflow}.yml`
    && run.status === 'completed' && run.conclusion === 'success';
}

export function verifyFiles(files, expected, root) {
  const names = Object.keys(files).filter(name => !name.endsWith('/'));
  assert.ok(expected.length > 0 && names.length === expected.length, `${root} inventory file count mismatch`);
  for (const file of expected) {
    const name = file.path.slice(root.length + 1);
    const bytes = files[name];
    assert.ok(validPath(name) && bytes && bytes.length === file.byteLength && hash(bytes) === file.sha256,
      `inventory mismatch: ${file.path}`);
  }
}

// Read-only promotion: all five payloads must validate before the caller writes
// any output. No rebuilding, latest-run fallback, or registry access is allowed.
export async function promoteCandidate({ api, source, tagName }) {
  assert.match(source, /^[0-9a-f]{40}$/);
  assert.match(tagName, /^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
  const ref = await api(`git/ref/tags/${tagName}`);
  assert.equal(ref.object?.type, 'tag', 'release requires an annotated tag');
  const tag = await api(`git/tags/${ref.object.sha}`);
  assert.ok(tag.tag === tagName && tag.object?.type === 'commit' && tag.object.sha === source,
    'tag source identity mismatch');
  assert.equal(annotation(tag.message, 'Source-Revision', /^[0-9a-f]{40}$/), source, 'annotation source mismatch');
  const runId = Number(annotation(tag.message, 'Candidate-Run-ID', /^[1-9]\d*$/));
  assert.ok(Number.isSafeInteger(runId), 'invalid annotation run ID');
  const expectedDigest = annotation(tag.message, 'Candidate-Inventory-SHA256', /^[0-9a-f]{64}$/);
  const ci = await api(`actions/runs/${runId}`);
  assert.ok(ci.id === runId && validRun(ci, source, 'ci'), 'CI identity or successful main conclusion mismatch');
  const licenses = await api(`actions/workflows/license-gate.yml/runs?head_sha=${source}&branch=main&event=push&status=success&per_page=100`);
  assert.ok(licenses.workflow_runs.some(run => validRun(run, source, 'license-gate')),
    'successful exact main License Gate required');
  const result = await api(`actions/runs/${runId}/artifacts?per_page=100`);
  assert.ok(result.total_count <= 100, 'unexpected artifact pagination');
  const selected = [];
  const download = async name => {
    const matches = result.artifacts.filter(a => a.name === name);
    assert.equal(matches.length, 1, `missing or ambiguous artifact ${name}`);
    const a = matches[0];
    assert.ok(Number.isSafeInteger(a.id) && a.expired === false
      && /^sha256:[0-9a-f]{64}$/.test(a.digest)
      && a.workflow_run?.id === runId && a.workflow_run.head_sha === source
      && a.workflow_run.repository_id === ci.repository.id, `artifact identity/expiration mismatch: ${name}`);
    const bytes = await api(`actions/artifacts/${a.id}/zip`, true);
    assert.equal(`sha256:${hash(bytes)}`, a.digest, `artifact digest mismatch: ${name}`);
    selected.push({ id: a.id, name, digest: a.digest });
    return unzipSync(bytes);
  };
  const manifest = await download(`release-candidate-${source}`);
  assert.deepEqual(Object.keys(manifest).sort(), ['release-candidate-files.json', 'release-candidate-files.json.sha256']);
  const raw = Buffer.from(manifest['release-candidate-files.json']);
  assert.equal(hash(raw), expectedDigest, 'annotation inventory digest mismatch');
  assert.equal(Buffer.from(manifest['release-candidate-files.json.sha256']).toString().trim().split(/\s+/)[0],
    expectedDigest, 'inventory digest sidecar mismatch');
  const inventory = JSON.parse(raw);
  assert.ok(inventory.schemaVersion === 1 && inventory.sourceRevision === source
    && Array.isArray(inventory.files), 'candidate inventory identity mismatch');
  const seen = new Set();
  for (const file of inventory.files) {
    assert.ok(validPath(file.path) && Object.keys(platforms).some(p => file.path.startsWith(`${p}-release/`))
      && !seen.has(file.path) && Number.isSafeInteger(file.byteLength) && file.byteLength >= 0
      && /^[0-9a-f]{64}$/.test(file.sha256), `invalid or duplicate inventory path: ${file.path}`);
    seen.add(file.path);
  }
  const files = {};
  for (const [platform, prefix] of Object.entries(platforms)) {
    const root = `${platform}-release`;
    const payload = await download(`${prefix}-${source}`);
    const expected = inventory.files.filter(file => file.path.startsWith(`${root}/`));
    verifyFiles(payload, expected, root);
    for (const file of expected) files[file.path] = Buffer.from(payload[file.path.slice(root.length + 1)]);
  }
  const finalRef = await api(`git/ref/tags/${tagName}`);
  assert.ok(finalRef.object?.type === 'tag' && finalRef.object.sha === ref.object.sha,
    'tag changed during candidate promotion');
  return { files, inventory, rawInventory: raw, provenance: {
    schemaVersion: 1, sourceRevision: source, tag: tagName, tagObject: ref.object.sha,
    ciRunId: runId, inventorySha256: expectedDigest, artifacts: selected.sort((a, b) => a.id - b.id),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2, 'usage: node tools/release/promote-ci.mjs');
    assert.ok(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_EVENT_NAME === 'push'
      && process.env.GITHUB_REF === `refs/tags/${process.env.GITHUB_REF_NAME}`, 'tag-push context required');
    assert.ok(process.env.GH_TOKEN, 'GitHub read token required');
    const api = async (path, binary = false) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, `GitHub read failed: HTTP ${response.status}`);
      return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
    };
    const result = await promoteCandidate({ api, source: process.env.GITHUB_SHA, tagName: process.env.GITHUB_REF_NAME });
    const files = { ...result.files, 'release-candidate-files.json': result.rawInventory,
      'release-candidate-files.json.sha256': Buffer.from(`${result.provenance.inventorySha256}  release-candidate-files.json\n`),
      'ci-promotion.json': Buffer.from(`${JSON.stringify(result.provenance, null, 2)}\n`) };
    for (const [path, bytes] of Object.entries(files)) {
      const output = resolve('target', path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: 'wx' });
    }
    const summary = `CI candidate ready: [run ${result.provenance.ciRunId}](https://github.com/${repository}/actions/runs/${result.provenance.ciRunId}), source \`${result.provenance.sourceRevision}\`. All five preserved payloads match the annotated inventory. Publication has not started.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
