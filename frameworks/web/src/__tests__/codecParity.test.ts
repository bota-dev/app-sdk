import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { CoreBridgeError } from '../errors.ts'
import { createWasmCore } from '../wasmCore.ts'

type JsonRecord = Record<string, unknown>

interface IntegrityHasherUnderTest {
  update(bytes: Uint8Array): void
  length(): bigint
  crc32(): number
  sha256Snapshot(): Uint8Array
}

interface CodecBridgeUnderTest {
  decodeRecordingList(bytes: Uint8Array): unknown[]
  encodeRecordingListCommand(): Uint8Array
  encodeRecordingConfirm(recordingUuid: string): Uint8Array
  encodeDeprovisionCommand(): Uint8Array
  decodeDeprovisionResult(bytes: Uint8Array): unknown
  decodeConnectionSettings(bytes: Uint8Array): unknown
  encodeConnectionSettings(settings: unknown, model: string): Uint8Array
  encodeWiFiGrant(grant: string, capacity: number): Uint8Array
  encodeWiFiCredentials(ssid: string, password: string): Uint8Array
  encodeWiFiScanCommand(): Uint8Array
  decodeWiFiConfigResult(bytes: Uint8Array): unknown
  decodeWiFiStatus(bytes: Uint8Array): unknown
  decodeWiFiScanUpdate(bytes: Uint8Array): unknown
  encodeRecordingControlCommand(action: 'start' | 'stop'): Uint8Array
  decodeRecordingControlResult(bytes: Uint8Array): unknown
  decodeEncryptedUploadV2Transfer(bytes: Uint8Array): JsonRecord
  encodeEncryptedUploadV2Transfer(frame: unknown): Uint8Array
  decodeEncryptedUploadV2Status(bytes: Uint8Array): unknown
  encodeEncryptedUploadV2SignedBlob(frame: unknown): Uint8Array
  createIntegrityHasher(): IntegrityHasherUnderTest
}

interface FixtureCase extends JsonRecord {
  name: string
  inputHex?: string
  input?: JsonRecord
  expected?: unknown
  expectedHex?: string
}

interface FixtureSuite {
  cases: FixtureCase[]
}

const wasm = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)
const core = wasm.then(async (bytes) =>
  await createWasmCore(bytes) as unknown as CodecBridgeUnderTest
)

async function fixture(
  filename: string,
  name: string,
): Promise<FixtureCase> {
  const suite = JSON.parse(await readFile(
    new URL(`../../../../protocol/fixtures/${filename}`, import.meta.url),
    'utf8',
  )) as FixtureSuite
  const found = suite.cases.find((candidate) => candidate.name === name)
  assert.ok(found, `missing fixture ${filename}:${name}`)
  return found
}

async function vector(name: string): Promise<FixtureCase> {
  const suite = JSON.parse(await readFile(
    new URL(
      '../../../../protocol/vectors/encrypted-upload-v2.json',
      import.meta.url,
    ),
    'utf8',
  )) as FixtureSuite
  const found = suite.cases.find((candidate) => candidate.name === name)
  assert.ok(found, `missing encrypted-upload-v2 vector ${name}`)
  return found
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
}

function hexString(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fixtureHex(value: FixtureCase, key: 'inputHex' | 'expectedHex'): string {
  const encoded = value[key]
  if (typeof encoded !== 'string') {
    assert.fail(`fixture ${value.name} has no ${key}`)
  }
  return encoded
}

test('legacy recording codecs match committed fixtures and reject bad identifiers', async () => {
  const bridge = await core
  const recording = await fixture('recording-list.json', 'encrypted-recording')
  const partial = await fixture(
    'recording-list.json',
    'trailing-partial-entry-is-ignored',
  )
  const list = await fixture('transfer-control.json', 'list-command')
  const confirm = await fixture('transfer-control.json', 'confirm-command')

  assert.deepEqual(
    bridge.decodeRecordingList(hex(fixtureHex(recording, 'inputHex'))),
    [{
      uuid: 'a1b2c3d4-0000-0000-0000-000000000000',
      startedAtTimestampSeconds: 1_700_000_000,
      durationMilliseconds: 12_000n,
      fileSizeBytes: 4_096n,
      codec: 'opus_16k',
      encrypted: true,
    }],
  )
  assert.deepEqual(
    bridge.decodeRecordingList(hex(fixtureHex(partial, 'inputHex'))),
    [],
  )
  assert.equal(
    hexString(bridge.encodeRecordingListCommand()),
    fixtureHex(list, 'expectedHex'),
  )
  assert.equal(
    hexString(bridge.encodeRecordingConfirm(
      String((confirm.input as JsonRecord).recordingUuid),
    )),
    fixtureHex(confirm, 'expectedHex'),
  )
  assertCoreBridgeError(
    () => bridge.encodeRecordingConfirm('not-a-uuid'),
    coreError('invalid_input', 'validate'),
  )
})

test('deprovision codec preserves released meanings and unknown status bytes', async () => {
  const bridge = await core
  const command = await fixture('provisioning.json', 'ble-deprovision-command')

  assert.equal(
    hexString(bridge.encodeDeprovisionCommand()),
    fixtureHex(command, 'expectedHex'),
  )
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('00')), { success: true })
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('01')), {
    success: false,
    error: 'invalid_token',
  })
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('02')), {
    success: false,
    error: 'storage_error',
  })
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('03')), {
    success: false,
    error: 'chunk_error',
  })
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('04')), {
    success: false,
    error: 'already_paired',
  })
  assert.deepEqual(bridge.decodeDeprovisionResult(hex('fe')), {
    success: false,
    error: 'unknown',
    errorRaw: 0xfe,
  })
  assertCoreBridgeError(
    () => bridge.decodeDeprovisionResult(new Uint8Array()),
    coreError('truncated_packet', 'decode'),
  )
  assertCoreBridgeError(
    () => bridge.decodeDeprovisionResult(hex('0000')),
    coreError('invalid_input', 'decode'),
  )
})

test('connection settings codecs use fixture bytes, Rust defaults, and model normalization', async () => {
  const bridge = await core
  const encoded = await fixture(
    'connection-settings.json',
    'serialize-explicit-v2-settings',
  )
  const decoded = await fixture(
    'connection-settings.json',
    'parse-explicit-v2-settings',
  )
  const unsupported = await fixture(
    'connection-settings.json',
    'unknown-version-uses-defaults',
  )
  const invalid = await fixture(
    'connection-settings.json',
    'invalid-negative-timeout',
  )
  const settings = {
    enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: false },
    uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
    powerManagement: {
      cellularIdleTimeoutSeconds: -1,
      wifiIdleTimeoutSeconds: 0,
    },
    streamingEnabled: false,
    streamingFlushIntervalSeconds: 60,
  }

  assert.equal(
    hexString(bridge.encodeConnectionSettings(settings, 'pin_4g')),
    fixtureHex(encoded, 'expectedHex'),
  )
  assert.deepEqual(
    bridge.decodeConnectionSettings(hex(fixtureHex(decoded, 'inputHex'))),
    { ...settings, supportedVersion: true },
  )
  assert.deepEqual(
    bridge.decodeConnectionSettings(hex(fixtureHex(unsupported, 'inputHex'))),
    {
      enabledConnections: { wifi: true, cellular: true },
      heartbeatEnabledConnections: { wifi: true, cellular: true },
      uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
      powerManagement: {
        cellularIdleTimeoutSeconds: 180,
        wifiIdleTimeoutSeconds: 180,
      },
      streamingEnabled: true,
      streamingFlushIntervalSeconds: 60,
      supportedVersion: false,
    },
  )
  assertCoreBridgeError(
    () => bridge.encodeConnectionSettings({
      ...settings,
      powerManagement: {
        cellularIdleTimeoutSeconds:
          Number((invalid.input as JsonRecord).power_management
            && ((invalid.input as JsonRecord).power_management as JsonRecord)
              .cellular_idle_timeout_seconds),
        wifiIdleTimeoutSeconds: 180,
      },
    }, 'pin_4g'),
    coreError('invalid_input', 'validate'),
  )
  assertCoreBridgeError(
    () => bridge.encodeConnectionSettings(settings, 'unsupported'),
    coreError('invalid_input', 'encode'),
  )
})

test('WiFi codecs match committed fixture packets and reject malformed input', async () => {
  const bridge = await core
  const grant = await fixture('provisioning.json', 'wifi-grant-packet')
  const credentials = await fixture('provisioning.json', 'wifi-credential-packet')
  const disconnect = await fixture('provisioning.json', 'wifi-disconnect-packet')
  const scan = await fixture('provisioning.json', 'wifi-scan-command')
  const config = await fixture('provisioning.json', 'wifi-config-expired')
  const status = await fixture('provisioning.json', 'wifi-status-connected')
  const pending = await fixture('provisioning.json', 'wifi-scan-scanning')
  const done = await fixture('provisioning.json', 'wifi-scan-done')
  const failed = await fixture('provisioning.json', 'wifi-scan-error')

  assert.equal(
    hexString(bridge.encodeWiFiGrant(
      String((grant.input as JsonRecord).grantBlob),
      64,
    )),
    fixtureHex(grant, 'expectedHex'),
  )
  assertCoreBridgeError(
    () => bridge.encodeWiFiGrant('grant.test', 9),
    coreError('payload_too_large', 'encode'),
  )
  assert.equal(
    hexString(bridge.encodeWiFiCredentials(
      String((credentials.input as JsonRecord).ssid),
      String((credentials.input as JsonRecord).password),
    )),
    fixtureHex(credentials, 'expectedHex'),
  )
  assert.equal(
    hexString(bridge.encodeWiFiCredentials(
      String((disconnect.input as JsonRecord).ssid),
      String((disconnect.input as JsonRecord).password),
    )),
    fixtureHex(disconnect, 'expectedHex'),
  )
  assertCoreBridgeError(
    () => bridge.encodeWiFiCredentials('Bota\0Guest', 'secret'),
    coreError('invalid_input', 'encode'),
  )
  assertCoreBridgeError(
    () => bridge.encodeWiFiCredentials('', 'secret'),
    coreError('invalid_input', 'encode'),
  )
  assert.equal(
    hexString(bridge.encodeWiFiScanCommand()),
    fixtureHex(scan, 'expectedHex'),
  )
  assert.deepEqual(
    bridge.decodeWiFiConfigResult(hex(fixtureHex(config, 'inputHex'))),
    config.expected,
  )
  assertCoreBridgeError(
    () => bridge.decodeWiFiConfigResult(new Uint8Array()),
    coreError('truncated_packet', 'decode'),
  )
  assert.deepEqual(
    bridge.decodeWiFiStatus(hex(fixtureHex(status, 'inputHex'))),
    {
      status: 'connected',
      statusRaw: 2,
      signalStrength: 87,
      ssid: 'Bota',
    },
  )
  assertCoreBridgeError(
    () => bridge.decodeWiFiStatus(hex('0257ff')),
    coreError('invalid_input', 'decode'),
  )
  assert.deepEqual(
    bridge.decodeWiFiScanUpdate(hex(fixtureHex(pending, 'inputHex'))),
    { kind: 'pending', statusRaw: 1 },
  )
  assert.deepEqual(
    bridge.decodeWiFiScanUpdate(hex(fixtureHex(done, 'inputHex'))),
    { kind: 'done', ...(done.expected as JsonRecord) },
  )
  assertCoreBridgeError(
    () => bridge.decodeWiFiScanUpdate(hex(fixtureHex(failed, 'inputHex'))),
    coreError('protocol_rejected', 'decode', true, 3),
  )
})

test('recording-control codecs preserve released results and reject unknown commands', async () => {
  const bridge = await core
  const success = await fixture(
    'recording-control.json',
    'recording-control-success',
  )
  const rejected = await fixture(
    'recording-control.json',
    'recording-control-invalid-grant',
  )
  const empty = await fixture(
    'recording-control.json',
    'recording-control-empty-response',
  )
  const start = await fixture(
    'recording-control.json',
    'recording-control-start-command',
  )
  const stop = await fixture(
    'recording-control.json',
    'recording-control-stop-command',
  )

  assert.equal(
    hexString(bridge.encodeRecordingControlCommand('start')),
    fixtureHex(start, 'expectedHex'),
  )
  assert.equal(
    hexString(bridge.encodeRecordingControlCommand('stop')),
    fixtureHex(stop, 'expectedHex'),
  )
  assertCoreBridgeError(
    () => bridge.encodeRecordingControlCommand('pause' as 'start'),
    coreError('invalid_input', 'encode'),
  )
  assert.deepEqual(
    bridge.decodeRecordingControlResult(hex(fixtureHex(success, 'inputHex'))),
    success.expected,
  )
  assert.deepEqual(
    bridge.decodeRecordingControlResult(hex(fixtureHex(rejected, 'inputHex'))),
    rejected.expected,
  )
  assert.deepEqual(
    bridge.decodeRecordingControlResult(hex(fixtureHex(empty, 'inputHex'))),
    empty.expected,
  )
})

test('encrypted-upload-v2 transfer codecs decode vectors and round-trip app frames', async () => {
  const bridge = await core
  const validNames = [
    'ble-list',
    'ble-recording-entry',
    'ble-recording-list-end',
    'ble-fresh-transfer',
    'ble-start-ack',
    'ble-data',
    'ble-window-end',
    'ble-window-clean-ack',
    'ble-window-repair',
    'ble-manifest-chunk',
    'ble-eof',
    'ble-resume-request',
    'ble-resume-accepted',
    'ble-resume-reject',
    'ble-confirm',
    'ble-abort',
    'ble-error',
  ]
  const appFrameNames = [
    'ble-list',
    'ble-fresh-transfer',
    'ble-window-clean-ack',
    'ble-window-repair',
    'ble-resume-request',
    'ble-confirm',
    'ble-abort',
  ]
  const deviceFrameNames = [
    'ble-recording-entry',
    'ble-start-ack',
    'ble-data',
    'ble-window-end',
    'ble-manifest-chunk',
    'ble-eof',
    'ble-resume-accepted',
    'ble-resume-reject',
    'ble-error',
  ]

  for (const name of validNames) {
    const fixture = await vector(name)
    const decoded = bridge.decodeEncryptedUploadV2Transfer(
      hex(fixtureHex(fixture, 'inputHex')),
    )
    const expected = fixture.expected as JsonRecord
    assert.equal(decoded.kind, snakeCase(String(expected.decodedType)), name)
  }

  for (const name of appFrameNames) {
    const fixture = await vector(name)
    const decoded = bridge.decodeEncryptedUploadV2Transfer(
      hex(fixtureHex(fixture, 'inputHex')),
    )
    assert.equal(
      hexString(bridge.encodeEncryptedUploadV2Transfer(decoded)),
      String((fixture.expected as JsonRecord).encodedHex),
      name,
    )
  }

  for (const name of deviceFrameNames) {
    const fixture = await vector(name)
    const decoded = bridge.decodeEncryptedUploadV2Transfer(
      hex(fixtureHex(fixture, 'inputHex')),
    )
    const expected = fixture.expected as JsonRecord
    const transferDto = expected.transferDto
    assert.ok(transferDto, `${name} has no committed transfer DTO`)
    assert.deepEqual(jsonCodecValue(decoded), transferDto, name)
    if (name === 'ble-recording-entry') {
      assert.ok(
        BigInt(String((transferDto as JsonRecord).startedAt))
          > BigInt(Number.MAX_SAFE_INTEGER),
        `${name} does not exercise a u64 above Number.MAX_SAFE_INTEGER`,
      )
    }
  }

  const malformed = await vector('ble-truncated-start')
  assertCoreBridgeError(
    () => bridge.decodeEncryptedUploadV2Transfer(
      hex(fixtureHex(malformed, 'inputHex')),
    ),
    coreError('truncated_packet', 'decode'),
  )
  const unknown = await vector('ble-unknown-message')
  assertCoreBridgeError(
    () => bridge.decodeEncryptedUploadV2Transfer(
      hex(fixtureHex(unknown, 'inputHex')),
    ),
    coreError('unknown_packet', 'decode', false, 0x7e),
  )
  const deviceFrame = bridge.decodeEncryptedUploadV2Transfer(
    hex(fixtureHex(await vector('ble-data'), 'inputHex')),
  )
  assertCoreBridgeError(
    () => bridge.encodeEncryptedUploadV2Transfer(deviceFrame),
    coreError('invalid_input', 'encode'),
  )
})

test('encrypted-upload-v2 status decoder rejects noncanonical lengths', async () => {
  const bridge = await core
  const statusVector = await vector('ble-transfer-status')
  const status = hex(fixtureHex(statusVector, 'inputHex'))
  const expected = statusVector.expected as JsonRecord

  assert.deepEqual(
    jsonCodecValue(bridge.decodeEncryptedUploadV2Status(status)),
    expected.statusDto,
  )
  assert.ok(
    BigInt(String((expected.statusDto as JsonRecord).durableCiphertextBytes))
      > BigInt(Number.MAX_SAFE_INTEGER),
    'status vector does not exercise a u64 above Number.MAX_SAFE_INTEGER',
  )
  assertCoreBridgeError(
    () => bridge.decodeEncryptedUploadV2Status(status.slice(0, -1)),
    coreError('truncated_packet', 'decode'),
  )
  assertCoreBridgeError(
    () => bridge.decodeEncryptedUploadV2Status(
      Uint8Array.from([...status, 0]),
    ),
    coreError('invalid_input', 'decode'),
  )
})

test('encrypted-upload-v2 signed-blob encoders match committed vectors', async () => {
  const bridge = await core
  const begin = await vector('ble-blob-begin')
  const data = await vector('ble-blob-data')
  const commit = await vector('ble-blob-commit')
  const abort = await vector('ble-blob-abort')
  const beginBytes = hex(fixtureHex(begin, 'inputHex'))
  const dataBytes = hex(fixtureHex(data, 'inputHex'))
  const frames = [
    {
      fixture: begin,
      frame: {
        kind: 'begin',
        blobKind: 'authorization',
        writeId: 0x0102_0304,
        totalLength: 408,
        sha256: beginBytes.slice(10),
      },
    },
    {
      fixture: data,
      frame: {
        kind: 'data',
        blobKind: 'authorization',
        writeId: 0x0102_0304,
        offset: 0,
        data: dataBytes.slice(12),
      },
    },
    {
      fixture: commit,
      frame: {
        kind: 'commit',
        blobKind: 'authorization',
        writeId: 0x0102_0304,
      },
    },
    {
      fixture: abort,
      frame: {
        kind: 'abort',
        blobKind: 'authorization',
        writeId: 0x0102_0304,
      },
    },
  ]

  for (const { fixture, frame } of frames) {
    assert.equal(
      hexString(bridge.encodeEncryptedUploadV2SignedBlob(frame)),
      String((fixture.expected as JsonRecord).encodedHex),
      fixture.name,
    )
  }
  assertCoreBridgeError(
    () => bridge.encodeEncryptedUploadV2SignedBlob({
      ...frames[0]?.frame,
      sha256: new Uint8Array(31),
    }),
    coreError('invalid_input', 'encode'),
  )
})

test('integrity hashing is incremental, snapshot-safe, and uses IEEE CRC-32', async () => {
  const bridge = await core
  const hasher = bridge.createIntegrityHasher()
  const resumed = bridge.createIntegrityHasher()
  const first = new TextEncoder().encode('1234')
  const second = new TextEncoder().encode('56789')

  hasher.update(first)
  const prefix = hexString(hasher.sha256Snapshot())
  hasher.update(second)
  resumed.update(first)
  resumed.update(second)

  assert.equal(hasher.length(), 9n)
  assert.equal(hasher.crc32(), 0xcbf4_3926)
  assert.equal(
    hexString(hasher.sha256Snapshot()),
    '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225',
  )
  assert.equal(hexString(resumed.sha256Snapshot()), hexString(hasher.sha256Snapshot()))
  assert.notEqual(prefix, hexString(hasher.sha256Snapshot()))
})

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function jsonCodecValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Array.from(value)
  if (Array.isArray(value)) return value.map(jsonCodecValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonCodecValue(item)]),
    )
  }
  return value
}

function coreError(
  code: CoreBridgeError['code'],
  operation: CoreBridgeError['operation'],
  retryable = false,
  protocolStatus: number | null = null,
): Pick<CoreBridgeError, 'code' | 'operation' | 'retryable' | 'protocolStatus'> {
  return { code, operation, retryable, protocolStatus }
}

function assertCoreBridgeError(
  run: () => unknown,
  expected: Pick<
    CoreBridgeError,
    'code' | 'operation' | 'retryable' | 'protocolStatus'
  >,
): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof CoreBridgeError, 'expected CoreBridgeError')
  assert.deepEqual({
    code: caught.code,
    operation: caught.operation,
    retryable: caught.retryable,
    protocolStatus: caught.protocolStatus,
  }, expected)
}
