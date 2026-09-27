import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { publicPackageIdentifier } from './package-identities.mjs';

export async function waitForCocoaPodsVersion({
  name, version, fetchImpl = fetch, maxAttempts = 61,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  onWait = () => {},
}) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name ?? '')
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid CocoaPods readiness input');
  }
  const shard = createHash('md5').update(name).digest('hex').slice(0, 3).split('');
  const indexUrl = `https://cdn.cocoapods.org/all_pods_versions_${shard.join('_')}.txt`;
  const specUrl = `https://cdn.cocoapods.org/Specs/${shard.join('/')}/${name}/${version}/${name}.podspec.json`;
  const lookup = async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`CocoaPods CDN lookup failed: HTTP ${response.status}`);
    return response;
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const index = await lookup(indexUrl);
    const versions = index ? (await index.text()).split('\n')
      .map((line) => line.trim().split('/')).find((parts) => parts[0] === name)?.slice(1) : [];
    if (versions?.includes(version)) {
      const response = await lookup(specUrl);
      if (response) {
        const spec = await response.json();
        if (spec?.name !== name || spec?.version !== version) {
          throw new Error('CocoaPods CDN spec identity mismatch');
        }
        return;
      }
    }
    if (attempt + 1 < maxAttempts) {
      onWait(`Waiting for CocoaPods CDN ${name}@${version} (${attempt + 1}/${maxAttempts})`);
      await sleep(30_000);
    }
  }
  throw new Error(`CocoaPods CDN ${name}@${version} not ready after ${maxAttempts} checks; retry verification, not publication`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version] = process.argv.slice(2);
  if (!version || process.argv.length !== 3) throw new Error('usage: wait-cocoapods.mjs <version>');
  await waitForCocoaPodsVersion({
    name: publicPackageIdentifier('apple', version), version, onWait: console.log,
  });
  console.log(`CocoaPods CDN is ready for ${version}`);
}
