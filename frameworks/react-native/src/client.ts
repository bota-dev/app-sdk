import type {
  NativeCapabilities,
  NativeConnectedDevice,
  NativeConfiguration,
  NativeDeviceStatus,
  NativeDiscoveredDevice,
  NativeFactoryResetCompletion,
  NativeFactoryResetGrantRequest,
  NativeProvisioningMaterialRequest,
  Spec,
} from './specs/NativeBotaDeviceSDK';
import type {
  ConnectedDevice,
  ConnectionState,
  DeviceState,
  DeviceStatus,
  DeviceType,
  DiscoveredDevice,
  PairingState,
  ReconnectOptions,
  ScanOptions,
  LteStatus,
  WifiStatus,
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

export type BotaAsyncEventSubscription = {
  remove(): Promise<void>;
};

export type BotaProvisioningMaterialRequest = Omit<
  NativeProvisioningMaterialRequest,
  'requestId'
>;

export type BotaProvisioningMaterial = {
  apiEndpoint: string;
  deviceToken: string;
  mtu: number;
};

export type BotaProvisioningMaterialProvider = (
  request: BotaProvisioningMaterialRequest
) => Promise<BotaProvisioningMaterial>;

export type BotaDeviceSDKProvisioningClient = {
  provision(
    device: ConnectedDevice,
    provider: BotaProvisioningMaterialProvider
  ): Promise<void>;
  deprovision(device: ConnectedDevice): Promise<void>;
};

export type BotaFactoryResetGrantRequest = Omit<
  NativeFactoryResetGrantRequest,
  'requestId'
>;

export type BotaFactoryResetGrantProvider = (
  request: BotaFactoryResetGrantRequest
) => Promise<string>;

export type BotaFactoryResetOptions = {
  commandId: string;
  bindingGeneration: number;
};

export type BotaFactoryResetCompletion = NativeFactoryResetCompletion;

export type BotaDeviceSDKFactoryResetClient = {
  factoryReset(
    device: ConnectedDevice,
    options: BotaFactoryResetOptions,
    provider: BotaFactoryResetGrantProvider
  ): Promise<BotaFactoryResetCompletion>;
  resumePendingFactoryReset(
    device: ConnectedDevice,
    currentBindingGeneration: number
  ): Promise<BotaFactoryResetCompletion | null>;
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
  readStatus(): Promise<DeviceStatus>;
  subscribeToStatus(
    onStatus: (status: DeviceStatus) => void
  ): Promise<BotaAsyncEventSubscription>;
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
  readonly factoryReset: BotaDeviceSDKFactoryResetClient;
  readonly provisioning: BotaDeviceSDKProvisioningClient;
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

const toNativeConnectedDevice = (
  device: ConnectedDevice
): NativeConnectedDevice => ({
  id: device.id,
  serialNumber: device.serialNumber,
  deviceType: device.deviceType,
  firmwareVersion: device.firmwareVersion,
  ...(device.hardwareRevision === undefined
    ? {}
    : { hardwareRevision: device.hardwareRevision }),
  isProvisioned: device.isProvisioned,
  connectionState: device.connectionState,
  mtu: device.mtu,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const mapDeviceStatus = (status: NativeDeviceStatus): DeviceStatus => ({
  batteryLevel: status.batteryLevel,
  ...(status.batteryMv === undefined ? {} : { batteryMv: status.batteryMv }),
  storageTotalMb: status.storageTotalMb,
  storageUsedMb: status.storageUsedMb,
  state: status.state as DeviceState,
  pendingRecordings: status.pendingRecordings,
  lastTimeSyncAt:
    status.lastTimeSyncAtMs === undefined
      ? null
      : new Date(status.lastTimeSyncAtMs),
  signalStrength: status.signalStrength,
  flags: status.flags,
  timestamp: status.timestamp,
  lteStatus: status.lteStatus as LteStatus,
  ...(status.lteSignalQuality === undefined
    ? {}
    : { lteSignalQuality: status.lteSignalQuality }),
  ...(status.wifiStatus === undefined
    ? {}
    : { wifiStatus: status.wifiStatus as WifiStatus }),
  ...(status.modemInfo === undefined ? {} : { modemInfo: status.modemInfo }),
});

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

    async readStatus() {
      return mapDeviceStatus(await requireNativeModule().readStatus());
    },

    async subscribeToStatus(onStatus) {
      const module = requireNativeModule();
      const eventSubscription = module.onDeviceStatusUpdated((status) => {
        onStatus(mapDeviceStatus(status));
      });
      try {
        await module.startStatusUpdates();
      } catch (error) {
        eventSubscription.remove();
        throw error;
      }
      let removed = false;
      return {
        async remove() {
          if (removed) return;
          removed = true;
          eventSubscription.remove();
          await module.stopStatusUpdates();
        },
      };
    },
  };

  const provisioning: BotaDeviceSDKProvisioningClient = {
    async provision(device, provider) {
      const module = requireNativeModule();
      const subscription = module.onProvisioningMaterialRequested((request) => {
        void (async () => {
          try {
            const material = await provider({
              serialNumber: request.serialNumber,
              nonce: request.nonce,
              devicePublicKey: request.devicePublicKey,
            });
            await module.resolveProvisioningMaterial(request.requestId, material);
          } catch (error) {
            await module.rejectApplicationMaterial(
              request.requestId,
              errorMessage(error)
            );
          }
        })().catch(() => {});
      });
      try {
        await module.provision(toNativeConnectedDevice(device));
      } finally {
        subscription.remove();
      }
    },

    async deprovision(device) {
      await requireNativeModule().deprovision(toNativeConnectedDevice(device));
    },
  };

  const factoryReset: BotaDeviceSDKFactoryResetClient = {
    async factoryReset(device, options, provider) {
      const module = requireNativeModule();
      const subscription = module.onFactoryResetGrantRequested((request) => {
        void (async () => {
          try {
            const grantBlob = await provider({
              serialNumber: request.serialNumber,
              nonce: request.nonce,
              commandId: request.commandId,
              bindingGeneration: request.bindingGeneration,
            });
            await module.resolveFactoryResetGrant(request.requestId, grantBlob);
          } catch (error) {
            await module.rejectApplicationMaterial(
              request.requestId,
              errorMessage(error)
            );
          }
        })().catch(() => {});
      });
      try {
        return await module.factoryReset(
          toNativeConnectedDevice(device),
          options.commandId,
          options.bindingGeneration
        );
      } finally {
        subscription.remove();
      }
    },

    async resumePendingFactoryReset(device, currentBindingGeneration) {
      return requireNativeModule().resumePendingFactoryReset(
        toNativeConnectedDevice(device),
        currentBindingGeneration
      );
    },
  };

  return {
    devices,
    factoryReset,
    provisioning,

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
