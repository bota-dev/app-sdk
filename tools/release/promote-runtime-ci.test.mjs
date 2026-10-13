import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { Header } from 'tar';
import { promoteRuntimeCandidate } from './promote-runtime-ci.mjs';

const source = 'a'.repeat(40);
const version = '0.1.0-beta.0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = () => ({ name: '@bota.dev/react-native-app-sdk-runtime', version,
  main: 'lib/commonjs/runtime.js', module: 'lib/module/runtime.js', types: 'lib/typescript/runtime.d.ts',
  exports: { '.': { types: './lib/typescript/runtime.d.ts', default: './lib/commonjs/runtime.js' }, './package.json': './package.json' },
  dependencies: { buffer: '6.0.3', eventemitter3: '5.0.1' },
  scripts: { build: 'node ../../tools/react-native/build-runtime-package.mjs', test: 'node --test test/*.test.mjs' } });

function tar(entries) {
  const chunks = [];
  for (const [path, data, type = 'File'] of entries) {
    const bytes = Buffer.from(type === 'SymbolicLink' ? '' : data);
    const header = new Header({ path, size: bytes.length, type, mode: 0o644,
      ...(type === 'SymbolicLink' ? { linkpath: 'LICENSE' } : {}) });
    const encoded = Buffer.alloc(512);
    assert.equal(header.encode(encoded), false);
    chunks.push(encoded, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function fixture() {
  const pkg = manifest();
  const files = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'lib/commonjs/runtime.js', 'lib/module/runtime.js',
    'lib/typescript/runtime.d.ts', 'lib/commonjs/jsHost/generated/core.js', 'lib/module/jsHost/generated/core.js']
    .map(path => [`package/${path}`, 'source']);
  for (let i = 0; i < 47; i++) files.push([`package/THIRD_PARTY_NOTICES/${i}.txt`, 'notice']);
  const ci = { id: 100, path: '.github/workflows/ci.yml', head_sha: source, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', repository: { id: 1, full_name: 'bota-dev/app-sdk' } };
  const license = { ...ci, id: 101, path: '.github/workflows/license-gate.yml' };
  const artifacts = [{ id: 10, name: `react-native-runtime-ci-${source}`, expired: false,
    workflow_run: { id: 100, head_sha: source, repository_id: 1 } }];
  const calls = [];
  const args = { source, runId: 100, version };
  let zip;
  const api = async (path, binary) => {
    calls.push(path);
    if (path === 'actions/runs/100') return ci;
    if (path.startsWith('actions/workflows/license-gate.yml/runs?')) return { total_count: 1, workflow_runs: [license] };
    if (path === 'actions/runs/100/artifacts?per_page=100') return { total_count: artifacts.length, artifacts };
    if (path === 'actions/artifacts/10/zip' && binary) return zip;
    throw new Error(`unexpected request ${path}`);
  };
  const f = { pkg, files, ci, license, artifacts, calls, args, api,
    rebuild(extraZip = {}) {
      const bytes = tar([['package/package.json', JSON.stringify(pkg)], ...files]);
      zip = zipSync({ 'bota.dev-react-native-app-sdk-runtime-0.1.0-beta.0.tgz': bytes, ...extraZip });
      args.expectedPackageSha256 = hash(bytes);
      args.expectedArchiveSha256 = hash(zip);
      artifacts[0].digest = `sha256:${hash(zip)}`;
    },
    setZip(bytes) { zip = bytes; args.expectedArchiveSha256 = hash(bytes); artifacts[0].digest = `sha256:${hash(bytes)}`; },
    run: () => promoteRuntimeCandidate({ api, ...args }),
  };
  f.rebuild();
  return f;
}

test('preserves the candidate bytes and records exact source, CI, License Gate and artifact provenance', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.filename, 'bota.dev-react-native-app-sdk-runtime-0.1.0-beta.0.tgz');
  assert.equal(hash(result.packageBytes), f.args.expectedPackageSha256);
  assert.equal(result.provenance.sourceRevision, source);
  assert.equal(result.provenance.ciRunId, 100);
  assert.equal(result.provenance.licenseRunId, 101);
  assert.equal(result.provenance.artifact.id, 10);
  assert.deepEqual(result.provenance.package, { name: f.pkg.name, version, fileCount: 56 });
  assert.ok(!f.calls.some(path => /tags|registry/.test(path)));
});

test('validates all caller inputs before reading GitHub', async () => {
  for (const [field, value] of [['source', 'a'.repeat(39)], ['runId', '100'], ['runId', 0],
    ['runId', Number.MAX_SAFE_INTEGER + 1], ['expectedArchiveSha256', 'bad'], ['expectedPackageSha256', 'bad'],
    ['version', '1.0.0-beta.0'], ['version', '0.01.0-beta.0'], ['version', '0.1.0-beta.01'], ['version', '0.1.0']]) {
    const f = fixture(); f.args[field] = value;
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
  }
});

for (const [field, value] of [['id', 999], ['head_sha', 'b'.repeat(40)], ['head_branch', 'feature'],
  ['event', 'workflow_dispatch'], ['path', '.github/workflows/release-runtime.yml'], ['status', 'queued'],
  ['conclusion', 'failure'], ['repository', { id: 2, full_name: 'fork/app-sdk' }]]) {
  test(`rejects CI ${field} mismatch before artifact download`, async () => {
    const f = fixture(); f.ci[field] = value;
    await assert.rejects(f.run(), /CI identity/);
    assert.ok(!f.calls.some(path => path.endsWith('/zip')));
  });
}

test('requires an exact successful main License Gate before reading artifacts', async () => {
  for (const [field, value] of [['head_sha', 'b'.repeat(40)], ['head_branch', 'other'], ['event', 'workflow_dispatch'],
    ['path', '.github/workflows/other.yml'], ['conclusion', 'failure'], ['status', 'in_progress']]) {
    const f = fixture(); f.license[field] = value;
    await assert.rejects(f.run(), /License Gate/);
    assert.ok(!f.calls.some(path => path.includes('/artifacts')));
  }
});

test('rejects expired, missing, duplicate, foreign-run/source/repository and unpinned artifacts before download', async () => {
  for (const mutate of [f => { f.artifacts[0].expired = true; }, f => f.artifacts.splice(0),
    f => f.artifacts.push(f.artifacts[0]), f => { f.artifacts[0].workflow_run.id = 999; },
    f => { f.artifacts[0].workflow_run.head_sha = 'b'.repeat(40); },
    f => { f.artifacts[0].workflow_run.repository_id = 2; }, f => { f.artifacts[0].digest = `sha256:${'0'.repeat(64)}`; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.run(), /artifact/);
    assert.ok(!f.calls.some(path => path.endsWith('/zip')));
  }
});

test('checks the downloaded archive hash before parsing and package hash before tar inspection', async () => {
  const first = fixture(); first.args.expectedArchiveSha256 = '0'.repeat(64); first.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(first.run(), /downloaded archive SHA256/);
  const second = fixture(); second.args.expectedPackageSha256 = '0'.repeat(64);
  await assert.rejects(second.run(), /package SHA256/);
});

test('rejects extra ZIP entries and unsafe candidate names', async () => {
  const extra = fixture(); extra.rebuild({ 'extra.txt': Buffer.from('extra') });
  await assert.rejects(extra.run(), /exactly one/);
  for (const name of ['../escape.tgz', 'nested/file.tgz', 'file\\evil.tgz', 'payload.txt']) {
    const f = fixture(); f.setZip(zipSync({ [name]: Buffer.from('bad') }));
    await assert.rejects(f.run(), /filename/);
  }
});

test('rejects ZIP directories and symlinks before decompression', async () => {
  for (const attributes of [0x10, (0o120644 << 16) >>> 0]) {
    const f = fixture(); const bytes = zipSync({ 'payload.tgz': Buffer.from('bad') });
    const copy = Buffer.from(bytes);
    const directory = copy.readUInt32LE(copy.length - 6);
    copy.writeUInt32LE(attributes, directory + 38);
    f.setZip(copy);
    await assert.rejects(f.run(), /file type/);
  }
});

test('rejects oversized declared ZIP entries without allocating expanded payload', async () => {
  const f = fixture(); const bytes = Buffer.from(zipSync({ 'payload.tgz': Buffer.from('bad') }));
  const directory = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt32LE(100 * 1024 * 1024 + 1, directory + 24);
  f.setZip(bytes);
  await assert.rejects(f.run(), /size/);
});

test('caps gzip expansion before parsing a decompression bomb', async () => {
  const f = fixture();
  const bytes = gzipSync(Buffer.alloc(100 * 1024 * 1024 + 1));
  f.setZip(zipSync({ 'payload.tgz': bytes }));
  f.args.expectedPackageSha256 = hash(bytes);
  await assert.rejects(f.run(), /larger|limit/i);
});

test('rejects oversized package metadata before JSON parsing', async () => {
  const f = fixture(); f.pkg.description = 'x'.repeat(64 * 1024); f.rebuild();
  await assert.rejects(f.run(), /package.json size/);
});

test('requires the fixed runtime identity, entrypoints, dependencies and native-free metadata', async () => {
  for (const mutate of [pkg => { pkg.name = '@bota.dev/react-native-app-sdk'; }, pkg => { pkg.version = '0.1.0-beta.1'; },
    pkg => { pkg.dependencies.buffer = '^6.0.3'; }, pkg => { pkg.dependencies['react-native'] = '*'; },
    pkg => { pkg.peerDependencies = {}; }, pkg => { pkg.codegenConfig = {}; }, pkg => { pkg['react-native'] = 'index.js'; },
    pkg => { pkg.optionalDependencies = {}; }, pkg => { pkg.bin = './evil.js'; },
    pkg => { pkg.scripts.postinstall = 'node evil.js'; }, pkg => { pkg.scripts.build = 'react-native codegen'; },
    pkg => { pkg.main = '../escape.js'; }, pkg => { pkg.exports['.'].default = './evil.js'; }]) {
    const f = fixture(); mutate(f.pkg); f.rebuild();
    await assert.rejects(f.run(), /candidate|metadata/);
  }
});

test('requires 47 regular notices and generated core in both runtime distributions', async () => {
  for (const path of ['package/THIRD_PARTY_NOTICES/0.txt', 'package/lib/commonjs/jsHost/generated/core.js',
    'package/lib/module/jsHost/generated/core.js']) {
    const f = fixture(); f.files.splice(f.files.findIndex(file => file[0] === path), 1); f.rebuild();
    await assert.rejects(f.run(), /notices|payload missing/);
  }
});

test('rejects traversal, duplicate names, links, native implementation and unexpected payload in tar', async () => {
  for (const entry of [['package/../escape', 'bad'], ['package/LICENSE', 'duplicate'],
    ['package/linked', 'target', 'SymbolicLink'], ['package/react-native.config.js', 'bad'],
    ['package/lib/commonjs/specs/NativeBotaDeviceSDK.js', 'native'], ['package/android/native.aar', 'native']]) {
    const f = fixture(); f.files.push(entry); f.rebuild();
    await assert.rejects(f.run(), /tar|payload|Codegen/);
  }
});

test('CLI refuses foreign, tag or push controllers before API access or output writes', () => {
  const output = resolve('target/react-native-runtime-release');
  const before = existsSync(output) ? readdirSync(output).sort() : null;
  for (const mismatch of [{ GITHUB_REPOSITORY: 'fork/app-sdk' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/tags/v0.1.0-beta.0' }]) {
    const result = spawnSync(process.execPath, ['tools/release/promote-runtime-ci.mjs'], { encoding: 'utf8',
      env: { ...process.env, RUNTIME_SOURCE_REVISION: source, RUNTIME_CANDIDATE_RUN_ID: '100',
        GITHUB_REPOSITORY: 'bota-dev/app-sdk', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: source, GH_TOKEN: '', ...mismatch } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /main workflow_dispatch context/);
  }
  assert.deepEqual(existsSync(output) ? readdirSync(output).sort() : null, before);
});
