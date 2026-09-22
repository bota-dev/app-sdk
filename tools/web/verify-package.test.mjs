import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  verifyPackageInventory,
  verifyPackageTarball,
} from './verify-package.mjs'

const validFiles = [
  'package/LICENSE',
  'package/README.md',
  'package/package.json',
  'package/dist/index.d.ts',
  'package/dist/index.js',
  'package/dist/generated/bota_device_sdk_core.d.ts',
  'package/dist/generated/bota_device_sdk_core.js',
  'package/dist/generated/bota_device_sdk_core_bg.wasm',
]

const validMetadata = {
  packageJson: {
    name: '@bota.dev/web-sdk',
    version: '1.2.0-beta.1',
    type: 'module',
    packageManager: 'npm@12.0.2',
    publishConfig: { access: 'public' },
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
  },
  sdkVersion: '1.2.0-beta.1',
  expectedPackageManager: 'npm@12.0.2',
}

test('package verification rejects a missing WebAssembly artifact', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        validFiles.filter((file) => !file.endsWith('.wasm')),
        new Map(),
      ),
    /exactly one WebAssembly file/,
  )
})

test('package verification rejects multiple or misplaced WebAssembly artifacts', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        [...validFiles, 'package/dist/generated/second.wasm'],
        new Map(),
        validMetadata,
      ),
    /exactly one WebAssembly file/,
  )
  assert.throws(
    () =>
      verifyPackageInventory(
        validFiles.map((file) =>
          file.endsWith('.wasm') ? 'package/dist/core.wasm' : file),
        new Map(),
        validMetadata,
      ),
    /inside package\/dist\/generated/,
  )
})

test('package verification rejects source maps', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        [...validFiles, 'package/dist/index.js.map'],
        new Map(),
      ),
    /source maps/,
  )
})

test('package verification rejects tests and source files anywhere in the package', () => {
  for (const forbidden of [
    'package/dist/client.test.js',
    'package/source/client.js',
    'package/dist/client.ts',
  ]) {
    assert.throws(
      () =>
        verifyPackageInventory(
          [...validFiles, forbidden],
          new Map(),
          validMetadata,
        ),
      /source and tests are not allowed/,
    )
  }
})

test('package verification rejects unsafe and absolute archive paths', () => {
  for (const forbidden of [
    '/package/dist/absolute.js',
    'package/../outside.js',
    'C:\\workspace\\secret.txt',
  ]) {
    assert.throws(
      () =>
        verifyPackageInventory(
          [...validFiles, forbidden],
          new Map(),
          validMetadata,
        ),
      /unsafe package path/,
    )
  }
})

test('package verification rejects absolute workspace paths in text artifacts', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        validFiles,
        new Map([
          [
            'package/dist/index.js',
            'throw new Error("/Users/zhangqi/ws/bota/app-sdk/private")',
          ],
        ]),
      ),
    /absolute workspace path/,
  )

})

test('tarball verification rejects absolute paths embedded in binary artifacts', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bota-web-package-test-'))
  try {
    const packageRoot = join(fixture, 'package')
    mkdirSync(join(packageRoot, 'dist/generated'), { recursive: true })
    writeFileSync(join(packageRoot, 'LICENSE'), 'test license')
    writeFileSync(join(packageRoot, 'README.md'), '# test package')
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify(validMetadata.packageJson),
    )
    writeFileSync(join(packageRoot, 'dist/index.d.ts'), 'export {}')
    writeFileSync(join(packageRoot, 'dist/index.js'), 'export {}')
    writeFileSync(
      join(packageRoot, 'dist/generated/bota_device_sdk_core.d.ts'),
      'export {}',
    )
    writeFileSync(
      join(packageRoot, 'dist/generated/bota_device_sdk_core.js'),
      'export {}',
    )
    writeFileSync(
      join(packageRoot, 'dist/generated/bota_device_sdk_core_bg.wasm'),
      Buffer.from('/home/runner/.cargo/registry/src/dependency.rs'),
    )
    const tarball = join(fixture, 'package.tgz')
    execFileSync('tar', ['-czf', tarball, '-C', fixture, ...validFiles])

    assert.throws(
      () => verifyPackageTarball(tarball),
      /absolute workspace path/,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('package verification rejects credentials and known sensitive fixture values', () => {
  for (const sensitive of [
    'const token = "sk_live_0123456789abcdef"',
    '-----BEGIN PRIVATE KEY-----',
    'https://upload.example.test/file?X-Amz-Signature=abcdef',
  ]) {
    assert.throws(
      () =>
        verifyPackageInventory(
          validFiles,
          new Map([['package/dist/index.js', sensitive]]),
          validMetadata,
        ),
      /credential or sensitive fixture value/,
    )
  }
})

test('package verification rejects SDK version drift', () => {
  assert.throws(
    () =>
      verifyPackageInventory(validFiles, new Map(), {
        ...validMetadata,
        packageJson: { ...validMetadata.packageJson, version: '1.2.0-beta.0' },
      }),
    /version .* does not match sdk-version\.toml/,
  )
})

test('package verification rejects package-manager drift', () => {
  assert.throws(
    () =>
      verifyPackageInventory(validFiles, new Map(), {
        ...validMetadata,
        packageJson: { ...validMetadata.packageJson, packageManager: 'npm@11.10.0' },
      }),
    /package manager must be npm@12\.0\.2/,
  )
})

test('package verification accepts the complete public inventory', () => {
  assert.doesNotThrow(() =>
    verifyPackageInventory(
      validFiles,
      new Map([
        ['package/package.json', JSON.stringify(validMetadata.packageJson)],
        ['package/dist/index.js', 'export class BotaDeviceClient {}'],
      ]),
      validMetadata,
    ),
  )
})
