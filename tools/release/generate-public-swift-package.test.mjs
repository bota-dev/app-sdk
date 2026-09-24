import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPublicSwiftPackage } from './generate-public-swift-package.mjs';

const checksum = 'a'.repeat(64);

test('major two changes the facade but not its core binary identity', () => {
  const manifest = renderPublicSwiftPackage({ sdkVersion: '2.0.0-beta.0', artifactChecksum: checksum });
  assert.match(manifest, /name: "BotaAppSDK"/);
  assert.match(manifest, /Sources\/BotaAppSDK/);
  assert.match(manifest, /BotaDeviceSDKCore\.xcframework\.zip/);
  assert.match(manifest, /name: "BotaDeviceSDKC"/);
  assert.doesNotMatch(manifest, /BotaAppleSDK/);
});

test('public Swift package pins the matching Apple release artifact', () => {
  const manifest = renderPublicSwiftPackage({
    sdkVersion: '1.0.0',
    artifactChecksum: checksum,
  });

  assert.match(manifest, /name: "BotaAppleSDK"/);
  assert.match(manifest, /\.iOS\(\.v15\)/);
  assert.match(manifest, /\.macOS\(\.v13\)/);
  assert.match(
    manifest,
    /https:\/\/github\.com\/bota-dev\/app-sdk\/releases\/download\/v1\.0\.0\/BotaDeviceSDKCore\.xcframework\.zip/,
  );
  assert.match(manifest, new RegExp(`checksum: "${checksum}"`));
  assert.match(manifest, /path: "platforms\/apple\/Sources\/BotaAppleSDK"/);
  assert.doesNotMatch(manifest, /Artifacts\/BotaDeviceSDKCore\.xcframework/);
});

test('public Swift package rejects invalid versions and checksums', () => {
  assert.throws(
    () => renderPublicSwiftPackage({ sdkVersion: 'v1.0.0', artifactChecksum: checksum }),
    /SDK version/,
  );
  assert.throws(
    () => renderPublicSwiftPackage({ sdkVersion: '1.0.0', artifactChecksum: '0'.repeat(64) }),
    /checksum/,
  );
  assert.throws(
    () => renderPublicSwiftPackage({ sdkVersion: '1.0.0', artifactChecksum: 'A'.repeat(64) }),
    /checksum/,
  );
});
