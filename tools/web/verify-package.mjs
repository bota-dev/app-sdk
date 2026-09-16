import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/package.json',
  'package/dist/index.d.ts',
  'package/dist/index.js',
]

const TEXT_FILE = /\.(?:d\.ts|js|json|md)$/
const ABSOLUTE_WORKSPACE_PATH =
  /(?:\/Users\/[^/\s]+\/(?:ws|workspace)\/|\/home\/[^/\s]+\/(?:ws|workspace)\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/

export function verifyPackageInventory(files, textFiles) {
  const normalized = [...files].sort()
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
        file.includes('/src/') ||
        file.includes('/node_modules/') ||
        file.includes('/__tests__/'),
    )
  ) {
    throw new Error('source, dependencies, and tests are not allowed in the package')
  }

  for (const [file, contents] of textFiles) {
    if (ABSOLUTE_WORKSPACE_PATH.test(contents)) {
      throw new Error(`absolute workspace path found in ${file}`)
    }
  }
}

export function verifyPackageTarball(tarballPath) {
  const absoluteTarball = resolve(tarballPath)
  const files = execFileSync('tar', ['-tzf', absoluteTarball], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  const extraction = mkdtempSync(join(tmpdir(), 'bota-web-sdk-package-'))

  try {
    execFileSync('tar', ['-xzf', absoluteTarball, '-C', extraction])
    const textFiles = new Map()
    for (const file of files) {
      if (!TEXT_FILE.test(file)) continue
      textFiles.set(file, readFileSync(join(extraction, file), 'utf8'))
    }
    verifyPackageInventory(files, textFiles)

    const packageJson = JSON.parse(
      readFileSync(join(extraction, 'package/package.json'), 'utf8'),
    )
    if (packageJson.name !== '@bota.dev/web-sdk') {
      throw new Error('package name must be @bota.dev/web-sdk')
    }
    if (packageJson.exports?.['.']?.import !== './dist/index.js') {
      throw new Error('package ESM export must resolve to ./dist/index.js')
    }
    if (packageJson.exports?.['.']?.types !== './dist/index.d.ts') {
      throw new Error('package type export must resolve to ./dist/index.d.ts')
    }
  } finally {
    rmSync(extraction, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2]
  if (!tarball) {
    console.error('usage: node tools/web/verify-package.mjs <tarball>')
    process.exitCode = 2
  } else {
    verifyPackageTarball(tarball)
    console.log(`verified ${tarball}`)
  }
}
