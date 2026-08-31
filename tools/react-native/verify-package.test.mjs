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
