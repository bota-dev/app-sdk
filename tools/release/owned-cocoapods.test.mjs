import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalPodspec, stageOwnedPodspec, verifyOwnedPodspec } from './owned-cocoapods.mjs';

const version = '2.0.0-beta.22';
const checksum = '1'.repeat(64);
const spec = () => ({ name: 'BotaAppSDK', version, summary: 'Bota SDK',
  source: { http: `https://github.com/bota-dev/app-sdk/releases/download/v${version}/BotaAppSDK.cocoapods.zip`, sha256: checksum },
  platforms: { ios: '15.0', osx: '13.0' } });
const options = () => ({ spec: spec(), sdkVersion: version, artifactChecksum: checksum });

test('owned index preserves the entire spec with deterministic object ordering', () => {
  const canonical = canonicalPodspec(options());
  assert.deepEqual(JSON.parse(canonical), spec());
  assert.equal(canonical, canonicalPodspec({ ...options(), spec: Object.fromEntries(Object.entries(spec()).reverse()) }));
  for (const change of [ { name: 'OtherSDK' }, { version: '2.0.0-beta.21' },
    { source: { ...spec().source, sha256: '2'.repeat(64) } },
    { source: { ...spec().source, http: 'https://example.invalid/sdk.zip' } },
    { prepare_command: 'echo unexpected' }, { script_phases: [{ script: 'echo unexpected' }] },
    { subspecs: [{ name: 'Unsafe', prepare_command: 'echo unexpected' }] } ]) {
    assert.throws(() => canonicalPodspec({ ...options(), spec: { ...spec(), ...change } }));
  }
  assert.throws(() => canonicalPodspec({ ...options(), sdkVersion: '../other' }));
  assert.throws(() => canonicalPodspec({ ...options(), artifactChecksum: '0'.repeat(64) }));
});

test('publication creates one version and refuses every occupied-byte replacement', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'bota-specs-test-'));
  try {
    const first = await stageOwnedPodspec({ ...options(), checkout });
    assert.equal(first.created, true);
    assert.equal(first.path, `Specs/BotaAppSDK/${version}/BotaAppSDK.podspec.json`);
    const original = await readFile(join(checkout, first.path), 'utf8');
    assert.equal((await stageOwnedPodspec({ ...options(), checkout })).created, false);
    await assert.rejects(stageOwnedPodspec({ ...options(), checkout, spec: { ...spec(), summary: 'Changed' } }), /occupied/);
    assert.equal(await readFile(join(checkout, first.path), 'utf8'), original);
    await writeFile(join(checkout, first.path), '{}\n');
    await assert.rejects(stageOwnedPodspec({ ...options(), checkout }), /occupied/);
    assert.equal(await readFile(join(checkout, first.path), 'utf8'), '{}\n');
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('index staging refuses symlink traversal before touching an outside directory', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'bota-specs-link-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'bota-specs-outside-test-'));
  try {
    await mkdir(join(checkout, 'container'));
    await symlink(outside, join(checkout, 'Specs'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(stageOwnedPodspec({ ...options(), checkout }), /symlink/);
    await assert.rejects(readFile(join(outside, 'BotaAppSDK', version, 'BotaAppSDK.podspec.json')));
  } finally { await rm(checkout, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('public verification requires exact canonical bytes and rejects lookup uncertainty', async () => {
  const expected = canonicalPodspec(options());
  const request = async (url, init) => {
    assert.equal(url, `https://raw.githubusercontent.com/bota-dev/cocoapods-specs/main/Specs/BotaAppSDK/${version}/BotaAppSDK.podspec.json`);
    assert.equal(init.redirect, 'error');
    return new Response(expected);
  };
  assert.equal((await verifyOwnedPodspec({ ...options(), fetchImpl: request })).sha256.length, 64);
  for (const status of [404, 403, 429, 500]) {
    await assert.rejects(verifyOwnedPodspec({ ...options(), fetchImpl: async () => new Response('', { status }) }));
  }
  for (const body of ['{}', expected.replace('Bota SDK', 'Other SDK'), 'x'.repeat(65537)]) {
    await assert.rejects(verifyOwnedPodspec({ ...options(), fetchImpl: async () => new Response(body) }));
  }
});

test('new release keeps protected approval and immutable inputs while replacing Trunk with the owned index', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/publish-apple-pod.yml', import.meta.url), 'utf8');
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /generate-public-podspec.mjs/);
  assert.ok(workflow.indexOf('--check') < workflow.indexOf('tools/release/publish-owned-cocoapods.sh'));
  assert.match(workflow, /BOTA_COCOAPODS_SPECS_TOKEN/);
  assert.doesNotMatch(workflow, /pod trunk push|COCOAPODS_TRUNK_TOKEN|trunk.cocoapods.org/);
  const publisher = await readFile(new URL('./publish-owned-cocoapods.sh', import.meta.url), 'utf8');
  assert.match(publisher, /http.followRedirects=false/);
  assert.match(publisher, /credential.helper=!gh auth git-credential/);
  assert.match(publisher, /https:\/\/github.com\/bota-dev\/cocoapods-specs.git/);
  assert.match(publisher, /owned-specs-pull-request.mjs/);
  assert.doesNotMatch(publisher, /HEAD:refs\/heads\/main/);
  const commands = publisher.split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(commands, /push[^\n]*--force|ssh-keyscan|git[^\n]*rebase/);
  const release = (await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const publish = release.slice(release.indexOf('  publish:\n'), release.indexOf('  publish-apple-pod:\n'));
  assert.ok(publish.indexOf('test -n "$BOTA_COCOAPODS_SPECS_TOKEN"') > 0);
  assert.ok(publish.indexOf('test -n "$BOTA_COCOAPODS_SPECS_TOKEN"') < publish.indexOf('Check out tagged source'));
  const start = release.indexOf('  flutter:\n');
  const end = release.indexOf('  publish-flutter:\n', start);
  const flutter = release.slice(start, end);
  assert.ok(flutter.indexOf('test-public-cocoapods-consumer.sh') > flutter.indexOf('test "$CURRENT_FLUTTER" = "$EXPECTED_FLUTTER"'));
  assert.match(flutter, /--plugin-archive/);
  assert.match(flutter, /--plugin-inventory/);
});
