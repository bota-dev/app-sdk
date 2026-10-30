import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

test('private source fixture has only JavaScript dependencies and no native autolinking', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.publishConfig, undefined);
  assert.deepEqual(pkg.dependencies, { buffer: '6.0.3', eventemitter3: '5.0.4' });
  for (const key of ['peerDependencies', 'codegenConfig']) assert.equal(pkg[key], undefined);
  for (const name of ['ios', 'android', 'react-native.config.js']) assert.ok(!readdirSync(root).includes(name));
});

test('internal source fixture loads with native imports rejected', () => {
  const entry = require.resolve('@bota.dev/react-native-app-sdk-runtime');
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (id.startsWith('react-native') || id.includes('NativeBota')) throw Error('native dependency');
      return load.call(this, id, ...args);
    };
    const {createBotaReactNativeRuntime} = require(${JSON.stringify(entry)});
    createBotaReactNativeRuntime({apiVersion:1, device:{}});
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('portable declarations contain no React Native imports or TurboModule inheritance', () => {
  const visit = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? visit(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const path of visit(join(root, 'lib/typescript')).filter(path => path.endsWith('.d.ts'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"]react-native|extends TurboModule/);
  }
});

test('runtime presence identifies the internal JS fixture', async () => {
  const { createBotaReactNativeRuntime } = require('@bota.dev/react-native-app-sdk-runtime');
  const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: {
    nextClientPresence: async () => ({ schemaVersion: 1, sessionId: 'session', sequence: 1,
      platform: 'ios', sdkPackage: 'native', sdkVersion: 'native-older-version' }),
  } });
  const context = await runtime.sdk.clientPresence.nextReport('device');
  assert.equal(context.sdkPackage, pkg.name);
  assert.equal(context.sdkVersion, pkg.version);
});
