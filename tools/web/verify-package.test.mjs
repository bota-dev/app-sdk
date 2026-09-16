import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyPackageInventory } from './verify-package.mjs'

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

test('package verification accepts the complete public inventory', () => {
  assert.doesNotThrow(() =>
    verifyPackageInventory(
      validFiles,
      new Map([
        ['package/package.json', '{"name":"@bota.dev/web-sdk"}'],
        ['package/dist/index.js', 'export class BotaDeviceClient {}'],
      ]),
    ),
  )
})
