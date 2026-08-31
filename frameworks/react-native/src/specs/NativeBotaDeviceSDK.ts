import type { TurboModule } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';
import { TurboModuleRegistry } from 'react-native';

export type NativeConfiguration = {
  applicationSupportDirectory?: string;
  logLevel: string;
};

export type NativeCapabilities = {
  backgroundReconnect: boolean;
  backgroundScan: boolean;
  bluetooth: boolean;
  nativeFileTransfer: boolean;
  platform: string;
};

export type NativeDiscoveredDevice = {
  id: string;
  name?: string;
  deviceType?: string;
  firmwareVersion?: string;
  macAddress?: string;
  pairingState?: string;
  rssi: number;
  discoveredAtMs: number;
};

export type NativeConnectedDevice = {
  id: string;
  serialNumber: string;
  deviceType: string;
  firmwareVersion: string;
  hardwareRevision?: string;
  isProvisioned: boolean;
  connectionState: string;
  mtu: number;
};

export type NativeReconnectOptions = {
  scanTimeoutMs: number;
  connectionTimeoutMs: number;
};

export interface Spec extends TurboModule {
  readonly onDeviceDiscovered: EventEmitter<NativeDiscoveredDevice>;
  configure: (configuration: NativeConfiguration) => Promise<void>;
  connectSelected: (
    device: NativeDiscoveredDevice
  ) => Promise<NativeConnectedDevice>;
  destroy: () => Promise<void>;
  disconnect: () => Promise<void>;
  getCapabilities: () => Promise<NativeCapabilities>;
  getState: () => Promise<string>;
  reconnect: (
    serialNumber: string,
    options: NativeReconnectOptions
  ) => Promise<NativeConnectedDevice>;
  startScan: (timeoutMs: number, allowDuplicates: boolean) => Promise<void>;
  stopScan: () => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('BotaDeviceSDK');
