import NativeBotaDeviceSDK from './specs/NativeBotaDeviceSDK';
import { createBotaDeviceSDK } from './client';

export {
  BotaNativeModuleError,
  createBotaDeviceSDK,
} from './client';
export type {
  BotaAsyncEventSubscription,
  BotaDeviceSDKCapabilities,
  BotaDeviceSDKClient,
  BotaDeviceSDKConfiguration,
  BotaDeviceSDKDeviceClient,
  BotaDeviceSDKFactoryResetClient,
  BotaDeviceSDKProvisioningClient,
  BotaDeviceSDKState,
  BotaEventSubscription,
  BotaFactoryResetCompletion,
  BotaFactoryResetGrantProvider,
  BotaFactoryResetGrantRequest,
  BotaFactoryResetOptions,
  BotaLogLevel,
  BotaProvisioningMaterial,
  BotaProvisioningMaterialProvider,
  BotaProvisioningMaterialRequest,
} from './client';

export const BotaDeviceSDK = createBotaDeviceSDK(NativeBotaDeviceSDK);

export type {
  BleFactoryResetResult,
  BleFactoryResetResultPersister,
  ConnectedDevice,
  ConnectionState,
  ConnectionType,
  DeviceCapabilities,
  DeviceConnectionSettings,
  DeviceFlags,
  DeviceLogEvent,
  DeviceState,
  DeviceStatus,
  DeviceType,
  DeviceWiFiScanResult,
  DiscoveredDevice,
  Environment,
  LteStatus,
  ModemInfo,
  PairingState,
  ProvisioningResult,
  ReconnectOptions,
  ScanOptions,
  StorageInfo,
  WiFiConfigGrant,
  WiFiConfigResult,
  WiFiCredentials,
  WiFiScanNetwork,
  WiFiSecurityType,
  WiFiStatus,
  WiFiStatusInfo,
  WifiStatus,
} from './models/Device';
export type {
  AudioCodec,
  DeviceRecording,
  StreamingSessionEvents,
  StreamingState,
  StreamingSyncOptions,
  StreamingSyncProgress,
  SyncProgress,
  SyncStage,
  TransferPacket,
  UploadInfo,
  UploadTask,
  UploadTaskStatus,
} from './models/Recording';
export type {
  BluetoothState,
  BotaClientEvents,
  BotaConfig,
  DeviceManagerEvents,
  LogLevel,
  RecordingManagerEvents,
  SdkState,
  SdkStatus,
} from './models/Status';
export type {
  CachedDeviceState,
  DeviceStateCacheEvents,
  DeviceStatePatch,
} from './cache/DeviceStateCache';
export type {
  FirmwareDownloadProgressCallback,
  FirmwareInfo,
  OtaProgress,
  OtaStage,
  UploadInfoProvider,
} from './managers/types';

export { DeviceLogDecoder } from './ble/deviceLogs';
export {
  BotaError,
  BluetoothError,
  DeviceError,
  ProvisioningError,
  SdkError,
  TransferError,
  UploadError,
  isBotaError,
} from './utils/errors';
export type { LogHandler, SdkLogEntry, SdkLogLevel } from './utils/logger';
export { deriveSyncStatus } from './sync/syncStatus';
export type {
  SyncChannel,
  SyncKind,
  SyncStatus,
  SyncStatusInputs,
} from './sync/syncStatus';
