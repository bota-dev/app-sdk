import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { XMLParser } from 'fast-xml-parser';

const CHECKSUMS = ['md5', 'sha1', 'sha256', 'sha512'];
const CHECKSUM_LENGTHS = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

export async function normalizeCentralRepository({
  rawRepository,
  portalRepository,
  coordinate,
  version,
  targetRoot = defaultTargetRoot(),
}) {
  const { group, artifact } = parseCoordinate(coordinate);
  requireVersion(version);
  const rawRoot = resolve(rawRepository);
  const portalRoot = resolve(portalRepository);
  const allowedTarget = resolve(targetRoot);
  requireExactChild(rawRoot, allowedTarget, 'android-central-raw', 'raw repository');
  requireExactChild(portalRoot, allowedTarget, 'android-central-portal', 'Portal repository');
  if (rawRoot === portalRoot) throw new Error('raw and Portal repositories must be separate');

  const coordinatePath = join(...group.split('.'), artifact);
  const artifactDirectory = join(rawRoot, coordinatePath);
  const versionDirectory = join(artifactDirectory, version);
  const primaryNames = primaryFiles(artifact, version);
  const expectedVersionFiles = primaryNames.flatMap((name) => [
    name,
    `${name}.asc`,
    ...CHECKSUMS.map((algorithm) => `${name}.${algorithm}`),
    ...CHECKSUMS.map((algorithm) => `${name}.asc.${algorithm}`),
  ]).sort();
  const expectedRawFiles = [
    ...expectedVersionFiles.map((name) => `${coordinatePath}/${version}/${name}`),
    `${coordinatePath}/maven-metadata.xml`,
    ...CHECKSUMS.map((algorithm) => `${coordinatePath}/maven-metadata.xml.${algorithm}`),
  ].sort();
  const actualRawFiles = await listFiles(rawRoot);
  requireExactInventory(actualRawFiles, expectedRawFiles, 'raw Gradle repository');

  for (const name of [...primaryNames, ...primaryNames.map((entry) => `${entry}.asc`)]) {
    await verifyChecksums(join(versionDirectory, name));
  }
  const metadataPath = join(artifactDirectory, 'maven-metadata.xml');
  await verifyChecksums(metadataPath);
  await validatePom(join(versionDirectory, `${artifact}-${version}.pom`), { group, artifact, version });
  await validateModule(join(versionDirectory, `${artifact}-${version}.module`), { group, artifact, version });
  await validateMetadata(metadataPath, { group, artifact, version });

  await rm(portalRoot, { recursive: true, force: true });
  const portalVersionDirectory = join(portalRoot, coordinatePath, version);
  await mkdir(portalVersionDirectory, { recursive: true });
  for (const name of primaryNames) {
    for (const sourceName of [name, `${name}.asc`]) {
      await copyFile(join(versionDirectory, sourceName), join(portalVersionDirectory, sourceName));
    }
    for (const algorithm of CHECKSUMS) {
      const contents = await readFile(join(versionDirectory, name));
      const checksum = digest(algorithm, contents);
      await writeFile(join(portalVersionDirectory, `${name}.${algorithm}`), checksum);
    }
  }

  const files = await listFiles(portalRoot);
  if (files.length !== 30) throw new Error(`Portal repository must contain 30 files, found ${files.length}`);
  return { rawFiles: actualRawFiles, files };
}

export function parseCoordinate(coordinate) {
  if (typeof coordinate !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(coordinate)) {
    throw new Error('coordinate is invalid');
  }
  const [group, artifact] = coordinate.split(':');
  if (!group.includes('.') || !artifact) throw new Error('coordinate is invalid');
  return { group, artifact };
}

export function primaryFiles(artifact, version) {
  return [
    `${artifact}-${version}.aar`,
    `${artifact}-${version}.pom`,
    `${artifact}-${version}.module`,
    `${artifact}-${version}-sources.jar`,
    `${artifact}-${version}-javadoc.jar`,
  ];
}

export async function validatePublishedMetadata({ repository, coordinate, version }) {
  const { group, artifact } = parseCoordinate(coordinate);
  requireVersion(version);
  const root = resolve(repository);
  const names = primaryFiles(artifact, version);
  const files = await listFiles(root);
  if (names.some((name) => !files.includes(name))) {
    throw new Error('release directory is missing a Maven primary file');
  }
  await validatePom(join(root, `${artifact}-${version}.pom`), { group, artifact, version });
  await validateModule(join(root, `${artifact}-${version}.module`), { group, artifact, version });
}

async function validatePom(path, expected) {
  let project;
  try {
    project = parser.parse(await readFile(path, 'utf8')).project;
  } catch (error) {
    throw new Error(`POM is invalid: ${error.message}`);
  }
  if (!project || project.groupId !== expected.group || project.artifactId !== expected.artifact || project.version !== expected.version) {
    throw new Error('POM coordinate does not match requested coordinate and version');
  }
  const exact = {
    name: 'Bota SDK for Android',
    description: 'Android facade for connecting applications to Bota devices.',
    url: 'https://github.com/bota-dev/app-sdk',
  };
  for (const [field, value] of Object.entries(exact)) {
    if (project[field] !== value) throw new Error(`POM ${field} is invalid`);
  }
  const license = first(project.licenses?.license);
  if (license?.name !== 'MIT License' || license?.url !== 'https://opensource.org/license/mit' || license?.distribution !== 'repo') {
    throw new Error('POM license is invalid');
  }
  const developer = first(project.developers?.developer);
  if (developer?.id !== 'bota-dev' || developer?.name !== 'Bota' || developer?.url !== 'https://bota.dev') {
    throw new Error('POM developer is invalid');
  }
  if (project.scm?.url !== exact.url
      || project.scm?.connection !== 'scm:git:git://github.com/bota-dev/app-sdk.git'
      || project.scm?.developerConnection !== 'scm:git:ssh://git@github.com/bota-dev/app-sdk.git') {
    throw new Error('POM SCM is invalid');
  }
  for (const dependency of array(project.dependencies?.dependency)) requireStaticVersion(dependency.version, 'POM dependency');
}

async function validateModule(path, expected) {
  let module;
  try {
    module = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Gradle module metadata is invalid: ${error.message}`);
  }
  const component = module.component;
  if (component?.group !== expected.group || component?.module !== expected.artifact || component?.version !== expected.version) {
    throw new Error('Gradle module coordinate does not match requested coordinate and version');
  }
  for (const variant of module.variants ?? []) {
    for (const dependency of variant.dependencies ?? []) requireStaticVersion(dependency.version?.requires, 'Gradle module dependency');
  }
}

async function validateMetadata(path, expected) {
  let metadata;
  try {
    metadata = parser.parse(await readFile(path, 'utf8')).metadata;
  } catch (error) {
    throw new Error(`Maven metadata is invalid: ${error.message}`);
  }
  const versions = array(metadata?.versioning?.versions?.version);
  if (metadata?.groupId !== expected.group || metadata?.artifactId !== expected.artifact
      || metadata?.versioning?.latest !== expected.version || metadata?.versioning?.release !== expected.version
      || versions.length !== 1 || versions[0] !== expected.version) {
    throw new Error('Maven metadata coordinate or version is invalid');
  }
}

async function verifyChecksums(path) {
  const contents = await readFile(path);
  for (const algorithm of CHECKSUMS) {
    const checksumPath = `${path}.${algorithm}`;
    const recorded = (await readFile(checksumPath, 'utf8')).trim();
    if (!new RegExp(`^[0-9a-f]{${CHECKSUM_LENGTHS[algorithm]}}$`).test(recorded)) {
      throw new Error(`${basename(checksumPath)} checksum syntax is invalid`);
    }
    if (recorded !== digest(algorithm, contents)) throw new Error(`${basename(checksumPath)} checksum does not match`);
  }
}

function requireStaticVersion(value, label) {
  if (typeof value !== 'string' || !VERSION.test(value) || /[+()[\],]|latest|snapshot/i.test(value)) {
    throw new Error(`${label} version must be static`);
  }
}

function requireVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new Error('version is invalid');
}

function requireExactChild(path, root, name, label) {
  if (path !== join(root, name) || !path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} must be the exact ${name} directory beneath target`);
  }
}

function requireExactInventory(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    const unexpected = actual.filter((value) => !expected.includes(value));
    const missing = expected.filter((value) => !actual.includes(value));
    throw new Error(`${label} has unexpected or missing files: unexpected=${unexpected.join(',')} missing=${missing.join(',')}`);
  }
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join('/'));
      else throw new Error(`repository contains unsupported entry ${path}`);
    }
  }
  await visit(root);
  return result.sort();
}

function digest(algorithm, contents) {
  return createHash(algorithm).update(contents).digest('hex');
}

function array(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function first(value) {
  return array(value)[0];
}

function defaultTargetRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../target');
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
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0] === 'verify-maven' ? arguments_.shift() : 'normalize';
  const options = parseArguments(arguments_);
  if (command === 'verify-maven') {
    await validatePublishedMetadata({ repository: options.repository, coordinate: options.coordinate, version: options.version });
    return;
  }
  await normalizeCentralRepository({
    rawRepository: options['raw-repository'],
    portalRepository: options['portal-repository'],
    coordinate: options.coordinate,
    version: options.version,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
