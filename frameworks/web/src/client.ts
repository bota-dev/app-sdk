import type { CoreLoader } from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import type { RecordingUploadProvider } from './providers.ts'
import { RecordingManager } from './recordingManager.ts'
import type { BrowserSdkStorage } from './storage.ts'
import type { BrowserBluetoothTransport } from './transport.ts'
import { loadDefaultCore } from './wasmCore.ts'
import { WebBluetoothTransport } from './webBluetoothTransport.ts'
import { BrowserWorkflowRuntime } from './workflowRuntime.ts'

export interface BotaDeviceClientOptions {
  coreLoader?: CoreLoader
  transport?: BrowserBluetoothTransport
  storage?: BrowserSdkStorage
  providers?: {
    recordingUpload?: RecordingUploadProvider
  }
}

export class BotaDeviceClient {
  readonly devices: DeviceManager
  readonly recordings: RecordingManager

  private constructor(
    devices: DeviceManager,
    recordings: RecordingManager,
  ) {
    this.devices = devices
    this.recordings = recordings
  }

  static async create(options: BotaDeviceClientOptions = {}): Promise<BotaDeviceClient> {
    const core = await (options.coreLoader ?? loadDefaultCore)()
    const transport = options.transport ?? new WebBluetoothTransport()
    const runtime = new BrowserWorkflowRuntime(core, transport)
    const storage = options.storage ?? null
    const devices = new DeviceManager(core, transport, {
      runtime,
      storage,
    })
    return new BotaDeviceClient(
      devices,
      new RecordingManager(
        core,
        transport,
        runtime,
        devices,
        storage,
        options.providers?.recordingUpload ?? null,
      ),
    )
  }

  async destroy(): Promise<void> {
    await this.recordings.destroy()
    await this.devices.destroy()
  }
}
