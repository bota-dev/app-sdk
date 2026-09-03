import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyFlutterPackage } from './verify-package.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const packageFiles = [
  'LICENSE',
  'analysis_options.yaml',
  'lib/bota_flutter_sdk.dart',
  'pubspec.yaml',
  'test/package_contract_test.dart',
];

const validPubspec = `name: bota_flutter_sdk
version: 1.1.0
environment:
  sdk: ">=3.11.0 <4.0.0"
  flutter: ">=3.41.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: 6.0.0
  pigeon: 28.0.0
flutter:
  plugin:
    platforms:
      android:
        package: dev.bota.sdk.flutter
        pluginClass: BotaFlutterSdkPlugin
      ios:
        pluginClass: BotaFlutterSdkPlugin
`;

const createFixture = (prefix = 'bota-flutter-package-') => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const packageRoot = join(root, 'frameworks', 'flutter', 'bota_flutter_sdk');

  writeFileSync(join(root, 'sdk-version.toml'), 'version = "1.1.0"\n');
  for (const file of packageFiles) {
    const path = join(packageRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === 'pubspec.yaml' ? validPubspec : 'fixture\n');
  }

  return { packageRoot, root };
};

const replacePubspec = (packageRoot, from, to) => {
  writeFileSync(
    join(packageRoot, 'pubspec.yaml'),
    validPubspec.replace(from, to)
  );
};

test('accepts the synchronized iOS and Android Flutter package metadata', () => {
  const { root } = createFixture();

  assert.deepEqual(verifyFlutterPackage(root), {
    packageName: 'bota_flutter_sdk',
    sdkVersion: '1.1.0',
  });
});

test('rejects a missing Flutter package', () => {
  const root = mkdtempSync(join(tmpdir(), 'bota-flutter-package-missing-'));
  writeFileSync(join(root, 'sdk-version.toml'), 'version = "1.1.0"\n');

  assert.throws(() => verifyFlutterPackage(root), /Flutter package is missing/);
});

test('rejects Flutter package version drift from sdk-version.toml', () => {
  const { packageRoot, root } = createFixture();
  replacePubspec(packageRoot, 'version: 1.1.0', 'version: 1.0.0');

  assert.throws(
    () => verifyFlutterPackage(root),
    /package version 1\.0\.0 does not match 1\.1\.0/
  );
});

test('rejects Dart and Flutter consumer floor drift', () => {
  const dartFixture = createFixture();
  replacePubspec(
    dartFixture.packageRoot,
    'sdk: ">=3.11.0 <4.0.0"',
    'sdk: ">=3.12.0 <4.0.0"'
  );
  const flutterFixture = createFixture();
  replacePubspec(
    flutterFixture.packageRoot,
    'flutter: ">=3.41.0"',
    'flutter: ">=3.42.0"'
  );

  assert.throws(
    () => verifyFlutterPackage(dartFixture.root),
    /Dart SDK constraint must be >=3\.11\.0 <4\.0\.0/
  );
  assert.throws(
    () => verifyFlutterPackage(flutterFixture.root),
    /Flutter SDK constraint must be >=3\.41\.0/
  );
});

test('rejects Flutter platforms other than iOS and Android', () => {
  const { packageRoot, root } = createFixture();
  replacePubspec(
    packageRoot,
    '      ios:\n        pluginClass: BotaFlutterSdkPlugin',
    '      ios:\n        pluginClass: BotaFlutterSdkPlugin\n      web:\n        pluginClass: BotaFlutterSdkPlugin'
  );

  assert.throws(
    () => verifyFlutterPackage(root),
    /platforms must contain exactly android and ios/
  );
});

test('rejects a non-exact Pigeon development dependency', () => {
  const { packageRoot, root } = createFixture();
  replacePubspec(packageRoot, 'pigeon: 28.0.0', 'pigeon: ^28.0.0');

  assert.throws(
    () => verifyFlutterPackage(root),
    /Pigeon version must be exactly 28\.0\.0/
  );
});

test('rejects every missing package file', () => {
  for (const missingFile of packageFiles) {
    const { packageRoot, root } = createFixture();
    rmSync(join(packageRoot, missingFile));

    assert.throws(
      () => verifyFlutterPackage(root),
      new RegExp(`package is missing ${missingFile.replaceAll('.', '\\.')}`)
    );
  }
});

test('rejects YAML aliases in the package manifest', () => {
  const { packageRoot, root } = createFixture();
  replacePubspec(
    packageRoot,
    'version: 1.1.0',
    'shared: &version 1.1.0\nversion: *version'
  );

  assert.throws(
    () => verifyFlutterPackage(root),
    /YAML anchors or aliases are not allowed/
  );
});

test('rejects punctuation-named YAML anchors and aliases', () => {
  const anchorFixture = createFixture();
  replacePubspec(
    anchorFixture.packageRoot,
    'version: 1.1.0',
    'shared: &.shared 1.1.0\nversion: 1.1.0'
  );
  const aliasFixture = createFixture();
  replacePubspec(aliasFixture.packageRoot, 'version: 1.1.0', 'version: *.shared');

  assert.throws(
    () => verifyFlutterPackage(anchorFixture.root),
    /YAML anchors or aliases are not allowed/
  );
  assert.throws(
    () => verifyFlutterPackage(aliasFixture.root),
    /YAML anchors or aliases are not allowed/
  );
});

test('rejects package symlinks that escape the package root', () => {
  const { packageRoot, root } = createFixture();
  const outside = join(root, 'outside-license');
  writeFileSync(outside, 'outside\n');
  rmSync(join(packageRoot, 'LICENSE'));
  symlinkSync(outside, join(packageRoot, 'LICENSE'));

  assert.throws(
    () => verifyFlutterPackage(root),
    /package symlink escapes package root/
  );
});

test('runs package test paths from the Flutter package directory', () => {
  const flutterHome = mkdtempSync(join(tmpdir(), 'bota-flutter-home-'));
  const flutter = join(flutterHome, 'bin', 'flutter');
  mkdirSync(dirname(flutter), { recursive: true });
  writeFileSync(
    flutter,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" && "\${2:-}" == "--machine" ]]; then
  printf '%s\\n' '${JSON.stringify({ frameworkVersion: '3.47.2', dartSdkVersion: '3.13.2' })}'
  exit 0
fi
printf 'requested-command\\n'
printf "cwd=%s\\n" "$PWD"
printf "arg=%s\\n" "$@"
`
  );
  chmodSync(flutter, 0o755);

  const result = spawnSync(
    join(workspaceRoot, 'tools', 'flutter', 'run-flutter.sh'),
    [
      'test',
      'frameworks/flutter/bota_flutter_sdk/test/package_contract_test.dart',
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, BOTA_FLUTTER_HOME: flutterHome },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`cwd=${join(workspaceRoot, 'frameworks/flutter/bota_flutter_sdk')}`)
  );
  assert.match(result.stdout, /arg=test\/package_contract_test\.dart/);
});

const runWithOverride = ({ dartVersion, frameworkVersion }) => {
  const flutterHome = mkdtempSync(join(tmpdir(), 'bota-flutter-override-'));
  const flutter = join(flutterHome, 'bin', 'flutter');
  mkdirSync(dirname(flutter), { recursive: true });
  writeFileSync(
    flutter,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" && "\${2:-}" == "--machine" ]]; then
  printf '%s\\n' '${JSON.stringify({ frameworkVersion, dartSdkVersion: dartVersion })}'
  exit 0
fi
printf 'requested-command\\n'
`
  );
  chmodSync(flutter, 0o755);

  return spawnSync(
    join(workspaceRoot, 'tools', 'flutter', 'run-flutter.sh'),
    ['doctor'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, BOTA_FLUTTER_HOME: flutterHome },
    }
  );
};

test('rejects a BOTA_FLUTTER_HOME with a mismatched Flutter version', () => {
  const result = runWithOverride({
    dartVersion: '3.13.2',
    frameworkVersion: '3.48.0',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires Flutter 3\.47\.2, found 3\.48\.0/);
  assert.doesNotMatch(result.stdout, /requested-command/);
});

test('rejects a BOTA_FLUTTER_HOME with a mismatched Dart version', () => {
  const result = runWithOverride({
    dartVersion: '3.14.0',
    frameworkVersion: '3.47.2',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires Dart 3\.13\.2, found 3\.14\.0/);
  assert.doesNotMatch(result.stdout, /requested-command/);
});

test('discovers the workspace root when the verifier path contains spaces', () => {
  const { root } = createFixture('bota flutter package-');
  const verifier = join(root, 'tools', 'flutter', 'verify-package.mjs');
  mkdirSync(dirname(verifier), { recursive: true });
  copyFileSync(
    join(workspaceRoot, 'tools', 'flutter', 'verify-package.mjs'),
    verifier
  );

  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Flutter package metadata verified/);
});
