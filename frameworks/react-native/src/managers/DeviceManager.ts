import EventEmitter from 'eventemitter3';

import type {
  BotaAsyncEventSubscription,
  BotaDeviceSDKClient,
  BotaEventSubscription,
} from '../client';
import {
  getCompatibilityClient,
  subscribeToCompatibilityDisconnections,
} from '../compatibility/runtime';
import type {
  CachedDeviceState,
} from '../cache/DeviceStateCache';
import type {
  ConnectedDevice,
  DeviceConnectionSettings,
  DeviceLogEvent,
  DeviceStatus,
  DeviceWiFiScanResult,
  DiscoveredDevice,
  ReconnectOptions,
  ScanOptions,
  WiFiConfigGrant,
  WiFiConfigResult,
  WiFiCredentials,
  WiFiStatusInfo,
  Environment,
  BleFactoryResetResult,
  BleFactoryResetResultPersister,
  RecordingState,
  StartRecordingOptions,
  StopRecordingOptions,
} from '../models/Device';
import type { DeviceManagerEvents } from '../models/Status';
import { DeviceError, ProvisioningError } from '../utils/errors';

type Subscription = { remove(): void };

export type RecordingGrantFetcher = (
  nonce: string | null
) => Promise<string>;

export type RadioPriority = 'user' | 'background';

export interface ProvisionOptions {
  fetchDeprovisionGrant?: RecordingGrantFetcher;
}

type CacheListener = (
  serialNumber: string,
  patch: { wifiStatus?: Partial<WiFiStatusInfo> | null },
  state: CachedDeviceState
) => void;

export class DeviceManager extends EventEmitter<DeviceManagerEvents> {
  private readonly client: BotaDeviceSDKClient;
  private readonly discoveredDevices = new Map<string, DiscoveredDevice>();
  private readonly connectedDevices = new Map<string, ConnectedDevice>();
  private readonly knownBleIds = new Map<string, string>();
  private readonly cache = new Map<string, CachedDeviceState>();
  private readonly cacheListeners = new Set<CacheListener>();
  private readonly statusSubscriptions = new Map<
    string,
    Promise<BotaAsyncEventSubscription>
  >();
  private readonly statusCallbacks = new Map<
    string,
    Set<(status: DeviceStatus) => void>
  >();
  private readonly wifiStatusSubscriptions = new Map<
    string,
    Promise<BotaAsyncEventSubscription>
  >();
  private readonly logSubscriptions = new Map<
    string,
    Promise<BotaAsyncEventSubscription>
  >();
  private readonly recordingStateCache = new Map<string, RecordingState>();
  private readonly recordingStatePending = new Map<
    string,
    Promise<RecordingState>
  >();
  private readonly recordingStateSubscriptions = new Map<
    string,
    Promise<BotaAsyncEventSubscription>
  >();
  private readonly reconnectInFlight = new Map<
    string,
    Promise<ConnectedDevice>
  >();
  private reconnectChain: Promise<unknown> = Promise.resolve();
  private scanSubscription: BotaEventSubscription | null = null;
  private scanActive = false;
  private autoReconnectEnabled = false;
  private autoReconnectSerial: string | null = null;
  private autoReconnectTimer: ReturnType<typeof setInterval> | null = null;
  private autoReconnectAttempting = false;
  private userDisconnected = false;
  private destroyed = false;
  private readonly disconnectionSubscription: Subscription;

  constructor() {
    super();
    this.client = getCompatibilityClient();
    this.disconnectionSubscription = subscribeToCompatibilityDisconnections(
      this.client,
      (error) => this.handleNativeDisconnection(error)
    );
  }

  async initialize(): Promise<void> {}

  async startScan(options: ScanOptions = {}): Promise<void> {
    this.assertAlive();
    if (this.scanActive) return;
    this.emit('scanStarted');
    try {
      this.scanSubscription = await this.client.devices.startScan(
        options,
        (device) => {
          this.discoveredDevices.set(device.id, device);
          this.emit('deviceDiscovered', device);
        }
      );
      this.scanActive = true;
    } catch (error) {
      this.emit('scanError', asError(error));
      throw error;
    }
  }

  stopScan(): void {
    if (!this.scanActive) return;
    this.scanActive = false;
    this.scanSubscription?.remove();
    this.scanSubscription = null;
    void this.client.devices.stopScan().catch((error) => {
      this.emit('scanError', asError(error));
    });
    this.emit('scanStopped');
  }

  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values());
  }

  getConnectedDevices(): ConnectedDevice[] {
    return Array.from(this.connectedDevices.values());
  }

  getKnownBleIds(): Record<string, string> {
    return Object.fromEntries(this.knownBleIds);
  }

  async connect(
    device: DiscoveredDevice,
    priority: RadioPriority = 'user'
  ): Promise<ConnectedDevice> {
    void priority;
    this.assertAlive();
    this.userDisconnected = false;
    this.emit('connectionStateChanged', device.id, 'connecting');
    try {
      const connected = await this.client.devices.connect(device);
      this.rememberConnected(connected);
      if (this.autoReconnectEnabled) this.ensureStatusWatchdog(connected);
      this.emit('connectionStateChanged', connected.id, 'connected');
      this.emit('deviceConnected', connected);
      return connected;
    } catch (error) {
      this.emit('connectionStateChanged', device.id, 'disconnected');
      throw error;
    }
  }

  async reconnect(
    serialNumber: string,
    options?: ReconnectOptions
  ): Promise<ConnectedDevice> {
    this.assertAlive();
    const existing = this.findConnectedBySerial(serialNumber);
    if (existing) return existing;
    this.userDisconnected = false;
    const inFlight = this.reconnectInFlight.get(serialNumber);
    if (inFlight) return inFlight;
    const run = this.reconnectChain
      .catch(() => undefined)
      .then(async () => {
        const connected = await this.client.devices.reconnect(
          serialNumber,
          options
        );
        this.rememberConnected(connected);
        if (this.autoReconnectEnabled) this.ensureStatusWatchdog(connected);
        this.emit('connectionStateChanged', connected.id, 'connected');
        this.emit('deviceConnected', connected);
        return connected;
      });
    this.reconnectChain = run.catch(() => undefined);
    this.reconnectInFlight.set(serialNumber, run);
    void run.finally(() => {
      if (this.reconnectInFlight.get(serialNumber) === run) {
        this.reconnectInFlight.delete(serialNumber);
      }
    }).catch(() => undefined);
    return run;
  }

  async disconnect(device: ConnectedDevice): Promise<void> {
    this.assertAlive();
    this.userDisconnected = true;
    this.stopAutoReconnectLoop();
    this.emit('connectionStateChanged', device.id, 'disconnecting');
    await this.removeOwned(this.statusSubscriptions, device.id);
    this.statusCallbacks.delete(device.id);
    await this.removeOwned(this.wifiStatusSubscriptions, device.id);
    await this.removeOwned(this.logSubscriptions, device.id);
    await this.removeOwned(this.recordingStateSubscriptions, device.id);
    await this.client.devices.disconnect();
    this.connectedDevices.delete(device.id);
    this.recordingStateCache.delete(device.id);
    this.recordingStatePending.delete(device.id);
    this.emit('connectionStateChanged', device.id, 'disconnected');
    this.emit('deviceDisconnected', device.id);
  }

  isConnected(deviceId: string): boolean {
    return this.connectedDevices.get(deviceId)?.connectionState === 'connected';
  }

  async getStatus(device: ConnectedDevice): Promise<DeviceStatus> {
    this.requireConnected(device.id);
    return this.client.devices.readStatus();
  }

  async isProvisioned(device: ConnectedDevice): Promise<boolean> {
    this.requireConnected(device.id);
    return this.client.controls.isProvisioned(device);
  }

  async readPublicKey(device: ConnectedDevice): Promise<string | null> {
    this.requireConnected(device.id);
    return this.client.controls.readPublicKey(device);
  }

  async readAuthNonce(device: ConnectedDevice): Promise<string | null> {
    this.requireConnected(device.id);
    return this.client.controls.readAuthNonce(device);
  }

  async setApiEndpoint(
    device: ConnectedDevice,
    environment: Environment
  ): Promise<void> {
    this.requireConnected(device.id);
    await this.client.controls.setApiEndpoint(device, environment);
  }

  async deliverCert(
    device: ConnectedDevice,
    certPem: string,
    privkeyPem: string
  ): Promise<void> {
    this.requireConnected(device.id);
    await this.client.controls.deliverCertificate(
      device,
      certPem,
      privkeyPem
    );
  }

  async deliverBackendPubkey(
    device: ConnectedDevice,
    pubkey: Uint8Array
  ): Promise<void> {
    this.requireConnected(device.id);
    await this.client.controls.deliverBackendPublicKey(device, pubkey);
  }

  async writeGrant(device: ConnectedDevice, grantBlob: string): Promise<void> {
    this.requireConnected(device.id);
    await this.client.controls.writeGrant(device, grantBlob);
  }

  async syncTime(deviceId: string): Promise<void> {
    await this.client.controls.syncTime(this.requireConnected(deviceId));
  }

  async provision(
    device: ConnectedDevice,
    deviceToken: string,
    environment: Environment = 'production',
    options?: ProvisionOptions
  ): Promise<void> {
    this.requireConnected(device.id);
    const provision = () => this.client.provisioning.provision(
      device,
      async () => ({
        apiEndpoint: String.fromCharCode(environmentCode(environment)),
        deviceToken,
        mtu: device.mtu,
      })
    );
    try {
      await provision();
    } catch (error) {
      if (!isAlreadyPaired(error) || !options?.fetchDeprovisionGrant) {
        throw provisioningError(error, device.id);
      }
      const nonce = await this.readAuthNonce(device).catch(() => null);
      const grantBlob = await options.fetchDeprovisionGrant(nonce);
      const result = await this.deprovision(device, grantBlob);
      if (!result.success) {
        throw new ProvisioningError(
          `Auto-deprovision failed: ${result.error ?? 'unknown'}`,
          'PROVISIONING_FAILED',
          device.id
        );
      }
      await provision();
    }
  }

  async deprovision(
    device: ConnectedDevice,
    grantBlob: string
  ): Promise<{ success: boolean; error?: string }> {
    this.requireConnected(device.id);
    return this.client.provisioning.deprovision(device, grantBlob);
  }

  async factoryReset(device: ConnectedDevice): Promise<void> {
    this.requireConnected(device.id);
    throw ProvisioningError.invalidToken(device.id);
  }

  async bleFactoryReset(
    device: ConnectedDevice,
    grantBlob: string,
    persistResult: BleFactoryResetResultPersister
  ): Promise<BleFactoryResetResult> {
    this.requireConnected(device.id);
    let persisted: Extract<BleFactoryResetResult, { success: true }> | undefined;
    try {
      await this.client.factoryReset.factoryReset(
        device,
        {
          commandId: nextCompatibilityResetCommandId(),
          bindingGeneration: 0,
        },
        async () => grantBlob,
        async (result) => {
          await persistResult(result);
          persisted = result;
        }
      );
    } catch (error) {
      const rejected = factoryResetRejection(error);
      if (rejected) return rejected;
      throw error;
    }
    if (!persisted) {
      throw new Error('Factory reset completed without a persisted result');
    }
    return persisted;
  }

  async resumeBleFactoryReset(
    device: ConnectedDevice,
    persistResult: BleFactoryResetResultPersister
  ): Promise<BleFactoryResetResult> {
    this.requireConnected(device.id);
    let persisted: Extract<BleFactoryResetResult, { success: true }> | undefined;
    try {
      await this.client.factoryReset.resumePendingFactoryReset(
        device,
        0,
        async (result) => {
          await persistResult(result);
          persisted = result;
        }
      );
    } catch (error) {
      const rejected = factoryResetRejection(error);
      if (rejected) return rejected;
      throw error;
    }
    if (!persisted) {
      throw new Error('Factory reset resume completed without a persisted result');
    }
    return persisted;
  }

  async requestStartRecording(
    device: ConnectedDevice,
    grantOrFetcher: string | RecordingGrantFetcher,
    _options?: StartRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    this.requireConnected(device.id);
    if (typeof grantOrFetcher === 'string') {
      return this.runRecordingControl(device, grantOrFetcher, 'start');
    }
    const grantBlob = await this.fetchRecordingGrant(device, grantOrFetcher);
    return this.runRecordingControl(device, grantBlob, 'start');
  }

  async requestStopRecording(
    device: ConnectedDevice,
    grantOrFetcher: string | RecordingGrantFetcher,
    _options?: StopRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    this.requireConnected(device.id);
    if (typeof grantOrFetcher === 'string') {
      return this.runRecordingControl(device, grantOrFetcher, 'stop');
    }
    const grantBlob = await this.fetchRecordingGrant(device, grantOrFetcher);
    return this.runRecordingControl(device, grantBlob, 'stop');
  }

  async getRecordingState(device: ConnectedDevice): Promise<RecordingState> {
    this.requireConnected(device.id);
    const pending = this.recordingStatePending.get(device.id);
    if (pending) return pending;
    try {
      return await this.readAndCacheRecordingState(device);
    } catch {
      return this.cachedRecordingState(device.id);
    }
  }

  subscribeToRecordingState(
    device: ConnectedDevice,
    callback: (state: RecordingState) => void
  ): () => void {
    this.requireConnected(device.id);
    const promise = this.replaceOwned(
      this.recordingStateSubscriptions,
      device.id,
      this.client.controls.subscribeToRecordingState(device, callback)
    );
    return idempotentRemoval(() => {
      void this.removeExpected(
        this.recordingStateSubscriptions,
        device.id,
        promise
      );
    });
  }

  subscribeToStatus(
    device: ConnectedDevice,
    callback: (status: DeviceStatus) => void
  ): () => void {
    this.requireConnected(device.id);
    const callbacks = this.statusCallbacks.get(device.id) ?? new Set();
    callbacks.add(callback);
    this.statusCallbacks.set(device.id, callbacks);
    this.ensureStatusWatchdog(device);
    return idempotentRemoval(() => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.statusCallbacks.delete(device.id);
        if (!this.autoReconnectEnabled) {
          void this.removeOwned(this.statusSubscriptions, device.id)
            .catch(() => undefined);
        }
      }
    });
  }

  async subscribeToDeviceLogs(
    device: ConnectedDevice,
    callback: (event: DeviceLogEvent) => void
  ): Promise<() => void> {
    this.requireConnected(device.id);
    const promise = this.replaceOwned(
      this.logSubscriptions,
      device.id,
      this.client.logs.subscribe(device, callback)
    );
    await promise;
    return idempotentRemoval(() => {
      void this.removeExpected(this.logSubscriptions, device.id, promise);
    });
  }

  async readConnectionSettings(
    device: ConnectedDevice
  ): Promise<DeviceConnectionSettings> {
    this.requireConnected(device.id);
    return this.client.provisioning.readConnectionSettings(device);
  }

  async writeConnectionSettings(
    device: ConnectedDevice,
    settings: DeviceConnectionSettings
  ): Promise<void> {
    this.requireConnected(device.id);
    await this.client.provisioning.writeConnectionSettings(device, settings);
  }

  async configureWiFi(
    deviceId: string,
    credentials: WiFiCredentials,
    grant: WiFiConfigGrant
  ): Promise<WiFiConfigResult> {
    return this.client.wifi.configure(
      this.requireConnected(deviceId),
      credentials,
      grant
    );
  }

  async disconnectWiFi(deviceId: string): Promise<WiFiConfigResult> {
    return this.client.wifi.disconnect(this.requireConnected(deviceId));
  }

  async getWiFiStatus(deviceId: string): Promise<WiFiStatusInfo> {
    const device = this.requireConnected(deviceId);
    const status = await this.client.wifi.readStatus(device);
    this.updateCachedDeviceState(device.serialNumber, { wifiStatus: status });
    return status;
  }

  subscribeToWiFiStatus(
    deviceId: string,
    callback: (status: WiFiStatusInfo) => void
  ): Subscription {
    const device = this.requireConnected(deviceId);
    const promise = this.replaceOwned(
      this.wifiStatusSubscriptions,
      device.id,
      this.client.wifi.subscribeToStatus(device, (status) => {
        this.updateCachedDeviceState(device.serialNumber, { wifiStatus: status });
        callback(status);
      })
    );
    return {
      remove: idempotentRemoval(() => {
        void this.removeExpected(this.wifiStatusSubscriptions, device.id, promise);
      }),
    };
  }

  async scanWiFiNetworks(
    device: ConnectedDevice
  ): Promise<DeviceWiFiScanResult> {
    this.requireConnected(device.id);
    return this.client.wifi.scanNetworks(device);
  }

  getCachedDeviceState(serialNumber: string): CachedDeviceState | null {
    return this.cache.get(serialNumber) ?? null;
  }

  getCachedWiFiStatus(serialNumber: string): WiFiStatusInfo | null {
    return this.cache.get(serialNumber)?.wifiStatus ?? null;
  }

  updateCachedDeviceState(
    serialNumber: string,
    patch: { wifiStatus?: Partial<WiFiStatusInfo> | null }
  ): void {
    const previous = this.cache.get(serialNumber);
    const wifiStatus = mergeWiFiStatus(previous?.wifiStatus, patch.wifiStatus);
    const state: CachedDeviceState = {
      ...(wifiStatus === undefined ? {} : { wifiStatus }),
      updatedAt: Date.now(),
    };
    this.cache.set(serialNumber, state);
    for (const listener of this.cacheListeners) listener(serialNumber, patch, state);
  }

  clearCachedDeviceState(serialNumber: string): void {
    this.cache.delete(serialNumber);
  }

  clearAllCachedDeviceStates(): void {
    this.cache.clear();
  }

  enableAutoReconnect(serialNumber: string): void {
    this.assertAlive();
    this.autoReconnectSerial = serialNumber;
    this.autoReconnectEnabled = true;
    this.userDisconnected = false;
    const connected = this.findConnectedBySerial(serialNumber);
    if (connected) {
      this.ensureStatusWatchdog(connected);
    } else {
      this.startAutoReconnectLoop();
    }
  }

  disableAutoReconnect(): void {
    const serialNumber = this.autoReconnectSerial;
    this.autoReconnectEnabled = false;
    this.autoReconnectSerial = null;
    this.userDisconnected = false;
    this.stopAutoReconnectLoop();
    const connected = serialNumber
      ? this.findConnectedBySerial(serialNumber)
      : null;
    if (connected && !this.statusCallbacks.has(connected.id)) {
      void this.removeOwned(this.statusSubscriptions, connected.id)
        .catch(() => undefined);
    }
  }

  onCachedDeviceStateChanged(
    listener: (
      serialNumber: string,
      patch: { wifiStatus?: Partial<WiFiStatusInfo> | null },
      state: CachedDeviceState
    ) => void
  ): { remove: () => void } {
    this.cacheListeners.add(listener);
    return { remove: () => this.cacheListeners.delete(listener) };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectionSubscription.remove();
    this.disableAutoReconnect();
    this.stopScan();
    for (const [deviceId] of this.statusSubscriptions) {
      void this.removeOwned(this.statusSubscriptions, deviceId);
    }
    for (const [deviceId] of this.wifiStatusSubscriptions) {
      void this.removeOwned(this.wifiStatusSubscriptions, deviceId);
    }
    for (const [deviceId] of this.logSubscriptions) {
      void this.removeOwned(this.logSubscriptions, deviceId);
    }
    for (const [deviceId] of this.recordingStateSubscriptions) {
      void this.removeOwned(this.recordingStateSubscriptions, deviceId);
    }
    this.connectedDevices.clear();
    this.recordingStateCache.clear();
    this.recordingStatePending.clear();
    this.statusCallbacks.clear();
    this.cache.clear();
    this.cacheListeners.clear();
    this.removeAllListeners();
  }

  private rememberConnected(device: ConnectedDevice): void {
    this.connectedDevices.set(device.id, device);
    this.knownBleIds.set(device.serialNumber, device.id);
  }

  private ensureStatusWatchdog(device: ConnectedDevice): void {
    if (this.statusSubscriptions.has(device.id)) return;
    const subscription = this.client.devices.subscribeToStatus((status) => {
      for (const callback of this.statusCallbacks.get(device.id) ?? []) {
        callback(status);
      }
      this.emit('deviceStatusUpdated', device.id, status);
    });
    this.statusSubscriptions.set(device.id, subscription);
    void subscription.catch(() => {
      if (this.statusSubscriptions.get(device.id) === subscription) {
        this.statusSubscriptions.delete(device.id);
      }
    });
  }

  private handleNativeDisconnection(error?: Error): void {
    if (this.destroyed || this.userDisconnected) return;
    for (const device of this.connectedDevices.values()) {
      this.connectedDevices.delete(device.id);
      this.recordingStateCache.delete(device.id);
      this.recordingStatePending.delete(device.id);
      this.statusCallbacks.delete(device.id);
      void this.removeOwned(this.statusSubscriptions, device.id)
        .catch(() => undefined);
      void this.removeOwned(this.wifiStatusSubscriptions, device.id)
        .catch(() => undefined);
      void this.removeOwned(this.logSubscriptions, device.id)
        .catch(() => undefined);
      void this.removeOwned(this.recordingStateSubscriptions, device.id)
        .catch(() => undefined);
      this.emit('connectionStateChanged', device.id, 'disconnected');
      this.emit('deviceDisconnected', device.id, error);
      if (
        this.autoReconnectEnabled &&
        this.autoReconnectSerial === device.serialNumber
      ) {
        this.startAutoReconnectLoop();
      }
    }
  }

  private startAutoReconnectLoop(): void {
    if (this.autoReconnectTimer || !this.autoReconnectSerial) return;
    const attempt = async (): Promise<void> => {
      const serialNumber = this.autoReconnectSerial;
      if (
        !this.autoReconnectEnabled ||
        !serialNumber ||
        this.userDisconnected ||
        this.destroyed
      ) {
        this.stopAutoReconnectLoop();
        return;
      }
      if (this.findConnectedBySerial(serialNumber)) {
        this.stopAutoReconnectLoop();
        return;
      }
      if (this.autoReconnectAttempting) return;
      this.autoReconnectAttempting = true;
      try {
        await this.reconnect(serialNumber, { scanTimeout: 5_000 });
        this.stopAutoReconnectLoop();
      } catch {
        // The timer owns retries; callers still receive errors from reconnect().
      } finally {
        this.autoReconnectAttempting = false;
      }
    };
    void attempt();
    this.autoReconnectTimer = setInterval(() => void attempt(), 3_000);
  }

  private stopAutoReconnectLoop(): void {
    if (!this.autoReconnectTimer) return;
    clearInterval(this.autoReconnectTimer);
    this.autoReconnectTimer = null;
  }

  private findConnectedBySerial(serialNumber: string): ConnectedDevice | null {
    for (const device of this.connectedDevices.values()) {
      if (
        device.serialNumber === serialNumber &&
        device.connectionState === 'connected'
      ) {
        return device;
      }
    }
    return null;
  }

  private requireConnected(deviceId: string): ConnectedDevice {
    const device = this.connectedDevices.get(deviceId);
    if (!device || device.connectionState !== 'connected') {
      throw DeviceError.notConnected(deviceId);
    }
    return device;
  }

  private async fetchRecordingGrant(
    device: ConnectedDevice,
    fetcher: RecordingGrantFetcher
  ): Promise<string> {
    const nonce = await this.readAuthNonce(device).catch(() => null);
    return fetcher(nonce);
  }

  private async runRecordingControl(
    device: ConnectedDevice,
    grantBlob: string,
    command: 'start' | 'stop'
  ): Promise<{ success: boolean; error?: string }> {
    const operation = command === 'start'
      ? this.client.controls.requestStartRecording(device, grantBlob)
      : this.client.controls.requestStopRecording(device, grantBlob);
    const pendingState = operation.then(
      () => this.readAndCacheRecordingState(device),
      () => this.cachedRecordingState(device.id)
    );
    this.recordingStatePending.set(device.id, pendingState);
    try {
      const result = await operation;
      await pendingState;
      return result;
    } catch (error) {
      await pendingState;
      throw error;
    } finally {
      if (this.recordingStatePending.get(device.id) === pendingState) {
        this.recordingStatePending.delete(device.id);
      }
    }
  }

  private async readAndCacheRecordingState(
    device: ConnectedDevice
  ): Promise<RecordingState> {
    const state = await this.client.controls.readRecordingState(device);
    this.recordingStateCache.set(device.id, state);
    return state;
  }

  private cachedRecordingState(deviceId: string): RecordingState {
    return this.recordingStateCache.get(deviceId) ?? {
      active: false,
      initiatedBy: 'local',
    };
  }

  private replaceOwned(
    owner: Map<string, Promise<BotaAsyncEventSubscription>>,
    deviceId: string,
    next: Promise<BotaAsyncEventSubscription>
  ): Promise<BotaAsyncEventSubscription> {
    void this.removeOwned(owner, deviceId);
    owner.set(deviceId, next);
    void next.catch(() => {
      if (owner.get(deviceId) === next) owner.delete(deviceId);
    });
    return next;
  }

  private async removeExpected(
    owner: Map<string, Promise<BotaAsyncEventSubscription>>,
    deviceId: string,
    expected: Promise<BotaAsyncEventSubscription>
  ): Promise<void> {
    if (owner.get(deviceId) !== expected) return;
    owner.delete(deviceId);
    await (await expected).remove();
  }

  private async removeOwned(
    owner: Map<string, Promise<BotaAsyncEventSubscription>>,
    deviceId: string
  ): Promise<void> {
    const subscription = owner.get(deviceId);
    if (!subscription) return;
    owner.delete(deviceId);
    await (await subscription).remove();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('DeviceManager has been destroyed');
  }
}

const idempotentRemoval = (remove: () => void): (() => void) => {
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    remove();
  };
};

const mergeWiFiStatus = (
  previous: WiFiStatusInfo | undefined,
  patch: Partial<WiFiStatusInfo> | null | undefined
): WiFiStatusInfo | undefined => {
  if (patch === undefined) return previous;
  if (patch === null) return undefined;
  return {
    status: patch.status ?? previous?.status ?? 'idle',
    ...(patch.signalStrength ?? previous?.signalStrength) === undefined
      ? {}
      : { signalStrength: patch.signalStrength ?? previous?.signalStrength },
    ...(patch.ssid ?? previous?.ssid) === undefined
      ? {}
      : { ssid: patch.ssid ?? previous?.ssid },
    ...(patch.lastError ?? previous?.lastError) === undefined
      ? {}
      : { lastError: patch.lastError ?? previous?.lastError },
  };
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const environmentCode = (environment: Environment): number => {
  switch (environment) {
    case 'development': return 0;
    case 'production': return 1;
    case 'gamma': return 2;
  }
};

const nativeProtocolStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const direct = Reflect.get(error, 'protocolStatus');
  if (typeof direct === 'number') return direct;
  const userInfo = Reflect.get(error, 'userInfo');
  if (!userInfo || typeof userInfo !== 'object') return undefined;
  const nested = Reflect.get(userInfo, 'protocolStatus');
  return typeof nested === 'number' ? nested : undefined;
};

const isAlreadyPaired = (error: unknown): boolean =>
  (error instanceof ProvisioningError && error.code === 'ALREADY_PAIRED') ||
  nativeProtocolStatus(error) === 4;

const provisioningError = (
  error: unknown,
  deviceId: string
): Error => {
  if (error instanceof ProvisioningError) return error;
  switch (nativeProtocolStatus(error)) {
    case 1: return ProvisioningError.invalidToken(deviceId);
    case 2: return ProvisioningError.storageError(deviceId);
    case 3: return ProvisioningError.chunkError(deviceId);
    case 4: return ProvisioningError.alreadyPaired(deviceId);
    default: return asError(error);
  }
};

let compatibilityResetSequence = 0;

const nextCompatibilityResetCommandId = (): string => {
  compatibilityResetSequence += 1;
  return `rn-reset-${Date.now().toString(36)}-${compatibilityResetSequence.toString(36)}`;
};

const factoryResetRejection = (
  error: unknown
): Extract<BleFactoryResetResult, { success: false }> | undefined => {
  switch (nativeProtocolStatus(error)) {
    case 1: return { success: false, error: 'invalid_token' };
    case 2: return { success: false, error: 'storage_error' };
    case 3: return { success: false, error: 'chunk_error' };
    case 4: return { success: false, error: 'already_paired' };
    default: return undefined;
  }
};
