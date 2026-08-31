import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { unzipSync } from 'fflate';

import { inspectZip, verifyCentralBundle } from './build-central-bundle.mjs';
import { primaryFiles, validatePublishedMetadata } from './normalize-central-repository.mjs';

const PACKAGE_IDENTIFIER = 'dev.bota:bota-android-sdk';
const VERSION = '1.1.0';
const API_ROOT = 'https://central.sonatype.com/api/v1/publisher';
const MAVEN_ROOT = 'https://repo1.maven.org/maven2';
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PORTAL_STATES = new Set(['PENDING', 'VALIDATING', 'VALIDATED', 'PUBLISHING', 'PUBLISHED', 'FAILED']);

export function deploymentName(bundleSha256) {
  requireMatch('bundleSha256', bundleSha256, SHA256);
  return `bota-android-sdk-${VERSION}-${bundleSha256.slice(0, 16)}`;
}

export function createDeploymentState({ sourceRevision, bundleSha256, inventorySha256, now = new Date() }) {
  requireMatch('sourceRevision', sourceRevision, REVISION);
  requireMatch('bundleSha256', bundleSha256, SHA256);
  requireMatch('inventorySha256', inventorySha256, SHA256);
  return {
    schemaVersion: 1,
    packageIdentifier: PACKAGE_IDENTIFIER,
    version: VERSION,
    sourceRevision,
    bundleSha256,
    inventorySha256,
    deploymentName: deploymentName(bundleSha256),
    deploymentId: null,
    deploymentState: 'READY',
    updatedAt: now.toISOString(),
  };
}

export async function loadDeploymentState(path, expected = {}) {
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read deployment state: ${error.message}`);
  }
  validateDeploymentState(state);
  for (const field of ['sourceRevision', 'bundleSha256', 'inventorySha256']) {
    if (expected[field] !== undefined && state[field] !== expected[field]) {
      throw new Error(`${field} does not match the expected release input`);
    }
  }
  return state;
}

export async function persistDeploymentState(path, state) {
  validateDeploymentState(state);
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(target), { recursive: true });
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
  const directory = await open(dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function createCentralPortalClient({ username, password, fetchImpl = fetch, apiRoot = API_ROOT }) {
  if (!username || !password) throw new Error('Central credentials are required');
  const authorization = `Bearer ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const redact = (value) => [authorization, username, password]
    .reduce((output, secret) => output.replaceAll(secret, '[REDACTED]'), String(value));
  const request = async (path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(`${apiRoot}${path}`, {
        ...options,
        headers: { authorization, ...options.headers },
      });
    } catch (error) {
      throw new Error(`Central request failed before a response: ${redact(error.message)}`);
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(`Central request failed with HTTP ${response.status}: ${redact(body)}`);
    }
    return response;
  };
  return {
    async upload({ bundlePath, name }) {
      const form = new FormData();
      form.set('bundle', new Blob([await readFile(bundlePath)]), 'central-bundle.zip');
      const response = await request(`/upload?name=${encodeURIComponent(name)}&publishingType=USER_MANAGED`, {
        method: 'POST',
        body: form,
      });
      const id = (await response.text()).trim();
      requireMatch('deploymentId', id, UUID);
      return id;
    },
    async status(id) {
      requireMatch('deploymentId', id, UUID);
      const response = await request(`/status?id=${encodeURIComponent(id)}`, { method: 'POST' });
      const status = await response.json();
      if (!PORTAL_STATES.has(status.deploymentState)) {
        throw new Error(`Central returned unknown deploymentState ${status.deploymentState}`);
      }
      return status;
    },
    async publish(id) {
      requireMatch('deploymentId', id, UUID);
      await request(`/deployment/${encodeURIComponent(id)}`, { method: 'POST' });
    },
  };
}

export async function resumeDeployment({
  statePath,
  portal,
  bundlePath,
  pollIntervalMs = 5_000,
  maxPolls = 180,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  let state = await loadDeploymentState(statePath);
  let polls = 0;
  while (state.deploymentState !== 'PUBLISHED') {
    if (state.deploymentState === 'FAILED') {
      throw new Error(`Central deployment ${state.deploymentId ?? '(unassigned)'} is FAILED`);
    }
    if (state.deploymentState === 'READY') {
      let deploymentId;
      try {
        deploymentId = await portal.upload({ bundlePath, name: state.deploymentName });
      } catch (error) {
        await transition(statePath, state, { deploymentState: 'UPLOAD_UNCERTAIN' }, now);
        throw new Error(`Central upload outcome is uncertain; use protected recovery: ${error.message}`);
      }
      requireMatch('deploymentId', deploymentId, UUID);
      state = await transition(statePath, state, { deploymentId, deploymentState: 'PENDING' }, now);
      continue;
    }
    if (state.deploymentState === 'UPLOAD_UNCERTAIN') {
      throw new Error('Central upload outcome requires protected recovery with the deployment ID');
    }
    if (state.deploymentState === 'VALIDATED') {
      try {
        await portal.publish(state.deploymentId);
      } catch (error) {
        await transition(statePath, state, { deploymentState: 'PUBLISH_UNCERTAIN' }, now);
        throw new Error(`Central publish outcome is uncertain; use protected recovery: ${error.message}`);
      }
      state = await transition(statePath, state, { deploymentState: 'PUBLISHING' }, now);
      continue;
    }
    if (state.deploymentState === 'PUBLISH_UNCERTAIN') {
      throw new Error('Central publish outcome requires protected recovery with the deployment ID');
    }
    if (!['PENDING', 'VALIDATING', 'PUBLISHING'].includes(state.deploymentState)) {
      throw new Error(`unknown deploymentState ${state.deploymentState}`);
    }
    if (polls >= maxPolls) throw new Error(`Central deployment polling timed out after ${maxPolls} attempts`);
    if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    const result = await portal.status(state.deploymentId);
    polls += 1;
    requirePortalIdentity(result, state);
    if (!PORTAL_STATES.has(result.deploymentState)) {
      throw new Error(`Central returned unknown deploymentState ${result.deploymentState}`);
    }
    state = await transition(statePath, state, {
      deploymentState: result.deploymentState,
      ...(result.deploymentState === 'FAILED' ? { errors: sanitizeErrors(result.errors) } : {}),
    }, now);
  }
  return state;
}

export async function recoverDeployment({
  statePath,
  deploymentId,
  portal,
  pollIntervalMs = 5_000,
  maxPolls = 180,
  now = () => new Date(),
  sleep,
}) {
  requireMatch('deploymentId', deploymentId, UUID);
  let state = await loadDeploymentState(statePath);
  if (state.deploymentId !== null && state.deploymentId !== deploymentId) {
    throw new Error('deploymentId does not match the persisted deployment');
  }
  if (state.deploymentId === null) {
    if (!['READY', 'UPLOAD_UNCERTAIN'].includes(state.deploymentState)) {
      throw new Error('deploymentId is missing from a state that cannot be recovered');
    }
    const result = await portal.status(deploymentId);
    requirePortalIdentity(result, state, true);
    state = await transition(statePath, state, {
      deploymentId,
      deploymentState: result.deploymentState,
      ...(result.deploymentState === 'FAILED' ? { errors: sanitizeErrors(result.errors) } : {}),
    }, now);
  } else if (state.deploymentState === 'PUBLISH_UNCERTAIN') {
    const result = await portal.status(deploymentId);
    requirePortalIdentity(result, state, true);
    state = await transition(statePath, state, {
      deploymentState: result.deploymentState,
      ...(result.deploymentState === 'FAILED' ? { errors: sanitizeErrors(result.errors) } : {}),
    }, now);
  }
  return resumeDeployment({ statePath, portal, pollIntervalMs, maxPolls, now, ...(sleep ? { sleep } : {}) });
}

export async function verifyArchivedBundle({ inventoryPath, bundlePath }) {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateInventory(inventory);
  const archive = unzipSync(await readFile(bundlePath));
  const entries = await inspectZip(bundlePath);
  if (entries.length !== inventory.files.length) throw new Error('bundle ZIP entry count does not match inventory');
  for (let index = 0; index < inventory.files.length; index += 1) {
    const expected = inventory.files[index];
    const entry = entries[index];
    if (entry.path !== expected.path || entry.directory || entry.mode !== 0o644
        || entry.timestamp !== '1980-01-01T00:00:00.000Z' || entry.extraFieldLength !== 0
        || entry.commentLength !== 0 || entry.os !== 3) {
      throw new Error(`bundle ZIP metadata does not match inventory for ${expected.path}`);
    }
    const bytes = archive[expected.path];
    if (!bytes || bytes.length !== expected.byteLength || digest(bytes) !== expected.sha256) {
      throw new Error(`bundle ZIP bytes do not match inventory for ${expected.path}`);
    }
  }
  return inventory;
}

export async function verifyPublishedArtifacts({
  statePath,
  inventoryPath,
  fetchImpl = fetch,
  mavenRoot = MAVEN_ROOT,
  retryIntervalMs = 10_000,
  maxAttempts = 60,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const state = await loadDeploymentState(statePath);
  if (state.deploymentState !== 'PUBLISHED') throw new Error('Central deployment is not PUBLISHED');
  const inventoryBytes = await readFile(inventoryPath);
  if (digest(inventoryBytes) !== state.inventorySha256) throw new Error('inventorySha256 is invalid');
  const inventory = JSON.parse(inventoryBytes);
  validateInventory(inventory, state.sourceRevision);
  const versionPrefix = `dev/bota/bota-android-sdk/${VERSION}/`;
  const expectedNames = inventory.files.map((file) => {
    if (!file.path.startsWith(versionPrefix)) throw new Error('inventory path is outside the release coordinate');
    return file.path.slice(versionPrefix.length);
  });
  const directoryUrl = `${mavenRoot.replace(/\/$/, '')}/${versionPrefix}`;
  let downloaded;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const directoryResponse = await fetchImpl(directoryUrl);
    if (directoryResponse.status === 404) {
      if (attempt === maxAttempts) throw new Error('published Maven directory did not synchronize before timeout');
      if (retryIntervalMs > 0) await sleep(retryIntervalMs);
      continue;
    }
    if (!directoryResponse.ok) throw new Error(`published Maven directory returned HTTP ${directoryResponse.status}`);
    const names = directoryEntries(await directoryResponse.text());
    const expectedSorted = [...expectedNames].sort();
    if (names.length !== expectedSorted.length || names.some((name, index) => name !== expectedSorted[index])) {
      throw new Error('published Maven directory has missing or extra files');
    }
    downloaded = new Map();
    let pending404 = false;
    for (const file of inventory.files) {
      const response = await fetchImpl(`${mavenRoot.replace(/\/$/, '')}/${file.path}`);
      if (response.status === 404) {
        pending404 = true;
        break;
      }
      if (!response.ok) throw new Error(`${file.path} returned HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.byteLength || digest(bytes) !== file.sha256) {
        throw new Error(`${file.path} does not match the signed release inventory`);
      }
      downloaded.set(basename(file.path), bytes);
    }
    if (pending404) {
      if (attempt === maxAttempts) throw new Error('published Maven files did not synchronize before timeout');
      if (retryIntervalMs > 0) await sleep(retryIntervalMs);
      continue;
    }
    break;
  }
  if (!downloaded) throw new Error('published Maven verification did not complete');
  await verifyDownloadedMavenFiles(downloaded);
}

function validateDeploymentState(state) {
  if (!state || state.schemaVersion !== 1) throw new Error('schemaVersion is invalid');
  if (state.packageIdentifier !== PACKAGE_IDENTIFIER) throw new Error('packageIdentifier is invalid');
  if (state.version !== VERSION) throw new Error('version is invalid');
  requireMatch('sourceRevision', state.sourceRevision, REVISION);
  requireMatch('bundleSha256', state.bundleSha256, SHA256);
  requireMatch('inventorySha256', state.inventorySha256, SHA256);
  if (state.deploymentName !== deploymentName(state.bundleSha256)) throw new Error('deploymentName is invalid');
  if (!['READY', 'UPLOAD_UNCERTAIN', 'PUBLISH_UNCERTAIN', ...PORTAL_STATES].includes(state.deploymentState)) throw new Error('deploymentState is unknown');
  if (['READY', 'UPLOAD_UNCERTAIN'].includes(state.deploymentState)) {
    if (state.deploymentId !== null) throw new Error('deploymentId must be null for READY state');
  } else {
    requireMatch('deploymentId', state.deploymentId, UUID);
  }
  if (typeof state.updatedAt !== 'string' || Number.isNaN(Date.parse(state.updatedAt))) {
    throw new Error('updatedAt is invalid');
  }
}

function validateInventory(inventory, expectedRevision) {
  if (!inventory || inventory.schemaVersion !== 1 || inventory.coordinate !== PACKAGE_IDENTIFIER
      || inventory.version !== VERSION || !REVISION.test(inventory.sourceRevision)
      || (expectedRevision !== undefined && inventory.sourceRevision !== expectedRevision)
      || !Array.isArray(inventory.files) || inventory.files.length !== 30) {
    throw new Error('Central bundle inventory is invalid');
  }
  const prefix = `dev/bota/bota-android-sdk/${VERSION}/`;
  const expectedPaths = primaryFiles('bota-android-sdk', VERSION).flatMap((name) => [
    `${prefix}${name}`,
    `${prefix}${name}.asc`,
    ...['md5', 'sha1', 'sha256', 'sha512'].map((algorithm) => `${prefix}${name}.${algorithm}`),
  ]).sort();
  let previous = '';
  for (let index = 0; index < inventory.files.length; index += 1) {
    const file = inventory.files[index];
    const expectedRole = file.path.endsWith('.asc')
      ? 'signature'
      : /\.(md5|sha1|sha256|sha512)$/.test(file.path) ? 'checksum' : 'primary';
    if (typeof file.path !== 'string' || file.path <= previous || file.path.includes('..')
        || file.path !== expectedPaths[index] || file.role !== expectedRole
        || !Number.isInteger(file.byteLength) || file.byteLength < 0 || !SHA256.test(file.sha256)) {
      throw new Error('Central bundle inventory file is invalid');
    }
    previous = file.path;
  }
}

function requirePortalIdentity(result, state, required = false) {
  if (required && result.deploymentName !== state.deploymentName) {
    throw new Error('Central deploymentName does not match the deterministic release identity');
  }
  if (result.deploymentName !== undefined && result.deploymentName !== state.deploymentName) {
    throw new Error('Central deploymentName does not match the persisted release identity');
  }
}

function directoryEntries(html) {
  const names = [];
  for (const match of html.matchAll(/href="([^"?#/]+)"/g)) names.push(decodeURIComponent(match[1]));
  return [...new Set(names)].sort();
}

async function verifyDownloadedMavenFiles(files) {
  const primary = primaryFiles('bota-android-sdk', VERSION);
  for (const name of primary) if (!files.has(name)) throw new Error(`published Maven primary ${name} is missing`);
  const aar = unzipSync(files.get(`bota-android-sdk-${VERSION}.aar`));
  const expectedLibraries = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
    .flatMap((abi) => ['libbota_android_jni.so', 'libbota_device_sdk_ffi.so'].map((library) => `jni/${abi}/${library}`))
    .sort();
  const actualLibraries = Object.keys(aar).filter((path) => path.startsWith('jni/') && path.endsWith('.so')).sort();
  if (actualLibraries.length !== expectedLibraries.length
      || actualLibraries.some((path, index) => path !== expectedLibraries[index])) {
    throw new Error('published AAR native ABI inventory is invalid');
  }
  const directory = await mkdtemp(join(tmpdir(), 'bota-published-maven-'));
  try {
    for (const name of primary) await writeFile(join(directory, name), files.get(name));
    await validatePublishedMetadata({ repository: directory, coordinate: PACKAGE_IDENTIFIER, version: VERSION });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function transition(path, state, changes, now) {
  const next = { ...state, ...changes, updatedAt: now().toISOString() };
  await persistDeploymentState(path, next);
  return next;
}

function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => String(error).slice(0, 1000));
}

function requireMatch(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} is invalid`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error(`invalid argument ${argv[index] ?? ''}`);
    }
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!['prepare', 'upload-or-resume', 'recover-and-resume', 'verify-published'].includes(command)) {
    throw new Error('usage: central-portal.mjs <prepare|upload-or-resume|recover-and-resume|verify-published> [options]');
  }
  if (command === 'prepare') {
    await verifyCentralBundle({ repository: options.repository, inventory: options.inventory, zip: options.bundle });
    const bundleSha256 = digest(await readFile(options.bundle));
    const inventorySha256 = digest(await readFile(options.inventory));
    const inventory = JSON.parse(await readFile(options.inventory, 'utf8'));
    if (inventory.coordinate !== PACKAGE_IDENTIFIER) throw new Error('inventory coordinate is invalid');
    if (inventory.version !== VERSION) throw new Error('inventory version is invalid');
    if (inventory.sourceRevision !== options['source-revision']) throw new Error('inventory sourceRevision is invalid');
    await persistDeploymentState(options.state, createDeploymentState({
      sourceRevision: options['source-revision'],
      bundleSha256,
      inventorySha256,
    }));
    return;
  }
  if (command === 'verify-published') {
    await verifyPublishedArtifacts({ statePath: options.state, inventoryPath: options.inventory });
    return;
  }
  const portal = createCentralPortalClient({
    username: process.env.MAVEN_CENTRAL_USERNAME,
    password: process.env.MAVEN_CENTRAL_PASSWORD,
  });
  if (command === 'recover-and-resume') {
    if (options['release-ref'] !== `refs/tags/v${VERSION}`) throw new Error('releaseRef is invalid');
    await verifyArchivedBundle({ inventoryPath: options.inventory, bundlePath: options.bundle });
    const state = await loadDeploymentState(options.state);
    const inventory = JSON.parse(await readFile(options.inventory, 'utf8'));
    validateInventory(inventory, state.sourceRevision);
    if (digest(await readFile(options.bundle)) !== state.bundleSha256) throw new Error('bundleSha256 is invalid');
    if (digest(await readFile(options.inventory)) !== state.inventorySha256) throw new Error('inventorySha256 is invalid');
    await recoverDeployment({ statePath: options.state, deploymentId: options['deployment-id'], portal });
    return;
  }
  const state = await loadDeploymentState(options.state);
  if (state.sourceRevision !== options['source-revision']) throw new Error('state sourceRevision is invalid');
  if (digest(await readFile(options.bundle)) !== state.bundleSha256) throw new Error('bundleSha256 is invalid');
  if (digest(await readFile(options.inventory)) !== state.inventorySha256) throw new Error('inventorySha256 is invalid');
  await verifyCentralBundle({ repository: options.repository, inventory: options.inventory, zip: options.bundle });
  await resumeDeployment({ statePath: options.state, portal, bundlePath: options.bundle });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
