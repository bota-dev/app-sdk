import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../tools/apple/build-xcframework.sh', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bota-apple-cargo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'sdk-version.toml': 'version = "2.0.0-beta.23"\n',
    'platforms/apple/Sources/BotaAppSDK/BotaAppSDK.swift': 'let current = "2.0.0-beta.23"\n',
    'bindings/device-sdk-ffi/include/bota_device_sdk.h': 'fixture header\n',
    'tools/apple/verify-reproducible-paths.sh': '#!/bin/sh\nset -eu\ntest -d "$(dirname "$0")/../../platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework"\n',
    'bin/rustup': '#!/bin/sh\nexit 0\n',
    'bin/cargo': `#!/bin/sh
set -eu
target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --target ]; then shift; target=$1; fi
  shift
done
printf '%s\\n' "$CARGO_TARGET_DIR|$target" >> "$APPLE_TEST_TRACE"
mkdir -p "$CARGO_TARGET_DIR/$target/release"
printf '%s\\n' archive > "$CARGO_TARGET_DIR/$target/release/libbota_device_sdk_ffi.a"
`,
    'bin/xcrun': `#!/bin/sh
set -eu
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = -output ]; then shift; mkdir -p "$(dirname "$1")"; printf archive > "$1"; exit; fi
  if [ "$1" != -create ]; then test -f "$1"; fi
  shift
done
exit 1
`,
    'bin/xcodebuild': `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = -output ]; then shift; mkdir -p "$1"; printf plist > "$1/Info.plist"; exit; fi
  if [ "$1" = -library ]; then shift; test -f "$1"; fi
  shift
done
exit 1
`,
  };
  files['bindings/device-sdk-ffi/bota_device_sdk.h.sha256'] = createHash('sha256').update(files['bindings/device-sdk-ffi/include/bota_device_sdk.h']).digest('hex') + '\n';
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), body, { mode: 0o755 });
  }
  await copyFile(source, join(root, 'tools/apple/build-xcframework.sh'));
  await mkdir(join(root, 'runner-temp'));
  const env = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME,
    APPLE_TEST_TRACE: join(root, 'calls'), GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'apple', RUNNER_TEMP: join(root, 'runner-temp') };
  const shared = join(env.RUNNER_TEMP, 'bota-apple-cargo-123-2-apple');
  return { root, env, shared, run(extra = {}) { return spawnSync('/bin/sh', [join(root, 'tools/apple/build-xcframework.sh')], { env: { ...env, ...extra }, encoding: 'utf8' }); } };
}

test('three same-job Apple producers validate all targets while preserving one Cargo build directory', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 3; n++) {
    const r = f.run({ BOTA_APPLE_CI_CARGO_TARGET_DIR: f.shared });
    assert.equal(r.status, 0, r.stderr);
  }
  const calls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n');
  assert.equal(calls.length, 15, 'all five target checks must still run per producer');
  assert.ok(calls.every(line => line.startsWith(f.shared + '|')));
  assert.equal((await readdir(f.shared)).length, 5, 'producer cleanup must retain shared Cargo outputs');
});

test('standalone builds retain fresh isolated directories and remove them after packaging', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) assert.equal(f.run().status, 0);
  const calls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n');
  const targets = [...new Set(calls.map(line => line.split('|')[0]))];
  assert.equal(targets.length, 2);
  for (const path of targets) await assert.rejects(readdir(path), { code: 'ENOENT' });
});

test('shared target opt-in refuses non-CI, wrong job/run/attempt and foreign paths before cargo', async t => {
  for (const extra of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_JOB: 'other' }, { GITHUB_RUN_ID: '124' },
    { GITHUB_RUN_ATTEMPT: '3' }, { RUNNER_TEMP: '' }, { BOTA_APPLE_CI_CARGO_TARGET_DIR: '/tmp/foreign-cargo' },
  ]) {
    const f = await fixture(t);
    const r = f.run({ BOTA_APPLE_CI_CARGO_TARGET_DIR: f.shared, ...extra });
    assert.notEqual(r.status, 0);
    await assert.rejects(readFile(join(f.root, 'calls')), { code: 'ENOENT' });
  }
});

test('real Cargo fingerprints reuse unchanged builds and recompile changed source/options', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bota-apple-cargo-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="apple-cache-input-fixture"\nversion="0.1.0"\nedition="2021"\n');
  await writeFile(join(root, 'src/main.rs'), 'fn main() { println!("first source"); }\n');
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'runner-temp'), RUSTFLAGS: '' };
  delete env.CARGO_ENCODED_RUSTFLAGS;
  assert.equal(spawnSync('cargo', ['generate-lockfile', '--offline'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  function build(extra = {}) {
    const result = spawnSync('cargo', ['build', '--offline', '--locked', '--release', '--message-format=json-render-diagnostics'],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.reason === 'compiler-artifact' && row.executable);
  }
  assert.equal(build().fresh, false);
  assert.equal(build().fresh, true);
  await writeFile(join(root, 'src/main.rs'), 'fn main() { println!("changed source"); }\n');
  const changed = build();
  assert.equal(changed.fresh, false);
  assert.equal(spawnSync(changed.executable, [], { encoding: 'utf8' }).stdout.trim(), 'changed source');
  assert.equal(build({ RUSTFLAGS: '--cfg ci_cache_option_changed' }).fresh, false);
});

test('Apple path guard rejects the selected Cargo directory outside the checkout', async t => {
  const f = await fixture(t);
  const shared = await mkdtemp(join(tmpdir(), 'bota-apple-external-cargo-'));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const guard = join(f.root, 'tools/apple/verify-reproducible-paths.sh');
  await copyFile(fileURLToPath(new URL('../tools/apple/verify-reproducible-paths.sh', import.meta.url)), guard);
  const archive = join(f.root, 'platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework/ios-arm64/libbota_device_sdk_ffi.a');
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, 'embedded generated-source path: ' + shared + '/build/output.rs');
  const env = { ...f.env, CARGO_TARGET_DIR: shared };
  const leaked = spawnSync('/bin/sh', [guard], { env, encoding: 'utf8' });
  assert.notEqual(leaked.status, 0, 'external compiler paths must not be admitted');
  assert.ok(leaked.stderr.includes(shared));
  const alias = join(f.root, 'cargo-alias');
  await symlink(shared, alias, 'dir');
  await writeFile(archive, 'canonical generated-source path: ' + await realpath(shared) + '/build/output.rs');
  assert.notEqual(spawnSync('/bin/sh', [guard], { env: { ...env, CARGO_TARGET_DIR: alias }, encoding: 'utf8' }).status, 0);
  await writeFile(archive, 'no machine-specific source path');
  assert.equal(spawnSync('/bin/sh', [guard], { env, encoding: 'utf8' }).status, 0);
});
