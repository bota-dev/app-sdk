import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { waitForCocoaPodsVersion } from './wait-cocoapods.mjs';

const name = 'BotaAppSDK';
const version = '2.0.0-beta.3';
const indexUrl = 'https://cdn.cocoapods.org/all_pods_versions_b_3_6.txt';
const specUrl = `https://cdn.cocoapods.org/Specs/b/3/6/${name}/${version}/${name}.podspec.json`;

function fixture({ staleIndex = 0, missingSpec = 0, wrongSpec = false, status } = {}) {
  let indexReads = 0;
  let specReads = 0;
  let sleeps = 0;
  return {
    counts: () => ({ indexReads, specReads, sleeps }),
    options: {
      name, version, maxAttempts: 3, sleep: async () => { sleeps++; },
      fetchImpl: async (url) => {
        if (status) return new Response('', { status });
        if (url === indexUrl) {
          indexReads++;
          return new Response(indexReads <= staleIndex
            ? `${name}/2.0.0-beta.1/2.0.0-beta.30\nOtherPod/${version}`
            : `${name}/2.0.0-beta.1/${version}\n`);
        }
        assert.equal(url, specUrl);
        specReads++;
        return specReads <= missingSpec ? new Response('', { status: 404 })
          : Response.json({ name, version: wrongSpec ? '2.0.0-beta.1' : version });
      },
    },
  };
}

test('waits for the exact indexed version, not a prefix or another pod', async () => {
  const f = fixture({ staleIndex: 2 });
  await waitForCocoaPodsVersion(f.options);
  assert.deepEqual(f.counts(), { indexReads: 3, specReads: 1, sleeps: 2 });
});

test('waits for the public spec after the index becomes ready', async () => {
  const f = fixture({ missingSpec: 2 });
  await waitForCocoaPodsVersion(f.options);
  assert.deepEqual(f.counts(), { indexReads: 3, specReads: 3, sleeps: 2 });
});

test('already propagated metadata does not wait', async () => {
  const f = fixture();
  await waitForCocoaPodsVersion(f.options);
  assert.deepEqual(f.counts(), { indexReads: 1, specReads: 1, sleeps: 0 });
});

test('missing index or spec fails after bounded retries', async () => {
  for (const options of [{ staleIndex: 10 }, { missingSpec: 10 }, { status: 404 }]) {
    const f = fixture(options);
    await assert.rejects(waitForCocoaPodsVersion(f.options), /not ready after 3 checks/);
    assert.equal(f.counts().sleeps, 2);
  }
});

test('authentication, server, identity and network errors fail without waiting', async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 500 }, { wrongSpec: true }]) {
    const f = fixture(options);
    await assert.rejects(waitForCocoaPodsVersion(f.options), /HTTP|identity/);
    assert.equal(f.counts().sleeps, 0);
  }
  const f = fixture();
  f.options.fetchImpl = async () => { throw new Error('network failed'); };
  await assert.rejects(waitForCocoaPodsVersion(f.options), /network failed/);
  assert.equal(f.counts().sleeps, 0);
});

test('invalid inputs cannot initiate registry requests', async () => {
  for (const input of [{ name: '../Other' }, { version: '' }, { maxAttempts: 0 }]) {
    await assert.rejects(waitForCocoaPodsVersion({
      name, version, ...input, fetchImpl: () => assert.fail('must not fetch'),
    }), /invalid/);
  }
});

test('public pod consumer waits before installing and preserves the CDN source', async () => {
  const script = await readFile(new URL('../flutter/test-public-apple-pod-consumer.sh', import.meta.url), 'utf8');
  const wait = script.indexOf('node "$ROOT/tools/release/wait-cocoapods.mjs" "$VERSION"');
  assert.ok(wait >= 0 && wait < script.indexOf('"${pod_command[@]}" install --repo-update'));
  assert.ok(script.includes("source 'https://cdn.cocoapods.org/'"));
});
