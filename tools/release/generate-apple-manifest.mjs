import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function generateAppleManifest({
  sdkVersion,
  sourceRevision,
  artifactChecksum,
  baseline,
  compatibility,
}) {
  requireMatch('SDK version', sdkVersion, VERSION);
  requireMatch('source revision', sourceRevision, REVISION);
  requireDigest('artifact checksum', artifactChecksum);
  requireDigest('protocol fixture digest', baseline?.fixtureDigest);
  if (compatibility?.sdkVersion !== sdkVersion) {
    throw new Error(`compatibility SDK version ${compatibility?.sdkVersion} does not match ${sdkVersion}`);
  }
  requireMatch('firmware baseline version', compatibility?.firmwareBaseline?.version, VERSION);
  requireMatch('firmware baseline revision', compatibility?.firmwareBaseline?.revision, REVISION);

  const supportedFeatures = (compatibility.features ?? [])
    .filter((entry) => entry.status === 'supported')
    .map((entry) => entry.feature);
  const supportedWorkflows = (compatibility.workflows ?? [])
    .filter((entry) => entry.status === 'supported')
    .map((entry) => `workflow_${entry.workflow.replaceAll('-', '_')}`);
  const capabilities = [...supportedFeatures, ...supportedWorkflows].sort();
  if (capabilities.length === 0) throw new Error('Apple artifact has no proven capabilities');
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('Apple artifact capabilities must be unique');
  }

  const supportedFirmwareVersions = (compatibility.features ?? [])
    .filter((entry) => entry.status === 'supported')
    .map((entry) => entry.earliestKnownFirmware)
    .filter((value) => VERSION.test(value));
  const minimum = supportedFirmwareVersions.sort(compareVersions)[0]
    ?? compatibility.firmwareBaseline.version;

  return {
    manifestVersion: 2,
    sdkFamily: 'bota-app-sdk',
    sdkVersion,
    sourceRevision,
    protocolFixtureDigest: baseline.fixtureDigest,
    firmwareCompatibility: {
      minimum,
      maximum: compatibility.firmwareBaseline.version,
      baselineRevision: compatibility.firmwareBaseline.revision,
    },
    artifacts: [
      {
        name: 'BotaDeviceSDKCore.xcframework.zip',
        ecosystem: 'swiftpm',
        platform: 'apple',
        packageIdentifier: 'BotaAppleSDK',
        version: sdkVersion,
        checksumSha256: artifactChecksum,
        capabilities,
      },
    ],
  };
}

function requireDigest(label, value) {
  requireMatch(label, value, SHA256);
  if (/^0+$/.test(value)) throw new Error(`${label} cannot be zero`);
}

function requireMatch(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/, 3).map(Number);
  const b = right.split(/[.-]/, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.localeCompare(right);
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
