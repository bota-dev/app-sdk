import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { generateNativeManifest, supportedCompatibilityCapabilities } from './generate-native-manifest.mjs';

export function generateAppleManifest({
  sdkVersion,
  sourceRevision,
  artifactChecksum,
  baseline,
  compatibility,
}) {
  const capabilities = supportedCompatibilityCapabilities(compatibility);
  if (capabilities.length === 0) throw new Error('Apple artifact has no proven capabilities');
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('Apple artifact capabilities must be unique');
  }

  return generateNativeManifest({
    sdkVersion, sourceRevision, baseline, compatibility,
    artifacts: [{
        name: 'BotaDeviceSDKCore.xcframework.zip',
        ecosystem: 'swiftpm',
        platform: 'apple',
        packageIdentifier: 'BotaAppleSDK',
        version: sdkVersion,
        checksumSha256: artifactChecksum,
        capabilities,
    }],
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key ?? ''}`);
    options[key.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [baseline, compatibility] = await Promise.all([
    readJson(options.baseline),
    readJson(options.compatibility),
  ]);
  const manifest = generateAppleManifest({
    sdkVersion: options['sdk-version'],
    sourceRevision: options['source-revision'],
    artifactChecksum: options['artifact-checksum'],
    baseline,
    compatibility,
  });
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readJson(path) {
  if (!path) throw new Error('required JSON path is missing');
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
