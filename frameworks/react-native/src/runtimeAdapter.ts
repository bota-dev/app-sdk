import type { FindDeviceAdapter } from './findDevice';
import type { Spec } from './specs/NativeBotaDeviceSDK';
import type { Spec as BackendSpec } from './specs/NativeBotaUploadV2Backend';

/** The bridge contract is independent of npm, SwiftPM and Maven package versions. */
export const BOTA_RUNTIME_API_VERSION = 1 as const;
export type BotaRuntimeSpec = Spec & FindDeviceAdapter;
export type BotaDeviceAdapter = Partial<Omit<BotaRuntimeSpec, 'getConstants'>>;
export type BotaNativeOperation = keyof BotaDeviceAdapter;
export type BotaUploadBackendAdapter = Partial<Omit<BackendSpec, 'getConstants'>>;

export function requireUploadBackend(
  adapter: BotaUploadBackendAdapter | null, operation: string,
  methods: readonly (keyof BotaUploadBackendAdapter)[],
): asserts adapter is BackendSpec {
  if (!adapter || methods.some(name => typeof adapter[name] !== 'function')) {
    throw new BotaRuntimeCompatibilityError('native_operation_unavailable', operation);
  }
}

export class BotaRuntimeCompatibilityError extends Error {
  constructor(
    readonly code: 'native_contract_unsupported' | 'native_operation_unavailable' |
      'device_identity_mismatch' | 'firmware_version_mismatch' | 'operation_in_progress' | 'operation_cancelled',
    readonly operation: string,
  ) {
    super(`${operation}: ${code}`);
    this.name = 'BotaRuntimeCompatibilityError';
  }
}

// A workflow needs its completion/cancellation callbacks before any device effect.
const dependencies: Partial<Record<BotaNativeOperation, readonly BotaNativeOperation[]>> = {
  reconnect: ['disconnect'],
  startScan: ['onDeviceDiscovered', 'stopScan'],
  startStatusUpdates: ['onDeviceStatusUpdated', 'stopStatusUpdates'],
  startRecordingStateUpdates: ['onRecordingStateUpdated', 'stopRecordingStateUpdates'],
  startWiFiStatusUpdates: ['onWiFiStatusUpdated', 'stopWiFiStatusUpdates'],
  startDeviceLogs: ['onDeviceLog', 'stopDeviceLogs'],
  provision: ['onProvisioningMaterialRequested', 'resolveProvisioningMaterial', 'rejectApplicationMaterial'],
  factoryReset: ['onFactoryResetGrantRequested', 'resolveFactoryResetGrant', 'rejectApplicationMaterial'],
  syncRecording: ['onRecordingTransferProgress'],
  syncEncryptedRecordingV2: ['onEncryptedUploadV2ProfileRequested', 'onEncryptedUploadV2Progress',
    'resolveEncryptedUploadV2Profile', 'rejectEncryptedUploadV2Profile',
    'cancelEncryptedRecordingV2', 'releaseEncryptedUploadV2Material'],
  uploadRecordingFile: ['onRecordingUploadProgress', 'cancelRecordingUpload'],
  observeUploadOwnership: ['onUploadOwnershipProgress'],
  updateFirmware: ['onFirmwareUpdateProgress', 'cancelFirmwareUpdate'],
  startStreaming: ['onStreamingProgress', 'onStreamingChunkDestinationRequested',
    'onStreamingFinalizeRequested', 'resolveStreamingChunkDestination', 'rejectStreamingChunkDestination',
    'resolveStreamingFinalize', 'rejectStreamingFinalize', 'abortStreaming'],
};

export function supportsNativeOperation(adapter: BotaDeviceAdapter | null, operation: BotaNativeOperation): boolean {
  return !!adapter && [operation, ...(dependencies[operation] ?? [])]
    .every(name => typeof adapter[name] === 'function');
}

export function requireNativeOperation(adapter: BotaDeviceAdapter, operation: BotaNativeOperation): void {
  if (!supportsNativeOperation(adapter, operation)) {
    throw new BotaRuntimeCompatibilityError('native_operation_unavailable', operation);
  }
}

/** Normalize method availability and `this` binding without importing React Native. */
export function guardDeviceAdapter(adapter: BotaDeviceAdapter): BotaRuntimeSpec {
  return new Proxy(adapter, {
    get(target, property) {
      const operation = property as BotaNativeOperation;
      requireNativeOperation(target, operation);
      return (target[operation] as (...args: unknown[]) => unknown).bind(target);
    },
  }) as BotaRuntimeSpec;
}
