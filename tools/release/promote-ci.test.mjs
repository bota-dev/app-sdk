import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { zipSync } from 'fflate';
import { promoteCandidate, verifyFiles } from './promote-ci.mjs';

const sha = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const roots = ['apple', 'android', 'react-native', 'web', 'flutter'];
function fixture() {
  const payloads = roots.map(root => ({ [`${root}.bin`]: Buffer.from(root) }));
  const inventory = { schemaVersion: 1, sourceRevision: sha, files: roots.map((root, i) => ({
    path: `${root}-release/${root}.bin`, byteLength: payloads[i][`${root}.bin`].length,
    sha256: hash(payloads[i][`${root}.bin`]),
  })) };
  const raw = encode(inventory);
  const zips = [...payloads.map(files => zipSync(files)), zipSync({
    'release-candidate-files.json': raw,
    'release-candidate-files.json.sha256': Buffer.from(`${hash(raw)}  target/release-candidate-files.json\n`),
  })];
  const names = [`apple-package-${sha}`, `android-ci-${sha}`, `react-native-ci-${sha}`,
    `web-ci-${sha}`, `flutter-ci-${sha}`, `release-candidate-${sha}`];
  const artifacts = names.map((name, i) => ({ id: 10 + i, name, expired: false,
    digest: `sha256:${hash(zips[i])}`, workflow_run: { id: 100, head_sha: sha, repository_id: 1 } }));
  const ci = { id: 100, path: '.github/workflows/ci.yml', head_sha: sha, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', repository: { id: 1, full_name: 'bota-dev/app-sdk' } };
  const license = { ...ci, id: 101, path: '.github/workflows/license-gate.yml' };
  const tag = { tag: 'v2.0.0-beta.5', object: { type: 'commit', sha },
    message: `Release\nSource-Revision: ${sha}\nCandidate-Run-ID: 100\nCandidate-Inventory-SHA256: ${hash(raw)}\n` };
  const calls = [];
  const api = async (path, binary) => {
    calls.push(path);
    if (path === 'git/ref/tags/v2.0.0-beta.5') return { object: { type: 'tag', sha: 'b'.repeat(40) } };
    if (path === `git/tags/${'b'.repeat(40)}`) return tag;
    if (path === 'actions/runs/100') return ci;
    if (path.startsWith('actions/workflows/license-gate.yml/runs?')) return { total_count: 1, workflow_runs: [license] };
    if (path === 'actions/runs/100/artifacts?per_page=100') return { total_count: artifacts.length, artifacts };
    const match = /^actions\/artifacts\/(\d+)\/zip$/.exec(path);
    if (match && binary) return zips[Number(match[1]) - 10];
    throw new Error(`unexpected request ${path}`);
  };
  return { ci, license, tag, inventory, artifacts, zips, calls, api,
    run: () => promoteCandidate({ api, source: sha, tagName: tag.tag }) };
}

test('promotes the five original payloads and records their exact run, IDs and digests', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.provenance.ciRunId, 100);
  assert.deepEqual(result.provenance.artifacts.map(a => a.id), [10, 11, 12, 13, 14, 15]);
  assert.equal(result.files['flutter-release/flutter.bin'].toString(), 'flutter');
  assert.equal(result.inventory.sourceRevision, sha);
  assert.equal(f.calls.filter(path => path.endsWith('/zip')).length, 6);
});

for (const [field, value] of [['head_sha', 'c'.repeat(40)], ['head_branch', 'feature'],
  ['event', 'pull_request'], ['conclusion', 'failure'], ['status', 'in_progress'],
  ['path', '.github/workflows/other.yml'], ['repository', { id: 1, full_name: 'fork/app-sdk' }]]) {
  test(`rejects CI ${field} mismatch before downloading payloads`, async () => {
    const f = fixture(); f.ci[field] = value;
    await assert.rejects(f.run(), /CI identity/);
    assert.ok(!f.calls.some(path => path.endsWith('/zip')));
  });
}

test('requires a successful License Gate on the same main revision', async () => {
  const f = fixture(); f.license.head_sha = 'c'.repeat(40);
  await assert.rejects(f.run(), /License Gate/);
});
test('requires an unambiguous pinned run and inventory in the annotation', async () => {
  for (const mutation of [s => s.replace('Candidate-Run-ID: 100', ''), s => `${s}Candidate-Run-ID: 101\n`,
    s => s.replace(`Source-Revision: ${sha}`, `Source-Revision: ${'c'.repeat(40)}`)]) {
    const f = fixture(); f.tag.message = mutation(f.tag.message);
    await assert.rejects(f.run(), /annotation/);
  }
});
test('rejects inventory drift even when artifact transport digest is correct', async () => {
  const f = fixture(); f.tag.message = f.tag.message.replace(hash(encode(f.inventory)), '0'.repeat(64));
  await assert.rejects(f.run(), /inventory digest/);
});
test('rejects expired, ambiguous, foreign and missing artifacts', async () => {
  for (const mutate of [f => { f.artifacts[0].expired = true; }, f => f.artifacts.push(f.artifacts[0]),
    f => { f.artifacts[0].workflow_run.id = 999; }, f => f.artifacts.splice(0, 1)]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run(), /artifact/);
  }
});
test('fails closed on ZIP digest corruption instead of trusting a download warning', async () => {
  const f = fixture(); f.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(f.run(), /artifact digest/);
});
test('compares every preserved file and rejects extras, missing files and byte drift', () => {
  const f = fixture(); const expected = f.inventory.files.filter(file => file.path.startsWith('apple-release/'));
  for (const files of [{}, { 'apple.bin': Buffer.from('wrong') },
    { 'apple.bin': Buffer.from('apple'), extra: Buffer.from('extra') }]) {
    assert.throws(() => verifyFiles(files, expected, 'apple-release'), /inventory/);
  }
});
test('rejects unsafe inventory paths, duplicates and unknown platform roots', async () => {
  for (const path of ['apple-release/../escape', 'apple-release/C:evil', '/apple-release/apple.bin',
    'apple-release/evil\\file', 'unknown-release/apple.bin']) {
    const f = fixture(); f.inventory.files[0].path = path;
    const raw = encode(f.inventory);
    f.zips[5] = zipSync({ 'release-candidate-files.json': raw,
      'release-candidate-files.json.sha256': Buffer.from(`${hash(raw)}  inventory\n`) });
    f.artifacts[5].digest = `sha256:${hash(f.zips[5])}`;
    f.tag.message = f.tag.message.replace(/Candidate-Inventory-SHA256: .*/, `Candidate-Inventory-SHA256: ${hash(raw)}`);
    await assert.rejects(f.run(), /inventory path/);
  }
});

test('rejects a tag moved while its artifacts were being downloaded', async () => {
  const f = fixture(); let reads = 0;
  const api = async (path, binary) => {
    const value = await f.api(path, binary);
    if (path.startsWith('git/ref/') && ++reads > 1) return { object: { type: 'tag', sha: 'c'.repeat(40) } };
    return value;
  };
  await assert.rejects(promoteCandidate({ api, source: sha, tagName: f.tag.tag }), /tag changed/);
});
