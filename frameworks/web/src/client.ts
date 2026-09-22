import type { CoreLoader } from './core.ts'
import { ControlManager } from './controlManager.ts'
import {
  destroyDeviceManagerAfter,
  DeviceManager,
} from './deviceManager.ts'
import { BotaSDKError, type BotaOperation } from './errors.ts'
import { LogManager } from './logManager.ts'
import { OTAManager } from './otaManager.ts'
import { ProvisioningManager } from './provisioningManager.ts'
import { validateStorageNamespace } from './indexedDbWorkflowStore.ts'
import type {
  ProvisioningProvider,
  FirmwareDownloadProvider,
  RecordingControlProvider,
  RecordingUploadProvider,
} from './providers.ts'
import { RecordingManager } from './recordingManager.ts'
import {
  BrowserStorageError,
  createDefaultBrowserStorage,
  type BrowserSdkStorage,
} from './storage.ts'
import type { BrowserBluetoothTransport } from './transport.ts'
import { loadDefaultCore } from './wasmCore.ts'
import { WebBluetoothTransport } from './webBluetoothTransport.ts'
import { WiFiManager } from './wifiManager.ts'
import { BrowserWorkflowRuntime } from './workflowRuntime.ts'

export interface BotaDeviceClientOptions {
  storageNamespace?: string
  coreLoader?: CoreLoader
  transport?: BrowserBluetoothTransport
  storage?: BrowserSdkStorage
  providers?: {
    provisioning?: ProvisioningProvider
    firmwareDownload?: FirmwareDownloadProvider
    recordingControl?: RecordingControlProvider
    recordingUpload?: RecordingUploadProvider
  }
}

export class BotaDeviceClient {
  readonly devices: DeviceManager
  readonly controls: ControlManager
  readonly provisioning: ProvisioningManager
  readonly ota: OTAManager
  readonly logs: LogManager
  readonly recordings: RecordingManager
  readonly wifi: WiFiManager
  private readonly runtime: BrowserWorkflowRuntime
  private readonly storage: BrowserSdkStorage | null
  private destroyPromise: Promise<void> | null = null

  private constructor(
    runtime: BrowserWorkflowRuntime,
    storage: BrowserSdkStorage | null,
    devices: DeviceManager,
    controls: ControlManager,
    provisioning: ProvisioningManager,
    ota: OTAManager,
    logs: LogManager,
    recordings: RecordingManager,
    wifi: WiFiManager,
  ) {
    this.runtime = runtime
    this.storage = storage
    this.devices = devices
    this.controls = controls
    this.provisioning = provisioning
    this.ota = ota
    this.logs = logs
    this.recordings = recordings
    this.wifi = wifi
  }

  static async create(options: BotaDeviceClientOptions = {}): Promise<BotaDeviceClient> {
    const storage = await resolveStorage(options)
    const core = await (options.coreLoader ?? loadDefaultCore)()
    const transport = options.transport ?? new WebBluetoothTransport()
    const runtime = new BrowserWorkflowRuntime(core, transport)
    const devices = new DeviceManager(core, transport, {
      runtime,
      storage,
    })
    return new BotaDeviceClient(
      runtime,
      storage,
      devices,
      new ControlManager({
        core,
        transport,
        runtime,
        devices,
        provider: options.providers?.recordingControl ?? null,
      }),
      new ProvisioningManager({
        core,
        transport,
        runtime,
        devices,
        storage,
        provider: options.providers?.provisioning ?? null,
      }),
      new OTAManager({
        core,
        transport,
        runtime,
        devices,
        storage,
        provider: options.providers?.firmwareDownload ?? null,
      }),
      new LogManager({ core, runtime, devices }),
      new RecordingManager(
        core,
        transport,
        runtime,
        devices,
        storage,
        options.providers?.recordingUpload ?? null,
      ),
      new WiFiManager({
        core,
        transport,
        runtime,
        devices,
      }),
    )
  }

  async clearPersistedData(): Promise<void> {
    const storage = this.storage
    if (!storage) return
    if (this.destroyPromise) {
      await this.destroyPromise
      await clearStorage(storage)
      return
    }
    try {
      await this.runtime.runExclusive('clear_persisted_data', async () => {
        await clearStorage(storage)
      })
    } catch (error) {
      if (error instanceof BotaSDKError) throw error
      throw storageError(error)
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    const managerCleanup = joinManagerCleanup([
      this.logs.destroy(),
      this.ota.destroy(),
      this.wifi.destroy(),
      this.controls.destroy(),
      this.provisioning.destroy(),
      this.recordings.destroy(),
    ])
    this.destroyPromise = destroyDeviceManagerAfter(
      this.devices,
      managerCleanup,
    )
    return this.destroyPromise
  }
}

async function joinManagerCleanup(
  cleanups: readonly Promise<void>[],
): Promise<void> {
  const results = await Promise.allSettled(cleanups)
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

async function resolveStorage(
  options: BotaDeviceClientOptions,
): Promise<BrowserSdkStorage | null> {
  if (options.storageNamespace !== undefined) {
    try {
      validateStorageNamespace(options.storageNamespace)
    } catch (error) {
      throw storageError(error, 'initialize')
    }
  }
  if (options.storage) {
    if (
      options.storageNamespace === undefined
      || options.storage.namespace !== options.storageNamespace
    ) {
      throw new BotaSDKError('invalid_input', 'initialize')
    }
    return options.storage
  }
  if (options.storageNamespace === undefined) return null
  try {
    return await createDefaultBrowserStorage(options.storageNamespace)
  } catch (error) {
    throw storageError(error, 'initialize')
  }
}

async function clearStorage(storage: BrowserSdkStorage): Promise<void> {
  try {
    await storage.clear()
  } catch (error) {
    throw storageError(error)
  }
}

function storageError(
  error: unknown,
  operation: BotaOperation = 'clear_persisted_data',
): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, operation)
  }
  return new BotaSDKError('storage_unavailable', operation)
}
