import type {
  NativeCapabilities,
  NativeConnectedDevice,
  NativeConfiguration,
  NativeDiscoveredDevice,
  Spec,
} from './specs/NativeBotaDeviceSDK';
import type {
  ConnectedDevice,
  ConnectionState,
  DeviceType,
  DiscoveredDevice,
  PairingState,
  ReconnectOptions,
  ScanOptions,
} from './models/Device';

export type BotaLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export type BotaDeviceSDKConfiguration = {
  applicationSupportDirectory?: string;
  logLevel?: BotaLogLevel;
};

export type BotaDeviceSDKState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'error';

export type BotaDeviceSDKCapabilities = NativeCapabilities;

export type BotaEventSubscription = {
  remove(): void;
};

export type BotaDeviceSDKDeviceClient = {
  startScan(
    options: ScanOptions | undefined,
    onDevice: (device: DiscoveredDevice) => void
  ): Promise<BotaEventSubscription>;
  stopScan(): Promise<void>;
  connect(device: DiscoveredDevice): Promise<ConnectedDevice>;
  reconnect(
    serialNumber: string,
    options?: ReconnectOptions
  ): Promise<ConnectedDevice>;
  disconnect(): Promise<void>;
};

export class BotaNativeModuleError extends Error {
  readonly code = 'native_module_unavailable';

  constructor() {
    super(
      'BotaDeviceSDK native module is unavailable. Rebuild the native application after installing the SDK.'
    );
    this.name = 'BotaNativeModuleError';
  }
}

export type BotaDeviceSDKClient = {
  readonly devices: BotaDeviceSDKDeviceClient;
  configure(configuration?: BotaDeviceSDKConfiguration): Promise<void>;
  destroy(): Promise<void>;
  getCapabilities(): Promise<BotaDeviceSDKCapabilities>;
  getState(): Promise<BotaDeviceSDKState>;
};

const mapDiscoveredDevice = (
  device: NativeDiscoveredDevice
): DiscoveredDevice => ({
  id: device.id,
  name: device.name ?? '',
  deviceType: (device.deviceType ?? 'bota_pin') as DeviceType,
  firmwareVersion: device.firmwareVersion ?? '',
  macAddress: device.macAddress ?? null,
  pairingState: (device.pairingState ?? 'unpaired') as PairingState,
  rssi: device.rssi,
  discoveredAt: new Date(device.discoveredAtMs),
});

const toNativeDiscoveredDevice = (
  device: DiscoveredDevice
): NativeDiscoveredDevice => ({
  id: device.id,
  name: device.name,
  deviceType: device.deviceType,
  firmwareVersion: device.firmwareVersion,
  ...(device.macAddress ? { macAddress: device.macAddress } : {}),
  pairingState: device.pairingState,
  rssi: device.rssi,
  discoveredAtMs: device.discoveredAt.getTime(),
});

const mapConnectedDevice = (
  device: NativeConnectedDevice
): ConnectedDevice => ({
  ...device,
  deviceType: device.deviceType as DeviceType,
  connectionState: device.connectionState as ConnectionState,
});

const matchesScanOptions = (
  device: DiscoveredDevice,
  options: ScanOptions | undefined
): boolean => {
  if (options?.deviceTypes && !options.deviceTypes.includes(device.deviceType)) {
    return false;
  }
  if (options?.pairingState && device.pairingState !== options.pairingState) {
    return false;
  }
  if (options?.minRssi !== undefined && device.rssi < options.minRssi) {
    return false;
  }
  return true;
};

export const createBotaDeviceSDK = (nativeModule: Spec | null): BotaDeviceSDKClient => {
  const requireNativeModule = (): Spec => {
    if (!nativeModule) throw new BotaNativeModuleError();
    return nativeModule;
  };

  const devices: BotaDeviceSDKDeviceClient = {
    async startScan(options, onDevice) {
      const module = requireNativeModule();
      const subscription = module.onDeviceDiscovered((device) => {
        const discovered = mapDiscoveredDevice(device);
        if (matchesScanOptions(discovered, options)) onDevice(discovered);
      });
      try {
        await module.startScan(
          options?.timeout ?? 30_000,
          options?.allowDuplicates ?? false
        );
      } catch (error) {
        subscription.remove();
        throw error;
      }
      return subscription;
    },

    async stopScan() {
      await requireNativeModule().stopScan();
    },

    async connect(device) {
      return mapConnectedDevice(
        await requireNativeModule().connectSelected(
          toNativeDiscoveredDevice(device)
        )
      );
    },

    async reconnect(serialNumber, options = {}) {
      return mapConnectedDevice(
        await requireNativeModule().reconnect(serialNumber, {
          scanTimeoutMs: options.scanTimeout ?? 10_000,
          connectionTimeoutMs: 10_000,
        })
      );
    },

    async disconnect() {
      await requireNativeModule().disconnect();
    },
  };

  return {
    devices,

    async configure(configuration = {}) {
      const nativeConfiguration: NativeConfiguration = {
        logLevel: configuration.logLevel ?? 'warn',
        ...(configuration.applicationSupportDirectory
          ? {
              applicationSupportDirectory:
                configuration.applicationSupportDirectory,
            }
          : {}),
      };
      await requireNativeModule().configure(nativeConfiguration);
    },

    async destroy() {
      await requireNativeModule().destroy();
    },

    async getCapabilities() {
      return requireNativeModule().getCapabilities();
    },

    async getState() {
      return (await requireNativeModule().getState()) as BotaDeviceSDKState;
    },
  };
};
