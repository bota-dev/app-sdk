import type { CoreLoader } from './core.ts'
import { ControlManager } from './controlManager.ts'
import { DeviceManager } from './deviceManager.ts'
import { LogManager } from './logManager.ts'
import { OTAManager } from './otaManager.ts'
import { ProvisioningManager } from './provisioningManager.ts'
import type {
  ProvisioningProvider,
  FirmwareDownloadProvider,
  RecordingControlProvider,
  RecordingUploadProvider,
} from './providers.ts'
import { RecordingManager } from './recordingManager.ts'
import type { BrowserSdkStorage } from './storage.ts'
import type { BrowserBluetoothTransport } from './transport.ts'
import { loadDefaultCore } from './wasmCore.ts'
import { WebBluetoothTransport } from './webBluetoothTransport.ts'
import { WiFiManager } from './wifiManager.ts'
import { BrowserWorkflowRuntime } from './workflowRuntime.ts'

export interface BotaDeviceClientOptions {
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

  private constructor(
    devices: DeviceManager,
    controls: ControlManager,
    provisioning: ProvisioningManager,
    ota: OTAManager,
    logs: LogManager,
    recordings: RecordingManager,
    wifi: WiFiManager,
  ) {
    this.devices = devices
    this.controls = controls
    this.provisioning = provisioning
    this.ota = ota
    this.logs = logs
    this.recordings = recordings
    this.wifi = wifi
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

  async destroy(): Promise<void> {
    await this.logs.destroy()
    await this.ota.destroy()
    await this.wifi.destroy()
    await this.controls.destroy()
    await this.provisioning.destroy()
    await this.recordings.destroy()
    await this.devices.destroy()
  }
}
