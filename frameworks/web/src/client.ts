import type { CoreLoader } from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import type { BrowserBluetoothTransport } from './transport.ts'
import { loadDefaultCore } from './wasmCore.ts'
import { WebBluetoothTransport } from './webBluetoothTransport.ts'

export interface BotaDeviceClientOptions {
  coreLoader?: CoreLoader
  transport?: BrowserBluetoothTransport
}

export class BotaDeviceClient {
  readonly devices: DeviceManager

  private constructor(devices: DeviceManager) {
    this.devices = devices
  }

  static async create(options: BotaDeviceClientOptions = {}): Promise<BotaDeviceClient> {
    const core = await (options.coreLoader ?? loadDefaultCore)()
    return new BotaDeviceClient(
      new DeviceManager(core, options.transport ?? new WebBluetoothTransport()),
    )
  }

  async destroy(): Promise<void> {
    await this.devices.destroy()
  }
}
