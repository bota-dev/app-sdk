import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
  'android/src/main/kotlin/dev/bota/sdk/flutter/BotaApi.g.kt',
  'ios/bota_flutter_sdk.podspec',
  'ios/bota_flutter_sdk/Package.swift',
  'ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaApi.g.swift',
  'lib/bota_flutter_sdk.dart',
  'lib/src/generated/bota_api.g.dart',
  'pigeon_options.yaml',
  'pigeons/bota_api.dart',
  'pubspec.yaml',
  'test/bridge_contract_test.dart',
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
  meta: 1.19.0
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

const validPluginPodspec = `
version = package.fetch("version")
spec.swift_version = "5.0"
spec.source_files = "bota_flutter_sdk/Sources/bota_flutter_sdk/**/*.swift"
spec.dependency "BotaAppleSDK", version
`;
const validSwiftPackage = `
.library(name: "bota-flutter-sdk", targets: ["bota_flutter_sdk"])
.package(name: "FlutterFramework", path: "../FlutterFramework")
.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "1.1.0")
swiftLanguageModes: [.v5]
`;
const validApplePodspec = `
spec.version = "1.1.0"
spec.vendored_frameworks = "Artifacts/BotaDeviceSDKCore.xcframework"
`;

const createFixture = (prefix = 'bota-flutter-package-') => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const packageRoot = join(root, 'frameworks', 'flutter', 'bota_flutter_sdk');

  writeFileSync(join(root, 'sdk-version.toml'), 'version = "1.1.0"\n');
  for (const file of packageFiles) {
    const path = join(packageRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    let contents = 'fixture\n';
    if (file === 'pubspec.yaml') contents = validPubspec;
    if (file === 'ios/bota_flutter_sdk.podspec') contents = validPluginPodspec;
    if (file === 'ios/bota_flutter_sdk/Package.swift') contents = validSwiftPackage;
    writeFileSync(path, contents);
  }
  const applePodspec = join(root, 'platforms', 'apple', 'BotaAppleSDK.podspec');
  mkdirSync(dirname(applePodspec), { recursive: true });
  writeFileSync(applePodspec, validApplePodspec);

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

test('rejects Apple package version and language-mode drift', () => {
  const packageFixture = createFixture();
  writeFileSync(
    join(packageFixture.packageRoot, 'ios/bota_flutter_sdk/Package.swift'),
    validSwiftPackage.replace('exact: "1.1.0"', 'exact: "1.0.0"')
  );
  const podFixture = createFixture();
  writeFileSync(
    join(podFixture.packageRoot, 'ios/bota_flutter_sdk.podspec'),
    validPluginPodspec.replace('"5.0"', '"6.0"')
  );

  assert.throws(
    () => verifyFlutterPackage(packageFixture.root),
    /pin BotaAppleSDK exactly to 1\.1\.0/
  );
  assert.throws(
    () => verifyFlutterPackage(podFixture.root),
    /compile in Swift 5 language mode/
  );
});

test('rejects a missing generated-code meta dependency', () => {
  const { packageRoot, root } = createFixture();
  replacePubspec(packageRoot, '  meta: 1.19.0\n', '');

  assert.throws(
    () => verifyFlutterPackage(root),
    /meta version must be exactly 1\.19\.0/,
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

const createFakeFlutterHome = ({
  dartVersion = '3.13.2',
  frameworkVersion = '3.47.2',
} = {}) => {
  const flutterHome = mkdtempSync(join(tmpdir(), 'bota-dart-runner-'));
  const bin = join(flutterHome, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'flutter'),
    `#!/usr/bin/env bash
if [[ "$1" == "--version" && "\${2:-}" == "--machine" ]]; then
  printf '%s\\n' '${JSON.stringify({ frameworkVersion, dartSdkVersion: dartVersion })}'
  exit 0
fi
printf 'unexpected-flutter-dispatch\\n'
`,
  );
  writeFileSync(
    join(bin, 'dart'),
    `#!/usr/bin/env bash
printf 'dart-command\\n'
printf 'cwd=%s\\n' "$PWD"
printf 'arg=%s\\n' "$@"
`,
  );
  chmodSync(join(bin, 'flutter'), 0o755);
  chmodSync(join(bin, 'dart'), 0o755);
  return flutterHome;
};

test('run-dart validates the pinned SDK and dispatches the Dart executable', () => {
  const flutterHome = createFakeFlutterHome();
  const result = spawnSync(
    join(workspaceRoot, 'tools', 'flutter', 'run-dart.sh'),
    ['format', '--output=none', 'lib'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, BOTA_FLUTTER_HOME: flutterHome },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dart-command/);
  assert.match(result.stdout, /arg=format/);
  assert.doesNotMatch(result.stdout, /unexpected-flutter-dispatch/);
});

test('run-dart rejects SDK version drift before Dart dispatch', () => {
  for (const versions of [
    { dartVersion: '3.14.0', frameworkVersion: '3.47.2' },
    { dartVersion: '3.13.2', frameworkVersion: '3.48.0' },
  ]) {
    const result = spawnSync(
      join(workspaceRoot, 'tools', 'flutter', 'run-dart.sh'),
      ['format', 'lib'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BOTA_FLUTTER_HOME: createFakeFlutterHome(versions),
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bota Flutter toolchain requires/);
    assert.doesNotMatch(result.stdout, /dart-command/);
  }
});

const sha256 = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  createReadStream(path)
    .on('error', reject)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolveHash(hash.digest('hex')));
});

const currentFlutterPlatform = () => {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  throw new Error(`unsupported test host: ${process.platform}-${process.arch}`);
};

const createBootstrapFixture = async ({ validArchive }) => {
  const root = mkdtempSync(join(tmpdir(), 'bota-flutter-bootstrap-'));
  const tools = join(root, 'tools', 'flutter');
  const downloads = join(root, 'source');
  const archiveName = 'flutter_test.tar.xz';
  const sourceArchive = join(downloads, archiveName);
  mkdirSync(tools, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  copyFileSync(join(workspaceRoot, 'tools', 'flutter', 'run-flutter.sh'), join(tools, 'run-flutter.sh'));
  chmodSync(join(tools, 'run-flutter.sh'), 0o755);

  if (validArchive) {
    const payload = join(root, 'payload');
    const flutter = join(payload, 'flutter', 'bin', 'flutter');
    mkdirSync(dirname(flutter), { recursive: true });
    writeFileSync(
      flutter,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" && "\${2:-}" == "--machine" ]]; then
  printf '%s\\n' '${JSON.stringify({ frameworkVersion: '3.47.2', dartSdkVersion: '3.13.2' })}'
  exit 0
fi
printf 'bootstrapped-command\\n'
`,
    );
    chmodSync(flutter, 0o755);
    const tar = spawnSync('tar', ['-cJf', sourceArchive, '-C', payload, 'flutter'], {
      encoding: 'utf8',
    });
    assert.equal(tar.status, 0, tar.stderr);
  } else {
    writeFileSync(sourceArchive, 'verified but not an archive\n');
  }

  const digest = await sha256(sourceArchive);
  const platform = currentFlutterPlatform();
  writeFileSync(
    join(tools, 'flutter-version.json'),
    `${JSON.stringify({
      version: '3.47.2',
      dartVersion: '3.13.2',
      baseUrl: `file://${downloads}`,
      archives: { [platform]: { path: archiveName, sha256: digest } },
    })}\n`,
  );
  return {
    archive: join(root, 'target', 'flutter-sdk', 'downloads', archiveName),
    root,
    script: join(tools, 'run-flutter.sh'),
  };
};

test('bootstrap removes the archive only after successful extraction', async () => {
  const success = await createBootstrapFixture({ validArchive: true });
  const successEnv = { ...process.env };
  delete successEnv.BOTA_FLUTTER_HOME;
  const successResult = spawnSync(success.script, ['doctor'], {
    cwd: success.root,
    encoding: 'utf8',
    env: successEnv,
  });

  assert.equal(successResult.status, 0, successResult.stderr);
  assert.match(successResult.stdout, /bootstrapped-command/);
  assert.equal(existsSync(success.archive), false);

  const failure = await createBootstrapFixture({ validArchive: false });
  const failureEnv = { ...process.env };
  delete failureEnv.BOTA_FLUTTER_HOME;
  const failureResult = spawnSync(failure.script, ['doctor'], {
    cwd: failure.root,
    encoding: 'utf8',
    env: failureEnv,
  });

  assert.notEqual(failureResult.status, 0);
  assert.equal(existsSync(failure.archive), true);
});
