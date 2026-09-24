import assert from 'node:assert/strict';
import test from 'node:test';
import { publishExactNpmArtifact } from './publish-npm.mjs';

const version = '2.0.0-beta.0';
const packageName = '@bota.dev/web-app-sdk';
const legacyName = '@bota.dev/web-sdk';
const shasum = 'a'.repeat(40);
const legacyTags = { latest: '1.1.0', beta: '1.2.0-beta.12' };

function fixture({ existing = false, delay = 0, mismatch = false, lookupStatus, legacyDrift = false } = {}) {
  let published = existing;
  let publishes = 0;
  let lookups = 0;
  return {
    count: () => publishes,
    options: {
      platform: 'web', version, shasum,
      packageMetadata: { name: packageName, version },
      sleep: async () => {}, maxAttempts: 3,
      publish: async () => { publishes++; published = true; },
      fetchImpl: async (url) => {
        if (lookupStatus) return new Response('', { status: lookupStatus });
        const path = decodeURIComponent(new URL(url).pathname.slice(1));
        if (path === legacyName) return Response.json({ 'dist-tags': { ...legacyTags, ...(legacyDrift && publishes ? { beta: version } : {}) } });
        if (path === packageName) return published
          ? Response.json({ 'dist-tags': { beta: version } }) : new Response('', { status: 404 });
        assert.equal(path, `${packageName}/${version}`);
        if (!published || lookups++ < delay) return new Response('', { status: 404 });
        return Response.json({ name: packageName, version, dist: { shasum: mismatch ? 'b'.repeat(40) : shasum } });
      },
    },
  };
}

test('first publication requires confirmed 404, then verifies exact bytes and tags', async () => {
  const f = fixture({ delay: 1 });
  await publishExactNpmArtifact(f.options);
  assert.equal(f.count(), 1);
});
test('matching existing version is verified without publishing', async () => {
  const f = fixture({ existing: true });
  await publishExactNpmArtifact(f.options);
  assert.equal(f.count(), 0);
});
test('different existing bytes fail without publishing', async () => {
  const f = fixture({ existing: true, mismatch: true });
  await assert.rejects(publishExactNpmArtifact(f.options), /checksum/);
  assert.equal(f.count(), 0);
});
test('authentication and transport failures never authorize publication', async () => {
  for (const lookupStatus of [401, 403, 500]) {
    const f = fixture({ lookupStatus });
    await assert.rejects(publishExactNpmArtifact(f.options), /HTTP/);
    assert.equal(f.count(), 0);
  }
  const f = fixture();
  f.options.fetchImpl = async () => { throw new Error('network failed'); };
  await assert.rejects(publishExactNpmArtifact(f.options), /network failed/);
  assert.equal(f.count(), 0);
});
test('wrong archive identity fails before registry or publication calls', async () => {
  const f = fixture();
  f.options.packageMetadata.name = legacyName;
  f.options.fetchImpl = async () => assert.fail('must not query registry');
  await assert.rejects(publishExactNpmArtifact(f.options), /artifact identity/);
});
test('historical dist-tag drift and exhausted visibility retries fail closed', async () => {
  await assert.rejects(publishExactNpmArtifact(fixture({ legacyDrift: true }).options), /historical.*tags/);
  await assert.rejects(publishExactNpmArtifact(fixture({ delay: 10 }).options), /not visible/);
});

test('RN publication requires the legacy latest tag to remain on maintenance', async () => {
  for (const version of ['1.2.0-beta.12', '2.0.0-beta.0']) {
    for (const latest of [undefined, '1.1.0', '0.0.67-beta.0']) {
      const name = version.startsWith('2.') ? '@bota.dev/react-native-app-sdk' : '@bota.dev/react-native-sdk';
      await assert.rejects(publishExactNpmArtifact({
        platform: 'react-native', version, shasum,
        packageMetadata: { name, version },
        publish: async () => assert.fail('must not publish with invalid maintenance tag'),
        fetchImpl: async (url) => {
          const path = decodeURIComponent(new URL(url).pathname.slice(1));
          if (path === '@bota.dev/react-native-sdk') return Response.json({ 'dist-tags': { latest } });
          return new Response('', { status: 404 });
        },
      }), /maintenance latest/);
    }
  }
});
