#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { create, Parser } from 'tar';

import { parsePubspec } from './verify-package.mjs';

import { publicPackageIdentifier } from '../release/package-identities.mjs';
const EXPECTED_GENERATOR = Object.freeze({ name: 'pigeon', version: '28.0.0' });
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SEGMENTS = new Set([
  '.dart_tool',
  '.git',
  '.gradle',
  '.idea',
  '.pub-cache',
  '.swiftpm',
  'Pods',
  'build',
  'node_modules',
]);

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');
const comparePaths = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function assertSafePath(path) {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || isAbsolute(path)
    || /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`unsafe archive path ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe archive path ${path}`);
  }
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`forbidden package path ${path}`);
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    throw new Error(`forbidden package path ${path}`);
  }
  if (
    path === 'example/pubspec.lock'
    || path === 'example/android/local.properties'
    || path.startsWith('example/android/app/src/main/java/io/flutter/plugins/')
    || path.startsWith('example/ios/Flutter/')
    || path.startsWith('example/ios/Runner/GeneratedPluginRegistrant.')
  ) {
    throw new Error(`forbidden package path ${path}`);
  }
  if (/\.(?:cer|crt|der|jks|keystore|key|p12|pfx|pem)$/i.test(path)) {
    throw new Error(`forbidden package path ${path}`);
  }
}

function normalizedDigest(files) {
  const canonical = files.map(({ path, byteLength, sha256: checksum }) => ({
    path,
    byteLength,
    sha256: checksum,
  }));
  return sha256(`${JSON.stringify(canonical)}\n`);
}

async function archiveBuffer(archive) {
  const contents = Buffer.isBuffer(archive) ? archive : await readFile(archive);
  if (contents.length === 0 || contents.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive byte length must be between 1 and ${MAX_ARCHIVE_BYTES}`);
  }
  return contents;
}

export async function inspectFlutterArchive(archive) {
  const contents = await archiveBuffer(archive);
  const archivedFiles = [];
  const paths = new Set();
  let entryCount = 0;
  let totalBytes = 0;

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: 1024 * 1024,
      maxDecompressionRatio: 200,
    });
    parser.on('error', fail);
    parser.on('warn', (code, message) => fail(new Error(`invalid tar archive (${code}): ${message}`)));
    parser.on('entry', (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_ENTRIES) throw new Error(`archive exceeds ${MAX_ENTRIES} entries`);
        assertSafePath(entry.path);
        if (paths.has(entry.path)) throw new Error(`duplicate archive path ${entry.path}`);
        paths.add(entry.path);

        if (entry.type === 'Directory') {
          entry.resume();
          return;
        }
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          throw new Error(`archive symbolic links are not allowed: ${entry.path}`);
        }
        if (entry.type !== 'File' && entry.type !== 'OldFile') {
          throw new Error(`unsupported archive entry type ${entry.type}: ${entry.path}`);
        }
        if (entry.size > MAX_FILE_BYTES) {
          throw new Error(`archive file exceeds ${MAX_FILE_BYTES} bytes: ${entry.path}`);
        }
        totalBytes += entry.size;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error(`archive contents exceed ${MAX_TOTAL_BYTES} bytes`);
        }
        const chunks = [];
        let received = 0;
        entry.on('data', (chunk) => {
          received += chunk.length;
          if (received > entry.size || received > MAX_FILE_BYTES) {
            fail(new Error(`archive file size is invalid: ${entry.path}`));
            parser.abort(new Error(`archive file size is invalid: ${entry.path}`));
            return;
          }
          chunks.push(chunk);
        });
        entry.on('end', () => {
          if (settled) return;
          if (received !== entry.size) {
            fail(new Error(`archive file size is invalid: ${entry.path}`));
            return;
          }
          archivedFiles.push({ path: entry.path, contents: Buffer.concat(chunks) });
        });
      } catch (error) {
        fail(error);
        parser.abort(error);
      }
    });
    parser.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    parser.end(contents);
  });

  archivedFiles.sort((left, right) => comparePaths(left.path, right.path));
  const pubspecFile = archivedFiles.find(({ path }) => path === 'pubspec.yaml');
  if (!pubspecFile) throw new Error('Flutter archive is missing pubspec.yaml');
  const pubspec = parsePubspec(pubspecFile.contents.toString('utf8'));
  if (typeof pubspec.name !== 'string') throw new Error('Flutter archive pubspec is missing package name');
  if (typeof pubspec.version !== 'string') throw new Error('Flutter archive pubspec is missing package version');

  const packageName = publicPackageIdentifier('flutter', pubspec.version);
  const swiftPackage = archivedFiles.find(
    ({ path }) => path === `ios/${packageName}/Package.swift`,
  );
  if (
    swiftPackage
    && (swiftPackage.contents.includes('BOTA_APPLE_SDK_PACKAGE_PATH')
      || /\.package\(name:\s*["']Bota(?:Apple|App)SDK["'][^)]*\bpath\s*:/s.test(
        swiftPackage.contents.toString('utf8'),
      ))
  ) {
    throw new Error('published Flutter archive contains a local Apple dependency override');
  }

  const files = archivedFiles.map(({ path, contents: fileContents }) => ({
    path,
    byteLength: fileContents.length,
    sha256: sha256(fileContents),
  }));
  return {
    packageName: pubspec.name,
    version: pubspec.version,
    archiveByteLength: contents.length,
    archiveSha256: sha256(contents),
    normalizedArchiveSha256: normalizedDigest(files),
    files,
  };
}

async function assertSourceFiles(packageRoot, files) {
  const canonicalRoot = await realpath(packageRoot);
  for (const file of files) {
    assertSafePath(file);
    const path = resolve(packageRoot, file);
    const fromRoot = relative(canonicalRoot, await realpath(path));
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`package file escapes package root: ${file}`);
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`package archive input is not a regular file: ${file}`);
    }
  }
}

export async function createFlutterArchive({ archivePath, files, packageRoot }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('package archive requires a non-empty exact file list');
  }
  const sortedFiles = [...files].sort(comparePaths);
  if (new Set(sortedFiles).size !== sortedFiles.length) {
    throw new Error('package archive file list contains duplicates');
  }
  await assertSourceFiles(packageRoot, sortedFiles);
  await create({
    cwd: packageRoot,
    file: archivePath,
    gzip: { level: 9, portable: true },
    mtime: new Date(0),
    noDirRecurse: true,
    noPax: true,
    portable: true,
    strict: true,
  }, sortedFiles);
  return inspectFlutterArchive(archivePath);
}

function assertExactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} contains missing or unknown fields`);
  }
}

function validateInventory(inventory) {
  assertExactKeys(
    inventory,
    ['schemaVersion', 'packageName', 'version', 'sourceRevision', 'generator', 'archive', 'files'],
    'candidate inventory',
  );
  if (inventory.schemaVersion !== 1) throw new Error('candidate inventory schemaVersion must be 1');
  const EXPECTED_PACKAGE_NAME = publicPackageIdentifier('flutter', inventory.version);
  if (inventory.packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`package name must be ${EXPECTED_PACKAGE_NAME}`);
  }
  if (!VERSION_PATTERN.test(inventory.version)) throw new Error('package version is invalid');
  if (!REVISION_PATTERN.test(inventory.sourceRevision)) throw new Error('source revision is invalid');
  assertExactKeys(inventory.generator, ['name', 'version'], 'generator');
  if (
    inventory.generator.name !== EXPECTED_GENERATOR.name
    || inventory.generator.version !== EXPECTED_GENERATOR.version
  ) {
    throw new Error('generator identity must be pigeon 28.0.0');
  }
  assertExactKeys(
    inventory.archive,
    ['name', 'byteLength', 'sha256', 'normalizedSha256'],
    'archive',
  );
  if (inventory.archive.name !== `${inventory.packageName}-${inventory.version}.tar.gz`) {
    throw new Error('archive name does not match package name and version');
  }
  if (!Number.isSafeInteger(inventory.archive.byteLength) || inventory.archive.byteLength <= 0) {
    throw new Error('archive byteLength must be a positive integer');
  }
  if (!SHA256_PATTERN.test(inventory.archive.sha256)) throw new Error('archive sha256 is invalid');
  if (!SHA256_PATTERN.test(inventory.archive.normalizedSha256)) {
    throw new Error('normalized archive sha256 is invalid');
  }
  if (!Array.isArray(inventory.files) || inventory.files.length === 0) {
    throw new Error('package file inventory must not be empty');
  }
  let previous = '';
  for (const file of inventory.files) {
    assertExactKeys(file, ['path', 'byteLength', 'sha256'], 'package file inventory entry');
    assertSafePath(file.path);
    if (file.path <= previous) throw new Error('package file inventory must be sorted and unique');
    previous = file.path;
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      throw new Error(`package file byteLength is invalid: ${file.path}`);
    }
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`package file sha256 is invalid: ${file.path}`);
    }
  }
}

function compareFiles(actual, expected) {
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  for (const file of actual) {
    if (!expectedByPath.has(file.path)) {
      throw new Error(`archive inventory contains unexpected file ${file.path}`);
    }
  }
  for (const file of expected) {
    const actualFile = actualByPath.get(file.path);
    if (!actualFile) throw new Error(`archive inventory is missing file ${file.path}`);
    if (actualFile.byteLength !== file.byteLength || actualFile.sha256 !== file.sha256) {
      throw new Error(`file checksum does not match candidate inventory: ${file.path}`);
    }
  }
}

async function inspectAndCompare({ archive, inventory, requireRawChecksum }) {
  validateInventory(inventory);
  const inspection = await inspectFlutterArchive(archive);
  if (inspection.packageName !== inventory.packageName) {
    throw new Error('package name does not match candidate inventory');
  }
  if (inspection.version !== inventory.version) {
    throw new Error('package version does not match candidate inventory');
  }
  if (requireRawChecksum) {
    if (inspection.archiveByteLength !== inventory.archive.byteLength) {
      throw new Error('archive byte length does not match candidate inventory');
    }
    if (inspection.archiveSha256 !== inventory.archive.sha256) {
      throw new Error('archive SHA-256 does not match candidate inventory');
    }
    if (typeof archive === 'string' && basename(archive) !== inventory.archive.name) {
      throw new Error('archive file name does not match candidate inventory');
    }
  }
  compareFiles(inspection.files, inventory.files);
  if (inspection.normalizedArchiveSha256 !== inventory.archive.normalizedSha256) {
    throw new Error('normalized archive SHA-256 does not match candidate inventory');
  }
  return { ...inspection, sourceRevision: inventory.sourceRevision, generator: inventory.generator };
}

export const verifyCandidateArchive = (options) => inspectAndCompare({
  ...options,
  requireRawChecksum: true,
});

export const verifyPublishedArchive = (options) => inspectAndCompare({
  ...options,
  requireRawChecksum: false,
});

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || !arguments_[index + 1] || arguments_[index + 1].startsWith('--')) {
    throw new Error(`missing required option ${name}`);
  }
  return arguments_[index + 1];
}

async function writeJson(path, value) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, target);
}

async function createCandidate(arguments_) {
  const packageRoot = option(arguments_, '--package-root');
  const archive = option(arguments_, '--archive');
  const inventoryPath = option(arguments_, '--inventory');
  const sourceRevision = option(arguments_, '--source-revision');
  const filesPath = option(arguments_, '--files');
  if (!REVISION_PATTERN.test(sourceRevision)) throw new Error('source revision is invalid');
  const files = (await readFile(filesPath, 'utf8'))
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(Boolean);
  const inspection = await createFlutterArchive({ archivePath: archive, files, packageRoot });
  const EXPECTED_PACKAGE_NAME = publicPackageIdentifier('flutter', inspection.version);
  if (inspection.packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`package name must be ${EXPECTED_PACKAGE_NAME}`);
  }
  const inventory = {
    schemaVersion: 1,
    packageName: inspection.packageName,
    version: inspection.version,
    sourceRevision,
    generator: EXPECTED_GENERATOR,
    archive: {
      name: basename(archive),
      byteLength: inspection.archiveByteLength,
      sha256: inspection.archiveSha256,
      normalizedSha256: inspection.normalizedArchiveSha256,
    },
    files: inspection.files,
  };
  validateInventory(inventory);
  await writeJson(inventoryPath, inventory);
  console.log(`created deterministic candidate ${inventory.archive.name}`);
}

export function buildReleaseManifest(templateInput, inventory, applePackage) {
  validateInventory(inventory);
  const template = structuredClone(templateInput);
  if (template.sdkVersion !== inventory.version) {
    throw new Error('release manifest sdkVersion does not match candidate inventory');
  }
  const expectedAppleURL = `https://github.com/bota-dev/app-sdk/releases/download/v${inventory.version}/BotaDeviceSDKCore.xcframework.zip`;
  const appleURLs = [...applePackage.matchAll(/\burl:\s*"([^"]+)"/g)].map((match) => match[1]);
  const appleChecksums = [...applePackage.matchAll(/\bchecksum:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (appleURLs.length !== 1 || appleURLs[0] !== expectedAppleURL) {
    throw new Error('Apple package URL does not match candidate version');
  }
  if (
    appleChecksums.length !== 1
    || !SHA256_PATTERN.test(appleChecksums[0])
    || /^0+$/.test(appleChecksums[0])
  ) {
    throw new Error('Apple package checksum must be one nonzero SHA-256');
  }
  const appleArtifacts = template.artifacts?.filter(
    (artifact) => artifact.platform === 'apple',
  );
  if (appleArtifacts?.length !== 1) {
    throw new Error('release manifest template must contain exactly one Apple artifact');
  }
  appleArtifacts[0].checksumSha256 = appleChecksums[0];
  template.sourceRevision = inventory.sourceRevision;
  const flutterArtifacts = template.artifacts?.filter(
    (artifact) => artifact.platform === 'flutter',
  );
  if (flutterArtifacts?.length !== 1) {
    throw new Error('release manifest template must contain exactly one Flutter artifact');
  }
  Object.assign(flutterArtifacts[0], {
    packageIdentifier: inventory.packageName,
    name: inventory.archive.name,
    ecosystem: 'pub',
    version: inventory.version,
    checksumSha256: inventory.archive.sha256,
    sourceRevision: inventory.sourceRevision,
    normalizedArchiveSha256: inventory.archive.normalizedSha256,
    generator: inventory.generator,
    packageInventory: inventory.files,
    capabilities: ['flutter_sdk'],
  });
  return template;
}

async function writeReleaseManifest(arguments_) {
  const templatePath = option(arguments_, '--template');
  const inventoryPath = option(arguments_, '--inventory');
  const applePackagePath = option(arguments_, '--apple-package');
  const output = option(arguments_, '--output');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const applePackage = await readFile(applePackagePath, 'utf8');
  const manifest = buildReleaseManifest(template, inventory, applePackage);
  await writeJson(output, manifest);
  console.log(`wrote Flutter release manifest ${output}`);
}

function normalizeManifestSourceRevision(manifest, field) {
  const normalized = structuredClone(manifest);
  if (!REVISION_PATTERN.test(normalized.sourceRevision)) {
    throw new Error(`${field} source revision is invalid`);
  }
  const flutterArtifacts = normalized.artifacts?.filter(
    (artifact) => artifact.platform === 'flutter',
  );
  if (flutterArtifacts?.length !== 1) {
    throw new Error(`${field} must contain exactly one Flutter artifact`);
  }
  if (flutterArtifacts[0].sourceRevision !== normalized.sourceRevision) {
    throw new Error(`${field} Flutter source revision does not match its release source revision`);
  }
  normalized.sourceRevision = '<source-revision>';
  flutterArtifacts[0].sourceRevision = '<source-revision>';
  return normalized;
}

export function verifyReleaseManifestTemplate(manifest, template) {
  const actual = normalizeManifestSourceRevision(manifest, 'release manifest');
  const expected = normalizeManifestSourceRevision(template, 'release manifest template');
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('release manifest does not match checked template');
  }
}

async function verifyReleaseManifestTemplateFiles(arguments_) {
  const manifestPath = option(arguments_, '--manifest');
  const templatePath = option(arguments_, '--template');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  verifyReleaseManifestTemplate(manifest, template);
  console.log('release manifest matches checked template and runtime source identity');
}

async function main(arguments_) {
  const [command] = arguments_;
  if (command === 'create-candidate') {
    await createCandidate(arguments_);
    return;
  }
  if (command === 'write-release-manifest') {
    await writeReleaseManifest(arguments_);
    return;
  }
  if (command === 'verify-release-manifest-template') {
    await verifyReleaseManifestTemplateFiles(arguments_);
    return;
  }
  if (command !== 'verify-candidate' && command !== 'verify-public') {
    throw new Error('usage: verify-publication.mjs <create-candidate|write-release-manifest|verify-release-manifest-template|verify-candidate|verify-public> [options]');
  }
  const archive = option(arguments_, '--archive');
  const inventoryPath = option(arguments_, '--inventory');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const result = command === 'verify-candidate'
    ? await verifyCandidateArchive({ archive, inventory })
    : await verifyPublishedArchive({ archive, inventory });
  const outputIndex = arguments_.indexOf('--output');
  if (outputIndex !== -1) {
    const output = option(arguments_, '--output');
    const evidence = {
      packageName: result.packageName,
      version: result.version,
      sourceRevision: result.sourceRevision,
      generator: result.generator,
      archiveByteLength: result.archiveByteLength,
      archiveSha256: result.archiveSha256,
      normalizedArchiveSha256: result.normalizedArchiveSha256,
      files: result.files,
    };
    await writeJson(output, evidence);
  }
  console.log(`${command} passed for ${result.packageName} ${result.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
