import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import type { CoreBridge, CoreWorkflowCheckpoint } from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_STORAGE_SERVICE,
  FIRMWARE_REVISION_CHARACTERISTIC,
} from '../gatt.ts'
import type {
  FirmwareImageDescriptor,
  FirmwareUpdateProgress,
} from '../models.ts'
import { OTAManager } from '../otaManager.ts'
import type { FirmwareDownloadProvider } from '../providers.ts'
import type {
  BrowserBlobHandle,
  FirmwareJournal,
} from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import {
  deferred,
  FakeRecordingBlob,
  FakeRecordingStorage,
} from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const TRANSFER_CONTROL_CHARACTERISTIC =
  'b07a0004-0004-1000-8000-00805f9b34fb'
const RECORDING_TRANSFER_CHARACTERISTIC =
  'b07a0004-0003-1000-8000-00805f9b34fb'
const TRANSFER_STATUS_CHARACTERISTIC =
  'b07a0004-0005-1000-8000-00805f9b34fb'
const FIRMWARE_UPLOAD_START = 0x08
const FIRMWARE_UPLOAD_VERIFY = 0x09
const MAX_DOWNLOAD_WRITE = 64 * 1024

const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

type ResolveContext = Parameters<FirmwareDownloadProvider['resolve']>[0]
type DownloadRequest = Awaited<ReturnType<FirmwareDownloadProvider['resolve']>>
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class FakeFirmwareProvider implements FirmwareDownloadProvider {
  readonly calls: ResolveContext[] = []
  readonly events: string[]
  request: DownloadRequest = {
    method: 'GET',
    url: 'https://firmware-secret.example.invalid/image.ufw?token=secret',
    headers: { Authorization: 'Bearer firmware-secret' },
  }
  resolveHandler: ((context: ResolveContext) => Promise<DownloadRequest>) | null = null

  constructor(events: string[] = []) {
    this.events = events
  }

  async resolve(context: ResolveContext): Promise<DownloadRequest> {
    this.events.push('provider:resolve')
    this.calls.push({
      operationId: context.operationId,
      serialNumber: context.serialNumber,
      image: { ...context.image },
    })
    if (this.resolveHandler) return await this.resolveHandler(context)
    return {
      method: this.request.method,
      url: this.request.url,
      headers: { ...this.request.headers },
    }
  }
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

class FakeFirmwareFetcher {
  readonly calls: FetchCall[] = []
  readonly events: string[]
  handler: (call: FetchCall) => Promise<Response>

  constructor(
    response: Response,
    events: string[] = [],
  ) {
    this.events = events
    this.handler = async () => response
  }

  readonly fetch: Fetcher = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const call = { url, init }
    this.calls.push(call)
    this.events.push('fetch:start')
    return await this.handler(call)
  }
}

class ObservedFirmwareBlob extends FakeRecordingBlob {
  readonly reads: Array<{ offset: number; maximumLength: number }> = []
  readonly writes: Array<{ offset: number; length: number }> = []
  readonly truncations: number[] = []
  deleteError: unknown = null

  override async truncate(size: number): Promise<void> {
    this.truncations.push(size)
    await super.truncate(size)
  }

  override async write(offset: number, bytes: Uint8Array): Promise<void> {
    this.writes.push({ offset, length: bytes.byteLength })
    await super.write(offset, bytes)
  }

  override async read(
    offset: number,
    maximumLength: number,
  ): Promise<Uint8Array> {
    this.reads.push({ offset, maximumLength })
    return await super.read(offset, maximumLength)
  }

  override async delete(): Promise<void> {
    if (this.deleteError) throw this.deleteError
    await super.delete()
  }
}

class FakeFirmwareStorage extends FakeRecordingStorage {
  readonly firmwareJournals = new Map<string, FirmwareJournal>()
  verifiedSaveGate: Promise<void> | null = null
  checkpointDeleteError: unknown = null
  blobDeleteError: unknown = null
  journalDeleteError: unknown = null

  override async loadFirmwareJournal(
    operationId: string,
  ): Promise<FirmwareJournal | null> {
    this.events.push('firmware:load')
    const journal = this.firmwareJournals.get(operationId)
    return journal ? { ...journal } : null
  }

  override async saveFirmwareJournal(journal: FirmwareJournal): Promise<void> {
    this.events.push(
      `firmware:save:${journal.verified ? 'verified' : 'identity'}:begin`,
    )
    if (journal.verified && this.verifiedSaveGate) await this.verifiedSaveGate
    this.firmwareJournals.set(journal.operationId, { ...journal })
    this.events.push(
      `firmware:save:${journal.verified ? 'verified' : 'identity'}:done`,
    )
  }

  override async deleteFirmwareJournal(operationId: string): Promise<void> {
    if (this.journalDeleteError) throw this.journalDeleteError
    this.events.push('firmware:delete')
    this.firmwareJournals.delete(operationId)
  }

  override async deleteWorkflowCheckpoint(operationId: string): Promise<void> {
    if (this.checkpointDeleteError) throw this.checkpointDeleteError
    await super.deleteWorkflowCheckpoint(operationId)
  }

  override async openBlob(blobId: string): Promise<ObservedFirmwareBlob> {
    this.openBlobCalls += 1
    this.events.push(`blob:open:${blobId}`)
    let blob = this.blobs.get(blobId)
    if (!blob) {
      blob = new ObservedFirmwareBlob(blobId, this.events)
      this.blobs.set(blobId, blob)
    }
    assert.ok(blob instanceof ObservedFirmwareBlob)
    blob.deleteError = this.blobDeleteError
    return blob
  }

  blob(blobId: string): ObservedFirmwareBlob {
    const blob = this.blobs.get(blobId)
    assert.ok(blob instanceof ObservedFirmwareBlob)
    return blob
  }

  override async clear(): Promise<void> {
    await super.clear()
    this.firmwareJournals.clear()
  }
}

interface Harness {
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  fetcher: FakeFirmwareFetcher
  ota: OTAManager
  provider: FakeFirmwareProvider
  runtime: BrowserWorkflowRuntime
  storage: FakeFirmwareStorage
  transport: FakeBrowserBluetoothTransport
}

async function createHarness(options: {
  bytes?: Uint8Array
  connected?: boolean
  firmwareUpdateCapability?: boolean
  provider?: FakeFirmwareProvider
  storage?: FakeFirmwareStorage
  fetcher?: FakeFirmwareFetcher
} = {}): Promise<Harness> {
  const events = options.storage?.events ?? []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  const storage = options.storage ?? new FakeFirmwareStorage(
    'organization:project:user',
    events,
  )
  const provider = options.provider ?? new FakeFirmwareProvider(events)
  const bytes = options.bytes ?? Uint8Array.of(1, 2, 3, 4)
  const fetcher = options.fetcher ?? new FakeFirmwareFetcher(
    response([bytes], 200, bytes.byteLength),
    events,
  )
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime, storage })
  Object.defineProperty(devices, 'getCapabilities', {
    configurable: true,
    value: () => Object.freeze({
      bluetooth: true,
      authorizedDeviceReconnect: true,
      durableStorage: true,
      largeRecordingSync: true,
      firmwareUpdate: options.firmwareUpdateCapability ?? true,
    }),
  })
  if (options.connected !== false) {
    await devices.connect({ expectedSerialNumber: SERIAL })
    events.length = 0
    transport.calls.length = 0
    transport.writes.length = 0
  }
  const ota = new OTAManager({
    core,
    transport,
    runtime,
    devices,
    storage,
    provider,
    fetcher: fetcher.fetch,
    now: () => 1_789_000_000_000,
  })
  return {
    core,
    devices,
    events,
    fetcher,
    ota,
    provider,
    runtime,
    storage,
    transport,
  }
}

test('firmwareUpdate capability fails before provider, storage, or device mutation', async () => {
  const harness = await createHarness({
    connected: false,
    firmwareUpdateCapability: false,
  })
  const image = descriptor(Uint8Array.of(1, 2, 3, 4))

  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId: 'update_firmware:unsupported' }),
    isSdkError('unsupported_capability'),
  )

  assert.deepEqual(harness.provider.calls, [])
  assert.deepEqual(harness.storage.firmwareJournals, new Map())
  assert.deepEqual(harness.transport.calls, [])
  assert.deepEqual(harness.transport.writes, [])
})

test('an orphan Rust checkpoint rejects a new update before provider or GATT', async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4)
  const image = descriptor(bytes)
  const operationId = 'update_firmware:orphan-checkpoint'
  const harness = await createHarness({ bytes })
  harness.storage.workflowCheckpoints.set(operationId, {
    workflow: 'firmware_update',
    operation: 'update_firmware',
    serialNumber: SERIAL,
    recordingUuid: null,
    phase: 'transferring',
    completedUnits: 0n,
    retryCount: 0,
    lastSequence: null,
    firmwareVersion: image.version,
  } satisfies CoreWorkflowCheckpoint)
  installStartResult(harness, 1)

  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('resume_rejected'),
  )

  assert.equal(harness.storage.firmwareJournals.has(operationId), false)
  assert.deepEqual(harness.provider.calls, [])
  assert.deepEqual(harness.transport.calls, [])
  assert.deepEqual(harness.transport.writes, [])
})

test('download persists only stable identity, writes bounded OPFS chunks, and reports monotonic progress before GATT', async () => {
  const bytes = Uint8Array.from(
    { length: MAX_DOWNLOAD_WRITE * 2 + 17 },
    (_, index) => index % 251,
  )
  const harness = await createHarness({ bytes })
  installStartResult(harness, 1)
  const image = descriptor(bytes)
  const progress: FirmwareUpdateProgress[] = []
  const operationId = 'update_firmware:bounded-download'

  await assert.rejects(
    harness.ota.updateFirmware(image, {
      operationId,
      onProgress: (value) => progress.push({ ...value }),
    }),
    isSdkError('firmware_rejected'),
  )

  assert.deepEqual(harness.provider.calls, [{
    operationId,
    serialNumber: SERIAL,
    image,
  }])
  assert.equal(
    indexOf(harness.events, 'firmware:save:identity:done')
      < indexOf(harness.events, 'provider:resolve'),
    true,
  )
  assert.equal(
    indexOf(harness.events, 'firmware:save:verified:done')
      < indexOfPrefix(harness.events, 'write:'),
    true,
  )
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal)
  const persisted = stringify(journal)
  assert.doesNotMatch(persisted, /firmware-secret|https:|Authorization|Bearer/)
  const blob = harness.storage.blob(journal.blobId)
  assert.ok(blob.writes.length >= 3)
  assert.ok(blob.writes.every(({ length }) => length <= MAX_DOWNLOAD_WRITE))
  assert.equal(blob.writes.at(-1)?.offset! + blob.writes.at(-1)?.length!, bytes.length)
  assert.deepEqual(blob.snapshot(), bytes)
  assert.equal(harness.fetcher.calls.length, 1)
  assert.equal(harness.fetcher.calls[0]?.init?.method, 'GET')
  assert.deepEqual(harness.fetcher.calls[0]?.init?.headers, {
    Authorization: 'Bearer firmware-secret',
  })
  const downloading = progress.filter(({ phase }) => phase === 'downloading')
  assert.ok(downloading.length >= 4)
  assert.deepEqual(downloading.at(-1), {
    phase: 'downloading',
    completedBytes: BigInt(bytes.byteLength),
    totalBytes: BigInt(bytes.byteLength),
  })
  for (let index = 1; index < downloading.length; index += 1) {
    assert.ok(
      downloading[index]!.completedBytes >= downloading[index - 1]!.completedBytes,
    )
  }
})

test('HTTP status, exact size, SHA-256, and CRC32 fail before the first device write', async (t) => {
  const bytes = Uint8Array.of(10, 20, 30, 40, 50)
  const image = descriptor(bytes)
  const cases: Array<{
    name: string
    request?: DownloadRequest
    response: Response
    code: 'upload_failed' | 'integrity_failed'
  }> = [
    {
      name: 'HTTP status',
      response: response([bytes], 503, bytes.byteLength),
      code: 'upload_failed',
    },
    {
      name: 'Content-Length header',
      response: response([bytes], 200, bytes.byteLength + 1),
      code: 'integrity_failed',
    },
    {
      name: 'short body',
      response: response([bytes.subarray(0, bytes.byteLength - 1)], 200),
      code: 'integrity_failed',
    },
    {
      name: 'long body',
      response: response([bytes, Uint8Array.of(99)], 200),
      code: 'integrity_failed',
    },
    {
      name: 'SHA-256',
      response: response([Uint8Array.of(10, 20, 30, 40, 51)], 200, bytes.byteLength),
      code: 'integrity_failed',
    },
    {
      name: 'CRC32',
      response: response([bytes], 200, bytes.byteLength),
      code: 'integrity_failed',
    },
    {
      name: 'non-loopback HTTP',
      request: {
        method: 'GET',
        url: 'http://firmware-secret.example.invalid/image.ufw?token=secret',
        headers: { Authorization: 'Bearer secret' },
      },
      response: response([bytes], 200, bytes.byteLength),
      code: 'upload_failed',
    },
  ]

  for (const failure of cases) {
    await t.test(failure.name, async () => {
      const events: string[] = []
      const provider = new FakeFirmwareProvider(events)
      if (failure.request) provider.request = failure.request
      const fetcher = new FakeFirmwareFetcher(failure.response, events)
      const harness = await createHarness({ provider, fetcher })
      const candidate = failure.name === 'CRC32'
        ? { ...image, crc32: (image.crc32 + 1) >>> 0 }
        : failure.name === 'SHA-256'
          ? image
          : image
      const error = await harness.ota.updateFirmware(candidate, {
        operationId: `update_firmware:invalid-${failure.name}`,
      }).then(
        () => null,
        (reason: unknown) => reason,
      )

      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, failure.code)
      assert.equal(error.operation, 'update_firmware')
      assert.equal('cause' in error, false)
      assert.doesNotMatch(error.message, /secret|https?:|Authorization|Bearer/)
      assert.deepEqual(harness.transport.writes, [])
      assert.equal(
        harness.transport.calls.includes('get_authorized_devices'),
        false,
      )
      const journal = harness.storage.firmwareJournals.values().next().value
      assert.ok(journal)
      assert.equal(harness.storage.blob(journal.blobId).snapshot().byteLength, 0)
      if (failure.name === 'non-loopback HTTP') {
        assert.equal(fetcher.calls.length, 0)
      }
      await harness.ota.destroy()
      await harness.devices.destroy()
    })
  }

  await t.test('deterministic loopback HTTP', async () => {
    const events: string[] = []
    const provider = new FakeFirmwareProvider(events)
    provider.request = {
      method: 'GET',
      url: 'http://127.0.0.1:4173/firmware.ufw',
      headers: {},
    }
    const fetcher = new FakeFirmwareFetcher(
      response([bytes], 200, bytes.byteLength),
      events,
    )
    const harness = await createHarness({ provider, fetcher })
    installStartResult(harness, 1)
    await assert.rejects(
      harness.ota.updateFirmware(image, {
        operationId: 'update_firmware:loopback',
      }),
      isSdkError('firmware_rejected'),
    )
    assert.equal(fetcher.calls.length, 1)
  })
})

test('a verified blob is revalidated and reused after manager reload with bounded Rust reads', async () => {
  const bytes = Uint8Array.of(5, 4, 3, 2, 1)
  const harness = await createHarness({ bytes })
  const operationId = 'update_firmware:verified-reload'
  const image = descriptor(bytes)
  const restore = installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('firmware_rejected'),
  )
  restore()
  assert.equal(harness.provider.calls.length, 1)
  assert.equal(harness.fetcher.calls.length, 1)
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal?.verified)
  await harness.storage.deleteWorkflowCheckpoint(operationId)
  await harness.ota.destroy()

  harness.ota = new OTAManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage: harness.storage,
    provider: harness.provider,
    fetcher: harness.fetcher.fetch,
  })
  installVerifyResult(harness, 1)
  await assert.rejects(
    harness.ota.resumeFirmwareUpdate(operationId),
    isSdkError('integrity_failed'),
  )

  assert.equal(harness.provider.calls.length, 1)
  assert.equal(harness.fetcher.calls.length, 1)
  const blob = harness.storage.blob(journal.blobId)
  assert.ok(blob.reads.length > 0)
  assert.deepEqual(blob.reads.at(-1), { offset: 0, maximumLength: bytes.length })
  assert.ok(blob.reads.every(({ offset, maximumLength }) =>
    Number.isSafeInteger(offset)
      && Number.isSafeInteger(maximumLength)
      && maximumLength <= 500))
  assert.equal(
    harness.transport.calls.includes('get_authorized_devices'),
    false,
  )
})

test('an incomplete durable download resolves the same image again and restarts at byte zero', async () => {
  const bytes = Uint8Array.of(21, 22, 23, 24, 25, 26)
  const harness = await createHarness({ bytes })
  const operationId = 'update_firmware:restart-download'
  const image = descriptor(bytes)
  installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('firmware_rejected'),
  )
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal)
  harness.storage.firmwareJournals.set(operationId, {
    ...journal,
    downloadedBytes: 0,
    verified: false,
  })
  const blob = harness.storage.blob(journal.blobId)
  blob.seed(bytes.subarray(0, 3))
  blob.writes.length = 0
  blob.truncations.length = 0
  await harness.storage.deleteWorkflowCheckpoint(operationId)
  harness.transport.writes.length = 0
  harness.fetcher.handler = async () => response(
    [bytes],
    200,
    bytes.byteLength,
  )

  await assert.rejects(
    harness.ota.resumeFirmwareUpdate(operationId),
    isSdkError('firmware_rejected'),
  )

  assert.equal(harness.provider.calls.length, 2)
  assert.deepEqual(harness.provider.calls[1], {
    operationId,
    serialNumber: SERIAL,
    image,
  })
  assert.ok(blob.truncations.includes(0) || blob.deleteCalls > 0)
  assert.deepEqual(blob.writes[0], { offset: 0, length: bytes.length })
  assert.deepEqual(blob.snapshot(), bytes)
})

test('device rejection and device CRC rejection use stable Rust errors without reconnect', async (t) => {
  const bytes = Uint8Array.of(31, 32, 33, 34)
  const image = descriptor(bytes)

  await t.test('upload start rejection', async () => {
    const harness = await createHarness({ bytes })
    installStartResult(harness, 7)
    const error = await harness.ota.updateFirmware(image, {
      operationId: 'update_firmware:device-rejected',
    }).then(() => null, (reason: unknown) => reason)
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'firmware_rejected')
    assert.equal(error.protocolStatus, 7)
    assert.equal(
      harness.transport.calls.includes('get_authorized_devices'),
      false,
    )
  })

  await t.test('device CRC rejection', async () => {
    const harness = await createHarness({ bytes })
    installVerifyResult(harness, 9)
    const error = await harness.ota.updateFirmware(image, {
      operationId: 'update_firmware:device-crc-rejected',
    }).then(() => null, (reason: unknown) => reason)
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'integrity_failed')
    assert.equal(error.protocolStatus, 9)
    assert.equal(
      harness.transport.calls.includes('get_authorized_devices'),
      false,
    )
  })
})

test('verified reboot reconnect uses only the exact authorized browser device and cleans checkpoint, blob, then journal', async () => {
  const bytes = Uint8Array.of(41, 42, 43, 44)
  const harness = await createHarness({ bytes })
  const image = descriptor(bytes)
  const operationId = 'update_firmware:successful-reconnect'
  const sameNameDevice = { id: 'same-name-impostor', name: 'Bota Pin' }
  harness.transport.authorizedDevices = [sameNameDevice, harness.transport.device]
  harness.transport.serialNumbers.set(sameNameDevice.id, SERIAL)
  harness.transport.setRead(
    '0000180a-0000-1000-8000-00805f9b34fb',
    FIRMWARE_REVISION_CHARACTERISTIC,
    new TextEncoder().encode(image.version),
  )
  installSuccessfulUpdate(harness)
  const progress: FirmwareUpdateProgress[] = []

  await harness.ota.updateFirmware(image, {
    operationId,
    onProgress: (value) => progress.push({ ...value }),
  })

  assert.equal(
    harness.transport.calls.filter((call) => call === 'get_authorized_devices').length,
    1,
  )
  assert.equal(
    harness.transport.calls.includes(`connect:${sameNameDevice.id}`),
    false,
  )
  assert.equal(
    harness.transport.calls.filter((call) => call === 'request_device').length,
    0,
  )
  assert.deepEqual(harness.devices.connectedDevice, {
    id: harness.transport.device.id,
    name: harness.transport.device.name,
    serialNumber: SERIAL,
  })
  assert.equal(harness.storage.firmwareJournals.has(operationId), false)
  assert.equal(harness.storage.workflowCheckpoints.has(operationId), false)
  const blobDelete = indexOf(harness.events, 'blob:delete')
  const journalDelete = indexOf(harness.events, 'firmware:delete')
  const checkpointDelete = lastIndexOf(harness.events, 'workflow:delete')
  assert.ok(checkpointDelete >= 0 && checkpointDelete < blobDelete)
  assert.ok(blobDelete < journalDelete)
  assert.deepEqual(progress.at(-1), {
    phase: 'complete',
    completedBytes: BigInt(bytes.length),
    totalBytes: BigInt(bytes.length),
  })
})

test('reload resumes a durable reconnect checkpoint without a picker or live manager connection', async () => {
  const bytes = Uint8Array.of(45, 46, 47, 48)
  const operationId = 'update_firmware:reload-reconnect'
  const harness = await createHarness({ bytes })
  const image = descriptor(bytes)
  installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('firmware_rejected'),
  )
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal?.verified)
  harness.storage.workflowCheckpoints.set(
    operationId,
    reconnectCheckpoint(image.version, bytes.byteLength),
  )
  await harness.ota.destroy()
  await harness.devices.destroy()

  const sameNameDevice = { id: 'same-name-after-reload', name: 'Bota Pin' }
  harness.transport.authorizedDevices = [sameNameDevice, harness.transport.device]
  harness.transport.serialNumbers.set(sameNameDevice.id, SERIAL)
  harness.transport.setRead(
    '0000180a-0000-1000-8000-00805f9b34fb',
    FIRMWARE_REVISION_CHARACTERISTIC,
    new TextEncoder().encode(image.version),
  )
  harness.transport.calls.length = 0
  harness.transport.writes.length = 0

  const core = await createWasmCore(await wasmBytes)
  const runtime = new BrowserWorkflowRuntime(core, harness.transport)
  const devices = new DeviceManager(core, harness.transport, {
    runtime,
    storage: harness.storage,
  })
  enableFirmwareUpdate(devices)
  const ota = new OTAManager({
    core,
    transport: harness.transport,
    runtime,
    devices,
    storage: harness.storage,
    provider: harness.provider,
    fetcher: harness.fetcher.fetch,
  })

  await ota.resumeFirmwareUpdate(operationId)

  assert.equal(
    harness.transport.calls.filter((call) => call === 'get_authorized_devices').length,
    1,
  )
  assert.equal(harness.transport.calls.includes('request_device'), false)
  assert.equal(
    harness.transport.calls.includes(`connect:${sameNameDevice.id}`),
    false,
  )
  assert.deepEqual(devices.connectedDevice, {
    id: harness.transport.device.id,
    name: harness.transport.device.name,
    serialNumber: SERIAL,
  })
  assert.equal(harness.storage.firmwareJournals.has(operationId), false)
  assert.equal(harness.storage.workflowCheckpoints.has(operationId), false)
  await ota.destroy()
  await devices.destroy()
})

test('fresh managers recover download, transfer, verify, and reconnect through the exact authorized device', async (t) => {
  const cases: Array<{
    name: string
    phase: 'transferring' | 'verifying' | 'reconnecting' | null
    completes: boolean
  }> = [
    { name: 'download', phase: null, completes: false },
    { name: 'transfer', phase: 'transferring', completes: false },
    { name: 'verify', phase: 'verifying', completes: false },
    { name: 'reconnecting', phase: 'reconnecting', completes: true },
  ]

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const bytes = Uint8Array.of(101, 102, 103, 104)
      const image = descriptor(bytes)
      const operationId = `update_firmware:fresh-${candidate.name}`
      const harness = await createHarness({ bytes })
      installStartResult(harness, 1)
      await assert.rejects(
        harness.ota.updateFirmware(image, { operationId }),
        isSdkError('firmware_rejected'),
      )
      const journal = harness.storage.firmwareJournals.get(operationId)
      assert.ok(journal?.verified)

      if (candidate.phase === null) {
        harness.storage.firmwareJournals.set(operationId, {
          ...journal,
          downloadedBytes: 0,
          verified: false,
        })
        await harness.storage.deleteWorkflowCheckpoint(operationId)
      } else {
        harness.storage.workflowCheckpoints.set(
          operationId,
          firmwareCheckpoint(candidate.phase, image.version, bytes.byteLength),
        )
      }
      await harness.ota.destroy()
      await harness.devices.destroy()

      const sameNameDevice = {
        id: `same-name-${candidate.name}`,
        name: harness.transport.device.name,
      }
      harness.transport.authorizedDevices = [sameNameDevice, harness.transport.device]
      harness.transport.serialNumbers.set(sameNameDevice.id, SERIAL)
      harness.transport.setRead(
        '0000180a-0000-1000-8000-00805f9b34fb',
        FIRMWARE_REVISION_CHARACTERISTIC,
        new TextEncoder().encode(image.version),
      )
      harness.transport.calls.length = 0
      harness.transport.writes.length = 0
      if (candidate.phase === null) {
        harness.fetcher.handler = async () => response(
          [bytes],
          200,
          bytes.byteLength,
        )
      }
      const fresh = await createFreshOtaHarness(harness)

      if (candidate.completes) {
        await fresh.ota.resumeFirmwareUpdate(operationId)
      } else {
        const error = await fresh.ota.resumeFirmwareUpdate(operationId).then(
          () => null,
          (reason: unknown) => reason,
        )
        assert.ok(error instanceof BotaSDKError)
        assert.equal(
          error.code,
          'firmware_rejected',
          stringify({
            events: harness.events,
            calls: harness.transport.calls,
            writes: harness.transport.writes.map((write) => [...write.value]),
          }),
        )
      }

      assert.equal(
        harness.transport.calls.filter((call) => call === 'get_authorized_devices').length,
        1,
      )
      assert.equal(harness.transport.calls.includes('request_device'), false)
      assert.equal(
        harness.transport.calls.includes(`connect:${sameNameDevice.id}`),
        false,
      )
      assert.ok(
        harness.transport.calls.includes(`connect:${harness.transport.device.id}`),
      )
      assert.deepEqual(fresh.devices.connectedDevice, {
        id: harness.transport.device.id,
        name: harness.transport.device.name,
        serialNumber: SERIAL,
      })
      await fresh.ota.destroy()
      await fresh.devices.destroy()
    })
  }
})

test('fresh recovery rejects an exact authorized device with the wrong serial before OTA GATT', async () => {
  const bytes = Uint8Array.of(105, 106, 107, 108)
  const image = descriptor(bytes)
  const operationId = 'update_firmware:fresh-identity-mismatch'
  const harness = await createHarness({ bytes })
  installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('firmware_rejected'),
  )
  assert.ok(harness.storage.firmwareJournals.get(operationId)?.verified)
  await harness.ota.destroy()
  await harness.devices.destroy()

  harness.transport.serialNumbers.set(harness.transport.device.id, 'WRONGSERIAL')
  harness.transport.calls.length = 0
  harness.transport.writes.length = 0
  const fresh = await createFreshOtaHarness(harness)

  await assert.rejects(
    fresh.ota.resumeFirmwareUpdate(operationId),
    isSdkError('identity_mismatch'),
  )
  assert.equal(
    harness.transport.calls.filter((call) => call === 'get_authorized_devices').length,
    1,
  )
  assert.equal(harness.transport.calls.includes('request_device'), false)
  assert.deepEqual(harness.transport.writes, [])
  assert.equal(harness.provider.calls.length, 1)
  await fresh.ota.destroy()
  await fresh.devices.destroy()
})

test('reload completes cleanup-only state after every terminal cleanup crash boundary', async (t) => {
  const cases: Array<{
    name: string
    inject(storage: FakeFirmwareStorage): void
    clear(storage: FakeFirmwareStorage): void
    checkpointRemains: boolean
    blobRemains: boolean
  }> = [
    {
      name: 'before checkpoint delete',
      inject: (storage) => { storage.checkpointDeleteError = new Error('injected') },
      clear: (storage) => { storage.checkpointDeleteError = null },
      checkpointRemains: true,
      blobRemains: true,
    },
    {
      name: 'before blob delete',
      inject: (storage) => { storage.blobDeleteError = new Error('injected') },
      clear: (storage) => { storage.blobDeleteError = null },
      checkpointRemains: false,
      blobRemains: true,
    },
    {
      name: 'before journal delete',
      inject: (storage) => { storage.journalDeleteError = new Error('injected') },
      clear: (storage) => { storage.journalDeleteError = null },
      checkpointRemains: false,
      blobRemains: false,
    },
  ]

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const bytes = Uint8Array.of(109, 110, 111, 112)
      const image = descriptor(bytes)
      const operationId = `update_firmware:cleanup-${candidate.name.replaceAll(' ', '-')}`
      const harness = await createHarness({ bytes })
      harness.transport.setRead(
        '0000180a-0000-1000-8000-00805f9b34fb',
        FIRMWARE_REVISION_CHARACTERISTIC,
        new TextEncoder().encode(image.version),
      )
      installSuccessfulUpdate(harness)
      candidate.inject(harness.storage)

      await assert.rejects(
        harness.ota.updateFirmware(image, { operationId }),
        isSdkError('internal_error'),
      )
      const journal = harness.storage.firmwareJournals.get(operationId)
      assert.ok(journal)
      assert.equal(
        (journal as FirmwareJournal & { state?: string }).state,
        'cleanup_only',
      )
      assert.equal(
        harness.storage.workflowCheckpoints.has(operationId),
        candidate.checkpointRemains,
      )
      assert.equal(
        harness.storage.blob(journal.blobId).snapshot().byteLength > 0,
        candidate.blobRemains,
      )
      const providerCalls = harness.provider.calls.length

      candidate.clear(harness.storage)
      await harness.ota.destroy()
      await harness.devices.destroy()
      harness.transport.calls.length = 0
      harness.transport.writes.length = 0
      const fresh = await createFreshOtaHarness(harness, { provider: null })

      await fresh.ota.resumeFirmwareUpdate(operationId)

      assert.equal(harness.provider.calls.length, providerCalls)
      assert.equal(harness.transport.calls.includes('get_authorized_devices'), false)
      assert.equal(harness.transport.calls.includes('request_device'), false)
      assert.deepEqual(harness.transport.writes, [])
      assert.equal(harness.storage.workflowCheckpoints.has(operationId), false)
      assert.equal(harness.storage.firmwareJournals.has(operationId), false)
      assert.equal(harness.storage.blob(journal.blobId).snapshot().byteLength, 0)
      await fresh.ota.destroy()
      await fresh.devices.destroy()
    })
  }
})

test('reconnect cancellation joins getDevices and preserves the verified artifact', async () => {
  const bytes = Uint8Array.of(49, 50, 51, 52)
  const operationId = 'update_firmware:cancel-get-devices'
  const harness = await createHarness({ bytes })
  const image = descriptor(bytes)
  installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(image, { operationId }),
    isSdkError('firmware_rejected'),
  )
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal?.verified)
  harness.storage.workflowCheckpoints.set(
    operationId,
    reconnectCheckpoint(image.version, bytes.byteLength),
  )
  harness.transport.emitDisconnected()
  const authorizedDevices = deferred<void>()
  harness.transport.authorizedDevicesGate = authorizedDevices.promise
  harness.transport.calls.length = 0
  const controller = new AbortController()
  const updating = harness.ota.resumeFirmwareUpdate(operationId, {
    signal: controller.signal,
  })
  void updating.catch(() => undefined)
  await waitFor(
    () => harness.transport.calls.includes('get_authorized_devices'),
    'authorized device enumeration',
  )

  controller.abort()
  const cancelling = harness.ota.cancelFirmwareUpdate(operationId)
  assert.equal(await promiseSettled(cancelling), false)
  await assert.rejects(
    harness.runtime.runExclusive('wifi', async () => undefined),
    isErrorCode('operation_in_progress'),
  )
  authorizedDevices.resolve()
  await cancelling
  await assert.rejects(updating, isSdkError('cancelled'))

  assert.equal(
    harness.transport.calls.some((call) => call.startsWith('connect:')),
    false,
  )
  assert.equal(harness.transport.calls.includes('request_device'), false)
  const latest = harness.storage.firmwareJournals.get(operationId)
  assert.ok(latest?.verified)
  assert.deepEqual(harness.storage.blob(latest.blobId).snapshot(), bytes)
})

test('cancellation joins a late provider, rejects its request, and retains workflow ownership', async () => {
  const bytes = Uint8Array.of(51, 52, 53, 54)
  const events: string[] = []
  const provider = new FakeFirmwareProvider(events)
  const providerGate = deferred<DownloadRequest>()
  provider.resolveHandler = async () => await providerGate.promise
  const fetcher = new FakeFirmwareFetcher(
    response([bytes], 200, bytes.length),
    events,
  )
  const harness = await createHarness({ bytes, provider, fetcher })
  const operationId = 'update_firmware:cancel-provider'
  const controller = new AbortController()
  const updating = harness.ota.updateFirmware(descriptor(bytes), {
    operationId,
    signal: controller.signal,
  })
  void updating.catch(() => undefined)
  await waitFor(() => provider.calls.length === 1, 'provider resolution')

  controller.abort()
  const cancelling = harness.ota.cancelFirmwareUpdate(operationId)
  assert.equal(await promiseSettled(updating), false)
  assert.equal(await promiseSettled(cancelling), false)
  await assert.rejects(
    harness.runtime.runExclusive('wifi', async () => undefined),
    isErrorCode('operation_in_progress'),
  )

  providerGate.resolve({
    method: 'GET',
    url: 'https://late-secret.example.invalid/image.ufw?token=late',
    headers: { Authorization: 'Bearer late-secret' },
  })
  await cancelling
  await assert.rejects(updating, isSdkError('cancelled'))
  assert.equal(fetcher.calls.length, 0)
  assert.deepEqual(harness.transport.writes, [])
  assert.equal(await harness.runtime.runExclusive('wifi', async () => 7), 7)
})

test('cancellation joins durable verification and preserves the latest compatible verified blob', async () => {
  const bytes = Uint8Array.of(61, 62, 63, 64)
  const harness = await createHarness({ bytes })
  const verifiedSave = deferred<void>()
  harness.storage.verifiedSaveGate = verifiedSave.promise
  const operationId = 'update_firmware:cancel-verified-save'
  const controller = new AbortController()
  const updating = harness.ota.updateFirmware(descriptor(bytes), {
    operationId,
    signal: controller.signal,
  })
  void updating.catch(() => undefined)
  await waitFor(
    () => harness.events.includes('firmware:save:verified:begin'),
    'verified journal save',
  )

  controller.abort()
  const cancelling = harness.ota.cancelFirmwareUpdate(operationId)
  assert.equal(await promiseSettled(updating), false)
  assert.equal(await promiseSettled(cancelling), false)
  await assert.rejects(
    harness.runtime.runExclusive('wifi', async () => undefined),
    isErrorCode('operation_in_progress'),
  )

  verifiedSave.resolve()
  await cancelling
  await assert.rejects(updating, isSdkError('cancelled'))
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal?.verified)
  assert.deepEqual(harness.storage.blob(journal.blobId).snapshot(), bytes)
  assert.deepEqual(harness.transport.writes, [])
})

test('reboot cancellation removes the exact subscription and rejects late progress or reconnect', async () => {
  const bytes = Uint8Array.of(71, 72, 73, 74)
  const harness = await createHarness({ bytes })
  installSuccessfulUpdate(harness, false)
  const operationId = 'update_firmware:cancel-reboot'
  const controller = new AbortController()
  const progress: FirmwareUpdateProgress[] = []
  const updating = harness.ota.updateFirmware(descriptor(bytes), {
    operationId,
    signal: controller.signal,
    onProgress: (value) => progress.push({ ...value }),
  })
  void updating.catch(() => undefined)
  await waitFor(
    () => progress.some(({ phase }) => phase === 'rebooting'),
    'rebooting progress',
  )
  const unsubscribeGate = deferred<void>()
  harness.transport.unsubscribeGate = unsubscribeGate.promise
  const unsubscribeStarted = deferred<void>()
  harness.transport.onUnsubscribe = () => unsubscribeStarted.resolve()

  controller.abort()
  const cancelling = harness.ota.cancelFirmwareUpdate(operationId)
  await unsubscribeStarted.promise
  assert.equal(await promiseSettled(cancelling), false)
  await assert.rejects(
    harness.runtime.runExclusive('wifi', async () => undefined),
    isErrorCode('operation_in_progress'),
  )
  const progressCount = progress.length
  unsubscribeGate.resolve()
  await cancelling
  await assert.rejects(updating, isSdkError('cancelled'))
  harness.transport.emitLateNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_STATUS_CHARACTERISTIC,
    Uint8Array.of(FIRMWARE_UPLOAD_VERIFY, 0),
  )
  harness.transport.emitDisconnected()
  await tick()
  assert.equal(progress.length, progressCount)
  assert.equal(
    harness.transport.calls.includes('get_authorized_devices'),
    false,
  )
  const journal = harness.storage.firmwareJournals.get(operationId)
  assert.ok(journal?.verified)
  assert.deepEqual(harness.storage.blob(journal.blobId).snapshot(), bytes)
})

test('incompatible image identity, version, size, hash, or Rust checkpoint rejects before GATT', async (t) => {
  const bytes = Uint8Array.of(81, 82, 83, 84)
  const harness = await createHarness({ bytes })
  const operationId = 'update_firmware:resume-bindings'
  installStartResult(harness, 1)
  await assert.rejects(
    harness.ota.updateFirmware(descriptor(bytes), { operationId }),
    isSdkError('firmware_rejected'),
  )
  const valid = harness.storage.firmwareJournals.get(operationId)
  assert.ok(valid)
  const providerCalls = harness.provider.calls.length
  harness.transport.calls.length = 0
  harness.transport.writes.length = 0

  const mutations: Array<[string, (journal: FirmwareJournal) => FirmwareJournal]> = [
    ['image ID', (journal) => ({ ...journal, imageId: 'other-image' })],
    ['version', (journal) => ({ ...journal, version: '9.9.9' })],
    ['size', (journal) => ({ ...journal, sizeBytes: journal.sizeBytes + 1 })],
    ['SHA-256', (journal) => ({ ...journal, sha256Hex: 'aa'.repeat(32) })],
  ]
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      harness.storage.firmwareJournals.set(operationId, mutate(valid))
      await harness.storage.deleteWorkflowCheckpoint(operationId)
      harness.transport.calls.length = 0
      harness.transport.writes.length = 0
      await assert.rejects(
        harness.ota.resumeFirmwareUpdate(operationId),
        isSdkError('resume_rejected'),
      )
      assert.deepEqual(harness.transport.calls, [])
      assert.deepEqual(harness.transport.writes, [])
      assert.equal(harness.provider.calls.length, providerCalls)
    })
  }

  await t.test('verified blob', async () => {
    harness.storage.firmwareJournals.set(operationId, valid)
    await harness.storage.deleteWorkflowCheckpoint(operationId)
    harness.storage.blob(valid.blobId).seed(Uint8Array.of(0, 0, 0, 0))
    harness.transport.calls.length = 0
    harness.transport.writes.length = 0
    await assert.rejects(
      harness.ota.resumeFirmwareUpdate(operationId),
      isSdkError('resume_rejected'),
    )
    assert.deepEqual(harness.transport.calls, [])
    assert.deepEqual(harness.transport.writes, [])
    assert.equal(harness.provider.calls.length, providerCalls)
  })

  await t.test('checkpoint', async () => {
    harness.storage.firmwareJournals.set(operationId, valid)
    harness.storage.workflowCheckpoints.set(operationId, {
      workflow: 'firmware_update',
      operation: 'update_firmware',
      serialNumber: SERIAL,
      recordingUuid: null,
      phase: 'transferring',
      completedUnits: 0n,
      retryCount: 0,
      lastSequence: null,
      firmwareVersion: 'different-version',
    } satisfies CoreWorkflowCheckpoint)
    harness.transport.calls.length = 0
    harness.transport.writes.length = 0
    await assert.rejects(
      harness.ota.resumeFirmwareUpdate(operationId),
      isSdkError('resume_rejected'),
    )
    assert.deepEqual(harness.transport.calls, [])
    assert.deepEqual(harness.transport.writes, [])
    assert.equal(harness.provider.calls.length, providerCalls)
  })
})

test('the public client composes one firmware manager with its configured provider', async () => {
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  const storage = new FakeFirmwareStorage()
  const provider = new FakeFirmwareProvider()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    storage,
    providers: { firmwareDownload: provider },
  })

  assert.ok(client.ota instanceof OTAManager)
  await client.destroy()
})

function descriptor(
  bytes: Uint8Array,
  overrides: Partial<FirmwareImageDescriptor> = {},
): FirmwareImageDescriptor {
  return {
    imageId: 'firmware-image-1',
    version: '1.0.18',
    sizeBytes: bytes.byteLength,
    crc32: crc32(bytes),
    sha256Hex: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  }
}

function reconnectCheckpoint(
  version: string,
  completedBytes: number,
): CoreWorkflowCheckpoint {
  return firmwareCheckpoint('reconnecting', version, completedBytes)
}

function firmwareCheckpoint(
  phase: 'transferring' | 'verifying' | 'reconnecting',
  version: string,
  completedBytes: number,
): CoreWorkflowCheckpoint {
  return {
    workflow: 'firmware_update',
    operation: 'update_firmware',
    serialNumber: SERIAL,
    recordingUuid: null,
    phase,
    completedUnits: BigInt(completedBytes),
    retryCount: 0,
    lastSequence: null,
    firmwareVersion: version,
  }
}

async function createFreshOtaHarness(
  harness: Harness,
  options: { provider?: FirmwareDownloadProvider | null } = {},
): Promise<{
  core: CoreBridge
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
  ota: OTAManager
}> {
  const core = await createWasmCore(await wasmBytes)
  const runtime = new BrowserWorkflowRuntime(core, harness.transport)
  const devices = new DeviceManager(core, harness.transport, {
    runtime,
    storage: harness.storage,
  })
  enableFirmwareUpdate(devices)
  const ota = new OTAManager({
    core,
    transport: harness.transport,
    runtime,
    devices,
    storage: harness.storage,
    provider: options.provider === undefined ? harness.provider : options.provider,
    fetcher: harness.fetcher.fetch,
  })
  return { core, runtime, devices, ota }
}

function enableFirmwareUpdate(devices: DeviceManager): void {
  Object.defineProperty(devices, 'getCapabilities', {
    configurable: true,
    value: () => Object.freeze({
      bluetooth: true,
      authorizedDeviceReconnect: true,
      durableStorage: true,
      largeRecordingSync: true,
      firmwareUpdate: true,
    }),
  })
}

function response(
  chunks: readonly Uint8Array[],
  status = 200,
  contentLength?: number,
): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk) controller.enqueue(chunk.slice())
      if (index >= chunks.length) controller.close()
    },
  })
  const headers = new Headers()
  if (contentLength !== undefined) {
    headers.set('Content-Length', String(contentLength))
  }
  return new Response(body, { status, headers })
}

function installStartResult(
  harness: Harness,
  result: number,
): () => void {
  const original = harness.transport.write.bind(harness.transport)
  harness.transport.write = async (...args) => {
    await original(...args)
    const [device, _service, characteristic, value] = args
    if (
      characteristic.toLowerCase() === TRANSFER_CONTROL_CHARACTERISTIC
      && value[0] === FIRMWARE_UPLOAD_START
    ) {
      harness.transport.emitNotification(
        device,
        BOTA_STORAGE_SERVICE,
        TRANSFER_STATUS_CHARACTERISTIC,
        Uint8Array.of(FIRMWARE_UPLOAD_START, result),
      )
    }
  }
  return () => {
    harness.transport.write = original
  }
}

function installVerifyResult(
  harness: Harness,
  result: number,
): () => void {
  const original = harness.transport.write.bind(harness.transport)
  harness.transport.write = async (...args) => {
    await original(...args)
    const [device, _service, characteristic, value] = args
    if (
      characteristic.toLowerCase() === TRANSFER_CONTROL_CHARACTERISTIC
      && value[0] === FIRMWARE_UPLOAD_START
    ) {
      harness.transport.emitNotification(
        device,
        BOTA_STORAGE_SERVICE,
        TRANSFER_STATUS_CHARACTERISTIC,
        Uint8Array.of(FIRMWARE_UPLOAD_START, 0),
      )
    } else if (
      characteristic.toLowerCase() === TRANSFER_CONTROL_CHARACTERISTIC
      && value[0] === FIRMWARE_UPLOAD_VERIFY
    ) {
      harness.transport.emitNotification(
        device,
        BOTA_STORAGE_SERVICE,
        TRANSFER_STATUS_CHARACTERISTIC,
        Uint8Array.of(FIRMWARE_UPLOAD_VERIFY, result),
      )
    }
  }
  return () => {
    harness.transport.write = original
  }
}

function installSuccessfulUpdate(
  harness: Harness,
  disconnectAfterVerify = true,
): () => void {
  const restore = installVerifyResult(harness, 0)
  const current = harness.transport.write.bind(harness.transport)
  harness.transport.write = async (...args) => {
    await current(...args)
    const characteristic = args[2]
    const value = args[3]
    if (
      disconnectAfterVerify
      && characteristic.toLowerCase() === TRANSFER_CONTROL_CHARACTERISTIC
      && value[0] === FIRMWARE_UPLOAD_VERIFY
    ) {
      setTimeout(() => harness.transport.emitDisconnected(), 0)
    }
  }
  return () => {
    restore()
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function isSdkError(code: BotaSDKError['code']): (error: unknown) => boolean {
  return (error) => error instanceof BotaSDKError
    && error.code === code
    && error.operation === 'update_firmware'
}

function isErrorCode(code: BotaSDKError['code']): (error: unknown) => boolean {
  return (error) => error instanceof BotaSDKError && error.code === code
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item)
}

function indexOf(values: readonly string[], value: string): number {
  const index = values.indexOf(value)
  assert.notEqual(index, -1, `missing event ${value}`)
  return index
}

function indexOfPrefix(values: readonly string[], prefix: string): number {
  const index = values.findIndex((value) => value.startsWith(prefix))
  assert.notEqual(index, -1, `missing event prefix ${prefix}`)
  return index
}

function lastIndexOf(values: readonly string[], value: string): number {
  return values.lastIndexOf(value)
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  assert.fail(`${label} did not occur`)
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await tick()
  return settled
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
