import assert from 'node:assert/strict'
import test from 'node:test'

import { createCoreLoader } from '../core.ts'
import { BotaSDKError, normalizeCoreError } from '../errors.ts'

const bridge = {
  startExactConnection: () => [],
  dispatch: () => [],
  status: () => ({ kind: 'idle' as const }),
  decodeDeviceStatus: () => ({
    batteryPercent: 50,
    batteryMillivolts: null,
    storageTotalMb: 1024,
    storageUsedMb: 256,
    state: 'idle' as const,
    pendingRecordings: 2,
    lastTimeSyncTimestamp: 0,
    flags: {
      charging: false,
      lowBattery: false,
      storageFull: false,
      wifiConnected: false,
      lteConnected: false,
      syncActive: false,
    },
    lteStatusRaw: 0,
    lteSignalQuality: null,
    wifiStatusRaw: null,
    modemInfo: null,
  }),
  decodeEncryptedUploadV2Capabilities: () => ({
    flags: 0x7f,
    maximumSignedBlobBytes: 408,
    maximumManifestBytes: 580,
    maximumDataPayloadBytes: 244,
    maximumWindowPackets: 16,
    durableCheckpointIntervalBlocks: 8,
    maximumMissingSequences: 4,
  }),
}

test('concurrent callers share one core initialization and bridge', async () => {
  let calls = 0
  const load = createCoreLoader(async () => {
    calls += 1
    await Promise.resolve()
    return bridge
  })

  const [first, second] = await Promise.all([load(), load()])

  assert.equal(calls, 1)
  assert.equal(first, bridge)
  assert.equal(second, bridge)
})

test('a failed core initialization can be retried', async () => {
  let calls = 0
  const load = createCoreLoader(async () => {
    calls += 1
    if (calls === 1) throw new Error('local workspace path must not leak')
    return bridge
  })

  await assert.rejects(load(), (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'internal_error')
    assert.doesNotMatch(error.message, /workspace path/)
    return true
  })
  assert.equal(await load(), bridge)
  assert.equal(calls, 2)
})

test('structured Rust identity failures map to the stable public error', () => {
  const error = normalizeCoreError(
    {
      code: 'IdentityMismatch',
      operation: 'Connect',
      retryable: false,
      protocol_status: null,
      detail: 'selected device serial is WRONG, expected GDPPSBZJN6',
    },
    'connect',
  )

  assert.equal(error.code, 'identity_mismatch')
  assert.equal(error.operation, 'connect')
  assert.equal(error.retryable, false)
  assert.equal(error.message, 'The selected device does not match this device record.')
  assert.doesNotMatch(error.message, /WRONG|GDPPSBZJN6/)
})

test('unknown platform errors remain private causes', () => {
  const platformError = new Error('token=secret-value')

  const error = normalizeCoreError(platformError, 'initialize')

  assert.equal(error.code, 'internal_error')
  assert.equal(error.cause, platformError)
  assert.doesNotMatch(error.message, /secret-value/)
})
