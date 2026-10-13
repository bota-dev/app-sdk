import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { list } from 'tar';

const name = '@bota.dev/react-native-app-sdk-runtime';
const protectedNames = ['@bota.dev/react-native-app-sdk', '@bota.dev/web-app-sdk',
  '@bota.dev/react-native-sdk', '@bota.dev/web-sdk'];
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

async function packageMetadata(bytes) {
  const values = [];
  let invalid = false;
  await new Promise((resolve, reject) => {
    const parser = list({ strict: true, onReadEntry(entry) {
      if (entry.path !== 'package/package.json') return;
      if (entry.type !== 'File' || entry.size > 1_048_576) { invalid = true; return; }
      const chunks = [];
      entry.on('data', chunk => chunks.push(chunk));
      entry.on('end', () => values.push(Buffer.concat(chunks).toString('utf8')));
    } });
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.end(bytes);
  });
  if (invalid || values.length !== 1) throw new Error('npm artifact must contain one regular package.json');
  return JSON.parse(values[0]);
}

// An existing namespace keeps latest unchanged. A previously absent namespace
// may gain latest at this exact first beta because npm can assign it implicitly.
// This first-namespace allowance never changes another package's channels.
export async function publishExactRuntimeNpmArtifact({
  mode, version, expectedSha256, tarball, publish, fetchImpl = fetch,
  maxAttempts = 30, sleep = ms => new Promise(done => setTimeout(done, ms)),
}) {
  if (!['publish', 'verify'].includes(mode)) throw new Error('runtime npm mode must be publish or verify');
  if (typeof version !== 'string' || version !== version.trim()
    || !/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('runtime npm version must match 0.x.y-beta.n');
  }
  if (typeof expectedSha256 !== 'string' || expectedSha256.length !== 64
    || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid expected SHA-256');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 30) throw new Error('invalid retry attempts');
  if (mode === 'publish' && typeof publish !== 'function') throw new Error('publish callback required');
  const stat = await lstat(tarball);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('npm artifact must be a regular file');
  const bytes = await readFile(tarball);
  if (hash(bytes) !== expectedSha256) throw new Error('npm artifact SHA-256 mismatch');
  const metadata = await packageMetadata(bytes);
  if (metadata?.name !== name || metadata.version !== version) throw new Error('npm artifact identity mismatch');
  const sha1 = hash(bytes, 'sha1'), integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
  const request = url => fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const lookup = async path => {
    const response = await request(`https://registry.npmjs.org/${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
    const metadata = await response.json();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid npm registry metadata');
    return metadata;
  };
  const tags = metadata => {
    if (metadata === null) return {};
    const value = metadata?.['dist-tags'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(tag => typeof tag !== 'string')) throw new Error('invalid npm dist-tags');
    return value;
  };
  const snapshots = new Map();
  for (const packageName of protectedNames) snapshots.set(packageName, tags(await lookup(encodeURIComponent(packageName))));
  const namespace = await lookup(encodeURIComponent(name)), before = tags(namespace);
  const guardLatest = after => {
    if (namespace === null ? after.latest !== undefined && after.latest !== version : after.latest !== before.latest) {
      throw new Error('runtime npm latest tag unexpectedly changed');
    }
  };
  const verify = metadata => {
    if (metadata?.name !== name || metadata.version !== version) throw new Error('npm registry artifact identity mismatch');
    if (metadata.dist?.shasum !== sha1 || metadata.dist?.integrity !== integrity) throw new Error('npm registry checksum mismatch');
    if (typeof metadata.dist.tarball !== 'string') throw new Error('invalid public tarball URL');
    const url = new URL(metadata.dist.tarball);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== `/${name}/-/react-native-app-sdk-runtime-${version}.tgz`) {
      throw new Error('invalid public tarball URL');
    }
    return url.href;
  };
  const wait = async (check, message) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await check();
      if (result) return result;
      if (attempt + 1 < maxAttempts) await sleep(10_000);
    }
    throw new Error(`${message} after bounded retries`);
  };
  const errors = [];
  let finalTags;
  try {
    const path = `${encodeURIComponent(name)}/${version}`;
    const existing = await lookup(path);
    if (existing !== null) verify(existing);
    else if (mode === 'publish') {
      if (hash(await readFile(tarball)) !== expectedSha256) throw new Error('npm artifact SHA-256 changed before publication');
      await publish(tarball);
    }
    const publicUrl = await wait(async () => {
      const metadata = await lookup(path);
      return metadata === null ? false : verify(metadata);
    }, mode === 'verify' ? 'runtime npm version is not published' : 'published npm version is not visible');
    await wait(async () => {
      const response = await request(publicUrl);
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`npm tarball download failed: HTTP ${response.status}`);
      if (hash(Buffer.from(await response.arrayBuffer())) !== expectedSha256) throw new Error('public npm tarball SHA-256 mismatch');
      return true;
    }, 'public npm tarball is not visible');
    finalTags = await wait(async () => {
      const after = tags(await lookup(encodeURIComponent(name)));
      guardLatest(after);
      return after.beta === version ? after : false;
    }, 'npm beta tag does not match runtime release');
  } catch (error) { errors.push(error); }
  // Check every namespace even after an uncertain upload or a failed check.
  try {
    const after = tags(await lookup(encodeURIComponent(name)));
    guardLatest(after);
    if (!errors.length && after.beta !== version) throw new Error('npm beta tag changed after verification');
    finalTags = after;
  } catch (error) { errors.push(error); }
  for (const [packageName, before] of snapshots) {
    try {
      if (!isDeepStrictEqual(tags(await lookup(encodeURIComponent(packageName))), before)) {
        throw new Error(`protected npm dist-tags changed: ${packageName}`);
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
  return { name, version, sha256: expectedSha256, sha1, integrity, tags: finalTags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, version, expectedSha256, tarball] = process.argv.slice(2);
  if (!tarball || process.argv.length !== 6) throw new Error('usage: publish-runtime-npm.mjs <publish|verify> <version> <expected-sha256> <tarball>');
  const result = await publishExactRuntimeNpmArtifact({ mode, version, expectedSha256, tarball,
    publish: async file => execFileSync('npx', ['--yes', 'npm@12.0.2', 'publish', file, '--access', 'public', '--tag', 'beta'], { stdio: 'inherit' }),
  });
  console.log(JSON.stringify(result));
}
