import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_PACKAGE_NAME = '@bota.dev/web-sdk'
const EXPECTED_PACKAGE_MANAGER = 'npm@12.0.2'

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

export function verifyPackageInventory(files, textFiles, metadata = null) {
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
  if (!wasmFiles[0].startsWith('package/dist/generated/')) {
    throw new Error('WebAssembly file must be inside package/dist/generated')
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

  for (const [file, contents] of textFiles) {
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
  const files = execFileSync('tar', ['-tzf', absoluteTarball], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  const extraction = mkdtempSync(join(tmpdir(), 'bota-web-sdk-package-'))

  try {
    verifyPackageInventory(files, new Map())
    execFileSync('tar', ['-xzf', absoluteTarball, '-C', extraction])
    const packageContents = new Map()
    const inventoryFiles = []
    for (const file of files) {
      const contents = readFileSync(join(extraction, file))
      inventoryFiles.push({
        path: file,
        byteLength: contents.byteLength,
        sha256: sha256(contents),
      })
      packageContents.set(file, contents.toString('latin1'))
    }

    const packageJson = JSON.parse(
      readFileSync(join(extraction, 'package/package.json'), 'utf8'),
    )
    const sdkVersion = readSdkVersion(resolve(workspaceRoot, 'sdk-version.toml'))
    verifyPackageInventory(files, packageContents, { packageJson, sdkVersion })
    inventoryFiles.sort((left, right) => left.path.localeCompare(right.path))
    const tarballContents = readFileSync(absoluteTarball)
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
        byteLength: statSync(absoluteTarball).size,
        sha256: sha256(tarballContents),
        normalizedContentSha256: sha256(
          `${JSON.stringify(inventoryFiles)}\n`,
        ),
      },
      files: inventoryFiles,
    }
  } finally {
    rmSync(extraction, { recursive: true, force: true })
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
