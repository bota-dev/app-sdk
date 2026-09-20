import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCoreLoader } from '../core.ts'
import type { CoreBridge } from '../core.ts'
import { BotaSDKError, normalizeCoreError } from '../errors.ts'
import { createWasmCore } from '../wasmCore.ts'

interface EffectEnvelopeUnderTest {
  requestId: bigint
  operation: string
  cancellationId: Uint8Array
  effect: Record<string, unknown>
}

interface WorkflowBridgeUnderTest {
  startExactConnection(input: {
    expectedSerialNumber: string
    peripheralId: string
    name: string | null
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  startReconnect(input: {
    expectedSerialNumber: string
    hint: {
      storedPeripheralId: string | null
      advertisedAddress: string | null
      storedName: string | null
      scanTimeoutMs: bigint
      connectionTimeoutMs: bigint
    }
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  startProvisioning(input: {
    serialNumber: string
    materialId: string
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  startRecordingTransfer(input: {
    serialNumber: string
    recordingUuid: string
    sinkId: string
    totalUnits: bigint
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  startEncryptedUploadV2(input: ReturnType<typeof encryptedUploadV2Input>): EffectEnvelopeUnderTest[]
  startFirmwareUpdate(input: {
    serialNumber: string
    version: string
    sizeBytes: number
    crc32: number
    downloadId: bigint
    reconnectHint: {
      storedPeripheralId: string | null
      advertisedAddress: string | null
      storedName: string | null
      scanTimeoutMs: bigint
      connectionTimeoutMs: bigint
    }
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  startDeviceLogs(input: {
    serialNumber: string
    cancellationId: Uint8Array
  }): EffectEnvelopeUnderTest[]
  dispatch(event: Record<string, unknown>): EffectEnvelopeUnderTest[]
  cancel(cancellationId: Uint8Array): EffectEnvelopeUnderTest[]
}

const CANCELLATION_ID = new Uint8Array(16).fill(0x11)
const RECORDING_UUID = '22222222-2222-2222-2222-222222222222'
const UPLOAD_SESSION_ID = '44444444-4444-4444-4444-444444444444'

async function createWorkflowBridge(): Promise<WorkflowBridgeUnderTest> {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  return await createWasmCore(wasm) as unknown as WorkflowBridgeUnderTest
}

function encryptedUploadV2Input() {
  return {
    serialNumber: 'EVFXXW67KP',
    recordingUuid: RECORDING_UUID,
    recordingGeneration: 9,
    storageFormat: 3,
    uploadSessionId: UPLOAD_SESSION_ID,
    ownerRevision: 3,
    transportSessionId: 0x1_0000_0000n,
    materialId: 'web-v2-material-1',
    sinkId: 'web-v2-sink-1',
    policy: 'v2_preferred' as const,
    capabilities: {
      flags: 0x7f,
      maximumSignedBlobBytes: 1_024,
      maximumManifestBytes: 1_024,
      maximumDataPayloadBytes: 244,
      maximumWindowPackets: 16,
      durableCheckpointIntervalBlocks: 8,
      maximumMissingSequences: 16,
    },
    windowPackets: 16,
    dataPayloadBytes: 244,
    ciphertextLength: 330n,
    ciphertextSha256: new Uint8Array(32).fill(0x33),
    cancellationId: CANCELLATION_ID,
  }
}

function reconnectInput(cancellationId = CANCELLATION_ID) {
  return {
    expectedSerialNumber: 'EVFXXW67KP',
    hint: {
      storedPeripheralId: 'browser-peripheral-1',
      advertisedAddress: '001122334455',
      storedName: 'Bota Pin',
      scanTimeoutMs: 5_000n,
      connectionTimeoutMs: 15_000n,
    },
    cancellationId,
  }
}

function assertPrivateCoreError(
  error: unknown,
  code: string,
  operation: string,
): boolean {
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof BotaSDKError))
  const structured = error as Error & {
    code?: unknown
    operation?: unknown
    retryable?: unknown
  }
  assert.equal(structured.code, code)
  assert.equal(structured.operation, operation)
  assert.equal(structured.retryable, false)
  return true
}

function effect(
  effects: EffectEnvelopeUnderTest[],
  kind: string,
): EffectEnvelopeUnderTest {
  const found = effects.find((candidate) => candidate.effect.kind === kind)
  assert.ok(found, `expected ${kind} effect`)
  return found
}

function assertOwnership(envelope: EffectEnvelopeUnderTest, operation: string): void {
  assert.equal(typeof envelope.requestId, 'bigint')
  assert.equal(envelope.operation, operation)
  assert.deepEqual(envelope.cancellationId, CANCELLATION_ID)
}

const bridge: CoreBridge = {
  startExactConnection: () => [],
  startReconnect: () => [],
  startProvisioning: () => [],
  startRecordingTransfer: () => [],
  startEncryptedUploadV2: () => [],
  startFirmwareUpdate: () => [],
  startDeviceLogs: () => [],
  cancel: () => [],
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
  decodeRecordingList: () => [],
  encodeRecordingListCommand: () => new Uint8Array(),
  encodeRecordingConfirm: () => new Uint8Array(),
  encodeDeprovisionCommand: () => new Uint8Array(),
  decodeDeprovisionResult: () => ({ success: true }),
  decodeConnectionSettings: () => ({
    enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: true },
    uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
    powerManagement: {
      cellularIdleTimeoutSeconds: 180,
      wifiIdleTimeoutSeconds: 180,
    },
    streamingEnabled: true,
    streamingFlushIntervalSeconds: 60,
    supportedVersion: true,
  }),
  encodeConnectionSettings: () => new Uint8Array(),
  encodeWiFiGrant: () => new Uint8Array(),
  encodeWiFiCredentials: () => new Uint8Array(),
  encodeWiFiScanCommand: () => new Uint8Array(),
  decodeWiFiConfigResult: () => ({ success: true }),
  decodeWiFiStatus: () => ({ status: 'idle', statusRaw: 0 }),
  decodeWiFiScanUpdate: () => ({ kind: 'pending', statusRaw: 1 }),
  encodeRecordingControlCommand: () => new Uint8Array(),
  decodeRecordingControlResult: () => ({ success: true }),
  decodeEncryptedUploadV2Transfer: () => ({
    kind: 'list',
    flags: 0,
    transportSessionId: 1n,
  }),
  encodeEncryptedUploadV2Transfer: () => new Uint8Array(),
  decodeEncryptedUploadV2Status: () => ({
    phase: 0,
    result: 0,
    transportSessionId: 1n,
    durableCiphertextBytes: 0n,
    progressPercent: 0,
    transportProfile: 2,
  }),
  encodeEncryptedUploadV2SignedBlob: () => new Uint8Array(),
  decodeEncryptedUploadV2SignedBlobResult: () => ({
    blobKind: 'authorization',
    writeId: 1,
    result: 0,
  }),
  createIntegrityHasher: () => ({
    update: () => undefined,
    length: () => 0n,
    crc32: () => 0,
    sha256Snapshot: () => new Uint8Array(32),
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

test('unknown platform errors are normalized without retaining their causes', () => {
  const platformError = new Error('token=secret-value')

  const error = normalizeCoreError(platformError, 'initialize')

  assert.equal(error.code, 'internal_error')
  assert.equal(error.cause, undefined)
  assert.doesNotMatch(error.message, /secret-value/)
})

test('the additional WASM workflow starts return typed first effects', async () => {
  const reconnectHint = {
    storedPeripheralId: 'browser-peripheral-1',
    advertisedAddress: '001122334455',
    storedName: 'Bota Pin',
    scanTimeoutMs: 5_000n,
    connectionTimeoutMs: 15_000n,
  }
  const cases = [
    {
      operation: 'reconnect',
      effectKind: 'ble_start_scan',
      start: (core: WorkflowBridgeUnderTest) => core.startReconnect({
        expectedSerialNumber: 'EVFXXW67KP',
        hint: reconnectHint,
        cancellationId: CANCELLATION_ID,
      }),
    },
    {
      operation: 'provision',
      effectKind: 'ble_read',
      start: (core: WorkflowBridgeUnderTest) => core.startProvisioning({
        serialNumber: 'EVFXXW67KP',
        materialId: 'web-material-1',
        cancellationId: CANCELLATION_ID,
      }),
    },
    {
      operation: 'transfer_recording',
      effectKind: 'persistence_load_checkpoint',
      start: (core: WorkflowBridgeUnderTest) => core.startRecordingTransfer({
        serialNumber: 'EVFXXW67KP',
        recordingUuid: RECORDING_UUID,
        sinkId: 'web-sink-1',
        totalUnits: 4_096n,
        cancellationId: CANCELLATION_ID,
      }),
    },
    {
      operation: 'update_firmware',
      effectKind: 'persistence_load_checkpoint',
      start: (core: WorkflowBridgeUnderTest) => core.startFirmwareUpdate({
        serialNumber: 'EVFXXW67KP',
        version: '1.0.18',
        sizeBytes: 1_024,
        crc32: 0x1234_5678,
        downloadId: 41n,
        reconnectHint,
        cancellationId: CANCELLATION_ID,
      }),
    },
    {
      operation: 'read_device_logs',
      effectKind: 'ble_subscribe',
      start: (core: WorkflowBridgeUnderTest) => core.startDeviceLogs({
        serialNumber: 'EVFXXW67KP',
        cancellationId: CANCELLATION_ID,
      }),
    },
  ] as const

  for (const workflow of cases) {
    const started = workflow.start(await createWorkflowBridge())
    const first = effect(started, workflow.effectKind)
    assertOwnership(first, workflow.operation)
  }
})

test('WASM preserves OperationInProgress and Reconnect for a second owner', async () => {
  const core = await createWorkflowBridge()
  core.startReconnect(reconnectInput())

  assert.throws(
    () => core.startReconnect(reconnectInput()),
    (error: unknown) => assertPrivateCoreError(
      error,
      'operation_in_progress',
      'reconnect',
    ),
  )
})

test('WASM preserves UnexpectedEvent and Reconnect for a wrong cancellation owner', async () => {
  const core = await createWorkflowBridge()
  core.startReconnect(reconnectInput())

  assert.throws(
    () => core.cancel(new Uint8Array(16).fill(0x12)),
    (error: unknown) => assertPrivateCoreError(
      error,
      'unexpected_event',
      'reconnect',
    ),
  )
})

test('WASM workflow envelopes preserve bigint, fixed bytes, and ownership', async () => {
  const core = await createWorkflowBridge()
  const started = core.startEncryptedUploadV2(encryptedUploadV2Input())
  const load = effect(started, 'encrypted_upload_v2_load_checkpoint')

  assertOwnership(load, 'transfer_recording')
  assert.deepEqual(load.effect.recordingUuid, new Uint8Array(16).fill(0x22))
  assert.deepEqual(load.effect.uploadSessionId, new Uint8Array(16).fill(0x44))

  const truncated = effect(
    core.dispatch({
      requestId: load.requestId,
      kind: 'encrypted_upload_v2_checkpoint_loaded',
      checkpoint: null,
    }),
    'encrypted_upload_v2_truncate_sink',
  )
  assertOwnership(truncated, 'transfer_recording')

  const prepare = effect(
    core.dispatch({
      requestId: truncated.requestId,
      kind: 'encrypted_upload_v2_sink_truncated',
    }),
    'encrypted_upload_v2_prepare_session',
  )
  assertOwnership(prepare, 'transfer_recording')

  const authorizationSha256 = new Uint8Array(32).fill(0x55)
  const transfer = effect(
    core.dispatch({
      requestId: prepare.requestId,
      kind: 'encrypted_upload_v2_session_prepared',
      authorizationSha256,
    }),
    'encrypted_upload_v2_start_transfer',
  )
  assertOwnership(transfer, 'transfer_recording')
  assert.deepEqual(transfer.effect.authorizationSha256, authorizationSha256)
  assert.equal(transfer.effect.transportSessionId, 0x1_0000_0000n)
  assert.equal(transfer.effect.ciphertextLength, 330n)
  assert.deepEqual(
    transfer.effect.ciphertextSha256,
    new Uint8Array(32).fill(0x33),
  )

  assert.deepEqual(core.dispatch({
    requestId: transfer.requestId,
    kind: 'encrypted_upload_v2_transfer_started',
  }), [])

  const checkpoint = {
    serialNumber: 'EVFXXW67KP',
    recordingUuid: new Uint8Array(16).fill(0x22),
    recordingGeneration: 9,
    uploadSessionId: new Uint8Array(16).fill(0x44),
    ownerRevision: 3,
    transportSessionId: 0x1_0000_0000n,
    checkpointRevision: 1,
    nextCiphertextOffset: 244n,
    prefixSha256: new Uint8Array(32).fill(0x66),
    windowPackets: 16,
    dataPayloadBytes: 244,
  }
  const save = effect(
    core.dispatch({
      requestId: transfer.requestId,
      kind: 'encrypted_upload_v2_window_staged',
      checkpoint,
      missingSequences: [],
    }),
    'encrypted_upload_v2_save_checkpoint',
  )
  assert.deepEqual(
    (save.effect.checkpoint as Record<string, unknown>).prefixSha256,
    checkpoint.prefixSha256,
  )

  const acknowledge = effect(
    core.dispatch({
      requestId: save.requestId,
      kind: 'encrypted_upload_v2_checkpoint_saved',
    }),
    'encrypted_upload_v2_acknowledge_window',
  )
  const progress = effect(
    core.dispatch({
      requestId: acknowledge.requestId,
      kind: 'encrypted_upload_v2_window_acknowledged',
      checkpoint,
    }),
    'progress',
  )
  assert.equal(progress.effect.completedUnits, 244n)
  assert.equal(progress.effect.totalUnits, 330n)

  const evidence = {
    ciphertextLength: 330n,
    ciphertextSha256: new Uint8Array(32).fill(0x33),
    manifestLength: 580,
    manifestSha256: new Uint8Array(32).fill(0x77),
    blockCount: 1,
  }
  const stage = effect(
    core.dispatch({
      requestId: transfer.requestId,
      kind: 'encrypted_upload_v2_transfer_completed',
      evidence,
    }),
    'encrypted_upload_v2_stage_artifacts',
  )
  assert.deepEqual(
    (stage.effect.evidence as Record<string, unknown>).manifestSha256,
    evidence.manifestSha256,
  )

  const staged = core.dispatch({
    requestId: stage.requestId,
    kind: 'encrypted_upload_v2_artifacts_staged',
  })
  const notification = effect(staged, 'notify')
  const stagedNotification = notification.effect.notification as Record<string, unknown>
  assert.deepEqual(stagedNotification.uploadSessionId, checkpoint.uploadSessionId)
  assert.deepEqual(stagedNotification.ciphertextSha256, evidence.ciphertextSha256)
  assert.deepEqual(stagedNotification.manifestSha256, evidence.manifestSha256)

  const receiptRequest = effect(staged, 'encrypted_upload_v2_await_completion_receipt')
  const receiptSha256 = new Uint8Array(32).fill(0x88)
  const confirm = effect(
    core.dispatch({
      requestId: receiptRequest.requestId,
      kind: 'encrypted_upload_v2_completion_receipt_accepted',
      receiptSha256,
    }),
    'encrypted_upload_v2_confirm_with_receipt',
  )
  assert.deepEqual(confirm.effect.receiptSha256, receiptSha256)

  const cancelled = core.cancel(CANCELLATION_ID)
  assert.ok(cancelled.length > 0)
  for (const envelope of cancelled) {
    assertOwnership(envelope, 'transfer_recording')
  }
})

test('WASM workflow inputs reject malformed fixed-length byte arrays', async () => {
  const core = await createWorkflowBridge()

  assert.throws(
    () => core.startExactConnection({
      expectedSerialNumber: 'EVFXXW67KP',
      peripheralId: 'browser-peripheral-1',
      name: 'Bota Pin',
      cancellationId: new Uint8Array(15),
    }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'invalid_input')
      return true
    },
  )

  assert.throws(
    () => core.startEncryptedUploadV2({
      ...encryptedUploadV2Input(),
      ciphertextSha256: new Uint8Array(31),
    }),
    (error: unknown) => assertPrivateCoreError(error, 'invalid_input', 'validate'),
  )

  assert.throws(
    () => core.cancel(new Uint8Array(17)),
    (error: unknown) => assertPrivateCoreError(error, 'invalid_input', 'validate'),
  )
})

test('unknown private host-event variants fail as internal errors', async () => {
  const core = await createWorkflowBridge()

  assert.throws(
    () => core.dispatch({ requestId: 1n, kind: 'future_host_event' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'internal_error')
      return true
    },
  )
})
