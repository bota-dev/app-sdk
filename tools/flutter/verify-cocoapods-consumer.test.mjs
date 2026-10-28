import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyCocoaPodsConsumer } from './verify-cocoapods-consumer.mjs';

const repository = 'https://github.com/bota-dev/app-sdk.git';
const name = 'BotaAppSDK';
const version = '2.0.0-beta.22';
const checksum = 'a'.repeat(64);
const indexCommit = 'd'.repeat(40);
const candidateRef = 'codex/cocoapods-owned-specs-20261028';
const fixture = () => {
  const expectedSpec = {
    name, version, module_name: name,
    source: { http: `https://github.com/bota-dev/app-sdk/releases/download/v${version}/${name}.cocoapods.zip`, sha256: checksum },
    source_files: `Sources/${name}/**/*.swift`,
    vendored_frameworks: 'Artifacts/BotaDeviceSDKCore.xcframework',
  };
  const input = {
    repository, version, expectedSpec, installedSpec: structuredClone(expectedSpec),
    expectedSpecChecksum: 'b'.repeat(40),
    indexSelection: {},
    indexState: { commit: indexCommit, ref: 'main', mainCommit: indexCommit, defaultRef: 'origin/main' },
    lock: {
      PODS: [`${name} (${version})`],
      DEPENDENCIES: [`${name} (= ${version})`],
      'SPEC REPOS': { [repository]: [name], trunk: ['OtherPod'] },
      'SPEC CHECKSUMS': { [name]: 'b'.repeat(40) },
      COCOAPODS: '1.16.2',
    },
  };
  input.installedManifest = structuredClone(input.lock);
  input.installedSdkPresent = true;
  return input;
};

test('admits the exact named/versioned SDK only from the selected Specs repository', () => {
  assert.deepEqual(verifyCocoaPodsConsumer(fixture()), {
    name, version, repository, artifactUrl: fixture().expectedSpec.source.http,
    artifactSha256: checksum, cocoapodsVersion: '1.16.2', specificationStorage: 'sandbox',
    indexCommit, indexRef: 'main', indexMode: 'default-main', defaultMain: true,
  });
});

test('reports a verified default main index rather than an unlabeled repository URL', () => {
  const result = verifyCocoaPodsConsumer(fixture());
  assert.equal(result.indexCommit, indexCommit);
  assert.equal(result.indexRef, 'main');
  assert.equal(result.indexMode, 'default-main');
  assert.equal(result.defaultMain, true);
});

test('default-main qualification refuses missing, detached, non-main or stale index state', () => {
  for (const change of [
    input => { delete input.indexState; },
    input => { input.indexState.ref = candidateRef; },
    input => { input.indexState.ref = '<detached>'; },
    input => { input.indexState.defaultRef = 'origin/other'; },
    input => { input.indexState.mainCommit = 'e'.repeat(40); },
    input => { input.indexState.commit = '0'.repeat(40); },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => verifyCocoaPodsConsumer(input), /index/);
  }
});

test('candidate qualification requires both the exact branch and post-install commit and never claims main', () => {
  const input = fixture();
  input.indexSelection = { ref: candidateRef, sha: indexCommit };
  input.indexState = { commit: indexCommit, ref: candidateRef };
  const result = verifyCocoaPodsConsumer(input);
  assert.equal(result.indexCommit, indexCommit);
  assert.equal(result.indexRef, candidateRef);
  assert.equal(result.indexMode, 'candidate');
  assert.equal(result.defaultMain, false);
  for (const change of [
    state => { state.commit = 'e'.repeat(40); },
    state => { state.ref = 'main'; },
    state => { state.ref = '<detached>'; },
  ]) {
    const changed = structuredClone(input);
    change(changed.indexState);
    assert.throws(() => verifyCocoaPodsConsumer(changed), /index/);
  }
});

test('invalid candidate environment pairs fail before repository discovery or CocoaPods', () => {
  const helper = fileURLToPath(new URL('./verify-cocoapods-consumer.mjs', import.meta.url));
  const environment = { ...process.env };
  delete environment.BOTA_COCOAPODS_SPECS_REF;
  delete environment.BOTA_COCOAPODS_SPECS_SHA;
  for (const selection of [
    { BOTA_COCOAPODS_SPECS_REF: candidateRef },
    { BOTA_COCOAPODS_SPECS_SHA: indexCommit },
    { BOTA_COCOAPODS_SPECS_REF: '', BOTA_COCOAPODS_SPECS_SHA: '' },
    ...['--other', 'HEAD', 'bad..ref', 'bad//ref', '.hidden/ref', 'bad.lock', 'bad/ref.', 'bad ref', 'bad;command', 'bad@{1}']
      .map(ref => ({ BOTA_COCOAPODS_SPECS_REF: ref, BOTA_COCOAPODS_SPECS_SHA: indexCommit })),
    ...['0'.repeat(40), 'D'.repeat(40), 'd'.repeat(39), '../main']
      .map(sha => ({ BOTA_COCOAPODS_SPECS_REF: candidateRef, BOTA_COCOAPODS_SPECS_SHA: sha })),
  ]) {
    const result = spawnSync(process.execPath, [helper, '--repository-url'], {
      encoding: 'utf8', env: { ...environment, ...selection },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /candidate index/);
  }
  for (const selection of [{}, { BOTA_COCOAPODS_SPECS_REF: candidateRef, BOTA_COCOAPODS_SPECS_SHA: indexCommit }]) {
    const result = spawnSync(process.execPath, [helper, '--repository-url'], {
      encoding: 'utf8', env: { ...environment, ...selection },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('refuses successful installation from Trunk, another repository or ambiguous sources', () => {
  for (const repos of [
    { trunk: [name] },
    { 'https://example.invalid/Specs.git': [name] },
    { [repository]: ['OtherPod'], trunk: [name] },
    { [repository]: [name], trunk: [name] },
    { [repository]: [name, name] },
  ]) {
    const input = fixture();
    input.lock['SPEC REPOS'] = repos;
    assert.throws(() => verifyCocoaPodsConsumer(input), /Specs repository/);
  }
});

test('refuses local, podspec and Git overrides while allowing unrelated Flutter plugin paths', () => {
  for (const section of ['EXTERNAL SOURCES', 'CHECKOUT OPTIONS']) {
    for (const source of [{ ':path': '../sdk' }, { ':podspec': '../sdk.podspec' }, { ':git': repository }]) {
      const input = fixture();
      input.lock[section] = { [name]: source };
      assert.throws(() => verifyCocoaPodsConsumer(input), /external override/);
    }
  }
  const input = fixture();
  input.lock['EXTERNAL SOURCES'] = { bota_app_sdk: { ':path': '.symlinks/plugins/bota_app_sdk/ios' } };
  input.installedManifest = structuredClone(input.lock);
  assert.equal(verifyCocoaPodsConsumer(input).version, version);
});

test('refuses wrong or multiply resolved versions and an unpinned native dependency', () => {
  for (const entries of [
    [`${name} (2.0.0-beta.2)`],
    [`${name} (${version})`, `${name}/Other (2.0.0-beta.2)`],
    [],
  ]) {
    const input = fixture();
    input.lock.PODS = entries;
    assert.throws(() => verifyCocoaPodsConsumer(input), /resolved SDK/);
  }
  for (const dependency of [name, `${name} (>= ${version})`, `${name} (= 2.0.0-beta.2)`]) {
    const input = fixture();
    input.lock.DEPENDENCIES = [dependency];
    assert.throws(() => verifyCocoaPodsConsumer(input), /exact native dependency/);
  }
});

test('refuses substituted installed metadata and archive identities or checksums', () => {
  for (const change of [
    spec => { spec.name = 'OtherPod'; },
    spec => { spec.version = '2.0.0-beta.2'; },
    spec => { spec.source.http = 'https://example.invalid/other.zip'; },
    spec => { spec.source.sha256 = 'c'.repeat(64); },
    spec => { spec.source_files = 'Other/**/*.swift'; },
  ]) {
    const input = fixture();
    change(input.installedSpec);
    assert.throws(() => verifyCocoaPodsConsumer(input), /installed Podspec/);
  }
  for (const source of [
    { http: 'https://example.invalid/other.zip', sha256: checksum },
    { http: fixture().expectedSpec.source.http, sha256: '0'.repeat(64) },
    { git: repository, tag: version },
  ]) {
    const input = fixture();
    input.expectedSpec.source = source;
    input.installedSpec.source = structuredClone(source);
    assert.throws(() => verifyCocoaPodsConsumer(input), /archive identity/);
  }
});

test('supports preserved historical package identities and dependency-bearing lock entries', () => {
  const input = fixture();
  input.version = '1.2.0-beta.11';
  input.expectedSpec.name = input.installedSpec.name = 'BotaAppleSDK';
  input.expectedSpec.version = input.installedSpec.version = input.version;
  const source = { http: `https://github.com/bota-dev/app-sdk/releases/download/v${input.version}/BotaAppleSDK.cocoapods.zip`, sha256: checksum };
  input.expectedSpec.source = source;
  input.installedSpec = structuredClone(input.expectedSpec);
  input.lock.PODS = [{ [`BotaAppleSDK (${input.version})`]: ['OtherPod'] }];
  input.lock.DEPENDENCIES = [`BotaAppleSDK (= ${input.version})`];
  input.lock['SPEC REPOS'] = { [repository]: ['BotaAppleSDK'] };
  input.lock['SPEC CHECKSUMS'] = { BotaAppleSDK: 'b'.repeat(40) };
  input.installedManifest = structuredClone(input.lock);
  assert.equal(verifyCocoaPodsConsumer(input).name, 'BotaAppleSDK');
});

test('registry installation is admitted without a Local Podspecs copy only with matching installed state', () => {
  const input = fixture();
  input.installedSpec = null;
  assert.equal(verifyCocoaPodsConsumer(input).specificationStorage, 'registry');
});

test('missing, stale or substituted sandbox manifests and missing SDK payloads are refused', () => {
  for (const change of [
    input => { input.installedManifest = null; },
    input => { delete input.installedManifest; },
    input => { input.installedManifest.PODS = [`${name} (2.0.0-beta.2)`]; },
    input => { input.installedManifest['SPEC REPOS'] = { trunk: [name] }; },
    input => { input.installedManifest['SPEC CHECKSUMS'][name] = 'c'.repeat(40); },
    input => { input.installedSdkPresent = false; },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => verifyCocoaPodsConsumer(input), /sandbox|payload/);
  }
});

test('refuses incomplete lock metadata and a different CocoaPods client', () => {
  for (const change of [
    lock => { delete lock['SPEC REPOS']; },
    lock => { delete lock['SPEC CHECKSUMS']; },
    lock => { lock['SPEC CHECKSUMS'][name] = ''; },
    lock => { lock['SPEC CHECKSUMS'][name] = 'c'.repeat(40); },
    lock => { lock.COCOAPODS = '1.17.0'; },
    lock => { lock.PODS = null; },
  ]) {
    const input = fixture();
    change(input.lock);
    assert.throws(() => verifyCocoaPodsConsumer(input));
  }
});

test('reports a changed or missing CocoaPods client without dumping the lock', () => {
  for (const observed of ['1.17.0', undefined]) {
    const input = fixture();
    if (observed === undefined) delete input.lock.COCOAPODS;
    else input.lock.COCOAPODS = observed;
    assert.throws(() => verifyCocoaPodsConsumer(input), error => {
      assert.match(error.message, /expected 1\.16\.2/);
      assert.ok(error.message.includes(observed === undefined ? '<missing>' : '"1.17.0"'));
      assert.ok(!error.message.includes('SPEC REPOS'));
      return true;
    });
  }
});

test('CLI requires the installed sandbox and refuses direct Podspec inputs before invoking Ruby', () => {
  const helper = fileURLToPath(new URL('./verify-cocoapods-consumer.mjs', import.meta.url));
  for (const filename of ['BotaAppSDK.podspec', 'OtherPod.podspec.json']) {
    const result = spawnSync(process.execPath, [helper,
      '--version', version, '--lock', 'unused-lock', '--repos-root', 'unused-repositories',
      '--installed-spec', filename], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid consumer verification arguments/);
  }
  const result = spawnSync(process.execPath, [helper,
    '--version', version, '--lock', 'unused-lock', '--repos-root', 'unused-repositories'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--sandbox is required/);
});

const rubyProbe = spawnSync('ruby', ['--version'], { encoding: 'utf8' });
test('the real Flutter YAML edit enables CocoaPods and refuses a missing Flutter marker', async context => {
  const script = (await readFile(new URL('./test-public-cocoapods-consumer.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const snippet = script.match(/ruby -0pi -e \\\n\s*'([^']+)' \\\n\s*"\$consumer\/pubspec\.yaml"/)?.[1];
  assert.ok(snippet, 'the actual Flutter YAML edit was not found');
  if (process.platform === 'win32' && rubyProbe.error?.code === 'ENOENT') {
    context.skip('Ruby is unavailable on Windows; this execution is required on Linux and macOS');
    return;
  }
  assert.ifError(rubyProbe.error);
  assert.equal(rubyProbe.status, 0, rubyProbe.stderr);
  const input = 'name: fixture\nflutter:\n  uses-material-design: true\n';
  const edited = spawnSync('ruby', ['-0p', '-e', snippet], { encoding: 'utf8', input });
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.stdout, 'name: fixture\nflutter:\n  config:\n    enable-swift-package-manager: false\n  uses-material-design: true\n');
  for (const input of ['name: fixture\n', 'name: fixture\n# flutter:\n']) {
    const refused = spawnSync('ruby', ['-0p', '-e', snippet], { encoding: 'utf8', input });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Flutter configuration marker is missing/);
  }
});

const bashBinary = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashProbe = spawnSync(bashBinary, ['--version'], { encoding: 'utf8' });
const shellPath = value => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;
test('the actual consumer toolchain pins Flutter and direct pod calls without changing the gem environment', async context => {
  const script = (await readFile(new URL('./test-public-cocoapods-consumer.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const setup = script.match(/# BEGIN CONSUMER POD TOOLCHAIN\n([\s\S]*?)# END CONSUMER POD TOOLCHAIN/)?.[1];
  assert.ok(setup, 'the actual consumer pod setup was not found');
  if (process.platform === 'win32' && bashProbe.error?.code === 'ENOENT') {
    context.skip('Git Bash is unavailable on Windows; this execution is required on Linux and macOS');
    return;
  }
  assert.ifError(bashProbe.error);
  assert.equal(bashProbe.status, 0, bashProbe.stderr);
  const temporary = await mkdtemp(join(tmpdir(), 'bota-pod-wrapper-'));
  try {
    const underlying = join(temporary, 'underlying tool with spaces', 'pod');
    await mkdir(dirname(underlying));
    await writeFile(underlying, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --version || "\${2:-}" == --version ]]; then
  if [[ "\${1:-}" == _1.16.2_ ]]; then echo 1.16.2; else echo 1.17.0; fi
  exit 0
fi
printf '%s\\0' CALL "$@" >> "$BOTA_CONSUMER_ARGS"
printf '%s\\0' "$GEM_HOME" "$GEM_PATH" "$PATH" "$BOTA_TEST_ORIGINAL_PATH" > "$BOTA_CONSUMER_ENV"
`, { mode: 0o755 });
    const result = spawnSync(bashBinary, ['-c', `set -euo pipefail
temporary="$BOTA_TEST_TEMP"
required_cocoapods_version=1.16.2
pod_command=("$BOTA_TEST_POD" _1.16.2_)
chmod +x "$BOTA_TEST_POD"
export BOTA_TEST_ORIGINAL_PATH="$PATH"
${setup}
pod install --repo-update "argument with spaces"
"\${pod_command[@]}" install --repo-update "argument with spaces"
`], { encoding: 'utf8', env: { ...process.env,
      BOTA_TEST_TEMP: shellPath(temporary), BOTA_TEST_POD: shellPath(underlying),
      BOTA_CONSUMER_ARGS: shellPath(join(temporary, 'arguments')),
      BOTA_CONSUMER_ENV: shellPath(join(temporary, 'environment')),
      GEM_HOME: 'synthetic gem home', GEM_PATH: 'synthetic:gem path',
    } });
    assert.equal(result.status, 0, result.stderr);
    const argumentsSeen = (await readFile(join(temporary, 'arguments'), 'utf8')).split('\0').slice(0, -1);
    const invocation = ['CALL', '_1.16.2_', 'install', '--repo-update', 'argument with spaces'];
    assert.deepEqual(argumentsSeen, [...invocation, ...invocation]);
    const [gemHome, gemPath, path, originalPath] = (await readFile(join(temporary, 'environment'), 'utf8')).split('\0');
    assert.equal(gemHome, 'synthetic gem home');
    assert.equal(gemPath, 'synthetic:gem path');
    assert.equal(path, `${shellPath(temporary)}/pod-bin:${originalPath}`);
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('bota-pod-wrapper-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('both real consumer install blocks add only the explicitly selected canonical candidate source', async context => {
  if (process.platform === 'win32' && bashProbe.error?.code === 'ENOENT') {
    context.skip('Git Bash is unavailable on Windows; this execution is required on Linux and macOS');
    return;
  }
  assert.ifError(bashProbe.error);
  assert.equal(bashProbe.status, 0, bashProbe.stderr);
  const temporary = await mkdtemp(join(tmpdir(), 'bota-index-install-'));
  try {
    const pod = join(temporary, 'selected pod');
    const argumentsFile = join(temporary, 'arguments');
    await writeFile(pod, '#!/usr/bin/env bash\nprintf "%s\\0" CALL "$@" >> "$BOTA_TEST_ARGS"\n', { mode: 0o755 });
    for (const file of ['./test-public-apple-pod-consumer.sh', './test-public-cocoapods-consumer.sh']) {
      const script = (await readFile(new URL(file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
      const install = script.match(/# BEGIN CONSUMER INDEX INSTALL\n([\s\S]*?)\s*# END CONSUMER INDEX INSTALL/)?.[1];
      assert.ok(install, 'the real consumer index install was not found');
      for (const candidate of [false, true]) {
        await writeFile(argumentsFile, '');
        const environment = { ...process.env };
        delete environment.BOTA_COCOAPODS_SPECS_REF;
        delete environment.BOTA_COCOAPODS_SPECS_SHA;
        const result = spawnSync(bashBinary, ['-c', `set -euo pipefail
pod_command=("$BOTA_TEST_POD" _1.16.2_)
chmod +x "$BOTA_TEST_POD"
SPECS_REPOSITORY="$BOTA_TEST_REPOSITORY"
${install}
`], { encoding: 'utf8', env: { ...environment,
          BOTA_TEST_POD: shellPath(pod), BOTA_TEST_ARGS: shellPath(argumentsFile), BOTA_TEST_REPOSITORY: repository,
          ...(candidate ? { BOTA_COCOAPODS_SPECS_REF: candidateRef, BOTA_COCOAPODS_SPECS_SHA: indexCommit } : {}),
        } });
        assert.equal(result.status, 0, result.stderr);
        const seen = (await readFile(argumentsFile, 'utf8')).split('\0').slice(0, -1);
        assert.deepEqual(seen, [
          ...(candidate ? ['CALL', '_1.16.2_', 'repo', 'add', 'bota-app-sdk-candidate', repository, candidateRef] : []),
          'CALL', '_1.16.2_', 'install', '--repo-update',
        ]);
      }
    }
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('bota-index-install-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
