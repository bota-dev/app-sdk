import { createBotaDeviceSDK } from './client';
import type { BotaDeviceSDKClient } from './client';
import { createBotaClient } from './BotaClient';
import { createManagedEncryptedUploadV2Backend } from './encryptedUploadV2Backend';
import type { EncryptedUploadV2BackendOptions, EncryptedUploadV2Backend } from './encryptedUploadV2Backend';
import { createManagedByoStorageBackend } from './byoStorageBackend';
import type { ByoStorageBackendOptions, ByoStorageBackend } from './byoStorageBackend';
import { createManagedProtectedStreamingStatusBackend } from './protectedStreamingStatus';
import type { ProtectedStreamingStatusBackendOptions, ProtectedStreamingStatusBackend } from './protectedStreamingStatus';
import { BOTA_RUNTIME_API_VERSION, BotaRuntimeCompatibilityError, supportsNativeOperation } from './runtimeAdapter';
import type { BotaDeviceAdapter, BotaNativeOperation, BotaUploadBackendAdapter } from './runtimeAdapter';
import type { BotaReconnectPolicy } from './reconnectPolicy';
import type { BotaFirmwareRecoveryPolicy } from './firmwareRecovery';

export { BOTA_RUNTIME_API_VERSION, BotaRuntimeCompatibilityError } from './runtimeAdapter';
export type { BotaDeviceAdapter, BotaNativeOperation, BotaUploadBackendAdapter } from './runtimeAdapter';
export type { BotaReconnectPolicy } from './reconnectPolicy';
export type { BotaFirmwareRecoveryPolicy } from './firmwareRecovery';

export interface BotaReactNativeAdapter {
  apiVersion: typeof BOTA_RUNTIME_API_VERSION;
  device: BotaDeviceAdapter | null;
  encryptedUploadBackend?: BotaUploadBackendAdapter | null;
}

export interface BotaReactNativeRuntime {
  sdk: BotaDeviceSDKClient;
  client: ReturnType<typeof createBotaClient>;
  supports(operation: BotaNativeOperation): boolean;
  createEncryptedUploadV2Backend(configuration: EncryptedUploadV2BackendOptions): EncryptedUploadV2Backend;
  createByoStorageBackend(configuration: ByoStorageBackendOptions): ByoStorageBackend;
  createProtectedStreamingStatusBackend(configuration: ProtectedStreamingStatusBackendOptions): ProtectedStreamingStatusBackend;
}

/** Portable TypeScript runtime. No OS APIs, native registry or package-version equality. */
export function createBotaReactNativeRuntime(
  adapter: BotaReactNativeAdapter,
  options: { reconnect?: BotaReconnectPolicy; firmwareRecovery?: BotaFirmwareRecoveryPolicy } = {},
): BotaReactNativeRuntime {
  if (adapter.apiVersion !== BOTA_RUNTIME_API_VERSION) {
    throw new BotaRuntimeCompatibilityError('native_contract_unsupported', 'createRuntime');
  }
  const device = adapter.device;
  const backend = adapter.encryptedUploadBackend ?? null;
  const sdk = createBotaDeviceSDK(device, options);
  return {
    sdk,
    client: createBotaClient(sdk),
    supports: (operation: BotaNativeOperation) => supportsNativeOperation(device, operation),
    createEncryptedUploadV2Backend: (configuration: EncryptedUploadV2BackendOptions) =>
      createManagedEncryptedUploadV2Backend(backend, sdk.recordings, configuration),
    createByoStorageBackend: (configuration: ByoStorageBackendOptions) =>
      createManagedByoStorageBackend(backend, configuration),
    createProtectedStreamingStatusBackend: (configuration: ProtectedStreamingStatusBackendOptions) =>
      createManagedProtectedStreamingStatusBackend(backend, configuration),
  };
}
