import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const schema = readJson(
  new URL('../../release/schema/release-manifest.schema.json', import.meta.url),
);
const publishedV1 = readJson(
  new URL('../../release/examples/published-1.0.0-v1.json', import.meta.url),
);
const v2Example = readJson(
  new URL('../../release/examples/1.1.0.json', import.meta.url),
);
const packagePairs = [
  ['apple', 'BotaAppleSDK'],
  ['android', 'dev.bota:bota-android-sdk'],
  ['react-native', '@bota.dev/react-native-sdk'],
  ['flutter', 'bota_flutter_sdk'],
  ['web', '@bota.dev/web-sdk'],
  ['windows', 'Bota.WindowsSdk'],
  ['electron', '@bota.dev/electron-sdk'],
];

function compileSchema() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  return ajv.compile(schema);
}

function withPackagePair(platform, packageIdentifier) {
  const manifest = structuredClone(v2Example);
  manifest.artifacts[0].platform = platform;
  manifest.artifacts[0].packageIdentifier = packageIdentifier;
  return manifest;
}

test('public schema compiled by Ajv 2020 accepts the immutable v1 manifest', () => {
  const validate = compileSchema();

  assert.equal(validate(publishedV1), true, JSON.stringify(validate.errors));
});

test('public schema accepts all seven exact v2 platform and package pairs', () => {
  const validate = compileSchema();

  for (const [platform, packageIdentifier] of packagePairs) {
    const valid = validate(withPackagePair(platform, packageIdentifier));
    assert.equal(
      valid,
      true,
      `${platform}/${packageIdentifier}: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('public schema rejects every mismatched v2 platform and package pair', () => {
  const validate = compileSchema();

  for (let index = 0; index < packagePairs.length; index += 1) {
    const [platform] = packagePairs[index];
    const packageIdentifier = packagePairs[(index + 1) % packagePairs.length][1];
    const valid = validate(withPackagePair(platform, packageIdentifier));
    assert.equal(
      valid,
      false,
      `${platform}/${packageIdentifier} unexpectedly passed schema validation`,
    );
  }
});

test('public schema rejects unknown v2 platforms and package identifiers', () => {
  const validate = compileSchema();
  const unknownPairs = [
    ['linux', 'BotaAppleSDK'],
    ['apple', 'BotaUnknownSDK'],
    ['linux', 'BotaUnknownSDK'],
  ];

  for (const [platform, packageIdentifier] of unknownPairs) {
    const valid = validate(withPackagePair(platform, packageIdentifier));
    assert.equal(
      valid,
      false,
      `${platform}/${packageIdentifier} unexpectedly passed schema validation`,
    );
  }
});
