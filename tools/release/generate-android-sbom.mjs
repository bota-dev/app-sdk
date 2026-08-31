import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { unzipSync } from 'fflate';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const LIBRARIES = ['libbota_android_jni.so', 'libbota_device_sdk_ffi.so'];

export function generateAndroidSbom({ sdkVersion, sourceRevision, artifactChecksum, createdAt, aarEntries, cargoPackages, gradleDependencies }) {
  requireMatch('SDK version', sdkVersion, VERSION);
  requireMatch('source revision', sourceRevision, REVISION);
  requireDigest('artifact checksum', artifactChecksum);
  const created = normalizeDate(createdAt);
  const entries = [...(aarEntries ?? [])].sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const abi of ABIS) {
    for (const library of LIBRARIES) {
      const path = `jni/${abi}/${library}`;
      const entry = byPath.get(path);
      if (!entry) throw new Error(`Android AAR is missing native ABI entry ${path}`);
      requireDigest(`native entry ${path} checksum`, entry.sha256);
    }
  }

  const packages = [{
    SPDXID: 'SPDXRef-Package-BotaAndroidSDK', name: 'BotaAndroidSDK', versionInfo: sdkVersion,
    downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'MIT',
    licenseDeclared: 'MIT', copyrightText: 'Copyright (c) 2026 Bota',
  }];
  const packageIDs = new Map([['BotaAndroidSDK', 'SPDXRef-Package-BotaAndroidSDK']]);
  for (const entry of [...(cargoPackages ?? []), ...(gradleDependencies ?? [])]
    .sort((a, b) => `${a.name}\0${a.version}`.localeCompare(`${b.name}\0${b.version}`))) {
    requireMatch(`${entry.name} version`, entry.version, VERSION);
    const id = `SPDXRef-Package-${slug(entry.name)}-${slug(entry.version)}`;
    packageIDs.set(entry.name, id);
    packages.push({
      SPDXID: id, name: entry.name, versionInfo: entry.version, downloadLocation: 'NOASSERTION',
      filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: entry.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    });
  }
  for (const required of ['bota-device-sdk-core', 'bota-device-sdk-ffi']) {
    if (!packageIDs.has(required)) throw new Error(`Android SBOM is missing ${required}`);
  }

  const relationships = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-BotaAndroidSDK' }];
  for (const dependency of [...(gradleDependencies ?? []), { name: 'bota-device-sdk-ffi' }]) {
    relationships.push({ spdxElementId: 'SPDXRef-Package-BotaAndroidSDK', relationshipType: 'DEPENDS_ON', relatedSpdxElement: packageIDs.get(dependency.name) });
  }
  relationships.push({ spdxElementId: packageIDs.get('bota-device-sdk-ffi'), relationshipType: 'DEPENDS_ON', relatedSpdxElement: packageIDs.get('bota-device-sdk-core') });
  relationships.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const files = [{
    SPDXID: 'SPDXRef-File-BotaAndroidSDK-AAR', fileName: `bota-android-sdk-${sdkVersion}.aar`,
    checksums: [{ algorithm: 'SHA256', checksumValue: artifactChecksum }], licenseConcluded: 'MIT',
    licenseInfoInFiles: ['MIT'], copyrightText: 'Copyright (c) 2026 Bota',
  }, ...entries.map((entry, index) => ({
    SPDXID: `SPDXRef-File-Native-${index + 1}`, fileName: entry.path,
    checksums: [{ algorithm: 'SHA256', checksumValue: entry.sha256 }], licenseConcluded: 'MIT',
    licenseInfoInFiles: ['MIT'], copyrightText: 'Copyright (c) 2026 Bota',
  }))];

  const result = {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: `BotaAndroidSDK-${sdkVersion}`,
    documentNamespace: `https://bota.dev/spdx/app-sdk/android/${sdkVersion}/${sourceRevision}`,
    creationInfo: { created, creators: ['Organization: Bota', 'Tool: generate-android-sbom.mjs'] },
    packages, files, relationships,
  };
  if (/\/(?:Users|private|home)\//.test(JSON.stringify(result))) throw new Error('Android SBOM contains a local path');
  return result;
}

function requireDigest(label, value) {
  requireMatch(label, value, SHA256);
  if (/^0+$/.test(value)) throw new Error(`${label} cannot be zero`);
}

function requireMatch(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('SPDX creation date is invalid');
  return date.toISOString().replace('.000Z', 'Z');
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'package';
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
  const [aarBytes, cargoMetadata, gradleModule] = await Promise.all([
    readFile(options.aar), readJson(options['cargo-metadata']), readJson(options['gradle-module']),
  ]);
  const archive = unzipSync(aarBytes);
  const aarEntries = Object.entries(archive)
    .filter(([path]) => /^jni\/[^/]+\/[^/]+\.so$/.test(path))
    .map(([path, bytes]) => ({ path, sha256: createDigest(bytes) }));
  const cargoPackages = (cargoMetadata.packages ?? [])
    .filter((entry) => ['bota-device-sdk-core', 'bota-device-sdk-ffi'].includes(entry.name))
    .map((entry) => ({ name: entry.name, version: entry.version, license: entry.license }));
  const gradleDependencies = [];
  const seen = new Set();
  for (const variant of gradleModule.variants ?? []) {
    for (const entry of variant.dependencies ?? []) {
      const key = `${entry.group}:${entry.module}:${entry.version?.requires}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gradleDependencies.push({ group: entry.group, name: entry.module, version: entry.version?.requires });
    }
  }
  const sbom = generateAndroidSbom({ sdkVersion: options['sdk-version'], sourceRevision: options['source-revision'],
    artifactChecksum: options['artifact-checksum'], createdAt: options['created-at'], aarEntries, cargoPackages, gradleDependencies });
  await writeFile(options.output, `${JSON.stringify(sbom, null, 2)}\n`);
}

function createDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path) {
  if (!path) throw new Error('required JSON path is missing');
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
