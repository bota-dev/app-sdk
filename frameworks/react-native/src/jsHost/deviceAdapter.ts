import type {
  NativeConnectedDevice, NativeDiscoveredDevice, NativeDeviceRecording, NativeReconnectOptions,
  NativeEncryptedUploadV2ProfileDecision, NativeEncryptedUploadV2Recording, NativeStreamingUploadDestination,
} from '../specs/NativeBotaDeviceSDK';
import { publicDeviceType } from '../deviceModel';
import { SDK_PACKAGE, SDK_VERSION } from '../sdkIdentity';
import type { BotaDeviceAdapter } from '../runtimeAdapter';
import type { BotaJsHostPorts, GattAddress, JsHostContext, JsHostSubscription, JsValue, RawJsCoreFactory } from './contracts';
import { BotaJsHostExecutor, BotaJsHostError } from './executor';
import { JsDeviceControls } from './deviceControls';
import type { JsControlConnection, ResolveBoundDeviceModel } from './deviceControls';
import { JsFileEffects } from './fileEffects';
import { JsEncryptedUploadV2Catalog, JsEncryptedUploadV2Host, JsUploadContextExchange } from './encryptedUploadV2';
import type { JsEncryptedUploadV2Material } from './encryptedUploadV2';
import { JsMaterialEffects } from './materialEffects';
import { JsStreamingEffects } from './streamingEffects';
import { validateJsHostPorts } from './ports';
import { JsByoBleLink } from './byoEffects';
import type { JsByoDeviceLink } from './byoEffects';
import { JsRecordingUploads } from './recordingUploads';
import type { JsRecordingUploadTarget } from './recordingUploads';
import type { JsV2Fetch } from './uploadBackendV2';
import type { OpaqueHostHandle } from './contracts';
declare const performance: { now(): number };

export interface JsDeviceAdapterOptions {
  resolveBoundDeviceModel?: ResolveBoundDeviceModel;
  fetch?: JsV2Fetch;
  uploadFile?(target: JsRecordingUploadTarget, file: OpaqueHostHandle, context: JsHostContext,
    progress?: (completedBytes: string, totalBytes: string) => void): Promise<void>;
  /** May shorten the shared core's post-verification recovery deadline. */
  firmwareRecoveryTimeoutMs?: number;
  upload?(destination: Readonly<NativeStreamingUploadDestination>, body: Uint8Array, context: JsHostContext): Promise<void>;
  /** Joins captured provider jobs, including an already submitted POST after cancellation. */
  drainMaterial?(operationId: string, context: JsHostContext): Promise<void>;
}
export type JsDeviceAdapter = BotaDeviceAdapter & {
  readNonce(operationId: string): Promise<string>;
  registerMaterial(operationId: string, material: JsEncryptedUploadV2Material): string;
  context(operationId: string, signal?: AbortSignal): JsHostContext;
  profileContext(operationId: string, signal?: AbortSignal): JsHostContext;
  checkOperation(operationId: string): void;
  markCleanupFailed(error: unknown): void;
  withByoDevice<T>(device: JsValue, operationId: string, live: boolean, signal: AbortSignal,
    body: (context: JsHostContext, link: JsByoDeviceLink) => Promise<T>): Promise<T>;
};
interface OperationLease {
  device: NativeConnectedDevice;
  physicalGeneration: string;
  scope: string;
  context?: JsHostContext;
  cancelled: boolean;
  providerDrained?: boolean;
}
interface ProfileRequest {
  operationId: string;
  lease: OperationLease;
  resolve(value: NativeEncryptedUploadV2ProfileDecision): void;
  reject(error: unknown): void;
}
interface QueuedControl {
  name: string;
  args: readonly unknown[];
  owner: JsDeviceControls;
  connection: JsControlConnection | null;
  epoch: number;
  namespace: string;
  body?: (context: JsHostContext) => Promise<unknown>;
  workflow?: { operationId: string; start(): Promise<void> };
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const controls = [
  'readStatus', 'isProvisioned', 'readPublicKey', 'readAuthNonce', 'setApiEndpoint',
  'deliverCertificate', 'deliverBackendPublicKey', 'writeGrant', 'syncTime',
  'requestStartRecording', 'requestStopRecording', 'readRecordingState',
  'readFindChallenge', 'readFindBindingChallenge', 'confirmFindBinding', 'readFindCapabilities', 'readFindStatus', 'requestFindDevice',
  'startRecordingStateUpdates', 'stopRecordingStateUpdates', 'configureWiFi', 'disconnectWiFi',
  'readConnectionSettings', 'writeConnectionSettings', 'readWiFiStatus', 'scanWiFiNetworks',
  'startStatusUpdates', 'stopStatusUpdates', 'startWiFiStatusUpdates', 'stopWiFiStatusUpdates',
  'startDeviceLogs', 'stopDeviceLogs',
  'readDiagnosticEvents', 'acknowledgeDiagnosticEvents',
] as const;
const eventNames = [
  'onDeviceDiscovered', 'onDeviceDisconnected', 'onDeviceStatusUpdated', 'onRecordingStateUpdated',
  'onProvisioningMaterialRequested', 'onFactoryResetGrantRequested', 'onFactoryResetResultPersistenceRequested',
  'onRecordingTransferProgress', 'onEncryptedUploadV2ProfileRequested', 'onEncryptedUploadV2Progress',
  'onRecordingUploadProgress', 'onStreamingProgress', 'onStreamingChunkDestinationRequested',
  'onStreamingFinalizeRequested', 'onUploadOwnershipProgress', 'onFirmwareUpdateProgress',
  'onDeviceLog', 'onWiFiStatusUpdated',
] as const;

/** Compatibility API mapping. All workflows execute the generated core over primitive ports. */
export function createJsDeviceAdapter(core: RawJsCoreFactory, ports: BotaJsHostPorts,
  options: JsDeviceAdapterOptions = {}): JsDeviceAdapter {
  validateJsHostPorts(ports);
  const executor = new BotaJsHostExecutor(core, ports);
  let connection: JsControlConnection | null = null;
  let connectionGeneration = 0n;
  let configured = false;
  let destroyed = false;
  let closing = false;
  let disconnecting = false;
  let controlEpoch = 0;
  const controlQueue: QueuedControl[] = [];
  let activeControl: { operationId?: string; workflow?: boolean; settled: Promise<void> } | undefined;
  let destroyPromise: Promise<void> | undefined;
  let scanPromise: Promise<unknown> | undefined;
  let disconnectObserver: JsHostSubscription | undefined;
  let presenceSequence = 0;
  let presenceSession = '';
  let registration = 0n;
  let firmwareOperation: { controller: AbortController; work: Promise<void> } | undefined;
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const operationLeases = new Map<string, OperationLease>();
  const profiles = new Map<string, ProfileRequest>();
  const materials = new Map<string, { operationId: string; material: JsEncryptedUploadV2Material }>();
  const v2Hosts = new Map<string, JsEncryptedUploadV2Host>();
  const retiredPhysicalGenerations = new Set<string>();
  let byoReservation: { operationId: string; selectedLive: boolean } | undefined;
  let recordingUploads: JsRecordingUploads | undefined;
  let recordingContext: ((operation: string, operationId: string) => Promise<JsHostContext>) | undefined;
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  let deviceControls = new JsDeviceControls({ ports, core, connection: () => connection,
    resolveBoundDeviceModel: options.resolveBoundDeviceModel,
    emit, gatt: (context, body) => executor.gatt(context, body),
    onCleanupFailure: error => executor.markCleanupFailed(error) });
  const fileEffects = ports.files ? new JsFileEffects(ports.files, ports.persistence.namespace,
    handle => recordingUploads?.acquireWritable(handle) ?? (() => {})) : undefined;
  const checkLease = (lease: OperationLease, operation: string) => {
    if (connection?.generation !== lease.physicalGeneration || connection.device.id !== lease.device.id ||
        connection.device.serialNumber !== lease.device.serialNumber || ports.persistence.namespace !== lease.scope ||
        ports.signal?.aborted || destroyed) throw new BotaJsHostError('identity_mismatch', operation);
    ports.checkScope?.();
  };
  const checkWorkflowOwner = (context: JsHostContext, serialNumber: string) => {
    executor.check(context);
    const lease = operationLeases.get(context.operationId);
    if (!lease || lease.device.serialNumber !== serialNumber) throw new BotaJsHostError('stale_host_owner', context.operation);
    checkLease(lease, context.operation);
    lease.context = context;
  };
  const materialEffects = new JsMaterialEffects({ core, emit, checkOwner: checkWorkflowOwner });
  executor.registerHandler('HostMaterial', materialEffects.handler);
  const streamingEffects = ports.files && options.upload ? new JsStreamingEffects({ core, files: ports.files,
    namespace: ports.persistence.namespace, emit, checkOwner: checkWorkflowOwner, upload: options.upload }) : undefined;
  if (fileEffects) {
    executor.registerHandler('RecordingSink', streamingEffects ? streamingEffects.recordingSink(fileEffects.recordingSink) : fileEffects.recordingSink);
    executor.registerHandler('FirmwareBlob', fileEffects.firmwareBlob);
  }
  executor.registerHandler('EncryptedUploadV2', (effect, context) => {
    const host = v2Hosts.get(context.operationId);
    if (!host) throw new BotaJsHostError('missing_primitive:EncryptedUploadV2', context.operation);
    return host.handle(effect, context);
  });
  const ready = () => {
    if (!configured || destroyed || closing) throw new BotaJsHostError('not_configured', 'Configure');
  };
  const captured = (device?: NativeConnectedDevice): NativeConnectedDevice => {
    ready();
    if (!connection) throw new BotaJsHostError('not_connected', 'Connect');
    if (device && (device.id !== connection.device.id || device.serialNumber !== connection.device.serialNumber)) {
      throw new BotaJsHostError('identity_mismatch', 'Connect');
    }
    return connection.device;
  };
  const direct = <T>(operation: string, body: (context: JsHostContext) => Promise<T>) => {
    ready();
    return executor.direct(operation, body);
  };
  const cancelQueuedControls = (code = 'operation_cancelled') => {
    controlEpoch++;
    for (const queued of controlQueue.splice(0)) queued.reject(new BotaJsHostError(code, queued.name));
  };
  const scopeChanged = () => cancelQueuedControls('scope_changed');
  ports.signal?.addEventListener('abort', scopeChanged, { once: true });
  const checkQueuedControl = (queued: QueuedControl) => {
    ready();
    if (disconnecting || queued.epoch !== controlEpoch) throw new BotaJsHostError('operation_cancelled', queued.name);
    if (queued.owner !== deviceControls || queued.namespace !== ports.persistence.namespace ||
        queued.connection?.generation !== connection?.generation ||
        queued.connection?.device.id !== connection?.device.id ||
        queued.connection?.device.serialNumber !== connection?.device.serialNumber) {
      throw new BotaJsHostError('identity_mismatch', queued.name);
    }
    executor.checkControlAdmission(queued.name);
  };
  const pumpControls = () => {
    while (!activeControl && controlQueue.length) {
      const queued = controlQueue.shift()!;
      try { checkQueuedControl(queued); }
      catch (error) { queued.reject(error); continue; }
      const work = queued.workflow ? queued.workflow.start()
        : executor.direct(queued.name, context => queued.body ? queued.body(context)
          : queued.owner.execute(queued.name, queued.args, context));
      const active = { operationId: executor.activeOperationId, workflow: queued.workflow !== undefined, settled: Promise.resolve() };
      activeControl = active;
      active.settled = work.then(queued.resolve, queued.reject).then(() => {
        if (activeControl === active) activeControl = undefined;
        pumpControls();
      });
    }
  };
  const queueControl = async (name: string, args: readonly unknown[],
    body?: (context: JsHostContext) => Promise<unknown>): Promise<unknown> => {
    ready();
    if (disconnecting) throw new BotaJsHostError('operation_cancelled', name);
    executor.checkControlAdmission(name, activeControl?.operationId);
    if (controlQueue.length >= 32) throw new BotaJsHostError('operation_in_progress', name);
    const owner = deviceControls;
    const physical = connection ? { device: { ...connection.device }, generation: connection.generation } : null;
    if (!physical && !name.startsWith('stop')) throw new BotaJsHostError('not_connected', name);
    // No caller-owned object may retarget a queued device, settings frame or grant.
    const capturedArgs = args.map(value => value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown);
    return new Promise((resolve, reject) => {
      controlQueue.push({ name, args: capturedArgs, body, owner, connection: physical, epoch: controlEpoch,
        namespace: ports.persistence.namespace, resolve, reject });
      pumpControls();
    });
  };
  const queueWorkflow = (operationId: string, start: () => Promise<void>): Promise<void> => {
    ready();
    if (disconnecting) throw new BotaJsHostError('operation_cancelled', 'TransferRecording');
    executor.checkControlAdmission('TransferRecording', activeControl?.operationId);
    if (activeControl?.workflow || controlQueue.some(queued => queued.workflow) || controlQueue.length >= 32) {
      throw new BotaJsHostError('operation_in_progress', 'TransferRecording');
    }
    return new Promise((resolve, reject) => {
      controlQueue.push({ name: 'TransferRecording', args: [], owner: deviceControls,
        connection: connection ? { device: { ...connection.device }, generation: connection.generation } : null,
        epoch: controlEpoch, namespace: ports.persistence.namespace,
        workflow: { operationId, start }, resolve() { resolve(); }, reject });
      pumpControls();
    });
  };
  const metadata = object(core.codec('protocolMetadata', {}));
  const address = (device: NativeConnectedDevice, service: string, characteristic: string): GattAddress => ({
    peripheralId: device.id, serviceUuid: text(metadata[service]), characteristicUuid: text(metadata[characteristic]),
  });
  const closeControls = async (context: JsHostContext) => {
    await deviceControls.close(context);
    deviceControls = new JsDeviceControls({ ports, core, connection: () => connection,
      resolveBoundDeviceModel: options.resolveBoundDeviceModel,
      emit, gatt: (lease, body) => executor.gatt(lease, body),
      onCleanupFailure: error => executor.markCleanupFailed(error) });
  };
  const clearConnection = async (context: JsHostContext) => {
    await closeControls(context);
    try { await disconnectObserver?.remove(); } catch (error) { executor.markCleanupFailed(error); throw error; }
    disconnectObserver = undefined;
    const device = connection?.device;
    if (device) {
      await executor.gatt(context, () => ports.ble.disconnect(device.id, context));
      retiredPhysicalGenerations.add(connection!.generation);
      executor.didDisconnect(device.id);
    }
    connection = null;
    presenceSession = '';
    connectionGeneration++;
    return device !== undefined;
  };
  const adoptConnection = (initial: NativeConnectedDevice, operation: string,
    expectedVersion?: string, signal?: AbortSignal): Promise<NativeConnectedDevice> =>
    executor.direct(operation, async context => {
      const generation = (++connectionGeneration).toString();
      try {
        // These monitors belonged to the earlier physical connection. Close their
        // captured subscriptions without issuing commands to that departed link.
        await deviceControls.close();
        try { await disconnectObserver?.remove(); } catch (error) { executor.markCleanupFailed(error); throw error; }
        disconnectObserver = undefined;
        deviceControls = new JsDeviceControls({ ports, core, connection: () => connection,
          resolveBoundDeviceModel: options.resolveBoundDeviceModel,
          emit, gatt: (lease, body) => executor.gatt(lease, body),
          onCleanupFailure: error => executor.markCleanupFailed(error) });
        connection = { device: initial, generation };
        presenceSession = '';
        const identity = await deviceControls.execute('readIdentity', [initial], context) as Partial<NativeConnectedDevice>;
        if (identity.serialNumber !== initial.serialNumber ||
            (expectedVersion !== undefined && identity.firmwareVersion !== expectedVersion)) {
          throw new BotaJsHostError('identity_mismatch', operation);
        }
        const mtu = ports.ble.getMtu ? await executor.gatt(context, () => ports.ble.getMtu!(initial.id, context)) : 23;
        if (!Number.isInteger(mtu) || mtu < 23 || mtu > 517) throw new BotaJsHostError('invalid_mtu', operation);
        const adoption = object(core.codec('planConnectionAdoption', {}));
        if (adoption.initializeTimeSync === true) {
          try { await deviceControls.execute('syncTime', [initial], context); }
          catch (error) {
            executor.check(context);
            if (adoption.continueOnTimeSyncFailure !== true) throw error;
          }
        }
        const provisioned = await deviceControls.execute('isProvisioned', [initial], context) as boolean;
        const wifiUpload = ports.ble.hasService
          ? await executor.gatt(context, () => ports.ble.hasService!(initial.id, text(metadata.SERVICE_BOTA_WIFI_CONFIG), context))
          : false;
        const device = { ...initial, ...identity, mtu, isProvisioned: provisioned,
          capabilities: { bleSync: true, wifiUpload, lteUpload: identity.deviceType === 'bota_pin_4g', remoteRecord: true } };
        const random = await ports.randomBytes(16);
        if (!(random instanceof Uint8Array) || random.length !== 16) throw new BotaJsHostError('invalid_entropy', operation);
        const session = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
        if (ports.ble.observeDisconnect) disconnectObserver = await ports.ble.observeDisconnect(device.id, error => {
          if (connection?.generation !== generation) return;
          cancelQueuedControls();
          retiredPhysicalGenerations.add(generation);
          connection = null;
          presenceSession = '';
          connectionGeneration++;
          void deviceControls.close().catch(() => {});
          void executor.peripheralDisconnected(device.id).catch(failure => executor.markCleanupFailed(failure));
          emit('onDeviceDisconnected', error ? { error } : {});
        }, context);
        executor.check(context);
        if (connection?.generation !== generation || executor.connectedPeripheralId !== initial.id) {
          throw new BotaJsHostError('identity_mismatch', operation);
        }
        connection = { device, generation };
        presenceSession = session;
        presenceSequence = 0;
        return device;
      } catch (error) {
        const cleanup = { ...context, signal: new AbortController().signal };
        try { await disconnectObserver?.remove(); disconnectObserver = undefined; }
        catch (failure) { executor.markCleanupFailed(failure); }
        if (executor.connectedPeripheralId === initial.id) {
          try {
            await executor.gatt(cleanup, () => ports.ble.disconnect(initial.id, cleanup));
            executor.didDisconnect(initial.id);
          } catch (failure) { executor.markCleanupFailed(failure); }
        }
        connection = null;
        presenceSession = '';
        connectionGeneration++;
        throw error;
      }
    }, { ...(signal ? { signal } : {}) });
  const establish = async (command: JsValue, operation: 'Connect' | 'Reconnect'): Promise<NativeConnectedDevice> => {
    ready();
    if (connection) {
      const retired = await direct('Disconnect', clearConnection);
      if (retired) emit('onDeviceDisconnected', {});
    }
    const result = await executor.run(command, { operation });
    const notification = result.notifications.map(value => object(value).ConnectionEstablished).find(value => value !== undefined);
    if (!notification) throw new BotaJsHostError('connection_not_verified', operation);
    const fields = object(notification);
    const candidate = object(fields.candidate!);
    const initial: NativeConnectedDevice = { id: text(candidate.peripheral_id), serialNumber: text(fields.device),
      deviceType: 'unknown', firmwareVersion: '', isProvisioned: false, connectionState: 'connected', mtu: 23 };
    return adoptConnection(initial, 'ReadIdentity');
  };
  const adapter: JsDeviceAdapter = {
    markCleanupFailed(error) { executor.markCleanupFailed(error); },
    async withByoDevice(value, operationId, live, signal, body) {
      const device = captured(value as unknown as NativeConnectedDevice);
      if (operationLeases.has(operationId)) throw new BotaJsHostError('operation_in_progress', 'ByoUpload');
      const lease: OperationLease = { device, physicalGeneration: connection!.generation,
        scope: ports.persistence.namespace, cancelled: false };
      operationLeases.set(operationId, lease);
      try {
        return await executor.direct('ByoUpload', async context => {
          lease.context = context;
          const check = (candidate: JsHostContext) => {
            executor.check(candidate);
            if (candidate.signal === context.signal) checkLease(lease, candidate.operation);
            else if (connection?.generation !== lease.physicalGeneration || connection.device.id !== device.id ||
                connection.device.serialNumber !== device.serialNumber) throw new BotaJsHostError('identity_mismatch', candidate.operation);
          };
          check(context);
          await deviceControls.execute('readIdentity', [device], context);
          check(context);
          const policy = object(core.codec('byoHostPolicy', { mode: live ? 'stream' : 'sync', selectedLive: live }));
          const exchange = new JsUploadContextExchange({ core, ports,
            peripheralId: device.id, maximumWriteBytes: device.mtu - 3, maximumSignedBlobBytes: safeNumber(policy.maximumSignedBlobBytes),
            gatt: (ctx, work) => executor.gatt(ctx, work), checkOwner: check,
            onCleanupFailure: error => executor.markCleanupFailed(error) });
          const link = new JsByoBleLink({ core, ble: ports.ble, peripheralId: device.id, maximumWriteBytes: device.mtu - 3,
            context, checkOwner: check, gatt: (ctx, work) => executor.gatt(ctx, work),
            refresh: (provider, ctx) => exchange.refresh(provider, ctx),
            onCleanupFailure: error => executor.markCleanupFailed(error),
            setLive: selectedLive => { if (byoReservation?.operationId === operationId) byoReservation.selectedLive = selectedLive; } });
          byoReservation = { operationId, selectedLive: live };
          let started = false;
          try { await link.start(); started = true; check(context); return await body(context, link); }
          finally {
            const cleanup = { ...context, signal: new AbortController().signal };
            let failure: unknown;
            try {
              if (started && !retiredPhysicalGenerations.has(lease.physicalGeneration)) await link.release(cleanup);
              else await link.close();
            } catch (error) { failure = error; executor.markCleanupFailed(error); }
            try { await exchange.close(); } catch (error) { failure ??= error; executor.markCleanupFailed(error); }
            if (byoReservation?.operationId === operationId) byoReservation = undefined;
            if (failure) throw failure;
          }
        }, { operationId, signal });
      } finally { operationLeases.delete(operationId); }
    },
    checkOperation(operationId) {
      const lease = operationLeases.get(operationId);
      if (!lease) throw new BotaJsHostError('stale_material_request', 'TransferRecording');
      if (lease.cancelled || lease.context?.signal.aborted) throw new BotaJsHostError('operation_cancelled', lease.context?.operation ?? 'TransferRecording');
      checkLease(lease, lease.context?.operation ?? 'TransferRecording');
    },
    context(operationId, signal) {
      const lease = operationLeases.get(operationId);
      if (!lease) throw new BotaJsHostError('stale_material_request', 'TransferRecording');
      if (signal) checkLease(lease, lease.context?.operation ?? 'TransferRecording');
      else adapter.checkOperation(operationId);
      const context = lease.context;
      if (!context) throw new BotaJsHostError('stale_material_request', 'TransferRecording');
      return signal ? Object.freeze({ ...context, signal }) : context;
    },
    profileContext(operationId, signal) { return adapter.context(operationId, signal); },
    async readNonce(operationId) {
      const context = adapter.context(operationId);
      executor.check(context);
      const value = await deviceControls.execute('readAuthNonce', [operationLeases.get(operationId)!.device], context);
      if (typeof value !== 'string') throw new BotaJsHostError('authorization_required', context.operation);
      return value;
    },
    registerMaterial(operationId, material) {
      const context = adapter.context(operationId);
      executor.check(context);
      const request = [...profiles.values()].find(value => value.operationId === operationId);
      if (!request || request.lease.cancelled) throw new BotaJsHostError('stale_material_request', context.operation);
      const id = `js-material/${++registration}`;
      materials.set(id, { operationId, material });
      return id;
    },
    async configure() { if (destroyed || closing) throw new BotaJsHostError('runtime_destroyed', 'Configure'); configured = true; },
    async getState() { return destroyed ? 'uninitialized' : configured ? 'ready' : 'uninitialized'; },
    async getCapabilities() { return { platform: ports.platform, bluetooth: true, nativeFileTransfer: false,
      backgroundScan: false, backgroundReconnect: false }; },
    async nextClientPresence(deviceId) {
      if (!connection || connection.device.id !== deviceId || !presenceSession) return null;
      return { schemaVersion: 1, sessionId: presenceSession, sequence: ++presenceSequence,
        platform: ports.platform, sdkPackage: SDK_PACKAGE, sdkVersion: SDK_VERSION };
    },
    async startScan(timeoutMs, allowDuplicates) {
      ready();
      let resolveStarted!: () => void;
      let rejectStarted!: (error: unknown) => void;
      const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      // Scan continues after the public start call, matching the subscription API.
      scanPromise = executor.run({ DiscoverDevices: { timeout_ms: String(timeoutMs), allow_duplicates: allowDuplicates } }, {
        operation: 'Discover', operationId: 'scan', onNotification(value) {
          if (object(value).Started) resolveStarted();
          const discovered = object(value).DeviceDiscovered;
          if (!discovered) return;
          const candidate = object(object(discovered).candidate!);
          const name = candidate.name ?? undefined;
          const advertised = ports.ble?.advertisementMetadata?.(text(candidate.peripheral_id));
          emit('onDeviceDiscovered', { id: text(candidate.peripheral_id), name,
            deviceType: publicDeviceType(advertised?.deviceType),
            rssi: candidate.rssi, macAddress: candidate.advertised_address ?? undefined, discoveredAtMs: Date.now() });
        },
      });
      void scanPromise.then(() => resolveStarted(), rejectStarted);
      await started;
    },
    async stopScan() { await executor.cancel('scan'); await scanPromise?.catch(() => {}); scanPromise = undefined; },
    connectSelected(device: NativeDiscoveredDevice) {
      return establish({ ConnectSelected: { candidate: { peripheral_id: device.id, name: device.name ?? null,
        advertised_address: device.macAddress ?? null, rssi: device.rssi } } }, 'Connect');
    },
    async reconnect(serialNumber: string, options: NativeReconnectOptions) {
      ready();
      const hint = await direct('LoadConnection', context => ports.persistence.load(`connection/${serialNumber}`, context));
      const candidate = hint ? object(object(hint).candidate!) : {};
      return establish({ Reconnect: { device: serialNumber, hint: {
        stored_peripheral_id: candidate.peripheral_id ?? null, advertised_address: candidate.advertised_address ?? null,
        stored_name: candidate.name ?? null, scan_timeout_ms: String(options.scanTimeoutMs),
        connection_timeout_ms: String(options.connectionTimeoutMs),
      } } }, 'Reconnect');
    },
    async disconnect() {
      disconnecting = true;
      cancelQueuedControls();
      try {
        const active = executor.activeOperationId;
        if (active) await executor.cancel(active);
        await activeControl?.settled;
        await direct('Disconnect', clearConnection);
        emit('onDeviceDisconnected', {});
      } finally { disconnecting = false; }
    },
    destroy() {
      closing = true;
      cancelQueuedControls();
      if (!destroyPromise) destroyPromise = (async () => {
        let failure: unknown;
        const active = executor.activeOperationId;
        const stopped = await Promise.allSettled([active ? executor.cancel(active) : Promise.resolve(), recordingUploads?.close()]);
        for (const result of stopped) if (result.status === 'rejected') failure ??= result.reason;
        await activeControl?.settled;
        try { await deviceControls.close(); } catch (error) { failure ??= error; }
        try { await disconnectObserver?.remove(); } catch (error) { executor.markCleanupFailed(error); failure ??= error; }
        try { await executor.destroy(); } catch (error) { failure ??= error; }
        connection = null;
        presenceSession = '';
        destroyed = true;
        configured = false;
        listeners.clear();
        ports.signal?.removeEventListener('abort', scopeChanged);
        if (failure) throw failure;
      })();
      return destroyPromise;
    },
    async listRecordings(device) {
      captured(device);
      return direct('ListRecordings', async context => {
        await deviceControls.execute('readIdentity', [device], context);
        const value = await response(context, address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_RECORDING_LIST'),
          () => executor.gatt(context, () => ports.ble.write(address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_TRANSFER_CONTROL'),
            packet(core.codec('encodeRecordingListCommand', {})), true, context)));
        const entries = core.codec('decodeRecordingList', { bytes: Array.from(value) }) as readonly JsValue[];
        return entries as unknown as NativeDeviceRecording[];
      });
    },
    async confirmRecording(device, recordingUuid) {
      captured(device);
      await direct('ConfirmRecording', async context => {
        await deviceControls.execute('readIdentity', [device], context);
        await executor.gatt(context, () => ports.ble.write(address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_TRANSFER_CONTROL'),
          packet(core.codec('encodeRecordingConfirm', { recordingUuid })), true, context));
      });
    },
    async loadCompatibilityUploadQueue() {
      if (recordingUploads && recordingContext) return recordingUploads.loadQueue(await recordingContext('LoadUploadQueue', 'upload-queue'));
      return direct('LoadUploadQueue', async context => {
        if (recordingUploads) return recordingUploads.loadQueue(context);
        const value = await ports.persistence.load('compatibility/upload-queue', context);
        executor.check(context);
        return JSON.stringify(core.codec('sanitizeCompatibilityUploadQueue', { tasks: value ?? [] }));
      });
    },
    async saveCompatibilityUploadQueue(serialized) {
      if (recordingUploads && recordingContext) return recordingUploads.saveQueue(serialized, await recordingContext('SaveUploadQueue', 'upload-queue'));
      await direct('SaveUploadQueue', async context => {
        if (recordingUploads) return recordingUploads.saveQueue(serialized, context);
        const value = core.codec('sanitizeCompatibilityUploadQueue', { tasks: JSON.parse(serialized) as JsValue });
        await ports.persistence.save('compatibility/upload-queue', value, context);
        executor.check(context);
        const readback = await ports.persistence.load('compatibility/upload-queue', context);
        executor.check(context);
        if (JSON.stringify(core.codec('sanitizeCompatibilityUploadQueue', { tasks: readback ?? [] })) !== JSON.stringify(value)) {
          throw new BotaJsHostError('persistence_failed', context.operation);
        }
      });
    },
    async stopAllRecordingOperations() {
      const active = executor.activeOperationId;
      const stopped = await Promise.allSettled([active ? executor.cancel(active) : Promise.resolve(), recordingUploads?.cancelAll()]);
      for (const result of stopped) if (result.status === 'rejected') throw result.reason;
    },
    async observeUploadOwnership(device, request) {
      captured(device);
      const result = await executor.run({ UploadRecording: { device: device.serialNumber, recording: uuidBytes(request.recordingUuid),
        upload_id: request.uploadId, destination_id: request.destinationId } }, { operation: 'Upload',
        onProgress(completed, total) { emit('onUploadOwnershipProgress', { completedUnits: safeNumber(completed), totalUnits: safeNumber(total) }); } });
      for (const notification of result.notifications) {
        const fields = object(notification);
        if (fields.DeviceUploadPreserved) return { kind: 'device_upload_preserved', uploadId: request.uploadId };
        if (fields.BleFallbackReady) return { kind: 'bluetooth_fallback', recordingUuid: request.recordingUuid,
          uploadId: request.uploadId, destinationId: request.destinationId };
      }
      if (result.notifications.some(value => object(value).Completed)) return { kind: 'device_upload_completed' };
      throw new BotaJsHostError('invalid_upload_result', 'Upload');
    },
  };
  for (const event of eventNames) {
    (adapter as Record<string, unknown>)[event] = (listener: (value: unknown) => void) => {
      const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(listener);
      return { remove() { set.delete(listener); } };
    };
  }
  for (const name of controls) (adapter as Record<string, unknown>)[name] = (...args: unknown[]) => {
    const reservation = byoReservation;
    if (reservation) {
      const policy = object(core.codec('byoHostPolicy', { mode: 'sync', selectedLive: reservation.selectedLive, control: name }));
      if (policy.allowControl === true) return executor.borrowDirect(reservation.operationId,
        context => deviceControls.execute(name, args, context));
    }
    return queueControl(name, args);
  };

  adapter.listPendingRecordings = async device => {
    device = { ...captured(device) };
    return queueControl('ListPendingRecordings', [], async context => {
      await deviceControls.execute('readIdentity', [device], context);
      const legacyValue = await response(context, address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_RECORDING_LIST'),
        () => executor.gatt(context, () => ports.ble.write(address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_TRANSFER_CONTROL'),
          packet(core.codec('encodeRecordingListCommand', {})), true, context)));
      const legacy = core.codec('decodeRecordingList', { bytes: Array.from(legacyValue) });
      const capabilityAddress = address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_STORAGE_TRANSFER_CAPABILITIES_V2');
      let value;
      try { value = await executor.gatt(context, () => ports.ble.read(capabilityAddress, context)); }
      catch (error) {
        const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        if (failure.code === 'characteristic_not_found' && failure.characteristicUuid === capabilityAddress.characteristicUuid &&
            failure.peripheralId === device.id) return core.codec('mergePendingRecordings', { legacy, encrypted: [] }) as unknown as
          Awaited<ReturnType<NonNullable<BotaDeviceAdapter['listPendingRecordings']>>>;
        throw error;
      }
      if (!(value instanceof Uint8Array)) throw new BotaJsHostError('invalid_capability_value', context.operation);
      core.codec('decodeEncryptedUploadV2Capabilities', { bytes: Array.from(value) });
      const physicalGeneration = connection!.generation;
      const catalog = new JsEncryptedUploadV2Catalog({ core, ports, peripheralId: device.id,
        checkOwner(lease) {
          executor.check(lease);
          if (connection?.generation !== physicalGeneration) throw new BotaJsHostError('identity_mismatch', lease.operation);
        }, gatt: (lease, body) => executor.gatt(lease, body),
        onCleanupFailure: error => executor.markCleanupFailed(error) });
      const result = object(await catalog.read(context, (++registration).toString()));
      if (!Array.isArray(result.entries)) throw new BotaJsHostError('invalid_catalog_result', context.operation);
      return core.codec('mergePendingRecordings', { legacy, encrypted: result.entries }) as unknown as
        Awaited<ReturnType<NonNullable<BotaDeviceAdapter['listPendingRecordings']>>>;
    }) as ReturnType<NonNullable<BotaDeviceAdapter['listPendingRecordings']>>;
  };
  adapter.resolveProvisioningMaterial = (requestId, value) => materialEffects.resolveProvisioningMaterial(requestId, value);
  adapter.resolveFactoryResetGrant = (requestId, value) => materialEffects.resolveFactoryResetGrant(requestId, value);
  adapter.resolveFactoryResetResultPersistence = requestId => materialEffects.resolveFactoryResetResultPersistence(requestId);
  adapter.rejectApplicationMaterial = (requestId, message) => materialEffects.rejectApplicationMaterial(requestId, message);
  adapter.provision = async device => {
    const operationId = `provision/${++registration}`;
    const lease = await prepareLease(device, operationId, 'VerifyProvisionIdentity');
    materialEffects.registerProvisioning(operationId, { serialNumber: device.serialNumber });
    try {
      checkLease(lease, 'Provision');
      await executor.run({ Provision: { device: device.serialNumber, material_id: operationId } }, { operation: 'Provision', operationId });
      if (connection?.generation === lease.physicalGeneration) connection = { ...connection,
        device: { ...connection.device, isProvisioned: true } };
    } finally { materialEffects.release(operationId); operationLeases.delete(operationId); }
  };
  adapter.deprovision = async (device, grantBlob) => {
    captured(device);
    return direct('Deprovision', async context => {
      await deviceControls.execute('readIdentity', [device], context);
      // The grant and canonical non-destructive opcode share the captured command lane.
      const result = await response(context, address(device, 'SERVICE_BOTA_PROVISIONING', 'CHAR_PROVISIONING_RESULT'), async () => {
        await deviceControls.execute('writeGrant', [device, grantBlob], context);
        await executor.gatt(context, () => ports.ble.write(address(device, 'SERVICE_BOTA_CONTROL', 'CHAR_DEVICE_COMMAND'),
          packet(core.codec('encodeDeprovisionCommand', {})), true, context));
      });
      return core.codec('decodeDeprovisionResult', { bytes: Array.from(result) }) as unknown as
        Awaited<ReturnType<NonNullable<BotaDeviceAdapter['deprovision']>>>;
    });
  };
  adapter.factoryReset = async (device, commandId, bindingGeneration, applicationPersistence) => {
    const operationId = `factory-reset/${++registration}`;
    const lease = await prepareLease(device, operationId, 'VerifyFactoryResetIdentity');
    try {
      await direct('VerifyFactoryResetJournal', async context => {
        checkLease(lease, context.operation);
        const journal = validateResetJournal(await ports.persistence.load(resetOwnerKey(device), context), device, bindingGeneration);
        if (journal !== null && object(journal).commandId !== commandId) throw new BotaJsHostError('stable_identity_mismatch', 'FactoryReset');
      });
      materialEffects.registerFactoryReset(operationId, { serialNumber: device.serialNumber, commandId, bindingGeneration });
      await executor.run({ FactoryReset: { device: device.serialNumber, command_id: commandId, grant_id: operationId } }, {
        operation: 'FactoryReset', operationId,
        beforeFactoryResetReceipt: (result, context) => saveResetOwner(device, commandId, bindingGeneration, result, context, applicationPersistence),
      });
      await clearResetOwner(device, commandId, bindingGeneration, lease);
      return { commandId, bindingGeneration };
    } finally { materialEffects.release(operationId); operationLeases.delete(operationId); }
  };
  adapter.resumePendingFactoryReset = async (device, bindingGeneration, applicationPersistence) => {
    const operationId = `resume-reset/${++registration}`;
    const lease = await prepareLease(device, operationId, 'VerifyFactoryResetIdentity');
    try {
      const journal = await direct('LoadFactoryResetJournal', async context => {
        checkLease(lease, context.operation);
        return validateResetJournal(await ports.persistence.load(resetOwnerKey(device), context), device, bindingGeneration);
      });
      if (journal === null && !applicationPersistence) return null;
      const commandId = journal === null ? `rn-resume/${registration}` : text(object(journal).commandId);
      const expected = journal === null ? null : object(journal).result!;
      await executor.run({ ResumeFactoryReset: { device: device.serialNumber, command_id: commandId, expected_result: expected } }, {
        operation: 'FactoryReset', operationId,
        beforeFactoryResetReceipt: (result, context) => saveResetOwner(device, commandId, bindingGeneration, result, context, applicationPersistence),
      });
      await clearResetOwner(device, commandId, bindingGeneration, lease);
      return { commandId, bindingGeneration };
    } finally { operationLeases.delete(operationId); }
  };
  adapter.resolveEncryptedUploadV2Profile = async (requestId, decision) => {
    const request = profiles.get(requestId);
    if (!request || request.lease.cancelled || !request.lease.context) throw new BotaJsHostError('stale_material_request', 'TransferRecording');
    checkLease(request.lease, 'TransferRecording');
    executor.check(request.lease.context);
    const selected = materials.get(decision.materialRegistrationId);
    if (!selected || selected.operationId !== request.operationId) throw new BotaJsHostError('material_identity_mismatch', 'TransferRecording');
    profiles.delete(requestId);
    request.resolve({ ...decision });
  };
  adapter.rejectEncryptedUploadV2Profile = async (requestId, _errorCode) => {
    const request = profiles.get(requestId);
    request?.reject(new BotaJsHostError('application_material_rejected', 'TransferRecording'));
  };
  adapter.releaseEncryptedUploadV2Material = async id => { materials.delete(id); };
  adapter.cancelEncryptedRecordingV2 = async operationId => {
    const lease = operationLeases.get(operationId);
    if (!lease) return;
    lease.cancelled = true;
    const queued = controlQueue.findIndex(value => value.workflow?.operationId === operationId);
    if (queued !== -1) controlQueue.splice(queued, 1)[0]!.reject(new BotaJsHostError('operation_cancelled', 'TransferRecording'));
    for (const request of profiles.values()) if (request.operationId === operationId) request.reject(new BotaJsHostError('operation_cancelled', 'TransferRecording'));
    await executor.cancel(lease.context?.operationId ?? operationId);
  };
  if (ports.files?.flush) {
    const syncV2 = async (device: NativeConnectedDevice, recording: NativeEncryptedUploadV2Recording,
      operationId: string, localWifi: boolean) => {
      if (!operationId || operationId.length > 256 || operationLeases.has(operationId)) throw new BotaJsHostError('invalid_operation_id', 'TransferRecording');
      device = { ...captured(device) };
      recording = { ...recording };
      const lease: OperationLease = { device, physicalGeneration: connection!.generation,
        scope: ports.persistence.namespace, cancelled: false };
      operationLeases.set(operationId, lease);
      let journalKey = '';
      let host: JsEncryptedUploadV2Host | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => cleanupPromise ??= (async () => {
        let cleanupError: unknown;
        try { await host?.close(); } catch (error) { cleanupError = error; }
        if (lease.context) {
          const context = { ...lease.context, signal: new AbortController().signal };
          if (!host) for (const value of materials.values()) if (value.operationId === operationId) {
            try { await value.material.cancel?.(context); } catch (error) { cleanupError ??= error; }
          }
          if (!lease.providerDrained) {
            try { await options.drainMaterial?.(operationId, context); } catch (error) { cleanupError ??= error; }
          }
        }
        if (cleanupError) throw cleanupError;
      })();
      try {
        await queueWorkflow(operationId, async () => {
          await executor.run(async context => {
            lease.context = context;
            try {
              checkLease(lease, context.operation);
              await deviceControls.execute('readIdentity', [device], context);
              checkLease(lease, context.operation);
              const localIdentity = object(core.codec('encryptedUploadV2LocalIdentity', {
                scope: lease.scope, serialNumber: device.serialNumber, recording: recording as unknown as JsValue,
              }));
              journalKey = text(localIdentity.journalKey);
              const capability = await executor.gatt(context, () => ports.ble.read(
                address(device, 'SERVICE_BOTA_STORAGE', 'CHAR_STORAGE_TRANSFER_CAPABILITIES_V2'), context));
              if (!(capability instanceof Uint8Array)) throw new BotaJsHostError('invalid_capability_value', context.operation);
              const nativeCapability = { ...object(core.codec('nativeEncryptedUploadV2Capability', { bytes: Array.from(capability) })) };
              let localCapability: Uint8Array | undefined;
              if (localWifi) {
                if (!ports.localWifi || recording.markersRequired || device.mtu < 185) {
                  throw new BotaJsHostError('unsupported_capability', context.operation);
                }
                await ports.localWifi.preflight(device.id, context);
                checkLease(lease, context.operation);
                const value = await executor.gatt(context, () => ports.ble.read(
                  address(device, 'SERVICE_BOTA_LOCAL_WIFI', 'CHAR_LOCAL_WIFI_CAPABILITIES'), context));
                checkLease(lease, context.operation);
                if (!(value instanceof Uint8Array)) throw new BotaJsHostError('invalid_capability_value', context.operation);
                localCapability = value;
                core.codec('localWifiTransfer', { op: 'Capabilities', bytes: Array.from(localCapability), att_mtu: device.mtu });
                nativeCapability.localWifiRawValueHex = Array.from(localCapability, value => value.toString(16).padStart(2, '0')).join('');
              }
              const journal = localWifi ? null : await ports.persistence.load(`encrypted-upload-v2/${journalKey}`, context);
              const checkpoint = localWifi ? null : core.codec('nativeEncryptedUploadV2Checkpoint', {
                journal, scope: lease.scope,
                serialNumber: device.serialNumber, recording: recording as unknown as JsValue,
              });
              const decision = await requestProfile(operationId, lease, recording, nativeCapability, checkpoint, context);
              if (lease.cancelled) throw new BotaJsHostError('operation_cancelled', context.operation);
              const selected = materials.get(decision.materialRegistrationId);
              if (!selected || selected.operationId !== operationId) throw new BotaJsHostError('material_identity_mismatch', context.operation);
              const request = core.codec('planEncryptedUploadV2Request', { serialNumber: device.serialNumber,
                recording: recording as unknown as JsValue, capabilityBytes: Array.from(capability),
                decision: decision as unknown as JsValue, transportSessionId: (++registration).toString(),
                sinkId: text(localIdentity.sinkId), maximumWriteBytes: device.mtu - 3, checkpoint,
                ...(localWifi ? { localWifi: true, localWifiCapabilityBytes: Array.from(localCapability!) } : {}),
              });
              const sink = await ports.files!.open(text(object(request).sink_id), 'file', context);
              checkLease(lease, context.operation);
              host = new JsEncryptedUploadV2Host({ core, ports, request, journalKey, sink,
                peripheralId: device.id, maximumWriteBytes: device.mtu - 3, material: selected.material,
                priorCheckpoint: journal === null ? null : object(journal).checkpoint!,
                expectedMarkersRequired: recording.markersRequired === true,
                checkOwner: owner => checkWorkflowOwner(owner, device.serialNumber),
                gatt: (owner, body) => executor.gatt(owner, body), onCleanupFailure: error => executor.markCleanupFailed(error) });
              v2Hosts.set(operationId, host);
              return { TransferEncryptedRecording: { request } };
            } catch (error) {
              if (options.drainMaterial) {
                await options.drainMaterial(operationId, { ...context, signal: new AbortController().signal });
                lease.providerDrained = true;
              }
              throw error;
            }
          }, {
            operation: 'TransferRecording', operationId,
            capabilities: ['Ble', 'Persistence', 'Progress', 'HostMaterial', 'RecordingSink', 'NetworkTransfer'],
            onProgress(completed, total) { emit('onEncryptedUploadV2Progress', { operationId, recordingUuid: recording.uuid,
              phase: 'transfer', completedBytes: completed, totalBytes: total }); },
          }, cleanup);
          emit('onEncryptedUploadV2Progress', { operationId, recordingUuid: recording.uuid, phase: 'completed',
            completedBytes: recording.ciphertextLength, totalBytes: recording.ciphertextLength });
        });
      } finally {
        try { await cleanup(); } finally {
          v2Hosts.delete(operationId);
          operationLeases.delete(operationId);
          for (const [id, material] of materials) if (material.operationId === operationId) materials.delete(id);
        }
      }
    };
    adapter.syncEncryptedRecordingV2 = (device, recording, operationId) => syncV2(device, recording, operationId, false);
    if (ports.localWifi) {
      adapter.syncEncryptedRecordingV2LocalWifi = (device, recording, operationId) => syncV2(device, recording, operationId, true);
    }
  }
  if (streamingEffects) {
    adapter.startStreaming = async (device, request) => {
      const operationId = `streaming/${request.sessionId}`;
      const lease = await prepareLease(device, operationId, 'VerifyStreamingIdentity');
      try {
        streamingEffects.register(operationId, { ...request, serialNumber: device.serialNumber });
        checkLease(lease, 'TransferRecording');
        await executor.run({ StreamRecording: { device: device.serialNumber, recording: uuidBytes(request.recordingUuid), sink_id: request.sessionId } }, {
          operation: 'TransferRecording', operationId, onProgress(completed) { emit('onStreamingProgress', {
            sessionId: request.sessionId, state: 'streaming', bytesReceived: safeNumber(completed), chunksUploaded: 0 }); },
          onNotification(notification) {
            const completed = object(notification).StreamingCompleted;
            if (completed) emit('onStreamingProgress', { sessionId: request.sessionId, state: 'completed',
              bytesReceived: safeNumber(object(completed).total_units), chunksUploaded: safeNumber(object(completed).uploaded_chunks) });
          },
        });
        return streamingEffects.result(request.sessionId);
      } finally { try { await streamingEffects.release(request.sessionId); } finally { operationLeases.delete(operationId); } }
    };
    adapter.abortStreaming = sessionId => executor.cancel(`streaming/${sessionId}`);
    adapter.resolveStreamingChunkDestination = (requestId, destination) => streamingEffects.resolveStreamingChunkDestination(requestId, destination);
    adapter.rejectStreamingChunkDestination = (requestId, message) => streamingEffects.rejectStreamingChunkDestination(requestId, message);
    adapter.resolveStreamingFinalize = requestId => streamingEffects.resolveStreamingFinalize(requestId);
    adapter.rejectStreamingFinalize = (requestId, message) => streamingEffects.rejectStreamingFinalize(requestId, message);
  }
  if (fileEffects && ports.files) {
    adapter.syncRecording = async (device, recording, sinkId) => {
      captured(device);
      await direct('VerifyTransferIdentity', context => deviceControls.execute('readIdentity', [device], context));
      const result = await executor.run({ TransferRecording: { device: device.serialNumber, recording: uuidBytes(recording.uuid),
        sink_id: sinkId, total_units: String(recording.fileSize), confirm_on_completion: false } }, {
        operation: 'TransferRecording', operationId: `recording/${sinkId}`,
        onProgress(completed, total) { emit('onRecordingTransferProgress', { completedUnits: safeNumber(completed), totalUnits: safeNumber(total) }); },
      });
      const file = fileEffects.peek(sinkId);
      if (!file?.localPath) throw new BotaJsHostError('missing_file_path', 'TransferRecording');
      const completion = result.notifications.map(value => object(value).RecordingTransferCompleted).find(value => value !== undefined);
      if (!completion) throw new BotaJsHostError('invalid_transfer_result', 'TransferRecording');
      const fields = object(completion);
      return { localPath: file.localPath, fileSizeBytes: safeNumber(file.durableUnits), e2eEncrypted: fields.encrypted === true,
        ...(Array.isArray(fields.sha256) ? { contentSha256: packet(fields.sha256).reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '') } : {}) };
    };
    const namespace = ports.persistence.namespace;
    const signal = ports.signal;
    const scopeCheck = ports.checkScope;
    const fileContext = async (operation: string, operationId: string): Promise<JsHostContext> => {
      ready();
      const random = await ports.randomBytes(16);
      if (!(random instanceof Uint8Array) || random.length !== 16) throw new BotaJsHostError('invalid_entropy', operation);
      const context = { operation, operationId, requestId: '0', generation: (++registration).toString(),
        cancellationId: Array.from(random, value => value.toString(16).padStart(2, '0')).join(''),
        signal: signal ?? new AbortController().signal };
      checkFileContext(context);
      return context;
    };
    const checkFileContext = (context: JsHostContext) => {
      ready();
      if (context.signal.aborted || signal?.aborted || ports.persistence.namespace !== namespace) {
        throw new BotaJsHostError('operation_cancelled', context.operation);
      }
      scopeCheck?.();
    };
    recordingContext = fileContext;
    recordingUploads = new JsRecordingUploads({ core, files: ports.files, persistence: ports.persistence,
      fetch: options.fetch ?? (() => Promise.reject(new BotaJsHostError('missing_primitive:http', 'UploadRecording'))),
      uploadFile: (target, handle, progress, context) => options.uploadFile ? options.uploadFile(target, handle, context, progress)
        : Promise.reject(new BotaJsHostError('missing_primitive:uploadFile', 'UploadRecording')),
      checkOwner: checkFileContext, onProgress: progress => emit('onRecordingUploadProgress', progress),
      async lookup(taskId, localPath, context, identity) {
        checkFileContext(context);
        const tasks = await ports.persistence.load('compatibility/upload-queue', context);
        checkFileContext(context);
        const admitted = object(core.codec('recordingFileLookupAdmission', { tasks: tasks ?? [], taskId, localPath,
          ...(identity ?? {}), journalWriteUncertain: false }));
        const originalId = text(object(admitted.task!).id);
        const file = fileEffects.findByPath(localPath) ?? await fileEffects.reopen(originalId, context);
        checkFileContext(context);
        if (file.localPath !== localPath) throw new BotaJsHostError('foreign_file_handle', context.operation);
        return { handle: file.handle, localPath, durableUnits: file.durableUnits };
      } });
    adapter.releaseRecordingFile = async (taskId, localPath) => {
      await recordingUploads!.release(taskId, localPath, await fileContext('ReleaseRecording', taskId));
      fileEffects.forgetPath(localPath);
    };
    if (options.uploadFile && options.fetch) {
      adapter.uploadRecordingFile = async request => recordingUploads!.upload(request,
        await fileContext('UploadRecording', request.taskId));
      adapter.cancelRecordingUpload = taskId => recordingUploads!.cancel(taskId);
    }
  }
  if (fileEffects && ports.files && ports.network?.registerDownload) {
    adapter.updateFirmware = (device, image) => {
      captured(device);
      if (firmwareOperation) throw new BotaJsHostError('operation_in_progress', 'UpdateFirmware');
      const downloadId = (++registration).toString();
      const operation = { controller: new AbortController(), work: Promise.resolve() };
      firmwareOperation = operation;
      operation.work = (async () => {
        let registrationContext: JsHostContext | undefined;
        let fileRegistered = false;
        let registrationAttempted = false;
        let cleanupPromise: Promise<void> | undefined;
        let verifiedAt: number | undefined;
        let deadlineExpired = false;
        let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
        let completedProgress: { phase: string; completedUnits: number; totalUnits: number } | undefined;
        const startedAt = performance.now();
        const canonicalBudget = safeNumber(metadata.firmwareRecoveryTimeoutMs);
        const budget = options.firmwareRecoveryTimeoutMs ?? canonicalBudget;
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > canonicalBudget) {
          throw new BotaJsHostError('invalid_core_deadline', 'UpdateFirmware');
        }
        const cleanupRegistration = (context: JsHostContext) => cleanupPromise ??= (async () => {
          const cleanup = { ...context, signal: new AbortController().signal };
          try {
            if (registrationAttempted) await ports.network!.unregister?.(downloadId, cleanup);
            if (fileRegistered) fileEffects.releaseFirmware(downloadId);
          } catch (error) { executor.markCleanupFailed(error); throw error; }
        })();
        try {
          await executor.direct('RegisterFirmware', async context => {
            registrationContext = context;
            try {
              await deviceControls.execute('readIdentity', [device], context);
              const handle = await ports.files!.open(`firmware/${downloadId}`, 'firmware', context);
              fileEffects.registerFirmware(downloadId, handle);
              fileRegistered = true;
              executor.check(context);
              registrationAttempted = true;
              await ports.network!.registerDownload!(downloadId, image.url, handle, context);
              executor.check(context);
            } catch (error) { await cleanupRegistration(context); throw error; }
          }, { signal: operation.controller.signal });
          await executor.run({ UpdateFirmware: { device: device.serialNumber,
            image: { version: image.version, size_bytes: image.sizeUnits, crc32: image.crc32 }, download_id: downloadId,
            reconnect_hint: { stored_peripheral_id: device.id, advertised_address: null, stored_name: null,
              scan_timeout_ms: '5000', connection_timeout_ms: '10000' } } }, {
            operation: 'UpdateFirmware', operationId: 'firmware', signal: operation.controller.signal,
            onNotification(value) {
              const notification = object(value).FirmwareProgress;
              if (!notification) return;
              const progress = object(object(notification).progress!);
              const phase = text(progress.phase).toLowerCase();
              if (phase === 'reconnecting' && connection?.device.id === device.id) {
                // The core retired this physical link. A delayed observer from it
                // must not invalidate a replacement that reuses the OS identifier.
                connection = null;
                presenceSession = '';
                connectionGeneration++;
                emit('onDeviceDisconnected', {});
              }
              if (verifiedAt === undefined && (phase === 'rebooting' || phase === 'reconnecting')) {
                verifiedAt = performance.now();
                recoveryTimer = setTimeout(() => { deadlineExpired = true; operation.controller.abort(); },
                  Math.max(0, Math.min(startedAt + budget, verifiedAt + budget) - performance.now()));
              }
              const event = { phase, completedUnits: safeNumber(progress.completed_bytes), totalUnits: safeNumber(progress.total_bytes) };
              if (phase === 'complete') completedProgress = event;
              else emit('onFirmwareUpdateProgress', event);
            },
          }, cleanupRegistration);
          const peripheralId = executor.connectedPeripheralId;
          if (!peripheralId || verifiedAt === undefined) throw new BotaJsHostError('connection_not_verified', 'UpdateFirmware');
          const remaining = Math.min(startedAt + budget, verifiedAt + budget) - performance.now();
          if (remaining <= 0) throw new BotaJsHostError('timeout', 'UpdateFirmware', true);
          await adoptConnection({ ...device, id: peripheralId, firmwareVersion: '', connectionState: 'connected' },
            'VerifyFirmwareConnection', image.version, operation.controller.signal);
          if (completedProgress) emit('onFirmwareUpdateProgress', completedProgress);
        } catch (error) {
          if (deadlineExpired && error instanceof BotaJsHostError &&
              ['operation_cancelled', 'stale_host_owner'].includes(error.code)) {
            throw new BotaJsHostError('timeout', 'UpdateFirmware', true);
          }
          throw error;
        } finally {
          if (recoveryTimer) clearTimeout(recoveryTimer);
          if (registrationContext && !cleanupPromise) await cleanupRegistration(registrationContext);
        }
      })().finally(() => { if (firmwareOperation === operation) firmwareOperation = undefined; });
      return operation.work;
    };
    adapter.cancelFirmwareUpdate = async () => {
      const operation = firmwareOperation;
      operation?.controller.abort();
      await executor.cancel('firmware');
      await operation?.work.catch(() => {});
    };
  }

  async function prepareLease(device: NativeConnectedDevice, operationId: string, operation: string): Promise<OperationLease> {
    captured(device);
    if (operationLeases.has(operationId)) throw new BotaJsHostError('operation_in_progress', operation);
    const lease: OperationLease = { device, physicalGeneration: connection!.generation,
      scope: ports.persistence.namespace, cancelled: false };
    operationLeases.set(operationId, lease);
    try {
      await direct(operation, async context => {
        lease.context = context;
        checkLease(lease, operation);
        await deviceControls.execute('readIdentity', [device], context);
        checkLease(lease, operation);
      });
      return lease;
    } catch (error) { operationLeases.delete(operationId); throw error; }
  }
  function resetOwnerKey(device: NativeConnectedDevice): string { return `reset-owner/${device.serialNumber}`; }
  function validateResetJournal(journal: JsValue | null, device: NativeConnectedDevice, generation: number): JsValue {
    return core.codec('validateFactoryResetJournal', { journal, serialNumber: device.serialNumber,
      currentBindingGeneration: String(generation) });
  }
  async function saveResetOwner(device: NativeConnectedDevice, commandId: string, bindingGeneration: number,
    durable: JsValue, context: JsHostContext, applicationPersistence: boolean): Promise<void> {
    checkWorkflowOwner(context, device.serialNumber);
    const result = object(durable).result!;
    const journal = validateResetJournal({ serialNumber: device.serialNumber, commandId,
      bindingGeneration: String(bindingGeneration), result }, device, bindingGeneration);
    const existing = validateResetJournal(await ports.persistence.load(resetOwnerKey(device), context), device, bindingGeneration);
    if (existing !== null && object(existing).commandId !== commandId) throw new BotaJsHostError('stable_identity_mismatch', 'FactoryReset');
    await ports.persistence.save(resetOwnerKey(device), journal, context);
    checkWorkflowOwner(context, device.serialNumber);
    const readback = validateResetJournal(await ports.persistence.load(resetOwnerKey(device), context), device, bindingGeneration);
    if (JSON.stringify(readback) !== JSON.stringify(journal)) throw new BotaJsHostError('persistence_failed', 'FactoryReset');
    if (applicationPersistence) await materialEffects.requestFactoryResetPersistence(device.serialNumber,
      safeNumber(object(result).deleted_recording_count), context);
  }
  async function clearResetOwner(device: NativeConnectedDevice, commandId: string, generation: number,
    lease: OperationLease): Promise<void> {
    await direct('ClearFactoryResetJournal', async context => {
      checkLease(lease, context.operation);
      const journal = validateResetJournal(await ports.persistence.load(resetOwnerKey(device), context), device, generation);
      if (journal === null || object(journal).commandId !== commandId) throw new BotaJsHostError('stable_identity_mismatch', 'FactoryReset');
      await ports.persistence.remove(resetOwnerKey(device), context);
    });
  }
  async function requestProfile(operationId: string, lease: OperationLease, recording: NativeEncryptedUploadV2Recording,
    capability: JsValue, checkpoint: JsValue, context: JsHostContext): Promise<NativeEncryptedUploadV2ProfileDecision> {
    const requestId = `profile:${operationId}:${context.generation}:${++registration}`;
    let abort!: () => void;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(new BotaJsHostError('operation_cancelled', context.operation));
        profiles.set(requestId, { operationId, lease, resolve, reject });
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted || lease.cancelled) { abort(); return; }
        try { emit('onEncryptedUploadV2ProfileRequested', { requestId, operationId, recording,
          capability, ...(checkpoint === null ? {} : { checkpoint }) }); }
        catch (error) { reject(error); }
      });
    } finally { profiles.delete(requestId); context.signal.removeEventListener('abort', abort); }
  }

  async function response(context: JsHostContext, source: GattAddress, write: () => Promise<void>): Promise<Uint8Array> {
    let resolve!: (value: Uint8Array) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Uint8Array>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {});
    const abort = () => reject(new BotaJsHostError('cancelled', context.operation));
    const timer = setTimeout(() => reject(new BotaJsHostError('timeout', context.operation)), 30_000);
    context.signal.addEventListener('abort', abort, { once: true });
    let subscription: JsHostSubscription | undefined;
    let accepting = false;
    let transportFailed = false;
    let transportError: unknown;
    const generation = connection?.generation;
    try {
      subscription = await executor.gatt(context, () => ports.ble.subscribe(source, value => {
        if (!accepting || context.signal.aborted) return;
        if (connection?.generation !== generation) { reject(new BotaJsHostError('identity_mismatch', context.operation)); return; }
        if (!(value instanceof Uint8Array)) { reject(new BotaJsHostError('opaque_packet_requires_protected_port', context.operation)); return; }
        resolve(value);
      }, context, error => { transportFailed = true; transportError = error; reject(error); }));
      if (transportFailed) throw transportError;
      accepting = true;
      await write();
      return await result;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      accepting = false;
      try { await subscription?.remove(); } catch (error) { executor.markCleanupFailed(error); throw error; }
    }
  }
  return adapter;
}

function object(value: JsValue | undefined): { readonly [key: string]: JsValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotaJsHostError('invalid_core_result', 'Validate');
  return value as { readonly [key: string]: JsValue };
}
function text(value: JsValue | undefined): string {
  if (typeof value !== 'string') throw new BotaJsHostError('invalid_core_result', 'Validate');
  return value;
}
function packet(value: JsValue): Uint8Array {
  if (!Array.isArray(value) || value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new BotaJsHostError('invalid_core_packet', 'Validate');
  }
  return Uint8Array.from(value as number[]);
}
function safeNumber(value: JsValue | undefined): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new BotaJsHostError('public_number_out_of_range', 'Validate');
  return result;
}
function uuidBytes(value: string): number[] {
  const compact = value.replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(compact)) throw new BotaJsHostError('invalid_recording_uuid', 'Validate');
  return compact.match(/../g)!.map(byte => parseInt(byte, 16));
}
