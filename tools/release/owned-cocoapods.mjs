import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicPackageIdentifier } from './package-identities.mjs';

export const specsRepository = Object.freeze({
  gitUrl: 'https://github.com/bota-dev/cocoapods-specs.git',
  branch: 'main',
});
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const MAX_SPEC_BYTES = 65_536;
const digest = body => createHash('sha256').update(body).digest('hex');

function ordered(value, depth = 0) {
  if (depth > 32) throw new Error('podspec nesting limit exceeded');
  if (Array.isArray(value)) return value.map(item => ordered(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    for (const key of ['prepare_command', 'script_phases']) {
      if (Object.hasOwn(value, key)) throw new Error('script-bearing podspec is not supported');
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key], depth + 1)]));
  }
  return value;
}

export function ownedSpecPath(sdkVersion) {
  if (typeof sdkVersion !== 'string' || !VERSION.test(sdkVersion)) throw new Error('invalid SDK version');
  const name = publicPackageIdentifier('apple', sdkVersion);
  return `Specs/${name}/${sdkVersion}/${name}.podspec.json`;
}

export function canonicalPodspec({ spec, sdkVersion, artifactChecksum }) {
  ownedSpecPath(sdkVersion);
  if (!/^[0-9a-f]{64}$/.test(artifactChecksum ?? '') || /^0+$/.test(artifactChecksum)) {
    throw new Error('nonzero lowercase archive SHA-256 is required');
  }
  const name = publicPackageIdentifier('apple', sdkVersion);
  const source = `https://github.com/bota-dev/app-sdk/releases/download/v${sdkVersion}/${name}.cocoapods.zip`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || spec.name !== name || spec.version !== sdkVersion
    || spec.source?.http !== source || spec.source?.sha256 !== artifactChecksum
    || Object.keys(spec.source).some(key => !['http', 'sha256'].includes(key))) {
    throw new Error('podspec identity or immutable archive mismatch');
  }
  const result = JSON.stringify(ordered(spec), null, 2) + '\n';
  if (Buffer.byteLength(result) > MAX_SPEC_BYTES) throw new Error('podspec size limit exceeded');
  return result;
}

export async function stageOwnedPodspec({ checkout, ...options }) {
  const contents = canonicalPodspec(options);
  const relativePath = ownedSpecPath(options.sdkVersion);
  const root = await realpath(checkout);
  const parts = relativePath.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('podspec path contains a symlink or non-directory');
  }
  const destination = join(root, ...parts);
  let created = false;
  try {
    await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(destination, 'utf8') !== contents) {
      throw new Error('occupied podspec differs; replacing published versions is forbidden');
    }
  }
  return { created, path: relativePath, sha256: digest(contents) };
}

async function boundedBody(response) {
  if (!response.body) throw new Error('empty owned-spec response');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SPEC_BYTES) throw new Error('podspec size limit exceeded');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function verifyOwnedPodspec({ fetchImpl = fetch, ...options }) {
  const contents = canonicalPodspec(options);
  const relativePath = ownedSpecPath(options.sdkVersion);
  const url = `https://raw.githubusercontent.com/bota-dev/cocoapods-specs/main/${relativePath}`;
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200 || response.redirected) throw new Error(`owned Specs lookup failed: HTTP ${response.status}`);
  if (await boundedBody(response) !== contents) throw new Error('public owned podspec differs from the approved spec');
  return { path: relativePath, sha256: digest(contents) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, sdkVersion, artifactChecksum, file, checkout, ...extra] = process.argv.slice(2);
  if (extra.length || !file || !['stage', 'verify-public'].includes(command)
    || (command === 'stage' ? !checkout : checkout !== undefined)) {
    throw new Error('usage: owned-cocoapods.mjs <stage|verify-public> <version> <archive-sha256> <podspec.json> [index-checkout]');
  }
  const input = await readFile(file);
  if (input.byteLength > MAX_SPEC_BYTES) throw new Error('podspec size limit exceeded');
  const options = { sdkVersion, artifactChecksum, spec: JSON.parse(input) };
  const result = command === 'stage' ? await stageOwnedPodspec({ ...options, checkout }) : await verifyOwnedPodspec(options);
  console.log(JSON.stringify(result));
}
