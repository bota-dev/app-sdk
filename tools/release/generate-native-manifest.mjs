import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGES = new Map([['apple', 'BotaAppleSDK'], ['android', 'dev.bota:bota-android-sdk']]);

export function generateNativeManifest({ sdkVersion, sourceRevision, artifacts, baseline, compatibility }) {
  requireMatch('SDK version', sdkVersion, VERSION);
  requireMatch('source revision', sourceRevision, REVISION);
  requireDigest('protocol fixture digest', baseline?.fixtureDigest);
  if (compatibility?.sdkVersion !== sdkVersion) throw new Error(`compatibility SDK version ${compatibility?.sdkVersion} does not match ${sdkVersion}`);
  requireMatch('firmware baseline version', compatibility?.firmwareBaseline?.version, VERSION);
  requireMatch('firmware baseline revision', compatibility?.firmwareBaseline?.revision, REVISION);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('native manifest requires at least one artifact');

  const outputArtifacts = artifacts.map((artifact) => {
    if (PACKAGES.get(artifact.platform) !== artifact.packageIdentifier) throw new Error(`package identifier does not match ${artifact.platform}`);
    if (artifact.version !== sdkVersion) throw new Error(`artifact version ${artifact.version} does not match ${sdkVersion}`);
    if (typeof artifact.name !== 'string' || artifact.name === '' || typeof artifact.ecosystem !== 'string' || artifact.ecosystem === '') throw new Error('artifact name and ecosystem are required');
    requireDigest('artifact checksum', artifact.checksumSha256);
    if (!Array.isArray(artifact.capabilities) || artifact.capabilities.length === 0 || new Set(artifact.capabilities).size !== artifact.capabilities.length
        || artifact.capabilities.some((value) => typeof value !== 'string' || value === '')) throw new Error('artifact capabilities must be non-empty and unique');
    if (artifact.platform === 'android') {
      const evidence = artifact.capabilityEvidence;
      if (evidence?.reviewed !== true || typeof evidence.path !== 'string' || !/^release\/evidence\/.+\.md$/.test(evidence.path)) {
        throw new Error('Android capabilities require reviewed evidence');
      }
      if (artifact.ecosystem !== 'maven' || !/^bota-android-sdk-.+\.aar$/.test(artifact.name)) throw new Error('Android Maven artifact is invalid');
    }
    return {
      platform: artifact.platform,
      packageIdentifier: artifact.packageIdentifier,
      name: artifact.name,
      ecosystem: artifact.ecosystem,
      version: artifact.version,
      checksumSha256: artifact.checksumSha256,
      capabilities: [...artifact.capabilities],
    };
  });

  const supportedFirmwareVersions = (compatibility.features ?? [])
    .filter((entry) => entry.status === 'supported' && VERSION.test(entry.earliestKnownFirmware))
    .map((entry) => entry.earliestKnownFirmware).sort(compareVersions);
  return {
    manifestVersion: 2, sdkFamily: 'bota-app-sdk', sdkVersion, sourceRevision,
    protocolFixtureDigest: baseline.fixtureDigest,
    firmwareCompatibility: {
      minimum: supportedFirmwareVersions[0] ?? compatibility.firmwareBaseline.version,
      maximum: compatibility.firmwareBaseline.version,
      baselineRevision: compatibility.firmwareBaseline.revision,
    },
    artifacts: outputArtifacts,
  };
}

export function supportedCompatibilityCapabilities(compatibility) {
  const features = (compatibility.features ?? []).filter((entry) => entry.status === 'supported').map((entry) => entry.feature);
  const workflows = (compatibility.workflows ?? []).filter((entry) => entry.status === 'supported').map((entry) => `workflow_${entry.workflow.replaceAll('-', '_')}`);
  return [...features, ...workflows].sort();
}

function requireDigest(label, value) {
  requireMatch(label, value, SHA256);
  if (/^0+$/.test(value)) throw new Error(`${label} cannot be zero`);
}

function requireMatch(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/, 3).map(Number);
  const b = right.split(/[.-]/, 3).map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return left.localeCompare(right);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument ${argv[index] ?? ''}`);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [baseline, compatibility] = await Promise.all([
    readJson(options.baseline), readJson(options.compatibility),
  ]);
  const evidencePath = options['android-evidence'];
  if (!evidencePath) throw new Error('Android evidence path is required');
  await readFile(evidencePath, 'utf8');
  const artifacts = [{
    platform: 'android',
    packageIdentifier: 'dev.bota:bota-android-sdk',
    name: options['android-artifact'],
    ecosystem: 'maven',
    version: options['sdk-version'],
    checksumSha256: options['artifact-checksum'],
    capabilities: ['android_device_sdk'],
    capabilityEvidence: { reviewed: true, path: 'release/evidence/1.1.0-android-facade.md' },
  }];
  const manifest = generateNativeManifest({ sdkVersion: options['sdk-version'], sourceRevision: options['source-revision'], artifacts, baseline, compatibility });
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readJson(path) {
  if (!path) throw new Error('required JSON path is missing');
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
