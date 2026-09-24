import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { list } from 'tar';
import { publicPackageIdentifier } from './package-identities.mjs';
import { loadPolicy, resolveReleaseChannel } from './resolve-release-channel.mjs';

export async function publishExactNpmArtifact({
  platform, version, packageMetadata, shasum, publish, fetchImpl = fetch,
  maxAttempts = 30, sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  if (!['react-native', 'web'].includes(platform)) throw new Error('unsupported npm platform');
  resolveReleaseChannel({ ref: `v${version}`, mode: 'recovery', policy: await loadPolicy() });
  const name = publicPackageIdentifier(platform, version);
  if (packageMetadata?.name !== name || packageMetadata?.version !== version) throw new Error('npm artifact identity does not match release');
  if (!/^[a-f0-9]{40}$/.test(shasum)) throw new Error('npm artifact checksum is invalid');
  const legacyName = publicPackageIdentifier(platform, '1.1.0');
  const lookup = async (path) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
    return response.json();
  };
  const tags = async (packageName) => {
    const metadata = await lookup(encodeURIComponent(packageName));
    if (metadata === null) return {};
    if (!metadata['dist-tags'] || typeof metadata['dist-tags'] !== 'object') throw new Error('npm registry dist-tags are invalid');
    return metadata['dist-tags'];
  };
  const before = await tags(name);
  const historicalBefore = name !== legacyName ? await tags(legacyName) : null;
  const verify = (metadata) => {
    if (metadata.name !== name || metadata.version !== version) throw new Error('npm registry artifact identity mismatch');
    if (metadata.dist?.shasum !== shasum) throw new Error('npm registry checksum mismatch');
  };
  const path = `${encodeURIComponent(name)}/${version}`;
  const existing = await lookup(path);
  if (existing) verify(existing);
  else await publish();

  let visible = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const metadata = await lookup(path);
    if (metadata) { verify(metadata); visible = true; break; }
    if (attempt + 1 < maxAttempts) await sleep(10_000);
  }
  if (!visible) throw new Error('published npm version is not visible after bounded retries');
  const after = await tags(name);
  if (after.latest !== before.latest) throw new Error('npm latest tag unexpectedly changed');
  if (after.beta !== version) throw new Error('npm beta tag does not match release');
  if (historicalBefore && !isDeepStrictEqual(await tags(legacyName), historicalBefore)) {
    throw new Error('historical npm dist-tags changed during new-name publication');
  }
}

async function packageMetadata(file) {
  const values = [];
  let invalid = false;
  await list({ file, strict: true, onReadEntry(entry) {
    if (entry.path !== 'package/package.json') { entry.resume(); return; }
    if (entry.type !== 'File' || entry.size > 1_048_576) { invalid = true; entry.resume(); return; }
    const chunks = [];
    entry.on('data', (chunk) => chunks.push(chunk));
    entry.on('end', () => values.push(Buffer.concat(chunks).toString('utf8')));
  } });
  if (invalid || values.length !== 1) throw new Error('npm artifact must contain one regular package.json');
  return JSON.parse(values[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [platform, version, file] = process.argv.slice(2);
  if (!file || process.argv.length !== 5) throw new Error('usage: publish-npm.mjs <react-native|web> <version> <tarball>');
  await publishExactNpmArtifact({
    platform, version, packageMetadata: await packageMetadata(file),
    shasum: createHash('sha1').update(await readFile(file)).digest('hex'),
    publish: async () => execFileSync('npx', ['--yes', 'npm@12.0.2', 'publish', file, '--access', 'public', '--tag', 'beta'], { stdio: 'inherit' }),
  });
  console.log(`Verified ${publicPackageIdentifier(platform, version)}@${version}`);
}
