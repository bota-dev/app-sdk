import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { canonicalJson, validateSpec, validateIndex, validateChanges } from './validate-owned-specs.mjs';

const version = '2.0.0-beta.22';
const path = `Specs/BotaAppSDK/${version}/BotaAppSDK.podspec.json`;
const spec = (changes = {}) => ({ name: 'BotaAppSDK', module_name: 'BotaAppSDK', version,
  license: { type: 'Apache-2.0' }, source: { http: `https://github.com/bota-dev/app-sdk/releases/download/v${version}/BotaAppSDK.cocoapods.zip`, sha256: '1'.repeat(64) }, ...changes });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bota-spec-index-'));
  const owned = resolve(root);
  assert.ok(owned.startsWith(`${resolve(tmpdir())}${sep}`) && basename(owned).startsWith('bota-spec-index-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  return root;
}
const runGit = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function put(root, file = path, value = spec()) {
  const target = join(root, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(value));
}
function commit(root) {
  runGit(root, 'add', '--all');
  runGit(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic metadata fixture');
  return runGit(root, 'rev-parse', 'HEAD');
}

test('accepts canonical metadata and explicitly reports an empty index', async t => {
  const root = await fixture(t);
  assert.deepEqual(await validateIndex(root), { count: 0 });
  assert.equal(validateSpec(path, canonicalJson(spec())).name, 'BotaAppSDK');
  await put(root);
  assert.deepEqual(await validateIndex(root), { count: 1 });
});

test('refuses wrong public identity, version path and unsafe semantic versions', () => {
  for (const changed of [spec({ name: 'Other' }), spec({ module_name: 'Other' }), spec({ version: '2.0.0-beta.23' })]) {
    assert.throws(() => validateSpec(path, canonicalJson(changed)));
  }
  for (const invalid of ['../../outside', 'v2.0.0', '02.0.0', '2.0.0-beta..1', '2.0.0-beta.01', '2.0.0+build', '3.0.0']) {
    assert.throws(() => validateSpec(`Specs/BotaAppSDK/${invalid}/BotaAppSDK.podspec.json`, canonicalJson(spec({ version: invalid }))));
  }
  assert.throws(() => validateSpec(path.replaceAll('BotaAppSDK', 'BotaAppleSDK'), canonicalJson(spec({ name: 'BotaAppleSDK', module_name: 'BotaAppleSDK' }))));
});

test('refuses mutable or foreign archives, missing/zero digests and license changes', () => {
  for (const source of [
    { ...spec().source, http: 'https://github.com/bota-dev/app-sdk/archive/main.zip' },
    { ...spec().source, http: spec().source.http.replace('github.com', 'github.example') },
    { ...spec().source, http: spec().source.http.replace('beta.22', 'beta.23') },
    { ...spec().source, sha256: '' }, { ...spec().source, sha256: '0'.repeat(64) },
    { ...spec().source, sha256: 'A'.repeat(64) }, { ...spec().source, git: 'https://example.invalid' },
  ]) assert.throws(() => validateSpec(path, canonicalJson(spec({ source }))));
  assert.throws(() => validateSpec(path, canonicalJson(spec({ license: { type: 'GPL-3.0' } }))));
});

test('refuses scripts, arbitrary build commands and noncanonical JSON', () => {
  for (const field of ['prepare_command', 'script_phase', 'script_phases']) {
    assert.throws(() => validateSpec(path, canonicalJson(spec({ [field]: 'do-not-run' }))));
  }
  assert.throws(() => validateSpec(path, canonicalJson(spec({ pod_target_xcconfig: { OTHER_SWIFT_FLAGS: 'unreviewed' } }))));
  assert.throws(() => validateSpec(path, JSON.stringify(spec())));
  assert.throws(() => validateSpec(path, `${canonicalJson(spec())}\n`));
  assert.throws(() => validateSpec(path, '{ invalid JSON }'));
});

test('rejects unexpected files and symlinks rather than following them', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'Specs'));
  await writeFile(join(root, 'Specs', 'unreviewed.rb'), 'raise "must not execute"');
  await assert.rejects(validateIndex(root), /unexpected index path/);
  await rm(join(root, 'Specs', 'unreviewed.rb'));
  const outside = await fixture(t);
  await symlink(outside, join(root, 'Specs', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateIndex(root), /symlinks/);
});

test('limits validation to the index while allowing the SDK source tree and platform Podspecs', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'platforms/apple'), { recursive: true });
  await writeFile(join(root, 'platforms/apple/BotaAppSDK.podspec'), 'raise "must not execute"');
  await writeFile(join(root, 'Package.swift'), '// SDK source remains outside index validation');
  assert.deepEqual(await validateIndex(root), { count: 0 });
  await put(root);
  assert.deepEqual(await validateIndex(root), { count: 1 });
});

test('Git admission allows only new version entries after the exact base', async t => {
  const root = await fixture(t);
  runGit(root, 'init', '--initial-branch=main');
  await put(root);
  const before = commit(root);
  assert.deepEqual(validateChanges(root, '0'.repeat(40)), { added: 1 });
  runGit(root, 'update-ref', 'refs/remotes/origin/main', before);
  const nextVersion = '2.0.0-beta.23';
  await put(root, path.replaceAll(version, nextVersion), spec({ version: nextVersion,
    source: { ...spec().source, http: spec().source.http.replaceAll(version, nextVersion) } }));
  commit(root);
  assert.deepEqual(validateChanges(root, before), { added: 1 });
  assert.deepEqual(validateChanges(root, ''), { added: 1 });
  assert.deepEqual(validateChanges(root, '0'.repeat(40)), { added: 1 });
  assert.throws(() => validateChanges(root, '--all'));
});

test('a new branch zero before SHA cannot hide an earlier occupied-version edit', async t => {
  const root = await fixture(t);
  runGit(root, 'init', '--initial-branch=main');
  await put(root);
  const main = commit(root);
  runGit(root, 'update-ref', 'refs/remotes/origin/main', main);
  await put(root, path, spec({ source: { ...spec().source, sha256: '2'.repeat(64) } }));
  commit(root);
  const next = '2.0.0-beta.23';
  await put(root, path.replaceAll(version, next), spec({ version: next, source: { ...spec().source, http: spec().source.http.replaceAll(version, next) } }));
  commit(root);
  assert.throws(() => validateChanges(root, '0'.repeat(40)), /immutable Specs entry/);
});

test('Git admission refuses editing, deleting or renaming an occupied version', async t => {
  for (const action of ['modify', 'delete', 'rename']) {
    await t.test(action, async child => {
      const root = await fixture(child);
      runGit(root, 'init', '--initial-branch=main');
      await put(root);
      const before = commit(root);
      if (action === 'modify') await put(root, path, spec({ source: { ...spec().source, sha256: '2'.repeat(64) } }));
      else {
        await rm(join(root, path));
        if (action === 'rename') await put(root, path.replaceAll(version, '2.0.0-beta.23'), spec({ version: '2.0.0-beta.23', source: { ...spec().source, http: spec().source.http.replaceAll(version, '2.0.0-beta.23') } }));
      }
      commit(root);
      assert.throws(() => validateChanges(root, before), /immutable Specs entry/);
    });
  }
});

test('Git admission refuses dirty Specs and unrelated base history', async t => {
  const root = await fixture(t);
  runGit(root, 'init', '--initial-branch=main');
  await put(root);
  const before = commit(root);
  await put(root, path, spec({ source: { ...spec().source, sha256: '2'.repeat(64) } }));
  assert.throws(() => validateChanges(root, before), /committed source/);
  commit(root);
  assert.throws(() => validateChanges(root, 'f'.repeat(40)));
});
