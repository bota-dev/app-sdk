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

export type NativeEnabledConnections = {
  wifi: boolean;
  cellular: boolean;
};

export type NativePowerManagement = {
  wifiIdleTimeoutSeconds: number;
  cellularIdleTimeoutSeconds: number;
};

export type NativeDeviceConnectionSettings = {
  enabledConnections: NativeEnabledConnections;
  heartbeatEnabledConnections: NativeEnabledConnections;
  uploadNetworkPreference: ReadonlyArray<string>;
  powerManagement: NativePowerManagement;
  streamingEnabled: boolean;
  streamingFlushIntervalSeconds: number;
};

export type NativeFactoryResetGrantRequest = {
  requestId: string;
  serialNumber: string;
  nonce: string;
  commandId: string;
  bindingGeneration: number;
};

export type NativeFactoryResetCompletion = {
  commandId: string;
  bindingGeneration: number;
};

export type NativeDeviceRecording = {
  uuid: string;
  startedAtMs: number;
  durationMs: number;
  fileSize: number;
  codec: string;
  isEncrypted: boolean;
};

export type NativeRecordingTransferProgress = {
  completedUnits: number;
  totalUnits: number;
};

export type NativeUploadOwnershipRequest = {
  recordingUuid: string;
  uploadId: string;
  destinationId: string;
};

export type NativeUploadOwnershipResult = {
  kind: string;
  recordingUuid?: string;
  uploadId?: string;
  destinationId?: string;
};

export type NativeFirmwareImage = {
  version: string;
  sizeUnits: number;
  crc32: number;
  url: string;
};

export type NativeFirmwareUpdateProgress = {
  phase: string;
  completedUnits: number;
  totalUnits: number;
};

export type NativeDeviceLogLine = {
  message: string;
  isBacklog: boolean;
};

export type NativeWiFiConfigResult = {
  success: boolean;
  error?: string;
};

export type NativeWiFiStatusInfo = {
  status: string;
  signalStrength?: number;
  ssid?: string;
  lastError?: string;
};

export type NativeWiFiScanNetwork = {
  ssid: string;
  quality: number;
  isCurrent: boolean;
  isOpen: boolean;
};

export type NativeDeviceWiFiScanResult = {
  networks: ReadonlyArray<NativeWiFiScanNetwork>;
  currentSsid?: string;
};

export interface Spec extends TurboModule {
  readonly onDeviceDiscovered: EventEmitter<NativeDiscoveredDevice>;
  readonly onDeviceStatusUpdated: EventEmitter<NativeDeviceStatus>;
  readonly onProvisioningMaterialRequested: EventEmitter<NativeProvisioningMaterialRequest>;
  readonly onFactoryResetGrantRequested: EventEmitter<NativeFactoryResetGrantRequest>;
  readonly onRecordingTransferProgress: EventEmitter<NativeRecordingTransferProgress>;
  readonly onUploadOwnershipProgress: EventEmitter<NativeRecordingTransferProgress>;
  readonly onFirmwareUpdateProgress: EventEmitter<NativeFirmwareUpdateProgress>;
  readonly onDeviceLog: EventEmitter<NativeDeviceLogLine>;
  readonly onWiFiStatusUpdated: EventEmitter<NativeWiFiStatusInfo>;
  configure: (configuration: NativeConfiguration) => Promise<void>;
  connectSelected: (
    device: NativeDiscoveredDevice
  ) => Promise<NativeConnectedDevice>;
  destroy: () => Promise<void>;
  deprovision: (device: NativeConnectedDevice) => Promise<void>;
  disconnect: () => Promise<void>;
  isProvisioned: (device: NativeConnectedDevice) => Promise<boolean>;
  readPublicKey: (device: NativeConnectedDevice) => Promise<string | null>;
  readAuthNonce: (device: NativeConnectedDevice) => Promise<string | null>;
  setApiEndpoint: (
    device: NativeConnectedDevice,
    environment: string
  ) => Promise<void>;
  deliverCertificate: (
    device: NativeConnectedDevice,
    certificatePem: string,
    privateKeyPem: string
  ) => Promise<void>;
  deliverBackendPublicKey: (
    device: NativeConnectedDevice,
    publicKeyHex: string
  ) => Promise<void>;
  writeGrant: (
    device: NativeConnectedDevice,
    grantBlob: string
  ) => Promise<void>;
  syncTime: (device: NativeConnectedDevice) => Promise<void>;
  configureWiFi: (
    device: NativeConnectedDevice,
    ssid: string,
    password: string,
    grantBlob: string
  ) => Promise<NativeWiFiConfigResult>;
  disconnectWiFi: (
    device: NativeConnectedDevice
  ) => Promise<NativeWiFiConfigResult>;
  factoryReset: (
    device: NativeConnectedDevice,
    commandId: string,
    bindingGeneration: number
  ) => Promise<NativeFactoryResetCompletion>;
  getCapabilities: () => Promise<NativeCapabilities>;
  getState: () => Promise<string>;
  listRecordings: (
    device: NativeConnectedDevice
  ) => Promise<ReadonlyArray<NativeDeviceRecording>>;
  observeUploadOwnership: (
    device: NativeConnectedDevice,
    request: NativeUploadOwnershipRequest
  ) => Promise<NativeUploadOwnershipResult>;
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
  resolveFactoryResetGrant: (
    requestId: string,
    grantBlob: string
  ) => Promise<void>;
  resumePendingFactoryReset: (
    device: NativeConnectedDevice,
    currentBindingGeneration: number
  ) => Promise<NativeFactoryResetCompletion | null>;
  readConnectionSettings: (
    device: NativeConnectedDevice
  ) => Promise<NativeDeviceConnectionSettings>;
  startScan: (timeoutMs: number, allowDuplicates: boolean) => Promise<void>;
  readStatus: () => Promise<NativeDeviceStatus>;
  readWiFiStatus: (
    device: NativeConnectedDevice
  ) => Promise<NativeWiFiStatusInfo>;
  scanWiFiNetworks: (
    device: NativeConnectedDevice
  ) => Promise<NativeDeviceWiFiScanResult>;
  startStatusUpdates: () => Promise<void>;
  startWiFiStatusUpdates: (device: NativeConnectedDevice) => Promise<void>;
  startDeviceLogs: (device: NativeConnectedDevice) => Promise<void>;
  stopDeviceLogs: () => Promise<void>;
  stopStatusUpdates: () => Promise<void>;
  stopWiFiStatusUpdates: () => Promise<void>;
  stopScan: () => Promise<void>;
  syncRecording: (
    device: NativeConnectedDevice,
    recording: NativeDeviceRecording
  ) => Promise<string>;
  updateFirmware: (
    device: NativeConnectedDevice,
    image: NativeFirmwareImage
  ) => Promise<void>;
  writeConnectionSettings: (
    device: NativeConnectedDevice,
    settings: NativeDeviceConnectionSettings
  ) => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('BotaDeviceSDK');
