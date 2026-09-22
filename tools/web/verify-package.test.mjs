import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { Header, Pax } from 'tar'

import * as packageVerifier from './verify-package.mjs'

const {
  verifyPackageInventory,
  verifyPackageTarball,
} = packageVerifier

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
const wasmPath = 'package/dist/generated/bota_device_sdk_core_bg.wasm'
const validWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

const validMetadata = {
  packageJson: {
    name: '@bota.dev/web-sdk',
    version: '1.2.0-beta.2',
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
  sdkVersion: '1.2.0-beta.2',
  expectedPackageManager: 'npm@12.0.2',
}

const validContents = new Map([
  ['package/LICENSE', Buffer.from('test license')],
  ['package/README.md', Buffer.from('# test package')],
  ['package/package.json', Buffer.from(JSON.stringify(validMetadata.packageJson))],
  ['package/dist/index.d.ts', Buffer.from('export {}')],
  ['package/dist/index.js', Buffer.from('export {}')],
  ['package/dist/generated/bota_device_sdk_core.d.ts', Buffer.from('export {}')],
  ['package/dist/generated/bota_device_sdk_core.js', Buffer.from('export {}')],
  [wasmPath, validWasm],
])

test('package verification rejects a missing WebAssembly artifact', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        validFiles.filter((file) => !file.endsWith('.wasm')),
        validContents,
      ),
    /exactly one WebAssembly file/,
  )
})

test('package verification rejects multiple or misplaced WebAssembly artifacts', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        [...validFiles, 'package/dist/generated/second.wasm'],
        validContents,
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
    /must be package\/dist\/generated\/bota_device_sdk_core_bg\.wasm/,
  )
})

test('package verification rejects invalid WebAssembly bytes', () => {
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.from([0x00, 0x61, 0x73, 0x6d]),
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]),
    Buffer.from('not wasm'),
  ]) {
    assert.throws(
      () =>
        verifyPackageInventory(
          validFiles,
          new Map([...validContents, [wasmPath, invalid]]),
          validMetadata,
        ),
      /WebAssembly magic and version/,
    )
  }
})

test('package verification rejects source maps', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        [...validFiles, 'package/dist/index.js.map'],
        validContents,
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
          validContents,
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
          validContents,
          validMetadata,
        ),
      /unsafe package path/,
    )
  }
})

test('tarball verification rejects unsafe paths from archive headers', () => {
  for (const path of [
    '/package/dist/absolute.js',
    'package/../outside.js',
    'C:/workspace/secret.txt',
  ]) {
    withTarball(validContents, (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /unsafe package path/,
      )
    }, [{ path, type: 'File', body: Buffer.from('unsafe') }])
  }
})

test('package verification rejects absolute workspace paths in text artifacts', () => {
  assert.throws(
    () =>
      verifyPackageInventory(
        validFiles,
        new Map([
          ...validContents,
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
  withTarball(
    new Map([
      ...validContents,
      [wasmPath, Buffer.concat([validWasm, Buffer.from('/home/runner/private')])],
    ]),
    (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /absolute workspace path/,
      )
    },
  )
})

test('tarball verification rejects links before reading package contents', () => {
  for (const entry of [
    { path: 'package/dist/absolute-link', type: 'SymbolicLink', linkpath: '/dev/null' },
    { path: 'package/dist/relative-link', type: 'SymbolicLink', linkpath: '../../../../dev/null' },
    { path: 'package/dist/hard-link', type: 'Link', linkpath: 'package/LICENSE' },
  ]) {
    withTarball(validContents, (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /(?:unsafe link target|archive links are not allowed)/,
      )
    }, [entry])
  }
})

test('tarball verification rejects non-file headers and duplicate paths', () => {
  for (const type of ['Directory', 'CharacterDevice', 'BlockDevice', 'FIFO', 'ContiguousFile']) {
    withTarball(validContents, (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /unsupported archive entry type/,
      )
    }, [{ path: `package/dist/${type}`, type }])
  }

  withTarball(validContents, (tarball) => {
    assert.throws(
      () => verifyPackageTarball(tarball),
      /duplicate archive path/,
    )
  }, [{ path: 'package/LICENSE', type: 'File', body: Buffer.from('duplicate') }])
})

test('tarball verification rejects conflicting PAX and GNU metadata headers', () => {
  const pax = new Pax({ path: 'package/dist/pax-name.js' }).encode()
  const gnuBody = Buffer.from('package/dist/gnu-name.js\0')
  const gnu = encodeEntry({
    path: '././@LongLink',
    type: 'NextFileHasLongPath',
    body: gnuBody,
  })

  for (const metadata of [pax, gnu]) {
    withTarball(validContents, (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /archive metadata headers are not allowed/,
      )
    }, [], metadata)
  }
})

test('tarball verification rejects oversized ignored PAX and GNU metadata', () => {
  for (const type of ['ExtendedHeader', 'NextFileHasLongPath']) {
    const metadata = {
      path: type === 'ExtendedHeader' ? 'PaxHeader' : '././@LongLink',
      type,
      body: randomBytes(65_537),
    }
    for (const position of ['before', 'after']) {
      const extraEntries = position === 'after' ? [metadata] : []
      const prefix = position === 'before' ? encodeEntry(metadata) : Buffer.alloc(0)
      withTarball(validContents, (tarball) => {
        assert.throws(
          () => verifyPackageTarball(tarball),
          /ignored archive entr(?:y|ies) are not allowed/,
        )
      }, extraEntries, prefix)
    }
  }
})

test('tarball verification rejects oversized entries, totals, and counts', () => {
  withTarball(validContents, (tarball) => {
    assert.throws(() => verifyPackageTarball(tarball), /archive entry is too large/)
  }, [{ path: 'package/dist/oversized.bin', type: 'File', body: Buffer.alloc(2 * 1024 * 1024 + 1) }])

  const totalEntries = Array.from({ length: 9 }, (_, index) => ({
    path: `package/dist/total-${index}.bin`,
    type: 'File',
    body: randomBytes(1024 * 1024),
  }))
  withTarball(validContents, (tarball) => {
    assert.throws(() => verifyPackageTarball(tarball), /archive expands beyond/)
  }, totalEntries)

  const countEntries = Array.from({ length: 129 }, (_, index) => ({
    path: `package/dist/count-${index}.bin`,
    type: 'File',
    body: Buffer.alloc(0),
  }))
  withTarball(validContents, (tarball) => {
    assert.throws(() => verifyPackageTarball(tarball), /too many archive entries/)
  }, countEntries)
})

test('tarball verification rejects malformed and truncated archives', () => {
  for (const contents of [Buffer.from('not a tarball'), createTarball(validContents).subarray(0, 64)]) {
    withRawTarball(contents, (tarball) => {
      assert.throws(
        () => verifyPackageTarball(tarball),
        /malformed or truncated archive/,
      )
    })
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
        new Map([...validContents, ['package/dist/index.js', Buffer.from(sensitive)]]),
          validMetadata,
        ),
      /credential or sensitive fixture value/,
    )
  }
})

test('package verification rejects SDK version drift', () => {
  assert.throws(
    () =>
      verifyPackageInventory(validFiles, validContents, {
        ...validMetadata,
        packageJson: { ...validMetadata.packageJson, version: '1.2.0-beta.0' },
      }),
    /version .* does not match sdk-version\.toml/,
  )
})

test('package verification rejects package-manager drift', () => {
  assert.throws(
    () =>
      verifyPackageInventory(validFiles, validContents, {
        ...validMetadata,
        packageJson: { ...validMetadata.packageJson, packageManager: 'npm@11.10.0' },
      }),
    /package manager must be npm@12\.0\.2/,
  )
})

test('package verification rejects private publication metadata', () => {
  assert.throws(
    () =>
      verifyPackageInventory(validFiles, validContents, {
        ...validMetadata,
        packageJson: { ...validMetadata.packageJson, private: true },
      }),
    /package must not be private/,
  )
})

test('package verification accepts the complete public inventory', () => {
  assert.doesNotThrow(() =>
    verifyPackageInventory(
      validFiles,
      validContents,
      validMetadata,
    ),
  )
})

test('installed package comparison rejects links and content drift without extraction', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bota-web-installed-test-'))
  const installed = join(fixture, 'installed')
  try {
    for (const [path, contents] of validContents) {
      const destination = join(installed, path.slice('package/'.length))
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, contents)
    }
    const inventoryFiles = [...validContents].map(([path, contents]) => ({
      path,
      byteLength: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }))

    assert.doesNotThrow(() =>
      packageVerifier.verifyInstalledPackage(inventoryFiles, installed),
    )

    const installedIndex = join(installed, 'dist/index.js')
    unlinkSync(installedIndex)
    symlinkSync('/dev/null', installedIndex)
    assert.throws(
      () => packageVerifier.verifyInstalledPackage(inventoryFiles, installed),
      /installed package must contain only regular files/,
    )

    unlinkSync(installedIndex)
    writeFileSync(installedIndex, 'export const changed = true\n')
    assert.throws(
      () => packageVerifier.verifyInstalledPackage(inventoryFiles, installed),
      /installed package does not match verified tarball inventory/,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function withTarball(contents, assertion, extraEntries = [], prefix = Buffer.alloc(0)) {
  withRawTarball(createTarball(contents, extraEntries, prefix), assertion)
}

function withRawTarball(contents, assertion) {
  const fixture = mkdtempSync(join(tmpdir(), 'bota-web-package-test-'))
  try {
    const tarball = join(fixture, 'package.tgz')
    writeFileSync(tarball, contents)
    assertion(tarball)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function createTarball(contents, extraEntries = [], prefix = Buffer.alloc(0)) {
  const entries = [...contents].map(([path, body]) => ({
    path,
    type: 'File',
    body,
  }))
  return gzipSync(Buffer.concat([
    prefix,
    ...entries.map(encodeEntry),
    ...extraEntries.map(encodeEntry),
    Buffer.alloc(1024),
  ]))
}

function encodeEntry({ path, type, body = Buffer.alloc(0), linkpath = '' }) {
  const header = Buffer.alloc(512)
  new Header({
    path,
    type,
    size: body.byteLength,
    linkpath,
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
  }).encode(header)
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.byteLength % 512)) % 512),
  ])
}
