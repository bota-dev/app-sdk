import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  buildReleaseManifest,
  createFlutterArchive,
  inspectFlutterArchive,
  verifyReleaseManifestTemplate,
  verifyCandidateArchive,
  verifyPublishedArchive,
} from './verify-publication.mjs';

const sourceRevision = 'a'.repeat(40);
const packageName = 'bota_flutter_sdk';
const version = '1.2.0-beta.0';

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeOctal(buffer, offset, length, value) {
  writeString(buffer, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function tarEntry({ body = '', linkName = '', mode = 0o644, mtime = 0, path, type = '0' }) {
  const contents = Buffer.from(body);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === '0' ? contents.length : 0);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 157, 100, linkName);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function archive(entries, mtime = 0) {
  const tar = Buffer.concat([
    ...entries.map(tarEntry),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar, { level: 9, mtime });
}

function validEntries() {
  return [
    {
      path: 'pubspec.yaml',
      body: `name: ${packageName}\nversion: ${version}\n`,
    },
    { path: 'LICENSE', body: 'Apache License 2.0\n' },
    { path: 'lib/bota_flutter_sdk.dart', body: 'library;\n' },
    {
      path: 'ios/bota_flutter_sdk/Package.swift',
      body: `.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "${version}")\n`,
    },
  ];
}

function candidateInventory(inspection) {
  return {
    schemaVersion: 1,
    packageName,
    version,
    sourceRevision,
    generator: { name: 'pigeon', version: '28.0.0' },
    archive: {
      name: `${packageName}-${version}.tar.gz`,
      byteLength: inspection.archiveByteLength,
      sha256: inspection.archiveSha256,
      normalizedSha256: inspection.normalizedArchiveSha256,
    },
    files: inspection.files,
  };
}

test('major-two Flutter archives use the renamed identity and reject local Apple overrides', async () => {
  const entries = validEntries().map((entry) => ({
    ...entry,
    path: entry.path.replaceAll('bota_flutter_sdk', 'bota_app_sdk'),
    body: entry.body.replaceAll('bota_flutter_sdk', 'bota_app_sdk')
      .replaceAll(version, '2.0.0-beta.0'),
  }));
  const bytes = archive(entries);
  const inspection = await inspectFlutterArchive(bytes);
  const inventory = {
    ...candidateInventory(inspection),
    packageName: 'bota_app_sdk',
    version: '2.0.0-beta.0',
  };
  inventory.archive.name = 'bota_app_sdk-2.0.0-beta.0.tar.gz';
  await verifyCandidateArchive({ archive: bytes, inventory });
  await assert.rejects(
    verifyCandidateArchive({ archive: bytes, inventory: { ...inventory, packageName } }),
    /package name must be bota_app_sdk/,
  );
  const swift = entries.find((entry) => entry.path.endsWith('Package.swift'));
  swift.body = '.package(name: "BotaAppSDK", path: "../local")';
  await assert.rejects(inspectFlutterArchive(archive(entries)), /local Apple dependency override/);
});

test('creates the same normalized candidate archive from an exact sorted file list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bota-flutter-archive-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'pubspec.yaml'), `name: ${packageName}\nversion: ${version}\n`);
  await writeFile(join(root, 'LICENSE'), 'Apache License 2.0\n');
  await writeFile(join(root, 'lib', 'bota_flutter_sdk.dart'), 'library;\n');
  const files = ['pubspec.yaml', 'LICENSE', 'lib/bota_flutter_sdk.dart'];
  const first = join(root, 'first.tar.gz');
  const second = join(root, 'second.tar.gz');

  await createFlutterArchive({ archivePath: first, files, packageRoot: root });
  await utimes(join(root, 'LICENSE'), new Date(), new Date());
  await createFlutterArchive({ archivePath: second, files: files.reverse(), packageRoot: root });

  assert.deepEqual(await readFile(second), await readFile(first));
  assert.deepEqual(
    (await inspectFlutterArchive(first)).files.map((file) => file.path),
    ['LICENSE', 'lib/bota_flutter_sdk.dart', 'pubspec.yaml'],
  );
});

test('accepts an exact normalized public archive with different tar metadata and order', async () => {
  const candidate = archive(validEntries());
  const candidateInspection = await inspectFlutterArchive(candidate);
  const inventory = candidateInventory(candidateInspection);
  const published = archive(validEntries().reverse(), 1_700_000_000);

  const result = await verifyPublishedArchive({ archive: published, inventory });

  assert.equal(result.packageName, packageName);
  assert.equal(result.version, version);
  assert.equal(result.normalizedArchiveSha256, inventory.archive.normalizedSha256);
  assert.notEqual(result.archiveSha256, inventory.archive.sha256);
});

test('rejects archive path traversal before reading package contents', async () => {
  const malicious = archive([
    ...validEntries(),
    { path: '../outside.txt', body: 'escape\n' },
  ]);

  await assert.rejects(
    inspectFlutterArchive(malicious),
    /unsafe archive path.*\.\.\/outside\.txt/,
  );
});

test('rejects a symlink escape from the archive root', async () => {
  const malicious = archive([
    ...validEntries(),
    { path: 'lib/escape', type: '2', linkName: '../../outside.txt' },
  ]);

  await assert.rejects(
    inspectFlutterArchive(malicious),
    /archive symbolic links are not allowed.*lib\/escape/,
  );
});

test('rejects an extra public archive file', async () => {
  const candidate = archive(validEntries());
  const inventory = candidateInventory(await inspectFlutterArchive(candidate));
  const published = archive([
    ...validEntries(),
    { path: 'lib/unreviewed.dart', body: 'library;\n' },
  ]);

  await assert.rejects(
    verifyPublishedArchive({ archive: published, inventory }),
    /archive inventory contains unexpected file lib\/unreviewed\.dart/,
  );
});

test('rejects a candidate archive checksum mismatch', async () => {
  const candidate = archive(validEntries());
  const inventory = candidateInventory(await inspectFlutterArchive(candidate));
  inventory.archive.sha256 = 'f'.repeat(64);

  await assert.rejects(
    verifyCandidateArchive({ archive: candidate, inventory }),
    /archive SHA-256 does not match candidate inventory/,
  );
});

test('rejects a normalized archive checksum mismatch', async () => {
  const candidate = archive(validEntries());
  const inventory = candidateInventory(await inspectFlutterArchive(candidate));
  inventory.archive.normalizedSha256 = 'f'.repeat(64);

  await assert.rejects(
    verifyCandidateArchive({ archive: candidate, inventory }),
    /normalized archive SHA-256 does not match candidate inventory/,
  );
});

test('rejects per-file checksum drift even when the normalized digest is replaced', async () => {
  const candidate = archive(validEntries());
  const inventory = candidateInventory(await inspectFlutterArchive(candidate));
  inventory.files[0].sha256 = createHash('sha256').update('other').digest('hex');

  await assert.rejects(
    verifyCandidateArchive({ archive: candidate, inventory }),
    /file checksum does not match.*LICENSE/,
  );
});

test('rejects credentials and build output paths in an archive', async () => {
  const credentials = archive([
    ...validEntries(),
    { path: '.env', body: 'PUB_TOKEN=secret\n' },
  ]);
  const buildOutput = archive([
    ...validEntries(),
    { path: 'build/output.bin', body: 'generated\n' },
  ]);

  await assert.rejects(inspectFlutterArchive(credentials), /forbidden package path \.env/);
  await assert.rejects(inspectFlutterArchive(buildOutput), /forbidden package path build\/output\.bin/);
});

test('rejects generated example metadata and local machine paths', async () => {
  for (const path of [
    'example/android/local.properties',
    'example/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java',
    'example/ios/Flutter/Generated.xcconfig',
    'example/ios/Flutter/ephemeral/flutter_native_integration.env',
    'example/ios/Runner/GeneratedPluginRegistrant.m',
    'example/pubspec.lock',
  ]) {
    await assert.rejects(
      inspectFlutterArchive(archive([...validEntries(), { path, body: 'generated\n' }])),
      new RegExp(`forbidden package path ${path.replaceAll('.', '\\.')}`),
    );
  }
});

test('rejects a published local Apple dependency override', async () => {
  const entries = validEntries().map((entry) =>
    entry.path === 'ios/bota_flutter_sdk/Package.swift'
      ? {
          ...entry,
          body: 'let path = ProcessInfo.processInfo.environment["BOTA_APPLE_SDK_PACKAGE_PATH"]\n',
        }
      : entry,
  );

  await assert.rejects(
    inspectFlutterArchive(archive(entries)),
    /published Flutter archive contains a local Apple dependency override/,
  );
});

test('rejects package name, version, source revision, and generator drift', async () => {
  const candidate = archive(validEntries());
  const inspection = await inspectFlutterArchive(candidate);

  for (const mutate of [
    (inventory) => { inventory.packageName = 'other_package'; },
    (inventory) => { inventory.version = '1.2.0-beta.1'; },
    (inventory) => { inventory.sourceRevision = 'not-a-revision'; },
    (inventory) => { inventory.generator.version = '29.0.0'; },
  ]) {
    const inventory = candidateInventory(inspection);
    mutate(inventory);
    await assert.rejects(
      verifyCandidateArchive({ archive: candidate, inventory }),
      /package name|package version|source revision|generator identity/,
    );
  }
});

test('compares release manifest templates while preserving runtime source identity', () => {
  const template = {
    manifestVersion: 2,
    sdkVersion: version,
    sourceRevision,
    artifacts: [{
      platform: 'flutter',
      packageIdentifier: packageName,
      version,
      checksumSha256: 'b'.repeat(64),
      sourceRevision,
      normalizedArchiveSha256: 'c'.repeat(64),
      packageInventory: [{
        path: 'pubspec.yaml',
        byteLength: 1,
        sha256: 'd'.repeat(64),
      }],
    }],
  };
  const runtime = structuredClone(template);
  runtime.sourceRevision = 'e'.repeat(40);
  runtime.artifacts[0].sourceRevision = runtime.sourceRevision;

  assert.doesNotThrow(() => verifyReleaseManifestTemplate(runtime, template));

  runtime.artifacts[0].checksumSha256 = 'f'.repeat(64);
  assert.throws(
    () => verifyReleaseManifestTemplate(runtime, template),
    /release manifest does not match checked template/,
  );
});

test('generates Apple and Flutter manifest checksums from deterministic inputs', async () => {
  const inspection = await inspectFlutterArchive(archive(validEntries()));
  const inventory = candidateInventory(inspection);
  const template = {
    manifestVersion: 2,
    sdkVersion: version,
    sourceRevision,
    artifacts: [
      {
        platform: 'apple',
        packageIdentifier: 'BotaAppleSDK',
        version,
        checksumSha256: '0'.repeat(64),
        capabilities: ['apple_device_sdk'],
      },
      {
        platform: 'flutter',
        packageIdentifier: packageName,
        version,
        checksumSha256: '0'.repeat(64),
        capabilities: ['flutter_sdk'],
      },
    ],
  };
  const appleChecksum = '1'.repeat(64);
  const applePackage = `
    url: "https://github.com/bota-dev/app-sdk/releases/download/v${version}/BotaDeviceSDKCore.xcframework.zip",
    checksum: "${appleChecksum}"
  `;

  const manifest = buildReleaseManifest(template, inventory, applePackage);

  assert.equal(manifest.artifacts[0].checksumSha256, appleChecksum);
  assert.equal(manifest.artifacts[1].checksumSha256, inventory.archive.sha256);
  assert.equal(manifest.artifacts[1].normalizedArchiveSha256, inventory.archive.normalizedSha256);
  assert.throws(
    () => buildReleaseManifest(template, inventory, applePackage.replace(`/v${version}/`, '/v1.2.0-beta.1/')),
    /Apple package URL does not match candidate version/,
  );
});
