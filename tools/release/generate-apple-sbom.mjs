import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function generateAppleSbom({
  sdkVersion,
  sourceRevision,
  artifactChecksum,
  createdAt,
  cargoMetadata,
  swiftDependencies,
}) {
  requireMatch('SDK version', sdkVersion, VERSION);
  requireMatch('source revision', sourceRevision, REVISION);
  requireMatch('artifact checksum', artifactChecksum, SHA256);
  if (/^0+$/.test(artifactChecksum)) throw new Error('artifact checksum cannot be zero');
  const created = normalizeDate(createdAt);

  const cargoPackages = [...(cargoMetadata?.packages ?? [])]
    .sort((left, right) => cargoSortKey(left).localeCompare(cargoSortKey(right)));
  const cargoByID = new Map();
  const packages = cargoPackages.map((entry, index) => {
    const spdxID = `SPDXRef-Cargo-${slug(entry.name)}-${slug(entry.version)}-${index + 1}`;
    cargoByID.set(entry.id, spdxID);
    return {
      SPDXID: spdxID,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: downloadLocation(entry.source),
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: entry.license || 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    };
  });

  const relationships = [];
  for (const node of cargoMetadata?.resolve?.nodes ?? []) {
    const from = cargoByID.get(node.id);
    if (!from) continue;
    const dependencies = node.dependencies ?? (node.deps ?? []).map((entry) => entry.pkg);
    for (const dependency of dependencies) {
      const to = cargoByID.get(dependency);
      if (to) relationships.push(relationship(from, 'DEPENDS_ON', to));
    }
  }

  const swiftPackages = flattenSwiftDependencies(swiftDependencies, sdkVersion);
  const swiftByIdentity = new Map();
  for (const [index, entry] of swiftPackages.entries()) {
    const spdxID = `SPDXRef-Swift-${slug(entry.identity)}-${index + 1}`;
    swiftByIdentity.set(entry.identity, spdxID);
    packages.push({
      SPDXID: spdxID,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: entry.identity === swiftPackages[0].identity ? 'MIT' : 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    });
  }
  for (const entry of swiftPackages) {
    for (const dependency of entry.dependencies) {
      const from = swiftByIdentity.get(entry.identity);
      const to = swiftByIdentity.get(dependency);
      if (from && to) relationships.push(relationship(from, 'DEPENDS_ON', to));
    }
  }

  const rootSwift = swiftByIdentity.get(swiftPackages[0]?.identity);
  const ffi = packages.find((entry) => entry.name === 'bota-device-sdk-ffi')?.SPDXID;
  if (rootSwift && ffi) relationships.push(relationship(rootSwift, 'DEPENDS_ON', ffi));
  if (rootSwift) relationships.push(relationship('SPDXRef-DOCUMENT', 'DESCRIBES', rootSwift));

  relationships.sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `BotaAppleSDK-${sdkVersion}`,
    documentNamespace: `https://bota.dev/spdx/device-sdk/${sdkVersion}/${sourceRevision}`,
    creationInfo: {
      created,
      creators: ['Organization: Bota', 'Tool: generate-apple-sbom.mjs'],
    },
    packages,
    files: [
      {
        SPDXID: 'SPDXRef-File-BotaDeviceSDKCore-XCFramework',
        fileName: 'BotaDeviceSDKCore.xcframework.zip',
        checksums: [{ algorithm: 'SHA256', checksumValue: artifactChecksum }],
        licenseConcluded: 'MIT',
        licenseInfoInFiles: ['MIT'],
        copyrightText: 'Copyright (c) 2026 Bota',
      },
    ],
    relationships,
  };
}

function flattenSwiftDependencies(root, sdkVersion) {
  if (!root || typeof root !== 'object') throw new Error('Swift package metadata is missing');
  const entries = [];
  const visit = (entry) => {
    const identity = entry.identity || entry.name;
    if (!identity || entries.some((item) => item.identity === identity)) return;
    entries.push({
      identity,
      name: entry.name || identity,
      version: entry.version && entry.version !== 'unspecified' ? entry.version : sdkVersion,
      dependencies: (entry.dependencies ?? []).map((dependency) => dependency.identity || dependency.name),
    });
    for (const dependency of entry.dependencies ?? []) visit(dependency);
  };
  visit(root);
  return entries;
}

function cargoSortKey(entry) {
  return `${entry.name}\u0000${entry.version}\u0000${entry.source ?? ''}`;
}

function downloadLocation(source) {
  if (!source || source.startsWith('path+file:')) return 'NOASSERTION';
  return source;
}

function relationship(spdxElementId, relationshipType, relatedSpdxElement) {
  return { spdxElementId, relationshipType, relatedSpdxElement };
}

function relationshipKey(entry) {
  return `${entry.spdxElementId}\u0000${entry.relationshipType}\u0000${entry.relatedSpdxElement}`;
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'package';
}

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('SPDX creation date is invalid');
  return date.toISOString().replace('.000Z', 'Z');
}

function requireMatch(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
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
  const [cargoMetadata, swiftDependencies] = await Promise.all([
    readJson(options['cargo-metadata']),
    readJson(options['swift-dependencies']),
  ]);
  const sbom = generateAppleSbom({
    sdkVersion: options['sdk-version'],
    sourceRevision: options['source-revision'],
    artifactChecksum: options['artifact-checksum'],
    createdAt: options['created-at'],
    cargoMetadata,
    swiftDependencies,
  });
  await writeFile(options.output, `${JSON.stringify(sbom, null, 2)}\n`);
}

async function readJson(path) {
  if (!path) throw new Error('required JSON path is missing');
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
