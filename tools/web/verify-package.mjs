import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser } from 'tar'

import { publicPackageIdentifier } from '../release/package-identities.mjs'
const EXPECTED_PACKAGE_MANAGER = 'npm@12.0.2'
const EXPECTED_WASM_PATH =
  'package/dist/generated/bota_device_sdk_core_bg.wasm'
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_COUNT = 128
const MAX_META_ENTRY_BYTES = 64 * 1024

const REQUIRED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/package.json',
  'package/dist/index.d.ts',
  'package/dist/index.js',
]

const ABSOLUTE_WORKSPACE_PATH =
  /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|\/tmp\/[^\s"']*|[A-Za-z]:\\(?:Users|workspace)\\[^\\\s]+\\)/
const SENSITIVE_CONTENT = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\b(?:sk_live|sk_test|rk|dtok|up|rct)_[A-Za-z0-9_-]{12,}\b/,
  /[?&]X-Amz-(?:Credential|Signature)=/i,
  /\bAWS_SECRET_ACCESS_KEY\s*[=:]/i,
]
const SOURCE_EXTENSIONS = /\.(?:c|cc|cpp|h|hpp|java|kt|kts|rs|swift|tsx?)$/i
const TEST_FILE = /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/i
const FORBIDDEN_PATH = /(?:^|\/)(?:__tests__|fixtures?|source|src|tests?)(?:\/|$)/i
const CREDENTIAL_PATH = /(?:^|\/)\.env(?:\.|$)|\.(?:jks|key|keystore|p12|pfx|pem)$/i

export function verifyPackageInventory(files, packageContents, metadata = null) {
  const normalized = [...files].sort()
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('duplicate package paths are not allowed')
  }
  for (const file of normalized) assertSafePackagePath(file)
  for (const required of REQUIRED_FILES) {
    if (!normalized.includes(required)) {
      throw new Error(`missing required package file: ${required}`)
    }
  }

  const wasmFiles = normalized.filter((file) => file.endsWith('.wasm'))
  if (wasmFiles.length !== 1) {
    throw new Error(
      `expected exactly one WebAssembly file, found ${wasmFiles.length}`,
    )
  }
  if (wasmFiles[0] !== EXPECTED_WASM_PATH) {
    throw new Error(`WebAssembly file must be ${EXPECTED_WASM_PATH}`)
  }
  const wasm = packageContents.get(EXPECTED_WASM_PATH)
  if (
    !wasm
    || Buffer.byteLength(wasm) < WASM_HEADER.byteLength
    || !Buffer.from(wasm).subarray(0, WASM_HEADER.byteLength).equals(WASM_HEADER)
  ) {
    throw new Error('WebAssembly file must contain the WebAssembly magic and version bytes')
  }
  if (normalized.some((file) => file.endsWith('.map'))) {
    throw new Error('source maps are not allowed in the release package')
  }
  if (
    normalized.some(
      (file) =>
        FORBIDDEN_PATH.test(file)
        || TEST_FILE.test(file)
        || (SOURCE_EXTENSIONS.test(file) && !file.endsWith('.d.ts')),
    )
  ) {
    throw new Error('source and tests are not allowed in the package')
  }
  if (normalized.some((file) => file.includes('/node_modules/'))) {
    throw new Error('dependencies are not allowed in the package')
  }
  if (normalized.some((file) => CREDENTIAL_PATH.test(file))) {
    throw new Error('credential files are not allowed in the package')
  }

  for (const [file, contents] of packageContents) {
    if (ABSOLUTE_WORKSPACE_PATH.test(contents)) {
      throw new Error(`absolute workspace path found in ${file}`)
    }
    if (SENSITIVE_CONTENT.some((pattern) => pattern.test(contents))) {
      throw new Error(`credential or sensitive fixture value found in ${file}`)
    }
  }

  if (metadata) verifyPackageMetadata(metadata)
}

export function verifyPackageMetadata({
  packageJson,
  sdkVersion,
  expectedPackageManager = EXPECTED_PACKAGE_MANAGER,
}) {
  const EXPECTED_PACKAGE_NAME = publicPackageIdentifier('web', sdkVersion)
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`package name must be ${EXPECTED_PACKAGE_NAME}`)
  }
  if (packageJson.version !== sdkVersion) {
    throw new Error(
      `package version ${packageJson.version ?? '(missing)'} does not match sdk-version.toml ${sdkVersion}`,
    )
  }
  if (packageJson.packageManager !== expectedPackageManager) {
    throw new Error(`package manager must be ${expectedPackageManager}`)
  }
  if (packageJson.private === true) {
    throw new Error('package must not be private')
  }
  if (packageJson.type !== 'module') {
    throw new Error('package type must be module')
  }
  if (packageJson.publishConfig?.access !== 'public') {
    throw new Error('package publishConfig access must be public')
  }
  if (packageJson.exports?.['.']?.import !== './dist/index.js') {
    throw new Error('package ESM export must resolve to ./dist/index.js')
  }
  if (packageJson.exports?.['.']?.types !== './dist/index.d.ts') {
    throw new Error('package type export must resolve to ./dist/index.d.ts')
  }
}

export function verifyPackageTarball(
  tarballPath,
  { workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..') } = {},
) {
  const absoluteTarball = resolve(tarballPath)
  const tarballStat = lstatSync(absoluteTarball)
  if (!tarballStat.isFile() || tarballStat.isSymbolicLink()) {
    throw new Error('package tarball must be a regular file')
  }
  if (tarballStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`compressed archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  }

  const tarballContents = readFileSync(absoluteTarball)
  const packageContents = parsePackageArchive(tarballContents)
  const files = [...packageContents.keys()]
  verifyPackageInventory(files, packageContents)
  const packageJson = JSON.parse(
    packageContents.get('package/package.json').toString('utf8'),
  )
  const sdkVersion = readSdkVersion(resolve(workspaceRoot, 'sdk-version.toml'))
  verifyPackageMetadata({ packageJson, sdkVersion })
  const inventoryFiles = [...packageContents]
    .map(([path, contents]) => ({
      path,
      byteLength: contents.byteLength,
      sha256: sha256(contents),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    schemaVersion: 1,
    packageName: packageJson.name,
    version: packageJson.version,
    packageManager: packageJson.packageManager,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    }).trim(),
    tarball: {
      name: basename(absoluteTarball),
      byteLength: tarballStat.size,
      sha256: sha256(tarballContents),
      normalizedContentSha256: sha256(
        `${JSON.stringify(inventoryFiles)}\n`,
      ),
    },
    files: inventoryFiles,
  }
}

export function verifyInstalledPackage(expectedFiles, packageRoot) {
  const absoluteRoot = resolve(packageRoot)
  const rootStat = lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('installed package must be a regular directory')
  }

  const expected = [...expectedFiles].sort((left, right) =>
    left.path.localeCompare(right.path))
  const actual = collectInstalledFiles(absoluteRoot)
  if (expected.length !== actual.length) {
    throw new Error('installed package does not match verified tarball inventory')
  }
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]
    const found = actual[index]
    if (
      wanted.path !== found.path
      || wanted.byteLength !== found.byteLength
      || wanted.sha256 !== found.sha256
    ) {
      throw new Error('installed package does not match verified tarball inventory')
    }
  }
}

export function verifyInstalledPackageEvidence(
  tarballPath,
  inventoryPath,
  checksumPath,
  packageRoot,
  { workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..') } = {},
) {
  const absoluteTarball = resolve(tarballPath)
  const absoluteInventory = resolve(inventoryPath)
  const inventoryContents = readRegularFileNoFollow(
    absoluteInventory,
    'package inventory',
  )
  const checksumContents = readRegularFileNoFollow(
    resolve(checksumPath),
    'package inventory checksum',
  )
  const expectedChecksum = Buffer.from(
    `${sha256(inventoryContents)}  ${basename(absoluteInventory)}\n`,
  )
  if (!checksumContents.equals(expectedChecksum)) {
    throw new Error('inventory checksum does not match inventory contents')
  }

  let inventory
  try {
    inventory = JSON.parse(inventoryContents.toString('utf8'))
  } catch {
    throw new Error('package inventory must be valid JSON')
  }
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }).trim()
  if (inventory.schemaVersion !== 1) {
    throw new Error('package inventory schema version must be 1')
  }
  if (inventory.sourceRevision !== sourceRevision) {
    throw new Error('inventory source revision does not match HEAD')
  }
  if (!Array.isArray(inventory.files) || inventory.files.length === 0) {
    throw new Error('package inventory files must be a non-empty array')
  }

  const inventoryFiles = inventory.files.map((file) => {
    assertSafePackagePath(file?.path)
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      throw new Error(`invalid inventory byte length: ${file.path}`)
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`invalid inventory SHA-256: ${file.path}`)
    }
    return {
      path: file.path,
      byteLength: file.byteLength,
      sha256: file.sha256,
    }
  })
  const sortedFiles = [...inventoryFiles].sort((left, right) =>
    left.path.localeCompare(right.path))
  if (
    new Set(sortedFiles.map(({ path }) => path)).size !== sortedFiles.length
    || JSON.stringify(sortedFiles) !== JSON.stringify(inventoryFiles)
  ) {
    throw new Error('package inventory files must have unique sorted paths')
  }
  const normalizedContentSha256 = sha256(`${JSON.stringify(sortedFiles)}\n`)
  if (inventory.tarball?.normalizedContentSha256 !== normalizedContentSha256) {
    throw new Error('normalized package inventory hash does not match files')
  }

  const tarballContents = readRegularFileNoFollow(absoluteTarball, 'package tarball')
  if (
    inventory.tarball?.name !== basename(absoluteTarball)
    || inventory.tarball?.byteLength !== tarballContents.byteLength
    || inventory.tarball?.sha256 !== sha256(tarballContents)
  ) {
    throw new Error('tarball does not match verified inventory')
  }
  verifyInstalledPackage(sortedFiles, packageRoot)
}

function collectInstalledFiles(packageRoot, relativeDirectory = '') {
  const directory = relativeDirectory
    ? resolve(packageRoot, relativeDirectory)
    : packageRoot
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name
    const absolutePath = resolve(packageRoot, relativePath)
    const entryStat = lstatSync(absolutePath)
    if (entryStat.isSymbolicLink()) {
      throw new Error('installed package must contain only regular files and directories')
    }
    if (entryStat.isDirectory()) {
      files.push(...collectInstalledFiles(packageRoot, relativePath))
      continue
    }
    if (!entryStat.isFile()) {
      throw new Error('installed package must contain only regular files and directories')
    }

    const packagePath = `package/${relativePath}`
    assertSafePackagePath(packagePath)
    const descriptor = openSync(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    try {
      const openedStat = fstatSync(descriptor)
      if (!openedStat.isFile()) {
        throw new Error('installed package must contain only regular files and directories')
      }
      const contents = readFileSync(descriptor)
      files.push({
        path: packagePath,
        byteLength: contents.byteLength,
        sha256: sha256(contents),
      })
    } finally {
      closeSync(descriptor)
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function parsePackageArchive(tarballContents) {
  const contents = new Map()
  let totalBytes = 0
  let validationError = null
  let parserError = null
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    maxDecompressionRatio: 100,
  })

  parser.on('error', (error) => {
    parserError ??= error
  })
  parser.on('meta', () => {
    validationError ??= new Error('archive metadata headers are not allowed')
  })
  parser.on('ignoredEntry', (entry) => {
    validationError ??= new Error(
      `ignored archive entries are not allowed: ${entry.type} ${entry.path}`,
    )
  })
  parser.on('entry', (entry) => {
    const chunks = []
    if (validationError) {
      entry.resume()
      return
    }
    try {
      assertArchiveEntry(entry, contents, totalBytes)
      totalBytes += entry.size
      entry.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      entry.on('end', () => {
        const body = Buffer.concat(chunks)
        if (body.byteLength !== entry.size) {
          validationError ??= new Error('malformed or truncated archive entry')
          return
        }
        contents.set(entry.path, body)
      })
    } catch (error) {
      validationError ??= error
    }
    entry.resume()
  })

  let parserCompleted = false
  try {
    parser.end(tarballContents, () => {
      parserCompleted = true
    })
  } catch (error) {
    parserError ??= error
  }
  if (validationError) throw validationError
  if (parserError || !parserCompleted || contents.size === 0) {
    const detail = parserError instanceof Error ? `: ${parserError.message}` : ''
    throw new Error(`malformed or truncated archive${detail}`)
  }
  return contents
}

function assertArchiveEntry(entry, contents, totalBytes) {
  if (entry.type === 'Link' || entry.type === 'SymbolicLink') {
    assertSafeLinkTarget(entry.linkpath)
    throw new Error('archive links are not allowed')
  }
  if (entry.type !== 'File' && entry.type !== 'OldFile') {
    throw new Error(`unsupported archive entry type: ${entry.type}`)
  }
  assertSafePackagePath(entry.path)
  if (contents.has(entry.path)) {
    throw new Error(`duplicate archive path: ${entry.path}`)
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`archive entry is too large: ${entry.path}`)
  }
  if (contents.size + 1 > MAX_ENTRY_COUNT) {
    throw new Error(`too many archive entries: maximum ${MAX_ENTRY_COUNT}`)
  }
  if (totalBytes + entry.size > MAX_TOTAL_BYTES) {
    throw new Error(`archive expands beyond ${MAX_TOTAL_BYTES} bytes`)
  }
}

function assertSafeLinkTarget(linkpath) {
  if (
    typeof linkpath !== 'string'
    || linkpath.length === 0
    || linkpath.includes('\\')
    || isAbsolute(linkpath)
    || /^[A-Za-z]:/.test(linkpath)
    || linkpath.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`unsafe link target: ${linkpath ?? '(missing)'}`)
  }
}

function assertSafePackagePath(path) {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || isAbsolute(path)
    || /^[A-Za-z]:/.test(path)
  ) throw new Error(`unsafe package path: ${path}`)
  const segments = path.split('/')
  if (
    segments[0] !== 'package'
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error(`unsafe package path: ${path}`)
}

function readSdkVersion(path) {
  const match = readFileSync(path, 'utf8').match(
    /^version\s*=\s*"([^"]+)"\s*$/m,
  )
  if (!match) throw new Error(`cannot read SDK version from ${path}`)
  return match[1]
}

function readRegularFileNoFollow(path, label) {
  const fileStat = lstatSync(path)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`)
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file`)
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2]
  const inventoryFlag = process.argv.indexOf('--inventory')
  const inventoryPath = inventoryFlag >= 0 ? process.argv[inventoryFlag + 1] : null
  if (!tarball) {
    console.error(
      'usage: node tools/web/verify-package.mjs <tarball> [--inventory <path>]',
    )
    process.exitCode = 2
  } else if (inventoryFlag >= 0 && !inventoryPath) {
    console.error('--inventory requires a path')
    process.exitCode = 2
  } else {
    const inventory = verifyPackageTarball(tarball)
    if (inventoryPath) {
      const serialized = `${JSON.stringify(inventory, null, 2)}\n`
      writeFileSync(inventoryPath, serialized)
      writeFileSync(`${inventoryPath}.sha256`, `${sha256(serialized)}  ${basename(inventoryPath)}\n`)
    }
    console.log(`verified ${tarball}`)
  }
}
