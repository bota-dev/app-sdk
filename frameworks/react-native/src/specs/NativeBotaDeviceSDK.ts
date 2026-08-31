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

export type NativeDeviceFlags = {
  charging: boolean;
  lowBattery: boolean;
  storageFull: boolean;
  wifiConnected: boolean;
  lteConnected: boolean;
  syncActive: boolean;
};

export type NativeModemInfo = {
  imei?: string;
  iccid?: string;
  operator?: string;
  rat?: string;
  band?: string;
  apn?: string;
  simStatus?: string;
  csq?: number;
  ipAddress?: string;
  modemVoltage?: number;
  modemFirmware?: string;
  roaming?: boolean;
};

export type NativeDeviceStatus = {
  batteryLevel: number;
  batteryMv?: number;
  storageTotalMb: number;
  storageUsedMb: number;
  state: string;
  pendingRecordings: number;
  lastTimeSyncAtMs?: number;
  signalStrength: number;
  flags: NativeDeviceFlags;
  timestamp: number;
  lteStatus: string;
  lteSignalQuality?: number;
  wifiStatus?: string;
  modemInfo?: NativeModemInfo;
};

export type NativeProvisioningMaterialRequest = {
  requestId: string;
  serialNumber: string;
  nonce: string;
  devicePublicKey: string;
};

export type NativeProvisioningMaterial = {
  apiEndpoint: string;
  deviceToken: string;
  mtu: number;
};

export interface Spec extends TurboModule {
  readonly onDeviceDiscovered: EventEmitter<NativeDiscoveredDevice>;
  readonly onDeviceStatusUpdated: EventEmitter<NativeDeviceStatus>;
  readonly onProvisioningMaterialRequested: EventEmitter<NativeProvisioningMaterialRequest>;
  configure: (configuration: NativeConfiguration) => Promise<void>;
  connectSelected: (
    device: NativeDiscoveredDevice
  ) => Promise<NativeConnectedDevice>;
  destroy: () => Promise<void>;
  deprovision: (device: NativeConnectedDevice) => Promise<void>;
  disconnect: () => Promise<void>;
  getCapabilities: () => Promise<NativeCapabilities>;
  getState: () => Promise<string>;
  reconnect: (
    serialNumber: string,
    options: NativeReconnectOptions
  ) => Promise<NativeConnectedDevice>;
  provision: (device: NativeConnectedDevice) => Promise<void>;
  rejectApplicationMaterial: (
    requestId: string,
    message: string
  ) => Promise<void>;
  resolveProvisioningMaterial: (
    requestId: string,
    material: NativeProvisioningMaterial
  ) => Promise<void>;
  startScan: (timeoutMs: number, allowDuplicates: boolean) => Promise<void>;
  readStatus: () => Promise<NativeDeviceStatus>;
  startStatusUpdates: () => Promise<void>;
  stopStatusUpdates: () => Promise<void>;
  stopScan: () => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('BotaDeviceSDK');
