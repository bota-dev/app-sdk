import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { unzipSync, zipSync } from 'fflate';

import { parseCoordinate, primaryFiles } from './normalize-central-repository.mjs';

const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FIXED_DATE = new Date(1980, 0, 1, 0, 0, 0);
const FIXED_TIMESTAMP = '1980-01-01T00:00:00.000Z';

export async function buildCentralBundle({ repository, coordinate, version, sourceRevision, inventory, zip }) {
  const { group, artifact } = parseCoordinate(coordinate);
  if (!REVISION.test(sourceRevision)) throw new Error('source revision is invalid');
  const repositoryRoot = resolve(repository);
  const expectedPrefix = `${group.replaceAll('.', '/')}/${artifact}/${version}/`;
  const paths = await listFiles(repositoryRoot);
  if (paths.length !== 30 || paths.some((path) => !path.startsWith(expectedPrefix))) {
    throw new Error('Portal repository must contain the exact 30-file coordinate inventory');
  }
  const expectedNames = primaryFiles(artifact, version).flatMap((name) => [
    name,
    `${name}.asc`,
    ...['md5', 'sha1', 'sha256', 'sha512'].map((algorithm) => `${name}.${algorithm}`),
  ]).sort();
  const actualNames = paths.map((path) => path.slice(expectedPrefix.length)).sort();
  if (actualNames.some((name, index) => name !== expectedNames[index])) throw new Error('Portal repository inventory is invalid');

  const files = [];
  const zippable = {};
  for (const path of paths) {
    requireSafePath(path);
    const contents = await readFile(join(repositoryRoot, ...path.split('/')));
    files.push({ path, role: role(path), byteLength: contents.length, sha256: digest(contents) });
    zippable[path] = [contents, { level: 0, mtime: FIXED_DATE, os: 3, attrs: 0o644 << 16 }];
  }
  const manifest = { schemaVersion: 1, coordinate, version, sourceRevision, files };
  await mkdir(dirname(resolve(inventory)), { recursive: true });
  await mkdir(dirname(resolve(zip)), { recursive: true });
  await writeFile(inventory, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(zip, zipSync(zippable, { level: 0, mtime: FIXED_DATE, os: 3, attrs: 0o644 << 16 }));
  await verifyCentralBundle({ repository, inventory, zip });
  return manifest;
}

export async function verifyCentralBundle({ repository, inventory, zip }) {
  const repositoryRoot = resolve(repository);
  const manifest = JSON.parse(await readFile(inventory, 'utf8'));
  if (manifest.schemaVersion !== 1 || typeof manifest.coordinate !== 'string'
      || typeof manifest.version !== 'string' || !REVISION.test(manifest.sourceRevision)
      || !Array.isArray(manifest.files) || manifest.files.length !== 30) {
    throw new Error('bundle inventory is invalid');
  }
  parseCoordinate(manifest.coordinate);
  const paths = manifest.files.map((entry) => entry.path);
  for (const path of paths) requireSafePath(path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] >= path)) {
    throw new Error('bundle inventory paths must be unique and sorted');
  }
  const repositoryFiles = await listFiles(repositoryRoot);
  if (repositoryFiles.length !== paths.length || repositoryFiles.some((path, index) => path !== paths[index])) {
    throw new Error('Portal repository does not match bundle inventory');
  }
  for (const entry of manifest.files) {
    if (!['primary', 'signature', 'checksum'].includes(entry.role) || !Number.isInteger(entry.byteLength) || entry.byteLength < 0 || !SHA256.test(entry.sha256)) {
      throw new Error(`bundle inventory entry ${entry.path} is invalid`);
    }
    const contents = await readFile(join(repositoryRoot, ...entry.path.split('/')));
    if (contents.length !== entry.byteLength) throw new Error(`${entry.path} byte length does not match inventory`);
    if (digest(contents) !== entry.sha256) throw new Error(`${entry.path} digest does not match inventory`);
  }

  const zipEntries = await inspectZip(zip);
  if (zipEntries.length !== paths.length || zipEntries.some((entry, index) => entry.path !== paths[index])) {
    throw new Error('ZIP entries do not match inventory');
  }
  const archive = unzipSync(await readFile(zip));
  for (const entry of zipEntries) {
    if (entry.directory || entry.mode !== 0o644 || entry.timestamp !== FIXED_TIMESTAMP
        || entry.extraFieldLength !== 0 || entry.commentLength !== 0 || entry.os !== 3) {
      throw new Error(`ZIP metadata is invalid for ${entry.path}`);
    }
    const source = await readFile(join(repositoryRoot, ...entry.path.split('/')));
    if (!archive[entry.path] || !Buffer.from(archive[entry.path]).equals(source)) throw new Error(`ZIP bytes do not match Portal source for ${entry.path}`);
  }
  return manifest;
}

export async function inspectZip(path) {
  const bytes = await readFile(path);
  const eocdOffset = findSignature(bytes, 0x06054b50, Math.max(0, bytes.length - 65557));
  if (eocdOffset < 0 || eocdOffset + 22 > bytes.length) throw new Error('ZIP end record is missing');
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (commentLength !== 0) throw new Error('ZIP archive comments are forbidden');
  if (eocdOffset + 22 + commentLength !== bytes.length) throw new Error('ZIP has trailing bytes or a comment');
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize !== eocdOffset) throw new Error('ZIP central directory bounds are invalid');
  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central entry is invalid');
    const madeBy = bytes.readUInt16LE(offset + 4);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraFieldLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const path = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    requireSafePath(path);
    if (names.has(path)) throw new Error(`ZIP contains duplicate entry ${path}`);
    names.add(path);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local entry is invalid for ${path}`);
    const localExtra = bytes.readUInt16LE(localOffset + 28);
    if (localExtra !== 0) throw new Error(`ZIP local extra field is invalid for ${path}`);
    entries.push({
      path,
      directory: path.endsWith('/'),
      mode: (externalAttributes >>> 16) & 0xffff,
      timestamp: dosTimestamp(bytes.readUInt16LE(offset + 12), bytes.readUInt16LE(offset + 14)),
      extraFieldLength,
      commentLength: entryCommentLength,
      os: madeBy >>> 8,
    });
    offset += 46 + nameLength + extraFieldLength + entryCommentLength;
  }
  if (offset !== eocdOffset) throw new Error('ZIP central directory entry count is invalid');
  return entries;
}

function requireSafePath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`ZIP path traversal or invalid path: ${path}`);
  }
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else throw new Error(`repository contains unsupported entry ${path}`);
    }
  }
  await visit(root);
  return files.sort();
}

function role(path) {
  if (path.endsWith('.asc')) return 'signature';
  if (/\.(md5|sha1|sha256|sha512)$/.test(path)) return 'checksum';
  return 'primary';
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function findSignature(bytes, signature, start) {
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function dosTimestamp(time, date) {
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >>> 11) & 0x1f;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument ${argv[index] ?? ''}`);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'build') {
    await buildCentralBundle({ repository: options.repository, coordinate: options.coordinate, version: options.version,
      sourceRevision: options['source-revision'], inventory: options.inventory, zip: options.output });
  } else if (command === 'verify') {
    await verifyCentralBundle({ repository: options.repository, inventory: options.inventory, zip: options.zip });
  } else throw new Error('usage: build-central-bundle.mjs <build|verify> [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
