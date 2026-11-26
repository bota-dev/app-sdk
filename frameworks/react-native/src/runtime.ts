import { BotaJsHostError } from './jsHost/executor';
export type { RegulatoryCapabilities, RegulatoryDelivery, RegulatoryReceipt } from './regulatory';
export type { CountryConfigurationDelivery, CountryConfigurationResult } from './countryConfiguration';
import { backgroundBleOwners, statusInterruptions } from './compatibility/runtime';
import { createBotaDeviceSDK, mapConnectedDevice } from './client';
import type { BotaDeviceSDKClient } from './client';
import { createBotaClient } from './BotaClient';
import { createManagedEncryptedUploadV2Backend } from './encryptedUploadV2Backend';
import type { EncryptedUploadV2BackendOptions, EncryptedUploadV2Backend } from './encryptedUploadV2Backend';
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
import type { JsRecordingUploadTarget } from './jsHost/recordingUploads';
import { validateJsHostPorts, BOTA_JS_HOST_PORT_API_VERSION } from './jsHost/ports';
import { setCompatibilityUploadPolicy } from './managers/NativeUploadQueue';
import { createUploadRecoveryProvider } from './uploadRecovery';
import { createJsBluetoothState } from './jsHost/bluetoothState';
import { setCompatibilityBluetoothState } from './compatibility/bluetoothState';

export { createBackgroundBleSession } from './backgroundBleSession';
export { createBlePlxPort } from './jsHost/blePlx';
export { createSecureBlePlxPort } from './jsHost/bleSecurity';
export type { BleBondingBridge, BleLinkSecurityOptions } from './jsHost/bleSecurity';
export { isEmptyLegacyAndroidV2CheckpointCatalog } from './jsHost/legacyStorage';
export { UPLOAD_RECOVERY_VERSION, RECORDING_TRANSFER_RETRY_VERSION } from './uploadRecovery';
export { deriveSyncStatus } from './sync/syncStatus';
export type { SyncChannel, SyncKind, SyncStatus, SyncStatusInputs } from './sync/syncStatus';
export { readClientPresenceObservation } from './clientPresence';
export type { ClientPresence, SdkClientContext } from './clientPresence';
export type { BlePlxManager } from './jsHost/blePlx';
export type { JsBackendFetch, JsUploadBackendOptions } from './jsHost/backend';
export type { JsV2Fetch, JsV2UploadTarget } from './jsHost/uploadBackendV2';
export type { JsEncryptedUploadV2Material } from './jsHost/encryptedUploadV2';
export type { JsRecordingUploadTarget } from './jsHost/recordingUploads';
export type { JsLocalWifiPort, JsLocalWifiMaterial, JsLocalWifiLease, JsLocalWifiReader } from './jsHost/localWifi';
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
  createProtectedStreamingStatusBackend(configuration: ProtectedStreamingStatusBackendOptions): ProtectedStreamingStatusBackend;
}

export interface BotaReactNativeJsRuntimeOptions {
  /** Host provides bluetooth-central or a connectedDevice service for the bound session. */
  backgroundBle?: {
    setActive(active: boolean): void;
    /** Optional native backoff after a terminal, retryable connection error.
     * setActive(false) must release a pending delay. */
    waitToRetry?(delayMs: number, signal?: AbortSignal): Promise<void>;
    isAvailable?(): boolean;
    canRecover?(): boolean;
  };
  /** Exact authenticated binding metadata; only BOTA_DEV may fall back to this Rust-validated model. */
  resolveBoundDeviceModel?: JsDeviceAdapterOptions['resolveBoundDeviceModel'];
  reconnect?: BotaReconnectPolicy;
  firmwareRecovery?: BotaFirmwareRecoveryPolicy;
  backend?: Omit<JsUploadBackendOptions, 'fetch'> & { fetch?: JsV2Fetch };
  /** Generic HTTP effects supplied by installed host libraries. */
  upload?: JsDeviceAdapterOptions['upload'];
  uploadFile?: (target: JsRecordingUploadTarget, file: OpaqueHostHandle, context: JsHostContext,
    progress?: (completedBytes: string, totalBytes: string) => void) => Promise<void>;
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
    const device = createJsDeviceAdapter(core, ports, { upload: options.upload,
      backgroundReconnect: () => options.backgroundBle?.isAvailable?.() ?? !!options.backgroundBle,
      onStatusInterrupted(id, error) {
        if (runtime) for (const notify of statusInterruptions.get(runtime.sdk) ?? []) notify(id, error);
      },
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

    }
    device.destroy = async () => {
      let failure: unknown;
      const stopped = await Promise.allSettled([destroyDevice(), bluetoothState.dispose()]);
      for (const result of stopped) if (result.status === 'rejected') failure ??= result.reason;
      try { await managedBackend?.dispose(); } catch (error) { failure ??= error; }
      try { await scalarBackend?.dispose(); } catch (error) { failure ??= error; }
      if (runtime) setCompatibilityUploadPolicy(runtime.sdk.recordings, undefined);
      core.dispose();
      if (failure) throw failure;
    };
    const backend = scalarBackend ? { ...scalarBackend, ...managedBackend } : null;
    runtime = createBotaReactNativeRuntime({ apiVersion: BOTA_RUNTIME_API_VERSION,
      device, encryptedUploadBackend: backend }, { ...options, generatedPolicy: { reconnect,
        planReconnect(attempt, retryable) {
          return codecPolicy('planForegroundReconnect', { policy: reconnect, attempt, retryable }).retryMs as number | null;
        } } });
    setCompatibilityUploadPolicy(runtime.sdk.recordings, codecPolicy);
    setCompatibilityBluetoothState(runtime.sdk, bluetoothState);
    const background = options.backgroundBle;
    if (background) {
      const waitForRetry = async (error: unknown, attempt: number, signal: AbortSignal, status = false) => {
        if (signal.aborted) throw error;
        const cause = error as { code?: string; errorCode?: number; retryable?: boolean } | null;
        // Map link errors reported by BLE PLX during post-link GATT operations.
        const radio = [3, 200, 201, 205].includes(cause?.errorCode ?? -1);
        const code = cause?.code ?? (radio ? 'connection_failed' : status ? 'status_subscription_failed' : 'unknown');
        const retryable = cause?.retryable ?? (radio || code === 'status_subscription_failed' || code === 'operation_in_progress');
        const { retryMs } = codecPolicy('planBoundReconnect', { code, retryable, attempt, platform: ports.platform });
        if (typeof retryMs !== 'number' || (retryMs > 0 && !background.waitToRetry)) throw error;
        if (retryMs > 0) await background.waitToRetry!(retryMs, signal);
        if (signal.aborted) throw error;
      };
      backgroundBleOwners.set(runtime.sdk, {
        setActive: background.setActive, canRecover: background.canRecover, waitForRetry,
        async connect(serial, id, signal) {
          for (let attempt = 1; !signal.aborted; attempt++) {
            try { return mapConnectedDevice(await device.reconnectKnown(serial, id, signal)); }
            catch (error) { await waitForRetry(error, attempt, signal); }
          }
          throw new BotaJsHostError('operation_cancelled', 'Connect');
        },
      });
    }
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
    createProtectedStreamingStatusBackend: (configuration: ProtectedStreamingStatusBackendOptions) =>
      createManagedProtectedStreamingStatusBackend(backend, configuration),
  };
}

export type { FindDeviceCapabilities, FindDeviceStatus, FindDeviceRequest } from './findDevice';

export { createNativeLocalWifiPort } from './jsHost/nativeLocalWifi';
export type { NativeLocalWifiTransport, NativeLocalWifiOptions } from './jsHost/nativeLocalWifi';

/** Mandatory local-control AEAD profile supported by this exact SDK. */
export const LOCAL_WIFI_CONTROL_PROFILE = 2;
export { createRecordingEditClient } from './recordingEdits';
export type { RecordingEditFile, RecordingEditSource, RecordingEditRequest, RecordingEditStatus, RecordingEditJournal, RecordingEditHost } from './recordingEdits';
