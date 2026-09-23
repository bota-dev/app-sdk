import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';

import {
  createDeploymentState,
  createCentralPortalClient,
  deploymentName,
  loadDeploymentState,
  recoverDeployment,
  retryFailedDeployment,
  resumeDeployment,
  verifyArchivedRelease,
  verifyPublishedArtifacts,
} from './central-portal.mjs';
import { buildCentralBundle } from './build-central-bundle.mjs';
import { normalizeCentralRepository } from './normalize-central-repository.mjs';
import { coordinate, createRawRepository, version } from './release-test-helpers.mjs';

const sourceRevision = 'a'.repeat(40);
const bundleSha256 = 'b'.repeat(64);
const inventorySha256 = 'c'.repeat(64);
const deploymentId = '12345678-1234-4234-8234-123456789abc';

async function stateFixture(t, deploymentState = 'READY') {
  const directory = await mkdtemp(join(tmpdir(), 'bota-central-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'central-portal-state.json');
  const state = createDeploymentState({ sourceRevision, bundleSha256, inventorySha256 });
  state.deploymentState = deploymentState;
  if (deploymentState !== 'READY') state.deploymentId = deploymentId;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { statePath, state };
}

test('creates deterministic READY state without credentials or a deployment ID', () => {
  const state = createDeploymentState({ sourceRevision, bundleSha256, inventorySha256 });

  assert.equal(state.packageIdentifier, 'dev.bota:bota-android-sdk');
  assert.equal(state.version, '1.2.0-beta.6');
  assert.equal(state.deploymentName, deploymentName(bundleSha256));
  assert.equal(state.deploymentId, null);
  assert.equal(state.deploymentState, 'READY');
  assert.equal(JSON.stringify(state).includes('password'), false);
  assert.equal(JSON.stringify(state).includes('username'), false);
});

test('READY uploads once and persists the deployment ID before polling', async (t) => {
  const { statePath } = await stateFixture(t);
  const calls = [];
  let statusCount = 0;
  const portal = {
    upload: async () => {
      calls.push('upload');
      return deploymentId;
    },
    status: async () => {
      const persisted = await loadDeploymentState(statePath);
      assert.equal(persisted.deploymentId, deploymentId);
      assert.equal(persisted.deploymentState, statusCount === 0 ? 'PENDING' : 'PUBLISHING');
      calls.push('status');
      statusCount += 1;
      return { deploymentState: statusCount === 1 ? 'VALIDATED' : 'PUBLISHED' };
    },
    publish: async () => calls.push('publish'),
  };

  await resumeDeployment({ statePath, portal, pollIntervalMs: 0 });

  assert.deepEqual(calls, ['upload', 'status', 'publish', 'status']);
  assert.equal((await loadDeploymentState(statePath)).deploymentState, 'PUBLISHED');
});

test('PENDING and VALIDATING poll without uploading', async (t) => {
  for (const initial of ['PENDING', 'VALIDATING']) {
    const { statePath } = await stateFixture(t, initial);
    const calls = [];
    const portal = {
      upload: async () => calls.push('upload'),
      status: async () => {
        calls.push('status');
        return { deploymentState: 'PUBLISHED' };
      },
      publish: async () => calls.push('publish'),
    };
    await resumeDeployment({ statePath, portal, pollIntervalMs: 0 });
    assert.deepEqual(calls, ['status']);
  }
});

test('VALIDATED publishes once while PUBLISHING and PUBLISHED never publish again', async (t) => {
  for (const [initial, expected] of [
    ['VALIDATED', ['publish', 'status']],
    ['PUBLISHING', ['status']],
    ['PUBLISHED', []],
  ]) {
    const { statePath } = await stateFixture(t, initial);
    const calls = [];
    const portal = {
      upload: async () => calls.push('upload'),
      status: async () => {
        calls.push('status');
        return { deploymentState: 'PUBLISHED' };
      },
      publish: async () => calls.push('publish'),
    };
    await resumeDeployment({ statePath, portal, pollIntervalMs: 0 });
    assert.deepEqual(calls, expected);
  }
});

test('FAILED and unknown states stop without upload or publication', async (t) => {
  for (const initial of ['FAILED', 'SURPRISE']) {
    const { statePath } = await stateFixture(t, initial);
    const portal = {
      upload: async () => assert.fail('must not upload'),
      status: async () => assert.fail('must not poll'),
      publish: async () => assert.fail('must not publish'),
    };
    await assert.rejects(
      () => resumeDeployment({ statePath, portal, pollIntervalMs: 0 }),
      /FAILED|unknown/i,
    );
  }
});

test('an uncertain initial upload is persisted and cannot upload again automatically', async (t) => {
  const { statePath } = await stateFixture(t);
  const portal = {
    upload: async () => { throw new Error('connection reset'); },
    status: async () => assert.fail('must not poll'),
    publish: async () => assert.fail('must not publish'),
  };

  await assert.rejects(() => resumeDeployment({ statePath, portal, pollIntervalMs: 0 }), /uncertain/i);
  const state = await loadDeploymentState(statePath);
  assert.equal(state.deploymentState, 'UPLOAD_UNCERTAIN');
  assert.equal(state.deploymentId, null);
  await assert.rejects(() => resumeDeployment({ statePath, portal, pollIntervalMs: 0 }), /recovery/i);
});

test('manual recovery adopts only the exact deterministic deployment identity', async (t) => {
  const { statePath, state } = await stateFixture(t);
  state.deploymentState = 'UPLOAD_UNCERTAIN';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const calls = [];
  const portal = {
    upload: async () => assert.fail('recovery must not upload'),
    status: async () => {
      calls.push('status');
      return calls.length === 1
        ? { deploymentState: 'VALIDATING', deploymentName: deploymentName(bundleSha256) }
        : { deploymentState: 'PUBLISHED', deploymentName: deploymentName(bundleSha256) };
    },
    publish: async () => assert.fail('must not publish while validating'),
  };

  const result = await recoverDeployment({ statePath, deploymentId, portal, pollIntervalMs: 0 });

  assert.equal(result.deploymentState, 'PUBLISHED');
  assert.equal(result.deploymentId, deploymentId);
  assert.deepEqual(calls, ['status', 'status']);
});

test('an uncertain publish is persisted and recovery polls before any retry', async (t) => {
  const { statePath } = await stateFixture(t, 'VALIDATED');
  const portal = {
    upload: async () => assert.fail('must not upload'),
    status: async () => ({ deploymentState: 'PUBLISHED', deploymentName: deploymentName(bundleSha256) }),
    publish: async () => { throw new Error('connection reset'); },
  };

  await assert.rejects(() => resumeDeployment({ statePath, portal, pollIntervalMs: 0 }), /uncertain/i);
  assert.equal((await loadDeploymentState(statePath)).deploymentState, 'PUBLISH_UNCERTAIN');

  const recovered = await recoverDeployment({ statePath, deploymentId, portal, pollIntervalMs: 0 });
  assert.equal(recovered.deploymentState, 'PUBLISHED');
});

test('a failed deployment can be superseded only by uploading the preserved bundle', async (t) => {
  const { statePath } = await stateFixture(t);
  const replacementDeploymentId = '87654321-4321-4321-8321-cba987654321';
  const calls = [];
  let replacementPolls = 0;
  const portal = {
    upload: async () => {
      calls.push('upload');
      return replacementDeploymentId;
    },
    status: async (id) => {
      calls.push(`status:${id}`);
      if (id === deploymentId) {
        return { deploymentState: 'FAILED', deploymentName: deploymentName(bundleSha256) };
      }
      replacementPolls += 1;
      return {
        deploymentState: replacementPolls === 1 ? 'VALIDATED' : 'PUBLISHED',
        deploymentName: deploymentName(bundleSha256),
      };
    },
    publish: async (id) => calls.push(`publish:${id}`),
  };

  const result = await retryFailedDeployment({
    statePath,
    failedDeploymentId: deploymentId,
    portal,
    bundlePath: 'preserved-central-bundle.zip',
    pollIntervalMs: 0,
  });

  assert.equal(result.deploymentState, 'PUBLISHED');
  assert.equal(result.deploymentId, replacementDeploymentId);
  assert.equal(result.retryOfDeploymentId, deploymentId);
  assert.deepEqual(calls, [
    `status:${deploymentId}`,
    'upload',
    `status:${replacementDeploymentId}`,
    `publish:${replacementDeploymentId}`,
    `status:${replacementDeploymentId}`,
  ]);
});

test('failed-deployment retry rejects active and identity-mismatched deployments', async (t) => {
  for (const result of [
    { deploymentState: 'VALIDATING', deploymentName: deploymentName(bundleSha256) },
    { deploymentState: 'FAILED', deploymentName: deploymentName('d'.repeat(64)) },
  ]) {
    const { statePath } = await stateFixture(t);
    const portal = {
      upload: async () => assert.fail('must not upload'),
      status: async () => result,
      publish: async () => assert.fail('must not publish'),
    };

    await assert.rejects(
      () => retryFailedDeployment({
        statePath,
        failedDeploymentId: deploymentId,
        portal,
        bundlePath: 'preserved-central-bundle.zip',
        pollIntervalMs: 0,
      }),
      /FAILED|deploymentName/i,
    );
  }
});

test('state loading rejects source, coordinate, version, hash, and UUID drift', async (t) => {
  const { statePath, state } = await stateFixture(t, 'PENDING');
  for (const [field, value] of [
    ['sourceRevision', 'd'.repeat(40)],
    ['packageIdentifier', 'dev.bota:other'],
    ['version', '9.9.9'],
    ['bundleSha256', 'e'.repeat(64)],
    ['inventorySha256', 'f'.repeat(64)],
    ['deploymentId', 'not-a-uuid'],
  ]) {
    await writeFile(statePath, `${JSON.stringify({ ...state, [field]: value })}\n`);
    const expectedError = field === 'bundleSha256' ? /bundleSha256|deploymentName/i : new RegExp(field, 'i');
    await assert.rejects(
      () => loadDeploymentState(statePath, {
        sourceRevision,
        bundleSha256,
        inventorySha256,
      }),
      expectedError,
    );
  }
});

test('Central HTTP errors redact credentials and authorization material', async () => {
  const username = 'central-user-secret';
  const password = 'central-password-secret';
  const authorization = `Bearer ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const client = createCentralPortalClient({
    username,
    password,
    fetchImpl: async () => new Response(`${username} ${password} ${authorization}`, { status: 500 }),
  });

  await assert.rejects(
    () => client.status(deploymentId),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.equal(error.message.includes(username), false);
      assert.equal(error.message.includes(password), false);
      assert.equal(error.message.includes(authorization), false);
      return true;
    },
  );
});

test('public Maven file verification does not require a directory index', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-central-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rawRepository = join(directory, 'android-central-raw');
  const repository = join(directory, 'android-central-portal');
  const inventoryPath = join(directory, 'central-bundle-files.json');
  const bundlePath = join(directory, 'central-bundle.zip');
  const statePath = join(directory, 'central-portal-state.json');
  const libraries = Object.fromEntries(
    ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].flatMap((abi) =>
      ['libbota_android_jni.so', 'libbota_device_sdk_ffi.so'].map((name) => [`jni/${abi}/${name}`, Uint8Array.of(1)])),
  );
  await createRawRepository(rawRepository, { aar: zipSync(libraries) });
  await normalizeCentralRepository({
    rawRepository,
    portalRepository: repository,
    targetRoot: directory,
    coordinate,
    version,
  });
  await buildCentralBundle({
    repository,
    inventory: inventoryPath,
    zip: bundlePath,
    coordinate,
    version,
    sourceRevision,
  });
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const state = createDeploymentState({
    sourceRevision,
    bundleSha256: sha256(await readFile(bundlePath)),
    inventorySha256: sha256(await readFile(inventoryPath)),
  });
  state.deploymentId = deploymentId;
  state.deploymentState = 'PUBLISHED';
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await verifyArchivedRelease({ inventoryPath, bundlePath, statePath, sourceRevision });
  await assert.rejects(
    () => verifyArchivedRelease({ inventoryPath, bundlePath, statePath, sourceRevision: 'f'.repeat(40) }),
    /archived release identity is invalid/,
  );
  const wrongState = { ...state, inventorySha256: '0'.repeat(64) };
  await writeFile(statePath, `${JSON.stringify(wrongState)}\n`);
  await assert.rejects(
    () => verifyArchivedRelease({ inventoryPath, bundlePath, statePath, sourceRevision }),
    /archived release hashes are invalid/,
  );
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const mavenRoot = 'https://maven.example/maven2';
  const prefix = `${mavenRoot}/`;
  const fetchImpl = async (url) => {
    if (url.endsWith('/')) return new Response(null, { status: 404 });
    return new Response(await readFile(join(repository, url.slice(prefix.length))));
  };

  await verifyPublishedArtifacts({
    statePath,
    inventoryPath,
    fetchImpl,
    mavenRoot,
    retryIntervalMs: 0,
    maxAttempts: 1,
  });
  assert.equal(inventory.files.length, 30);

  const names = inventory.files.map((file) => file.path.split('/').at(-1));
  const indexedFetch = async (url) => url.endsWith('/')
    ? new Response([...names, 'unexpected.txt'].map((name) => `<a href="${name}">${name}</a>`).join(''))
    : fetchImpl(url);
  await assert.rejects(
    () => verifyPublishedArtifacts({ statePath, inventoryPath, fetchImpl: indexedFetch, mavenRoot, maxAttempts: 1 }),
    /missing or extra files/,
  );

  const missingFileFetch = async (url) => url.endsWith('.pom')
    ? new Response(null, { status: 404 })
    : fetchImpl(url);
  await assert.rejects(
    () => verifyPublishedArtifacts({
      statePath,
      inventoryPath,
      fetchImpl: missingFileFetch,
      mavenRoot,
      retryIntervalMs: 0,
      maxAttempts: 1,
    }),
    /published Maven files did not synchronize/,
  );
});
