import type {
  NativeCapabilities,
  NativeConnectedDevice,
  NativeConfiguration,
  NativeDeviceStatus,
  NativeDeviceConnectionSettings,
  NativeDeviceRecording,
  NativeDiscoveredDevice,
  NativeFactoryResetCompletion,
  NativeFactoryResetGrantRequest,
  NativeFirmwareUpdateProgress,
  NativeRecordingControlResult,
  NativeRecordingState,
  NativeRecordingTransferProgress,
  NativeRecordingUploadRequest,
  NativeStreamingChunkDestinationRequest,
  NativeStreamingFinalizeRequest,
  NativeStreamingStartRequest,
  NativeStreamingUploadDestination,
  NativeProvisioningMaterialRequest,
  NativeUploadOwnershipResult,
  NativeWiFiConfigResult,
  NativeWiFiStatusInfo,
  NativeDeviceWiFiScanResult,
  Spec,
} from './specs/NativeBotaDeviceSDK';
import type {
  ConnectedDevice,
  ConnectionType,
  ConnectionState,
  DeviceConnectionSettings,
  DeviceState,
  DeviceStatus,
  DeviceType,
  DeviceLogEvent,
  DiscoveredDevice,
  PairingState,
  ReconnectOptions,
  ScanOptions,
  LteStatus,
  WiFiConfigGrant,
  WiFiConfigResult,
  WiFiCredentials,
  WiFiStatus,
  WiFiStatusInfo,
  BleFactoryResetResultPersister,
  DeviceWiFiScanResult,
  Environment,
  RecordingState,
  WifiStatus,
} from './models/Device';
import { reportCompatibilityDisconnection } from './compatibility/runtime';
import type {
  AudioCodec,
  DeviceRecording,
  UploadTask,
} from './models/Recording';

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
  deprovision(
    device: ConnectedDevice,
    grantBlob: string
  ): Promise<BotaDeprovisionResult>;
  readConnectionSettings(device: ConnectedDevice): Promise<DeviceConnectionSettings>;
  writeConnectionSettings(
    device: ConnectedDevice,
    settings: DeviceConnectionSettings
  ): Promise<void>;
};

export type BotaDeprovisionResult = {
  success: boolean;
  error?: string;
};

export type BotaDeviceSDKControlClient = {
  isProvisioned(device: ConnectedDevice): Promise<boolean>;
  readPublicKey(device: ConnectedDevice): Promise<string | null>;
  readAuthNonce(device: ConnectedDevice): Promise<string | null>;
  setApiEndpoint(
    device: ConnectedDevice,
    environment: Environment
  ): Promise<void>;
  deliverCertificate(
    device: ConnectedDevice,
    certificatePem: string,
    privateKeyPem: string
  ): Promise<void>;
  deliverBackendPublicKey(
    device: ConnectedDevice,
    publicKey: Uint8Array
  ): Promise<void>;
  writeGrant(device: ConnectedDevice, grantBlob: string): Promise<void>;
  syncTime(device: ConnectedDevice): Promise<void>;
  requestStartRecording(
    device: ConnectedDevice,
    grantBlob: string
  ): Promise<BotaRecordingControlResult>;
  requestStopRecording(
    device: ConnectedDevice,
    grantBlob: string
  ): Promise<BotaRecordingControlResult>;
  readRecordingState(device: ConnectedDevice): Promise<RecordingState>;
  subscribeToRecordingState(
    device: ConnectedDevice,
    onState: (state: RecordingState) => void
  ): Promise<BotaAsyncEventSubscription>;
};

export type BotaRecordingControlResult = {
  success: boolean;
  error?: string;
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
    provider: BotaFactoryResetGrantProvider,
    persistResult?: BleFactoryResetResultPersister
  ): Promise<BotaFactoryResetCompletion>;
  resumePendingFactoryReset(
    device: ConnectedDevice,
    currentBindingGeneration: number,
    persistResult?: BleFactoryResetResultPersister
  ): Promise<BotaFactoryResetCompletion | null>;
};

export type BotaRecordingTransferProgress = {
  completedBytes: number;
  totalBytes: number;
};

export type BotaUploadOwnershipRequest = {
  recordingUuid: string;
  uploadId: string;
  destinationId: string;
};

export type BotaUploadOwnershipResult =
  | { kind: 'device_upload_completed' }
  | { kind: 'device_upload_preserved'; uploadId: string }
  | {
      kind: 'bluetooth_fallback';
      recordingUuid: string;
      uploadId: string;
      destinationId: string;
    };

export type BotaFirmwareImage = {
  version: string;
  sizeBytes: number;
  crc32: number;
  url: string;
};

export type BotaFirmwareUpdatePhase =
  | 'downloading'
  | 'awaiting_device'
  | 'transferring'
  | 'verifying'
  | 'rebooting'
  | 'reconnecting'
  | 'complete';

export type BotaFirmwareUpdateProgress = {
  phase: BotaFirmwareUpdatePhase;
  completedBytes: number;
  totalBytes: number;
};

export type BotaDeviceSDKOTAClient = {
  updateFirmware(
    device: ConnectedDevice,
    image: BotaFirmwareImage,
    onProgress?: (progress: BotaFirmwareUpdateProgress) => void
  ): Promise<void>;
  cancelFirmwareUpdate(): Promise<void>;
};

export type BotaDeviceSDKLogClient = {
  subscribe(
    device: ConnectedDevice,
    onLine: (line: DeviceLogEvent) => void
  ): Promise<BotaAsyncEventSubscription>;
};

export type BotaDeviceSDKWiFiClient = {
  configure(
    device: ConnectedDevice,
    credentials: WiFiCredentials,
    grant: WiFiConfigGrant
  ): Promise<WiFiConfigResult>;
  disconnect(device: ConnectedDevice): Promise<WiFiConfigResult>;
  readStatus(device: ConnectedDevice): Promise<WiFiStatusInfo>;
  subscribeToStatus(
    device: ConnectedDevice,
    onStatus: (status: WiFiStatusInfo) => void
  ): Promise<BotaAsyncEventSubscription>;
  scanNetworks(device: ConnectedDevice): Promise<DeviceWiFiScanResult>;
};

export type BotaDeviceSDKRecordingClient = {
  listRecordings(device: ConnectedDevice): Promise<DeviceRecording[]>;
  syncRecording(
    device: ConnectedDevice,
    recording: DeviceRecording,
    onProgress?: (progress: BotaRecordingTransferProgress) => void,
    sinkId?: string
  ): Promise<{
    localPath: string;
    e2eEncrypted: boolean;
    contentSha256?: string;
  }>;
  confirmRecording(
    device: ConnectedDevice,
    recordingUuid: string
  ): Promise<void>;
  uploadRecordingFile(
    task: UploadTask,
    onProgress?: (progress: BotaRecordingTransferProgress) => void
  ): Promise<void>;
  cancelRecordingUpload(taskId: string): Promise<void>;
  loadUploadQueue(): Promise<UploadTask[]>;
  saveUploadQueue(tasks: UploadTask[]): Promise<void>;
  destroyCompatibilityOperations(): Promise<void>;
  observeUploadOwnership(
    device: ConnectedDevice,
    request: BotaUploadOwnershipRequest,
    onProgress?: (progress: BotaRecordingTransferProgress) => void
  ): Promise<BotaUploadOwnershipResult>;
};

export type BotaStreamingProgress = {
  state: string;
  bytesReceived: number;
  chunksUploaded: number;
};

export type BotaStreamingChunkRequest = {
  sequence: number;
  encrypted: boolean;
};

export type BotaStreamingFinalizeRequest = {
  totalChunks: number;
  durationMs: number;
  fileSizeBytes: number;
  encrypted: boolean;
};

export type BotaStreamingUploadDestination = NativeStreamingUploadDestination;

export type BotaDeviceSDKStreamingClient = {
  startStreaming(
    device: ConnectedDevice,
    request: NativeStreamingStartRequest,
    handlers: {
      onProgress(progress: BotaStreamingProgress): void;
      resolveChunkDestination(
        request: BotaStreamingChunkRequest
      ): Promise<BotaStreamingUploadDestination>;
      finalize(request: BotaStreamingFinalizeRequest): Promise<void>;
    }
  ): Promise<{ totalBytes: number }>;
  abortStreaming(sessionId: string): Promise<void>;
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
  readonly controls: BotaDeviceSDKControlClient;
  readonly devices: BotaDeviceSDKDeviceClient;
  readonly factoryReset: BotaDeviceSDKFactoryResetClient;
  readonly logs: BotaDeviceSDKLogClient;
  readonly ota: BotaDeviceSDKOTAClient;
  readonly provisioning: BotaDeviceSDKProvisioningClient;
  readonly recordings: BotaDeviceSDKRecordingClient;
  readonly streaming: BotaDeviceSDKStreamingClient;
  readonly wifi: BotaDeviceSDKWiFiClient;
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

const createOpaqueId = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const nibble = value === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });

const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');

const toNativeConnectionSettings = (settings: DeviceConnectionSettings) => ({
  enabledConnections: settings.enabled_connections,
  heartbeatEnabledConnections:
    settings.heartbeat_enabled_connections ?? { wifi: true, cellular: true },
  uploadNetworkPreference: settings.upload_network_preference,
  powerManagement: {
    wifiIdleTimeoutSeconds:
      settings.power_management?.wifi_idle_timeout_seconds ?? 180,
    cellularIdleTimeoutSeconds:
      settings.power_management?.cellular_idle_timeout_seconds ?? 180,
  },
  streamingEnabled: settings.streaming_enabled ?? true,
  streamingFlushIntervalSeconds:
    settings.streaming_flush_interval_seconds ?? 60,
});

const isConnectionType = (value: string): value is ConnectionType =>
  value === 'wifi' || value === 'ble' || value === 'cellular';

const mapNativeConnectionSettings = (
  settings: NativeDeviceConnectionSettings
): DeviceConnectionSettings => ({
  enabled_connections: settings.enabledConnections,
  heartbeat_enabled_connections: settings.heartbeatEnabledConnections,
  upload_network_preference: settings.uploadNetworkPreference.filter(isConnectionType),
  power_management: {
    wifi_idle_timeout_seconds: settings.powerManagement.wifiIdleTimeoutSeconds,
    cellular_idle_timeout_seconds:
      settings.powerManagement.cellularIdleTimeoutSeconds,
  },
  streaming_enabled: settings.streamingEnabled,
  streaming_flush_interval_seconds: settings.streamingFlushIntervalSeconds,
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

const mapRecording = (recording: NativeDeviceRecording): DeviceRecording => ({
  uuid: recording.uuid,
  startedAt: new Date(recording.startedAtMs),
  durationMs: recording.durationMs,
  fileSizeBytes: recording.fileSize,
  codec: recording.codec as AudioCodec,
  isEncrypted: recording.isEncrypted,
});

const toNativeRecording = (recording: DeviceRecording): NativeDeviceRecording => ({
  uuid: recording.uuid,
  startedAtMs: recording.startedAt.getTime(),
  durationMs: recording.durationMs,
  fileSize: recording.fileSizeBytes,
  codec: recording.codec,
  isEncrypted: recording.isEncrypted ?? false,
});

const mapRecordingProgress = (
  progress: NativeRecordingTransferProgress
): BotaRecordingTransferProgress => ({
  completedBytes: progress.completedUnits,
  totalBytes: progress.totalUnits,
});

const mapFirmwareProgress = (
  progress: NativeFirmwareUpdateProgress
): BotaFirmwareUpdateProgress => ({
  phase: progress.phase as BotaFirmwareUpdatePhase,
  completedBytes: progress.completedUnits,
  totalBytes: progress.totalUnits,
});

const isWiFiStatus = (value: string): value is WiFiStatus =>
  value === 'idle' ||
  value === 'connecting' ||
  value === 'connected' ||
  value === 'failed' ||
  value === 'disconnected';

const mapWiFiStatus = (status: NativeWiFiStatusInfo): WiFiStatusInfo => ({
  status: isWiFiStatus(status.status) ? status.status : 'idle',
  ...(status.signalStrength === undefined
    ? {}
    : { signalStrength: status.signalStrength }),
  ...(status.ssid === undefined ? {} : { ssid: status.ssid }),
  ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
});

const mapRecordingControlResult = (
  result: NativeRecordingControlResult
): BotaRecordingControlResult => ({
  success: result.success,
  ...(result.error === undefined ? {} : { error: result.error }),
});

const mapRecordingState = (state: NativeRecordingState): RecordingState => ({
  active: state.active,
  ...(state.recordingId === undefined
    ? {}
    : { recordingId: state.recordingId }),
  initiatedBy: state.initiatedBy === 'remote' ? 'remote' : 'local',
});

const mapWiFiConfigResult = (
  result: NativeWiFiConfigResult
): WiFiConfigResult => {
  if (result.success) return { success: true };
  switch (result.error) {
    case 'invalid_grant':
    case 'grant_expired':
    case 'decryption_error':
    case 'storage_error':
      return { success: false, error: result.error };
    default:
      return { success: false, error: 'unknown' };
  }
};

const mapWiFiScanResult = (
  result: NativeDeviceWiFiScanResult
): DeviceWiFiScanResult => ({
  networks: result.networks.map((network) => ({ ...network })),
  currentSsid: result.currentSsid ?? null,
});

const requiredUploadOwnershipField = (
  value: string | undefined,
  field: string
): string => {
  if (value === undefined) {
    throw new Error(`native upload ownership result is missing ${field}`);
  }
  return value;
};

const mapUploadOwnershipResult = (
  result: NativeUploadOwnershipResult
): BotaUploadOwnershipResult => {
  switch (result.kind) {
    case 'device_upload_completed':
      return { kind: 'device_upload_completed' };
    case 'device_upload_preserved':
      return {
        kind: 'device_upload_preserved',
        uploadId: requiredUploadOwnershipField(result.uploadId, 'uploadId'),
      };
    case 'bluetooth_fallback':
      return {
        kind: 'bluetooth_fallback',
        recordingUuid: requiredUploadOwnershipField(
          result.recordingUuid,
          'recordingUuid'
        ),
        uploadId: requiredUploadOwnershipField(result.uploadId, 'uploadId'),
        destinationId: requiredUploadOwnershipField(
          result.destinationId,
          'destinationId'
        ),
      };
    default:
      throw new Error(`unsupported native upload ownership result: ${result.kind}`);
  }
};

const toNativeRecordingUploadRequest = (
  task: UploadTask
): NativeRecordingUploadRequest => ({
  taskId: task.id,
  recordingId: task.recordingId,
  deviceId: task.deviceId,
  localPath: task.localPath,
  uploadUrl: task.uploadUrl,
  ...(task.uploadToken ? { uploadToken: task.uploadToken } : {}),
  ...(task.completeUrl ? { completeUrl: task.completeUrl } : {}),
  ...(task.contentType ? { contentType: task.contentType } : {}),
  ...(task.contentSha256 ? { contentSha256: task.contentSha256 } : {}),
  ...(task.relay
    ? {
        relayUrl: task.relay.url,
        relayBearerToken: task.relay.bearerToken,
      }
    : {}),
});

const parseUploadQueue = (serialized: string): UploadTask[] => {
  const value: unknown = JSON.parse(serialized || '[]');
  if (!Array.isArray(value)) return [];
  return value.map((task) => {
    const candidate = task as UploadTask & {
      createdAt: string | Date;
      updatedAt: string | Date;
    };
    return {
      ...candidate,
      createdAt: new Date(candidate.createdAt),
      updatedAt: new Date(candidate.updatedAt),
    };
  });
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

    async deprovision(device, grantBlob) {
      const result = await requireNativeModule().deprovision(
        toNativeConnectedDevice(device),
        grantBlob
      );
      return result.error === undefined
        ? { success: result.success }
        : { success: result.success, error: result.error };
    },

    async readConnectionSettings(device) {
      return mapNativeConnectionSettings(
        await requireNativeModule().readConnectionSettings(
          toNativeConnectedDevice(device)
        )
      );
    },

    async writeConnectionSettings(device, settings) {
      await requireNativeModule().writeConnectionSettings(
        toNativeConnectedDevice(device),
        toNativeConnectionSettings(settings)
      );
    },
  };

  const controls: BotaDeviceSDKControlClient = {
    async isProvisioned(device) {
      return requireNativeModule().isProvisioned(toNativeConnectedDevice(device));
    },

    async readPublicKey(device) {
      return requireNativeModule().readPublicKey(toNativeConnectedDevice(device));
    },

    async readAuthNonce(device) {
      return requireNativeModule().readAuthNonce(toNativeConnectedDevice(device));
    },

    async setApiEndpoint(device, environment) {
      await requireNativeModule().setApiEndpoint(
        toNativeConnectedDevice(device),
        environment
      );
    },

    async deliverCertificate(device, certificatePem, privateKeyPem) {
      await requireNativeModule().deliverCertificate(
        toNativeConnectedDevice(device),
        certificatePem,
        privateKeyPem
      );
    },

    async deliverBackendPublicKey(device, publicKey) {
      await requireNativeModule().deliverBackendPublicKey(
        toNativeConnectedDevice(device),
        bytesToHex(publicKey)
      );
    },

    async writeGrant(device, grantBlob) {
      await requireNativeModule().writeGrant(
        toNativeConnectedDevice(device),
        grantBlob
      );
    },

    async syncTime(device) {
      await requireNativeModule().syncTime(toNativeConnectedDevice(device));
    },

    async requestStartRecording(device, grantBlob) {
      return mapRecordingControlResult(
        await requireNativeModule().requestStartRecording(
          toNativeConnectedDevice(device),
          grantBlob
        )
      );
    },

    async requestStopRecording(device, grantBlob) {
      return mapRecordingControlResult(
        await requireNativeModule().requestStopRecording(
          toNativeConnectedDevice(device),
          grantBlob
        )
      );
    },

    async readRecordingState(device) {
      return mapRecordingState(
        await requireNativeModule().readRecordingState(
          toNativeConnectedDevice(device)
        )
      );
    },

    async subscribeToRecordingState(device, onState) {
      const module = requireNativeModule();
      const eventSubscription = module.onRecordingStateUpdated((state) => {
        onState(mapRecordingState(state));
      });
      try {
        await module.startRecordingStateUpdates(toNativeConnectedDevice(device));
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
          await module.stopRecordingStateUpdates();
        },
      };
    },
  };

  const factoryReset: BotaDeviceSDKFactoryResetClient = {
    async factoryReset(device, options, provider, persistResult) {
      const module = requireNativeModule();
      const grantSubscription = module.onFactoryResetGrantRequested((request) => {
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
      const persistenceSubscription = persistResult
        ? module.onFactoryResetResultPersistenceRequested((request) => {
            void (async () => {
              try {
                await persistResult({
                  success: true,
                  localRecordingsDeleted: request.localRecordingsDeleted,
                });
                await module.resolveFactoryResetResultPersistence(request.requestId);
              } catch (error) {
                await module.rejectApplicationMaterial(
                  request.requestId,
                  errorMessage(error)
                );
              }
            })().catch(() => {});
          })
        : null;
      try {
        return await module.factoryReset(
          toNativeConnectedDevice(device),
          options.commandId,
          options.bindingGeneration,
          persistResult !== undefined
        );
      } finally {
        grantSubscription.remove();
        persistenceSubscription?.remove();
      }
    },

    async resumePendingFactoryReset(device, currentBindingGeneration, persistResult) {
      const module = requireNativeModule();
      const subscription = persistResult
        ? module.onFactoryResetResultPersistenceRequested((request) => {
            void (async () => {
              try {
                await persistResult({
                  success: true,
                  localRecordingsDeleted: request.localRecordingsDeleted,
                });
                await module.resolveFactoryResetResultPersistence(request.requestId);
              } catch (error) {
                await module.rejectApplicationMaterial(
                  request.requestId,
                  errorMessage(error)
                );
              }
            })().catch(() => {});
          })
        : null;
      try {
        return await module.resumePendingFactoryReset(
          toNativeConnectedDevice(device),
          currentBindingGeneration,
          persistResult !== undefined
        );
      } finally {
        subscription?.remove();
      }
    },
  };

  const recordings: BotaDeviceSDKRecordingClient = {
    async listRecordings(device) {
      const values = await requireNativeModule().listRecordings(
        toNativeConnectedDevice(device)
      );
      return values.map(mapRecording);
    },

    async syncRecording(device, recording, onProgress, sinkId) {
      const module = requireNativeModule();
      const subscription = module.onRecordingTransferProgress((progress) => {
        onProgress?.(mapRecordingProgress(progress));
      });
      try {
        return await module.syncRecording(
          toNativeConnectedDevice(device),
          toNativeRecording(recording),
          sinkId ?? createOpaqueId()
        );
      } finally {
        subscription.remove();
      }
    },

    async uploadRecordingFile(task, onProgress) {
      const module = requireNativeModule();
      const subscription = module.onRecordingUploadProgress((progress) => {
        if (progress.taskId !== task.id) return;
        onProgress?.({
          completedBytes: progress.completedBytes,
          totalBytes: progress.totalBytes,
        });
      });
      try {
        await module.uploadRecordingFile(toNativeRecordingUploadRequest(task));
      } finally {
        subscription.remove();
      }
    },

    async confirmRecording(device, recordingUuid) {
      await requireNativeModule().confirmRecording(
        toNativeConnectedDevice(device),
        recordingUuid
      );
    },

    async cancelRecordingUpload(taskId) {
      await requireNativeModule().cancelRecordingUpload(taskId);
    },

    async loadUploadQueue() {
      return parseUploadQueue(
        await requireNativeModule().loadCompatibilityUploadQueue()
      );
    },

    async saveUploadQueue(tasks) {
      await requireNativeModule().saveCompatibilityUploadQueue(
        JSON.stringify(tasks)
      );
    },

    async destroyCompatibilityOperations() {
      await requireNativeModule().stopAllRecordingOperations();
    },

    async observeUploadOwnership(device, request, onProgress) {
      const module = requireNativeModule();
      const subscription = module.onUploadOwnershipProgress((progress) => {
        onProgress?.(mapRecordingProgress(progress));
      });
      try {
        return mapUploadOwnershipResult(
          await module.observeUploadOwnership(
            toNativeConnectedDevice(device),
            request
          )
        );
      } finally {
        subscription.remove();
      }
    },
  };

  const ota: BotaDeviceSDKOTAClient = {
    async updateFirmware(device, image, onProgress) {
      const module = requireNativeModule();
      const subscription = module.onFirmwareUpdateProgress((progress) => {
        onProgress?.(mapFirmwareProgress(progress));
      });
      try {
        await module.updateFirmware(toNativeConnectedDevice(device), {
          version: image.version,
          sizeUnits: image.sizeBytes,
          crc32: image.crc32,
          url: image.url,
        });
      } finally {
        subscription.remove();
      }
    },

    async cancelFirmwareUpdate() {
      await requireNativeModule().cancelFirmwareUpdate();
    },
  };

  const streaming: BotaDeviceSDKStreamingClient = {
    async startStreaming(device, request, handlers) {
      const module = requireNativeModule();
      const progressSubscription = module.onStreamingProgress((progress) => {
        if (progress.sessionId !== request.sessionId) return;
        handlers.onProgress({
          state: progress.state,
          bytesReceived: progress.bytesReceived,
          chunksUploaded: progress.chunksUploaded,
        });
      });
      const destinationSubscription = module.onStreamingChunkDestinationRequested(
        (nativeRequest: NativeStreamingChunkDestinationRequest) => {
          if (nativeRequest.sessionId !== request.sessionId) return;
          void handlers
            .resolveChunkDestination({
              sequence: nativeRequest.sequence,
              encrypted: nativeRequest.encrypted,
            })
            .then(
              (destination) =>
                module.resolveStreamingChunkDestination(
                  nativeRequest.requestId,
                  destination
                ),
              (error) =>
                module.rejectStreamingChunkDestination(
                  nativeRequest.requestId,
                  errorMessage(error)
                )
            )
            .catch(() => {});
        }
      );
      const finalizeSubscription = module.onStreamingFinalizeRequested(
        (nativeRequest: NativeStreamingFinalizeRequest) => {
          if (nativeRequest.sessionId !== request.sessionId) return;
          void handlers
            .finalize({
              totalChunks: nativeRequest.totalChunks,
              durationMs: nativeRequest.durationMs,
              fileSizeBytes: nativeRequest.fileSizeBytes,
              encrypted: nativeRequest.encrypted,
            })
            .then(
              () => module.resolveStreamingFinalize(nativeRequest.requestId),
              (error) =>
                module.rejectStreamingFinalize(
                  nativeRequest.requestId,
                  errorMessage(error)
                )
            )
            .catch(() => {});
        }
      );
      try {
        return await module.startStreaming(
          toNativeConnectedDevice(device),
          request
        );
      } finally {
        progressSubscription.remove();
        destinationSubscription.remove();
        finalizeSubscription.remove();
      }
    },

    async abortStreaming(sessionId) {
      await requireNativeModule().abortStreaming(sessionId);
    },
  };

  const logs: BotaDeviceSDKLogClient = {
    async subscribe(device, onLine) {
      const module = requireNativeModule();
      const eventSubscription = module.onDeviceLog((line) => {
        onLine({
          level: 'debug',
          message: line.message,
          isBacklog: line.isBacklog,
        });
      });
      try {
        await module.startDeviceLogs(toNativeConnectedDevice(device));
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
          await module.stopDeviceLogs();
        },
      };
    },
  };

  const wifi: BotaDeviceSDKWiFiClient = {
    async configure(device, credentials, grant) {
      return mapWiFiConfigResult(
        await requireNativeModule().configureWiFi(
          toNativeConnectedDevice(device),
          credentials.ssid,
          credentials.password,
          grant.grantBlob
        )
      );
    },

    async disconnect(device) {
      return mapWiFiConfigResult(
        await requireNativeModule().disconnectWiFi(
          toNativeConnectedDevice(device)
        )
      );
    },

    async readStatus(device) {
      return mapWiFiStatus(
        await requireNativeModule().readWiFiStatus(
          toNativeConnectedDevice(device)
        )
      );
    },

    async subscribeToStatus(device, onStatus) {
      const module = requireNativeModule();
      const eventSubscription = module.onWiFiStatusUpdated((status) => {
        onStatus(mapWiFiStatus(status));
      });
      try {
        await module.startWiFiStatusUpdates(toNativeConnectedDevice(device));
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
          await module.stopWiFiStatusUpdates();
        },
      };
    },

    async scanNetworks(device) {
      return mapWiFiScanResult(
        await requireNativeModule().scanWiFiNetworks(
          toNativeConnectedDevice(device)
        )
      );
    },
  };

  const client: BotaDeviceSDKClient = {
    controls,
    devices,
    factoryReset,
    logs,
    ota,
    provisioning,
    recordings,
    streaming,
    wifi,

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
  nativeModule?.onDeviceDisconnected?.((event) => {
    reportCompatibilityDisconnection(
      client,
      event.error ? new Error(event.error) : undefined
    );
  });
  return client;
};
