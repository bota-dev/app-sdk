import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Android adapter build is version-synchronized and Codegen-enabled', () => {
  const build = read('../android/build.gradle');
  const manifest = read('../android/src/main/AndroidManifest.xml');

  assert.match(build, /apply plugin: "com\.android\.library"/);
  assert.match(build, /apply plugin: "org\.jetbrains\.kotlin\.android"/);
  assert.match(build, /apply plugin: "com\.facebook\.react"/);
  assert.match(build, /namespace "dev\.bota\.sdk\.reactnative"/);
  assert.match(build, /minSdkVersion: 26/);
  assert.match(build, /compileSdkVersion: 36/);
  assert.match(build, /compileSdkVersion getExtOrDefault\("compileSdkVersion"\)/);
  assert.match(build, /minSdkVersion getExtOrDefault\("minSdkVersion"\)/);
  assert.match(build, /sourceCompatibility JavaVersion\.VERSION_17/);
  assert.match(build, /libraryName = "BotaDeviceSDKSpec"/);
  assert.match(build, /codegenJavaPackageName = "dev\.bota\.sdk\.reactnative"/);
  assert.match(
    build,
    /implementation "\$\{androidMetadata\.mavenCoordinate\}:\$\{packageVersion\}"/
  );
  assert.match(manifest, /<manifest/);
});

test('Android adapter package does not bypass the public facade', () => {
  const packageJson = JSON.parse(read('../package.json'));

  assert.deepEqual(packageJson.bota.android, {
    compileSdkVersion: 36,
    coroutinesVersion: '1.10.2',
    kotlinVersion: '2.1.20',
    mavenCoordinate: 'dev.bota:bota-android-sdk',
    minSdkVersion: 26,
    namespace: 'dev.bota.sdk.reactnative',
  });
  assert.ok(packageJson.files.includes('android/'));
});
