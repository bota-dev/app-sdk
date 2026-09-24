import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderPublicPodspec } from './generate-public-podspec.mjs';

const checksum = 'a'.repeat(64);

test('renders a script-free, checksummed CocoaPods source archive', () => {
  const spec = renderPublicPodspec({ sdkVersion: '1.2.0-beta.12', artifactChecksum: checksum });
  assert.match(spec, /spec.version = "1\.2\.0-beta\.12"/);
  assert.match(spec, /BotaAppleSDK\.cocoapods\.zip/);
  assert.match(spec, /http: "https:\/\/github\.com\/bota-dev\/app-sdk\/releases\/download\/v1\.2\.0-beta\.12\/BotaAppleSDK\.cocoapods\.zip"/);
  assert.match(spec, new RegExp(`sha256: "${checksum}"`));
  assert.match(spec, /Sources\/BotaAppleSDK\/\*\*\/\*\.swift/);
  assert.match(spec, /Artifacts\/BotaDeviceSDKCore\.xcframework/);
  assert.doesNotMatch(spec, /prepare_command/);
});

test('rejects invalid versions and checksums', () => {
  assert.throws(() => renderPublicPodspec({ sdkVersion: 'v1.2.0-beta.12', artifactChecksum: checksum }));
  assert.throws(() => renderPublicPodspec({ sdkVersion: '1.2.0-beta.12', artifactChecksum: '0'.repeat(64) }));
});
