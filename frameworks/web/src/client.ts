import type { CoreLoader } from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import type { BrowserSdkStorage } from './storage.ts'
import type { BrowserBluetoothTransport } from './transport.ts'
import { loadDefaultCore } from './wasmCore.ts'
import { WebBluetoothTransport } from './webBluetoothTransport.ts'
import { BrowserWorkflowRuntime } from './workflowRuntime.ts'

export interface BotaDeviceClientOptions {
  coreLoader?: CoreLoader
  transport?: BrowserBluetoothTransport
  storage?: BrowserSdkStorage
}

export class BotaDeviceClient {
  readonly devices: DeviceManager

  private constructor(devices: DeviceManager) {
    this.devices = devices
  }

  static async create(options: BotaDeviceClientOptions = {}): Promise<BotaDeviceClient> {
    const core = await (options.coreLoader ?? loadDefaultCore)()
    const transport = options.transport ?? new WebBluetoothTransport()
    const runtime = new BrowserWorkflowRuntime(core, transport)
    return new BotaDeviceClient(
      new DeviceManager(core, transport, {
        runtime,
        storage: options.storage ?? null,
      }),
    )
  }

  async destroy(): Promise<void> {
    await this.devices.destroy()
  }
}
