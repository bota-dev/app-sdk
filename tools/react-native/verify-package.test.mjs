import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const verifier = new URL('./verify-package.mjs', import.meta.url).pathname;

const validPackage = () => ({
  name: '@bota.dev/react-native-sdk',
  version: '1.0.2',
  private: true,
  files: [
    'BotaDeviceSDK.podspec',
    'android/',
    'generated/',
    'ios/',
    'lib/',
    'scripts/bota_device_sdk_spm_workaround.rb',
    'src/',
  ],
  peerDependencies: {
    react: '>=19.2.3',
    'react-native': '>=0.86.3 <1.0',
  },
  devDependencies: {
    react: '19.2.3',
    'react-native': '0.86.3',
  },
  codegenConfig: {
    name: 'BotaDeviceSDKSpec',
    type: 'modules',
    jsSrcsDir: './src/specs',
    android: {
      javaPackageName: 'dev.bota.sdk.reactnative',
    },
  },
  bota: {
    nativeModuleName: 'BotaDeviceSDK',
    reactNativeFloor: '0.86.3',
    apple: {
      podName: 'BotaDeviceSDK',
      moduleName: 'BotaDeviceSDK',
      deploymentTarget: '15.1',
      swiftVersion: '6.0',
      cocoapodsVersion: '1.13.0',
      packageUrl: 'https://github.com/bota-dev/app-sdk.git',
      packageRequirement: 'exactVersion',
      packageProduct: 'BotaAppleSDK',
      localPackagePathEnvironment: 'BOTA_APPLE_SDK_PACKAGE_PATH',
    },
  },
});

const runVerifier = (mutate = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), 'bota-rn-package-'));
  const packageRoot = join(root, 'frameworks', 'react-native');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(root, 'sdk-version.toml'), 'version = "1.0.2"\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ version: '1.0.2', private: true })}\n`
  );
  const packageJson = validPackage();
  mutate(packageJson);
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(packageJson)}\n`
  );

  return spawnSync(
    process.execPath,
    [verifier, '--workspace-root', root, '--package-root', packageRoot],
    { encoding: 'utf8' }
  );
};

const outputOf = (result) => `${result.stdout}${result.stderr}`;

test('accepts the private synchronized React Native package metadata', () => {
  const result = runVerifier();

  assert.equal(result.status, 0, outputOf(result));
  assert.match(result.stdout, /React Native package metadata verified/);
});

test('rejects a package that can be published', () => {
  const result = runVerifier((pkg) => {
    pkg.private = false;
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /must remain private/);
});

test('rejects a package-name mismatch', () => {
  const result = runVerifier((pkg) => {
    pkg.name = '@bota.dev/app-sdk';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /package name/);
});

test('rejects SDK version drift', () => {
  const result = runVerifier((pkg) => {
    pkg.version = '1.0.1';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /version 1\.0\.1 does not match 1\.0\.2/);
});

test('rejects a React Native floor mismatch', () => {
  const result = runVerifier((pkg) => {
    pkg.bota.reactNativeFloor = '0.87.0';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /React Native floor/);
});

test('rejects an unexpected native module name', () => {
  const result = runVerifier((pkg) => {
    pkg.bota.nativeModuleName = 'BotaAppSDK';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /native module name/);
});

test('rejects a package that omits the podspec from npm files', () => {
  const result = runVerifier((pkg) => {
    pkg.files = pkg.files.filter((entry) => entry !== 'BotaDeviceSDK.podspec');
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /BotaDeviceSDK\.podspec/);
});

test('rejects a package that omits the Apple SPM workaround from npm files', () => {
  const result = runVerifier((pkg) => {
    pkg.files = pkg.files.filter(
      (entry) => entry !== 'scripts/bota_device_sdk_spm_workaround.rb'
    );
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /SPM workaround/);
});

test('rejects Apple pod identity drift', () => {
  const result = runVerifier((pkg) => {
    pkg.bota.apple.podName = 'BotaReactNativeSDK';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /Apple pod name/);
});

test('rejects Apple deployment or Swift version drift', () => {
  const deploymentResult = runVerifier((pkg) => {
    pkg.bota.apple.deploymentTarget = '16.0';
  });
  const swiftResult = runVerifier((pkg) => {
    pkg.bota.apple.swiftVersion = '5.9';
  });

  assert.notEqual(deploymentResult.status, 0);
  assert.match(outputOf(deploymentResult), /deployment target/);
  assert.notEqual(swiftResult.status, 0);
  assert.match(outputOf(swiftResult), /Swift version/);
});

test('rejects a CocoaPods version without visionOS podspec support', () => {
  const result = runVerifier((pkg) => {
    pkg.bota.apple.cocoapodsVersion = '1.11.2';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /CocoaPods version/);
});

test('rejects an Apple package that is not pinned to the matching release', () => {
  const urlResult = runVerifier((pkg) => {
    pkg.bota.apple.packageUrl = 'https://github.com/bota-dev/apple-sdk.git';
  });
  const requirementResult = runVerifier((pkg) => {
    pkg.bota.apple.packageRequirement = 'upToNextMajorVersion';
  });
  const productResult = runVerifier((pkg) => {
    pkg.bota.apple.packageProduct = 'BotaDeviceSDK';
  });

  assert.notEqual(urlResult.status, 0);
  assert.match(outputOf(urlResult), /Apple package URL/);
  assert.notEqual(requirementResult.status, 0);
  assert.match(outputOf(requirementResult), /exactVersion/);
  assert.notEqual(productResult.status, 0);
  assert.match(outputOf(productResult), /Apple package product/);
});

test('rejects an unexpected local Apple package override', () => {
  const result = runVerifier((pkg) => {
    pkg.bota.apple.localPackagePathEnvironment = 'LOCAL_BOTA_SDK';
  });

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /local Apple package path/);
});

test('executes validation when the CLI entrypoint is relative', () => {
  const root = mkdtempSync(join(tmpdir(), 'bota-rn-package-relative-'));
  const packageRoot = join(root, 'frameworks', 'react-native');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(root, 'sdk-version.toml'), 'version = "1.0.2"\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ version: '1.0.2', private: true })}\n`
  );
  const packageJson = validPackage();
  packageJson.private = false;
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(packageJson)}\n`
  );

  const result = spawnSync(
    process.execPath,
    [
      'tools/react-native/verify-package.mjs',
      '--workspace-root',
      root,
      '--package-root',
      packageRoot,
    ],
    { cwd: resolve(new URL('../..', import.meta.url).pathname), encoding: 'utf8' }
  );

  assert.notEqual(result.status, 0);
  assert.match(outputOf(result), /must remain private/);
});
