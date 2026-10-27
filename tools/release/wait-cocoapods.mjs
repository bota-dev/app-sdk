import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { publicPackageIdentifier } from './package-identities.mjs';

export async function waitForCocoaPodsVersion({
  name, version, fetchImpl = fetch, maxAttempts = 61,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  onWait = () => {},
  checkReady = async () => true,
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
        // A separate CDN client can still see stale metadata. The public
        // consumer must also resolve through its normal CocoaPods install.
        if (await checkReady() === true) return;
      }
    }
    if (attempt + 1 < maxAttempts) {
      onWait(`Waiting for CocoaPods CDN ${name}@${version} (${attempt + 1}/${maxAttempts})`);
      await sleep(30_000);
    }
  }
  throw new Error(`CocoaPods CDN ${name}@${version} not ready after ${maxAttempts} checks; retry verification, not publication`);
}

export function runCocoaPodsInstall(podCommand) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = podCommand;
    // The CLI deliberately selects a local CocoaPods executable; arguments stay literal without a shell.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const child = spawn(command, [...args, 'install', '--repo-update'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(true);
      // CocoaPods reserves 31 for a missing specification. Never retry other
      // installation, archive verification, or build failures as propagation.
      else if (code === 31) resolve(false);
      else reject(new Error(`CocoaPods install failed: ${signal ? `signal ${signal}` : `exit ${code}`}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, separator, ...podCommand] = process.argv.slice(2);
  if (!version || (separator !== undefined && (separator !== '--' || !podCommand.length))) {
    throw new Error('usage: wait-cocoapods.mjs <version> [-- <pod executable> [args...]]');
  }
  await waitForCocoaPodsVersion({
    name: publicPackageIdentifier('apple', version), version, onWait: console.log,
    ...(podCommand.length ? { checkReady: () => runCocoaPodsInstall(podCommand) } : {}),
  });
  console.log(`CocoaPods ${podCommand.length ? 'public install succeeded' : 'CDN is ready'} for ${version}`);
}
