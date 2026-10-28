import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as cocoaPods from './wait-cocoapods.mjs';

const { waitForCocoaPodsVersion } = cocoaPods;

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

test('ready CDN metadata still waits for the normal CocoaPods install', async () => {
  const f = fixture();
  let installs = 0;
  f.options.checkReady = async () => ++installs === 3;
  await waitForCocoaPodsVersion(f.options);
  assert.equal(installs, 3);
  assert.deepEqual(f.counts(), { indexReads: 3, specReads: 3, sleeps: 2 });
});

test('missing specs do not start installation and install failures stop immediately', async () => {
  const missing = fixture({ missingSpec: 10 });
  missing.options.checkReady = () => assert.fail('must not install');
  await assert.rejects(waitForCocoaPodsVersion(missing.options), /not ready after 3 checks/);
  const failed = fixture();
  failed.options.checkReady = async () => { throw new Error('install failed'); };
  await assert.rejects(waitForCocoaPodsVersion(failed.options), /install failed/);
  assert.equal(failed.counts().sleeps, 0);
});

test('a consistently unresolved CocoaPods install exhausts the same bounded wait', async () => {
  const f = fixture();
  let installs = 0;
  f.options.checkReady = async () => { installs++; return false; };
  await assert.rejects(waitForCocoaPodsVersion(f.options), /not ready after 3 checks/);
  assert.equal(installs, 3);
  assert.equal(f.counts().sleeps, 2);
});

test('normal install preserves command arguments and retries only missing-spec exit 31', async () => {
  for (const [code, ready] of [[0, true], [31, false]]) {
    assert.equal(await cocoaPods.runCocoaPodsInstall([
      process.execPath, '-e',
      `if (process.argv.slice(1).join(',') !== 'install,--repo-update') process.exit(99); process.exit(${code});`,
    ]), ready);
  }
  for (const code of [1, 2, 65]) {
    await assert.rejects(cocoaPods.runCocoaPodsInstall([process.execPath, '-e', `process.exit(${code})`]),
      new RegExp(`CocoaPods install failed: exit ${code}`));
  }
  await assert.rejects(cocoaPods.runCocoaPodsInstall(['missing-cocoapods-executable-for-test']), /ENOENT/);
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

test('public pod consumer waits on its normal isolated install and retains strict checks', async () => {
  const script = await readFile(new URL('../flutter/test-public-apple-pod-consumer.sh', import.meta.url), 'utf8');
  const wait = script.indexOf('node "$ROOT/tools/release/wait-cocoapods.mjs" "$VERSION" -- "${pod_command[@]}"');
  assert.ok(wait > script.indexOf('cd "$temporary"'));
  for (const setting of ['CP_HOME_DIR', 'CP_REPOS_DIR', 'CP_CACHE_DIR']) {
    assert.match(script, new RegExp(`export ${setting}="\\$temporary/`));
  }
  assert.ok(script.includes("source 'https://cdn.cocoapods.org/'"));
  assert.ok(script.includes("grep -q '^EXTERNAL SOURCES:'"));
  assert.ok(script.includes('grep -Fq "${APPLE_PACKAGE} ($VERSION)"'));
  assert.ok(script.includes('xcodebuild \\'));
});
