import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { Parser } from 'tar';

const repository = 'bota-dev/app-sdk';
const packageName = '@bota.dev/react-native-app-sdk-runtime';
const maximumBytes = 100 * 1024 * 1024;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.split('/').every(part =>
  /^[A-Za-z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..');
const validRun = (run, source, workflow) => run?.repository?.full_name === repository
  && Number.isSafeInteger(run.repository.id) && run.repository.id > 0 && run.head_sha === source
  && run.head_branch === 'main' && run.event === 'push'
  && run.path === `.github/workflows/${workflow}.yml`
  && run.status === 'completed' && run.conclusion === 'success';

async function licenseGate(api, source) {
  const result = await api(`actions/workflows/license-gate.yml/runs?head_sha=${source}&branch=main&event=push&status=success&per_page=100`);
  const run = result.workflow_runs?.find(value => validRun(value, source, 'license-gate'));
  assert.ok(run && Number.isSafeInteger(run.id) && run.id > 0, 'successful exact main License Gate required');
  return run.id;
}

// Check the central directory before fflate allocates any expanded file. One
// regular basename is the complete artifact contract; no ZIP64 or links.
function inspectZip(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= maximumBytes, 'ZIP size limit');
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  assert.ok(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'invalid ZIP directory');
  assert.ok(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1, 'ZIP must contain exactly one file');
  const offset = bytes.readUInt32LE(end + 16);
  const directorySize = bytes.readUInt32LE(end + 12);
  assert.ok(offset + directorySize === end && directorySize >= 46 && offset + 46 <= end
    && bytes.readUInt32LE(offset) === 0x02014b50, 'invalid ZIP directory bounds');
  const nameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  assert.equal(46 + nameLength + extraLength + commentLength, directorySize, 'extra ZIP entries');
  const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]*\.tgz$/, 'unsafe candidate filename');
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  const compressed = bytes.readUInt32LE(offset + 20);
  const expanded = bytes.readUInt32LE(offset + 24);
  const mode = bytes.readUInt32LE(offset + 38) >>> 16;
  assert.ok(!(flags & 1) && (method === 0 || method === 8) && bytes.readUInt16LE(offset + 34) === 0
    && (mode === 0 || (mode & 0xf000) === 0x8000) && !(bytes.readUInt32LE(offset + 38) & 0x10)
    && expanded > 0 && expanded <= maximumBytes && compressed <= maximumBytes, 'invalid ZIP file type or size');
  const local = bytes.readUInt32LE(offset + 42);
  assert.ok(local === 0 && local + 30 <= offset && bytes.readUInt32LE(local) === 0x04034b50,
    'invalid ZIP local entry');
  const localNameLength = bytes.readUInt16LE(local + 26);
  const localExtraLength = bytes.readUInt16LE(local + 28);
  assert.ok(bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method
    && bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') === name
    && local + 30 + localNameLength + localExtraLength + compressed <= offset, 'ZIP local identity mismatch');
  const dataEnd = local + 30 + localNameLength + localExtraLength + compressed;
  if (flags & 8) {
    const descriptor = dataEnd + (bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
    assert.ok(descriptor + 12 === offset && bytes.readUInt32LE(descriptor) === bytes.readUInt32LE(offset + 16)
      && bytes.readUInt32LE(descriptor + 4) === compressed && bytes.readUInt32LE(descriptor + 8) === expanded,
    'invalid ZIP data descriptor or extra payload');
  } else {
    assert.ok(dataEnd === offset && bytes.readUInt32LE(local + 14) === bytes.readUInt32LE(offset + 16)
      && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === expanded,
    'ZIP local size mismatch or extra payload');
  }
  const files = unzipSync(bytes, { filter: entry => {
    assert.ok(entry.name === name && entry.originalSize === expanded && entry.size === compressed, 'ZIP entry mismatch');
    return true;
  } });
  assert.deepEqual(Object.keys(files), [name], 'ZIP must contain only the candidate');
  assert.equal(files[name].length, expanded, 'ZIP expanded size mismatch');
  return { filename: name, packageBytes: Buffer.from(files[name]) };
}

async function inspectPackage(bytes, version) {
  assert.ok(bytes.length <= maximumBytes, 'candidate package size limit');
  const archive = gunzipSync(bytes, { maxOutputLength: maximumBytes });
  const paths = new Set();
  const regularFiles = new Set();
  let entries = 0;
  let total = 0;
  let manifest;
  await new Promise((resolvePromise, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 });
    parser.on('error', reject);
    parser.on('end', resolvePromise);
    parser.on('entry', entry => {
      try {
        const path = entry.path.replace(/\/$/, '');
        assert.ok(++entries <= 4096 && safePath(path) && (path.startsWith('package/') || (path === 'package' && entry.type === 'Directory'))
          && !paths.has(path), 'unsafe or duplicate tar entry');
        paths.add(path);
        assert.ok(entry.type === 'File' || entry.type === 'Directory', 'candidate tar must contain only regular files/directories');
        assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 16 * 1024 * 1024
          && (total += entry.size) <= maximumBytes, 'candidate tar entry size limit');
        if (entry.type === 'Directory') { entry.resume(); return; }
        assert.ok(entry.size > 0, 'empty candidate file');
        regularFiles.add(path);
        const name = path.slice(8);
        assert.ok(['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(name)
          || name.startsWith('THIRD_PARTY_NOTICES/')
          || (name.startsWith('lib/') && /(?:\.js|\.d\.ts|\/(?:package\.json|README\.md))$/.test(name)),
        `unexpected/native candidate payload: ${name}`);
        assert.ok(!/^lib\/(?:commonjs|module)\/specs\//.test(name), 'native Codegen implementation in candidate');
        if (name === 'package.json') {
          assert.ok(entry.size <= 64 * 1024, 'package.json size limit');
          const chunks = [];
          entry.on('data', chunk => chunks.push(chunk));
          entry.on('end', () => { manifest = Buffer.concat(chunks); });
        } else entry.resume();
      } catch (error) { parser.abort(error); reject(error); }
    });
    parser.end(archive);
  });
  assert.ok(manifest, 'candidate package.json required');
  const pkg = JSON.parse(manifest);
  assert.ok(pkg.name === packageName && pkg.version === version, 'candidate package identity mismatch');
  assert.deepEqual(pkg.dependencies, { buffer: '6.0.3', eventemitter3: '5.0.1' }, 'candidate dependencies mismatch');
  for (const field of ['react-native', 'codegenConfig', 'rnpm', 'peerDependencies', 'peerDependenciesMeta',
    'optionalDependencies', 'bundledDependencies', 'bundleDependencies', 'bin']) {
    assert.ok(!Object.hasOwn(pkg, field), `native or unexpected package metadata: ${field}`);
  }
  assert.equal(pkg.main, 'lib/commonjs/runtime.js', 'candidate main mismatch');
  assert.equal(pkg.module, 'lib/module/runtime.js', 'candidate module mismatch');
  assert.equal(pkg.types, 'lib/typescript/runtime.d.ts', 'candidate types mismatch');
  assert.deepEqual(pkg.exports, { '.': { types: './lib/typescript/runtime.d.ts', default: './lib/commonjs/runtime.js' },
    './package.json': './package.json' }, 'candidate exports mismatch');
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(typeof script === 'string' && !/^(?:preinstall|install|postinstall|prepare|prepack|postpack|prepublish|prepublishOnly|publish|postpublish)$/.test(name)
      && !/(?:autolink|codegen)/i.test(`${name} ${script}`)
      && !/(?:^|[\s;&|])(?:react-native|pod|gradle|cargo|xcode(?:build)?)(?:\s|$)/i.test(script), 'native or install lifecycle script in candidate');
  }
  const notices = [...regularFiles].filter(path => path.startsWith('package/THIRD_PARTY_NOTICES/'));
  assert.equal(notices.length, 47, 'candidate requires 47 third-party notices');
  for (const required of ['THIRD_PARTY_NOTICES.md', 'LICENSE', 'lib/commonjs/runtime.js', 'lib/module/runtime.js',
    'lib/typescript/runtime.d.ts', 'lib/commonjs/jsHost/generated/core.js', 'lib/module/jsHost/generated/core.js']) {
    assert.ok(regularFiles.has(`package/${required}`), `candidate required payload missing: ${required}`);
  }
  return { name: pkg.name, version: pkg.version, fileCount: entries };
}

// Read-only: validate every gate and bounded archive before the caller writes.
// There is no rebuilding, tag lookup, registry access or latest-run fallback.
export async function promoteRuntimeCandidate({ api, source, runId, expectedArchiveSha256, expectedPackageSha256, version }) {
  assert.match(source, shaPattern, 'invalid source revision');
  assert.ok(Number.isSafeInteger(runId) && runId > 0, 'invalid candidate run ID');
  assert.match(expectedArchiveSha256, digestPattern, 'invalid archive SHA256');
  assert.match(expectedPackageSha256, digestPattern, 'invalid package SHA256');
  assert.match(version, versionPattern, 'runtime requires strict 0.x.y-beta.n version');
  const ci = await api(`actions/runs/${runId}`);
  assert.ok(ci.id === runId && validRun(ci, source, 'ci'), 'CI identity or successful main conclusion mismatch');
  const licenseRunId = await licenseGate(api, source);
  const result = await api(`actions/runs/${runId}/artifacts?per_page=100`);
  assert.ok(Number.isSafeInteger(result.total_count) && result.total_count <= 100 && Array.isArray(result.artifacts)
    && result.artifacts.length === result.total_count, 'unexpected artifact pagination');
  const name = `react-native-runtime-ci-${source}`;
  const matches = result.artifacts.filter(artifact => artifact.name === name);
  assert.equal(matches.length, 1, `missing or ambiguous artifact ${name}`);
  const artifact = matches[0];
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.expired === false
    && artifact.digest === `sha256:${expectedArchiveSha256}` && artifact.workflow_run?.id === runId
    && artifact.workflow_run.head_sha === source && artifact.workflow_run.repository_id === ci.repository.id,
  'artifact identity, expiration or expected digest mismatch');
  const downloaded = await api(`actions/artifacts/${artifact.id}/zip`, true);
  assert.ok(downloaded instanceof Uint8Array && downloaded.length <= maximumBytes, 'ZIP size limit');
  const bytes = Buffer.from(downloaded);
  assert.equal(hash(bytes), expectedArchiveSha256, 'downloaded archive SHA256 mismatch');
  const candidate = inspectZip(bytes);
  assert.equal(hash(candidate.packageBytes), expectedPackageSha256, 'candidate package SHA256 mismatch');
  const identity = await inspectPackage(candidate.packageBytes, version);
  return { ...candidate, provenance: { schemaVersion: 1, repository, sourceRevision: source,
    ciRunId: runId, licenseRunId, artifact: { id: artifact.id, name, digest: artifact.digest },
    archiveSha256: expectedArchiveSha256, packageSha256: expectedPackageSha256, package: identity } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2, 'usage: node tools/release/promote-runtime-ci.mjs');
    const source = process.env.RUNTIME_SOURCE_REVISION;
    assert.match(source, shaPattern, 'invalid source revision');
    assert.match(process.env.RUNTIME_CANDIDATE_RUN_ID ?? '', /^[1-9]\d*$/, 'invalid candidate run ID');
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    if (process.env.GITHUB_REPOSITORY || process.env.GITHUB_EVENT_NAME || process.env.GITHUB_REF || process.env.GITHUB_SHA) {
      assert.ok(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        && process.env.GITHUB_REF === 'refs/heads/main', 'main workflow_dispatch context required');
      assert.match(process.env.GITHUB_SHA, shaPattern, 'invalid controller revision');
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
        process.env.GITHUB_SHA, 'controller checkout mismatch');
    }
    execFileSync('git', ['merge-base', '--is-ancestor', source, 'main'], { cwd: workspace, stdio: 'pipe' });
    assert.ok(process.env.GH_TOKEN, 'GitHub read token required');
    const api = async (path, binary = false) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, `GitHub read failed: HTTP ${response.status}`);
      if (!binary) return response.json();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        assert.ok((size += chunk.length) <= maximumBytes, 'ZIP download size limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    const controller = process.env.GITHUB_SHA;
    if (controller && controller !== source) {
      const runs = await api(`actions/workflows/ci.yml/runs?head_sha=${controller}&branch=main&event=push&status=success&per_page=100`);
      assert.ok(runs.workflow_runs?.some(run => validRun(run, controller, 'ci')), 'successful exact main controller CI required');
      await licenseGate(api, controller);
    }
    const result = await promoteRuntimeCandidate({ api, source, runId: Number(process.env.RUNTIME_CANDIDATE_RUN_ID),
      expectedArchiveSha256: process.env.RUNTIME_ARCHIVE_SHA256, expectedPackageSha256: process.env.RUNTIME_PACKAGE_SHA256,
      version: process.env.RUNTIME_VERSION });
    const output = resolve(workspace, 'target/react-native-runtime-release');
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, result.filename), result.packageBytes, { flag: 'wx' });
    await writeFile(resolve(output, 'runtime-promotion.json'), `${JSON.stringify(result.provenance, null, 2)}\n`, { flag: 'wx' });
    const summary = `Runtime candidate ready: ${result.provenance.package.name}@${result.provenance.package.version}, `
      + `[CI run ${result.provenance.ciRunId}](https://github.com/${repository}/actions/runs/${result.provenance.ciRunId}), `
      + `source \`${source}\`, package SHA256 \`${result.provenance.packageSha256}\`. Publication has not started.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `package-filename=${result.filename}\n`);
    console.log(summary);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
