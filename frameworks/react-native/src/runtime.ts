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
import { createGeneratedJsCore } from './jsHost/core';
import { createJsDeviceAdapter } from './jsHost/deviceAdapter';
import type { BotaJsHostPorts } from './jsHost/contracts';
import { createJsUploadBackend } from './jsHost/backend';
import type { JsUploadBackendOptions } from './jsHost/backend';
import type { JsDeviceAdapterOptions } from './jsHost/deviceAdapter';
import { createJsEncryptedUploadV2Backend } from './jsHost/uploadBackendV2';
import type { JsEncryptedUploadV2Backend, JsV2Fetch, JsV2UploadTarget } from './jsHost/uploadBackendV2';
import type { JsHostContext, OpaqueHostHandle } from './jsHost/contracts';
import type { JsEncryptedUploadV2Material } from './jsHost/encryptedUploadV2';
import { createJsByoEffects } from './jsHost/byoEffects';
import type { JsByoEffects, JsByoSocket } from './jsHost/byoEffects';
import type { JsRecordingUploadTarget } from './jsHost/recordingUploads';
import { validateJsHostPorts, BOTA_JS_HOST_PORT_API_VERSION } from './jsHost/ports';
import { setCompatibilityUploadPolicy } from './managers/NativeUploadQueue';
import { createUploadRecoveryProvider } from './uploadRecovery';
import { createJsBluetoothState } from './jsHost/bluetoothState';
import { setCompatibilityBluetoothState } from './compatibility/bluetoothState';

export { createBlePlxPort } from './jsHost/blePlx';
export { isEmptyLegacyAndroidV2CheckpointCatalog } from './jsHost/legacyStorage';
export { UPLOAD_RECOVERY_VERSION } from './uploadRecovery';
export { deriveSyncStatus } from './sync/syncStatus';
export type { SyncChannel, SyncKind, SyncStatus, SyncStatusInputs } from './sync/syncStatus';
export { readClientPresenceObservation } from './clientPresence';
export type { ClientPresence, SdkClientContext } from './clientPresence';
export type { BlePlxManager } from './jsHost/blePlx';
export type { JsBackendFetch, JsUploadBackendOptions } from './jsHost/backend';
export type { JsV2Fetch, JsV2UploadTarget } from './jsHost/uploadBackendV2';
export type { JsByoSocket } from './jsHost/byoEffects';
export type { JsEncryptedUploadV2Material } from './jsHost/encryptedUploadV2';
export type { JsRecordingUploadTarget } from './jsHost/recordingUploads';
export { BOTA_JS_HOST_PORT_API_VERSION };
export type { BotaJsHostPorts, JsBlePort, JsFilePort, JsHostContext, JsPersistencePort,
  JsNetworkPort, JsLifecyclePort, OpaqueHostHandle } from './jsHost/contracts';

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

export interface BotaReactNativeJsRuntimeOptions {
  /** Exact authenticated binding metadata; only BOTA_DEV may fall back to this Rust-validated model. */
  resolveBoundDeviceModel?: JsDeviceAdapterOptions['resolveBoundDeviceModel'];
  reconnect?: BotaReconnectPolicy;
  firmwareRecovery?: BotaFirmwareRecoveryPolicy;
  backend?: Omit<JsUploadBackendOptions, 'fetch'> & { fetch?: JsV2Fetch };
  /** Generic HTTP effects supplied by installed host libraries. */
  upload?: JsDeviceAdapterOptions['upload'];
  uploadFile?: (target: JsRecordingUploadTarget, file: OpaqueHostHandle, context: JsHostContext,
    progress?: (completedBytes: string, totalBytes: string) => void) => Promise<void>;
  openSocket?: (url: string, headers: Readonly<Record<string, string>>, protocol: string,
    context: JsHostContext) => Promise<JsByoSocket>;
}

export interface BotaReactNativeJsRuntime extends BotaReactNativeRuntime {
  readEncryptedUploadV2AuthNonce(operationId: string): Promise<string>;
  registerEncryptedUploadV2Material(operationId: string, material: JsEncryptedUploadV2Material): string;
  releaseEncryptedUploadV2Material(registrationId: string): Promise<void>;
  createUploadRecoveryProvider: typeof createUploadRecoveryProvider;
}

/** Runs generated shared Rust behavior in JS over installed, narrow OS capabilities. */
export function createBotaReactNativeJsRuntime(
  ports: BotaJsHostPorts,
  options: BotaReactNativeJsRuntimeOptions = {},
): BotaReactNativeJsRuntime {
  validateJsHostPorts(ports);
  const core = createGeneratedJsCore();
  const constructionCleanups: Array<() => Promise<void>> = [];
  let runtime: BotaReactNativeRuntime | undefined;
  try {
    const codecPolicy = (name: string, input: Record<string, unknown>) =>
      core.codec(name, input as import('./jsHost/contracts').JsValue) as Record<string, unknown>;
    const reconnect = codecPolicy('normalizeForegroundReconnect', { ...options.reconnect }) as unknown as Required<BotaReconnectPolicy>;
    const backendOptions = options.backend;
    const scopeCheck = ports.checkScope;
    const backendScopeCheck = backendOptions?.checkScope;
    const scopedBackendOptions = { ...backendOptions, signal: backendOptions?.signal ?? ports.signal,
      checkScope() { scopeCheck?.(); backendScopeCheck?.(); } };
    const scalarBackend = backendOptions?.fetch ? createJsUploadBackend(scopedBackendOptions) : undefined;
    if (scalarBackend) constructionCleanups.push(() => scalarBackend.dispose());
    let managedBackend: JsEncryptedUploadV2Backend | undefined;
    let byoBackend: JsByoEffects | undefined;
    const device = createJsDeviceAdapter(core, ports, { upload: options.upload,
      resolveBoundDeviceModel: options.resolveBoundDeviceModel,
      fetch: backendOptions?.fetch, uploadFile: options.uploadFile,
      firmwareRecoveryTimeoutMs: options.firmwareRecovery?.timeoutMs,
      drainMaterial: operationId => managedBackend?.drain(operationId) ?? Promise.resolve() });
    const destroyDevice = device.destroy!.bind(device);
    constructionCleanups.push(destroyDevice);
    const bluetoothState = createJsBluetoothState(core, ports, error => device.markCleanupFailed(error));
    constructionCleanups.push(() => bluetoothState.dispose());
    if (scalarBackend && backendOptions?.fetch && ports.files && options.uploadFile) {
      managedBackend = createJsEncryptedUploadV2Backend({ core, files: ports.files, persistence: ports.persistence,
        fetch: backendOptions.fetch, uploadFile: options.uploadFile,
        requestCredentials: (operationId, signal) => scalarBackend.requestCredentials(operationId, signal),
        readNonce: operationId => device.readNonce(operationId),
        context: (operationId, signal) => device.context(operationId, signal),
        checkOperation: operationId => device.checkOperation(operationId),
        registerMaterial: (operationId, material) => device.registerMaterial(operationId, material),
        unregisterMaterial: registrationId => device.releaseEncryptedUploadV2Material!(registrationId),
        signal: scopedBackendOptions.signal, checkScope: scopedBackendOptions.checkScope });
      const constructedManagedBackend = managedBackend;
      constructionCleanups.push(() => constructedManagedBackend.dispose());
      byoBackend = createJsByoEffects({ core, files: ports.files, persistence: ports.persistence,
        fetch: backendOptions.fetch, uploadFile: options.uploadFile, openSocket: options.openSocket,
        randomBytes: length => ports.randomBytes(length),
        requestCredentials: (operationId, signal) => scalarBackend.requestCredentials(operationId, signal),
        withDevice: (value, operationId, live, signal, body) => device.withByoDevice(value, operationId, live, signal, body),
        onCleanupFailure: error => device.markCleanupFailed(error),
        signal: scopedBackendOptions.signal, checkScope: scopedBackendOptions.checkScope });
      const constructedByoBackend = byoBackend;
      constructionCleanups.push(() => constructedByoBackend.dispose());
    }
    device.destroy = async () => {
      let failure: unknown;
      const stopped = await Promise.allSettled([destroyDevice(), byoBackend?.dispose(), bluetoothState.dispose()]);
      for (const result of stopped) if (result.status === 'rejected') failure ??= result.reason;
      try { await managedBackend?.dispose(); } catch (error) { failure ??= error; }
      try { await scalarBackend?.dispose(); } catch (error) { failure ??= error; }
      if (runtime) setCompatibilityUploadPolicy(runtime.sdk.recordings, undefined);
      core.dispose();
      if (failure) throw failure;
    };
    const backend = scalarBackend ? { ...scalarBackend, ...managedBackend, ...byoBackend } : null;
    runtime = createBotaReactNativeRuntime({ apiVersion: BOTA_RUNTIME_API_VERSION,
      device, encryptedUploadBackend: backend }, { ...options, generatedPolicy: { reconnect,
        planReconnect(attempt, retryable) {
          return codecPolicy('planForegroundReconnect', { policy: reconnect, attempt, retryable }).retryMs as number | null;
        } } });
    setCompatibilityUploadPolicy(runtime.sdk.recordings, codecPolicy);
    setCompatibilityBluetoothState(runtime.sdk, bluetoothState);
    return { ...runtime,
      readEncryptedUploadV2AuthNonce: operationId => device.readNonce(operationId),
      registerEncryptedUploadV2Material: (operationId, material) => device.registerMaterial(operationId, material),
      releaseEncryptedUploadV2Material: registrationId => device.releaseEncryptedUploadV2Material!(registrationId),
      createUploadRecoveryProvider: openBackend => createUploadRecoveryProvider(openBackend, codecPolicy),
    };
  } catch (error) {
    if (constructionCleanups.length) {
      void Promise.allSettled(constructionCleanups.map(cleanup => Promise.resolve().then(cleanup)))
        .finally(() => core.dispose());
    }
    else core.dispose();
    throw error;
  }
}

/** Portable TypeScript runtime. No OS APIs, native registry or package-version equality. */
export function createBotaReactNativeRuntime(
  adapter: BotaReactNativeAdapter,
  options: Parameters<typeof createBotaDeviceSDK>[1] = {},
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

export type { FindDeviceCapabilities, FindDeviceStatus, FindDeviceRequest } from './findDevice';
