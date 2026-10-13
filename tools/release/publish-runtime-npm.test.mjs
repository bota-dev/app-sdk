import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { publishExactRuntimeNpmArtifact } from './publish-runtime-npm.mjs';

const name = '@bota.dev/react-native-app-sdk-runtime';
const version = '0.1.0-beta.0';
const protectedNames = ['@bota.dev/react-native-app-sdk', '@bota.dev/web-app-sdk',
  '@bota.dev/react-native-sdk', '@bota.dev/web-sdk'];
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

function archive(metadata, duplicate = false) {
  const body = Buffer.from(JSON.stringify(metadata));
  const header = new Header({ path: 'package/package.json', type: 'File', size: body.length, mode: 0o644 });
  header.encode();
  const entry = Buffer.concat([header.block, body, Buffer.alloc((512 - body.length % 512) % 512)]);
  return gzipSync(Buffer.concat([entry, ...(duplicate ? [entry] : []), Buffer.alloc(1024)]));
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bota-runtime-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = archive(options.metadata ?? { name, version }, options.duplicate);
  const tarball = join(directory, 'runtime.tgz');
  writeFileSync(tarball, bytes);
  const state = { published: options.existing ?? false, publishes: 0, sleeps: 0,
    versionReads: 0, tagReads: 0, downloadReads: 0, calls: [] };
  const namespaceExists = options.namespaceExists ?? options.existing ?? false;
  const beforeTags = options.beforeTags ?? { beta: version, latest: version };
  const dist = { shasum: hash(bytes, 'sha1'), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
    tarball: `https://registry.npmjs.org/${name}/-/react-native-app-sdk-runtime-${version}.tgz` };
  return {
    state, bytes, dist,
    args: {
      mode: options.mode ?? 'publish', version, tarball, expectedSha256: hash(bytes),
      maxAttempts: 3, sleep: async ms => { assert.equal(ms, 10_000); state.sleeps++; },
      publish: async path => {
        assert.equal(path, tarball);
        state.publishes++; state.published = true;
        if (options.publishError) throw new Error('uncertain upload');
      },
      fetchImpl: async url => {
        const path = decodeURIComponent(new URL(url).pathname.slice(1));
        state.calls.push(path);
        if (protectedNames.includes(path)) {
          const tags = { latest: 'old-stable', beta: 'old-beta', custom: 'retained' };
          if (options.drift === path && state.publishes) tags.custom = 'changed';
          return Response.json({ 'dist-tags': tags });
        }
        if (path === name) {
          const before = state.tagReads++ === 0;
          if (before) return namespaceExists ? Response.json({ 'dist-tags': beforeTags }) : new Response('', { status: 404 });
          if (!state.published) return new Response('', { status: 404 });
          const tags = namespaceExists ? { ...beforeTags } : {};
          if (options.initialLatest !== undefined) tags.latest = options.initialLatest;
          if (options.latestDrift) tags.latest = '0.9.0-beta.0';
          tags.beta = state.tagReads <= (options.tagDelay ?? 0) + 1 ? '0.0.9-beta.0' : version;
          return Response.json({ 'dist-tags': tags });
        }
        if (path === `${name}/${version}`) {
          if (options.lookupError) return new Response('', { status: options.lookupError });
          if (!state.published || state.versionReads++ < (options.versionDelay ?? 0)) return new Response('', { status: 404 });
          return Response.json({ name, version, dist: { ...dist, ...options.dist }, ...options.registryMetadata });
        }
        assert.equal(path, `${name}/-/react-native-app-sdk-runtime-${version}.tgz`);
        state.downloadReads++;
        if (options.downloadError) return new Response('', { status: options.downloadError });
        if (state.downloadReads <= (options.downloadDelay ?? 0)) return new Response('', { status: 404 });
        return new Response(options.downloadBytes ?? bytes);
      },
    },
  };
}

test('confirmed absent version publishes once and verifies hashes, public bytes and all existing tags', async t => {
  const f = fixture(t);
  const result = await publishExactRuntimeNpmArtifact(f.args);
  assert.equal(f.state.publishes, 1);
  assert.equal(result.sha256, f.args.expectedSha256);
  assert.equal(result.sha1, f.dist.shasum);
  assert.equal(result.integrity, f.dist.integrity);
  for (const packageName of protectedNames) assert.equal(f.state.calls.filter(path => path === packageName).length, 2);
});

test('initially absent namespace may have no latest or exactly the first candidate latest', async t => {
  for (const initialLatest of [undefined, version]) {
    const f = fixture(t, { initialLatest });
    await publishExactRuntimeNpmArtifact(f.args);
    assert.equal(f.state.publishes, 1);
  }
  const invalid = fixture(t, { initialLatest: '0.1.0-beta.1' });
  await assert.rejects(publishExactRuntimeNpmArtifact(invalid.args), /latest/);
});

test('an existing namespace preserves latest including its absence', async t => {
  for (const beforeTags of [{ beta: '0.0.9-beta.0' }, { latest: '0.0.9-beta.0', beta: '0.0.9-beta.0' }]) {
    const f = fixture(t, { namespaceExists: true, beforeTags });
    await publishExactRuntimeNpmArtifact(f.args);
  }
  const drift = fixture(t, { namespaceExists: true, beforeTags: {}, initialLatest: version });
  await assert.rejects(publishExactRuntimeNpmArtifact(drift.args), /latest/);
});

test('occupied exact version is verified without another upload in both modes', async t => {
  for (const mode of ['publish', 'verify']) {
    const f = fixture(t, { mode, existing: true });
    await publishExactRuntimeNpmArtifact(f.args);
    assert.equal(f.state.publishes, 0);
  }
});

test('verify mode never uploads a missing version', async t => {
  const f = fixture(t, { mode: 'verify' });
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /not published/);
  assert.equal(f.state.publishes, 0);
  assert.equal(f.state.sleeps, 2);
});

test('wrong local hash, archive identity or duplicate package.json fail before registry access', async t => {
  for (const options of [{ metadata: { name: '@other/package', version } },
    { metadata: { name, version: '0.1.0-beta.1' } }, { duplicate: true }, {}]) {
    const f = fixture(t, options);
    if (Object.keys(options).length === 0) f.args.expectedSha256 = 'a'.repeat(64);
    f.args.fetchImpl = async () => assert.fail('must validate local artifact first');
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /identity|package.json|SHA-256/);
    assert.equal(f.state.publishes, 0);
  }
});

test('only canonical 0.x.y-beta.n versions and valid modes/hashes/retry bounds are accepted', async t => {
  for (const invalidVersion of ['0.1.0', '1.0.0-beta.0', '2.0.0-beta.15', '0.01.0-beta.0', '0.1.0-beta.01',
    '0.1.0-alpha.0', '0.1.0-beta.0+build', '0.1.0-beta.0\n']) {
    const f = fixture(t); f.args.version = invalidVersion;
    f.args.fetchImpl = async () => assert.fail('invalid version must not access registry');
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /version/);
  }
  for (const override of [{ mode: 'recovery' }, { expectedSha256: 'bad' }, { maxAttempts: 0 }, { maxAttempts: 31 }]) {
    const f = fixture(t); Object.assign(f.args, override);
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /mode|SHA-256|attempts/);
  }
});

test('occupied SHA-1 and SHA-512 mismatches fail without publication', async t => {
  for (const dist of [{ shasum: 'a'.repeat(40) }, { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    { integrity: undefined }]) {
    const f = fixture(t, { existing: true, dist });
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /checksum/);
    assert.equal(f.state.publishes, 0);
  }
});

test('registry errors and network failures do not authorize upload', async t => {
  for (const lookupError of [401, 403, 429, 500]) {
    const f = fixture(t, { lookupError });
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /HTTP/);
    assert.equal(f.state.publishes, 0);
  }
  const network = fixture(t);
  const fetchImpl = network.args.fetchImpl;
  network.args.fetchImpl = async url => {
    if (decodeURIComponent(new URL(url).pathname.slice(1)) === `${name}/${version}`) throw new Error('network failed');
    return fetchImpl(url);
  };
  await assert.rejects(publishExactRuntimeNpmArtifact(network.args), /network failed/);
  assert.equal(network.state.publishes, 0);
});

test('HTTP 200 null or invalid registry metadata never counts as a missing version', async t => {
  for (const metadata of [null, false, 0, [], 'missing']) {
    const f = fixture(t);
    const fetchImpl = f.args.fetchImpl;
    f.args.fetchImpl = async url => decodeURIComponent(new URL(url).pathname.slice(1)) === `${name}/${version}`
      ? Response.json(metadata) : fetchImpl(url);
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /invalid npm registry metadata/);
    assert.equal(f.state.publishes, 0);
  }
});

test('occupied registry identity must match and candidate changes before upload stop publication', async t => {
  for (const registryMetadata of [{ name: '@other/package' }, { version: '0.1.0-beta.1' }]) {
    const f = fixture(t, { existing: true, registryMetadata });
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /identity/);
    assert.equal(f.state.publishes, 0);
  }
  const f = fixture(t);
  const fetchImpl = f.args.fetchImpl;
  f.args.fetchImpl = async url => {
    if (decodeURIComponent(new URL(url).pathname.slice(1)) === `${name}/${version}`) writeFileSync(f.args.tarball, 'changed candidate');
    return fetchImpl(url);
  };
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /SHA-256 changed/);
  assert.equal(f.state.publishes, 0);
});

test('independently delayed version, archive and beta visibility settle without republishing', async t => {
  const f = fixture(t, { versionDelay: 2, downloadDelay: 2, tagDelay: 2 });
  await publishExactRuntimeNpmArtifact(f.args);
  assert.equal(f.state.publishes, 1);
  assert.equal(f.state.sleeps, 6);
});

test('visibility budgets exhaust and latest drift fails immediately', async t => {
  for (const options of [{ versionDelay: 3 }, { downloadDelay: 3 }, { tagDelay: 3 }]) {
    const f = fixture(t, options);
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /bounded retries/);
    assert.equal(f.state.publishes, 1);
    assert.equal(f.state.sleeps, 2);
  }
  const f = fixture(t, { latestDrift: true });
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /latest/);
  assert.equal(f.state.sleeps, 0);
});

test('public bytes must match candidate SHA-256 even if version checksums claim a match', async t => {
  const f = fixture(t, { existing: true, downloadBytes: Buffer.from('different bytes') });
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /public.*SHA-256/);
  assert.equal(f.state.publishes, 0);
});

test('unsafe tarball URLs and download hard failures stop verification', async t => {
  for (const dist of [{ tarball: 'https://evil.example/runtime.tgz' },
    { tarball: `http://registry.npmjs.org/${name}/-/react-native-app-sdk-runtime-${version}.tgz` }]) {
    const f = fixture(t, { existing: true, dist });
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /tarball URL/);
    assert.equal(f.state.downloadReads, 0);
  }
  const f = fixture(t, { existing: true, downloadError: 500 });
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /HTTP/);
});

test('all four protected packages are checked after successful and uncertain uploads', async t => {
  for (const drift of protectedNames) for (const publishError of [false, true]) {
    const f = fixture(t, { drift, publishError });
    await assert.rejects(publishExactRuntimeNpmArtifact(f.args), publishError ? /uncertain upload.*dist-tags/s : /dist-tags/);
    for (const packageName of protectedNames) assert.equal(f.state.calls.filter(path => path === packageName).length, 2);
  }
});

test('uncertain upload and latest drift are both reported without a second upload', async t => {
  const f = fixture(t, { publishError: true, latestDrift: true });
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /uncertain upload.*latest/s);
  assert.equal(f.state.publishes, 1);
});

test('a beta tag changed after successful visibility fails final verification', async t => {
  const f = fixture(t, { existing: true });
  const fetchImpl = f.args.fetchImpl;
  let tagReads = 0;
  f.args.fetchImpl = async url => {
    const response = await fetchImpl(url);
    if (decodeURIComponent(new URL(url).pathname.slice(1)) === name && ++tagReads === 3) {
      return Response.json({ 'dist-tags': { latest: version, beta: '0.1.0-beta.1' } });
    }
    return response;
  };
  await assert.rejects(publishExactRuntimeNpmArtifact(f.args), /beta tag changed/);
  assert.equal(f.state.publishes, 0);
});
