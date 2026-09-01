import EventEmitter from 'eventemitter3';

import type { BotaDeviceSDKClient } from './client';
import { getCompatibilityClient } from './compatibility/runtime';
import { DeviceManager } from './managers/DeviceManager';
import { OTAManager } from './managers/OTAManager';
import { RecordingManager } from './managers/RecordingManager';
import type {
  BluetoothState,
  BotaClientEvents,
  BotaConfig,
  LogLevel,
  SdkState,
} from './models/Status';
import { BluetoothError, SdkError } from './utils/errors';
import { logger, type LogHandler } from './utils/logger';

const log = logger.tag('BotaClient');

const normalizeConfig = (config: BotaConfig): Required<BotaConfig> => ({
  environment: config.environment ?? 'production',
  backgroundSyncEnabled: config.backgroundSyncEnabled ?? true,
  wifiOnlyUpload: config.wifiOnlyUpload ?? false,
  logLevel: config.logLevel ?? 'warn',
  debug: config.debug ?? false,
});

class BotaClientImpl extends EventEmitter<BotaClientEvents> {
  private _config: BotaConfig | null = null;
  private _state: SdkState = 'uninitialized';
  private _bluetoothState: BluetoothState = 'unknown';
  private _client: BotaDeviceSDKClient | null = null;
  private _deviceManager: DeviceManager | null = null;
  private _recordingManager: RecordingManager | null = null;
  private _otaManager: OTAManager | null = null;
  private _nativeOwned = false;
  private _operation: Promise<void> = Promise.resolve();
  private _configurePromise: Promise<void> | null = null;
  private _destroyPromise: Promise<void> | null = null;

  get state(): SdkState {
    return this._state;
  }

  get bluetoothState(): BluetoothState {
    return this._bluetoothState;
  }

  get isBluetoothReady(): boolean {
    return this._bluetoothState === 'poweredOn';
  }

  get isInitialized(): boolean {
    return this._state === 'ready';
  }

  get config(): BotaConfig | null {
    return this._config;
  }

  get devices(): DeviceManager {
    if (!this._deviceManager) throw SdkError.notInitialized();
    return this._deviceManager;
  }

  get recordings(): RecordingManager {
    if (!this._recordingManager) throw SdkError.notInitialized();
    return this._recordingManager;
  }

  get ota(): OTAManager {
    if (!this._otaManager) throw SdkError.notInitialized();
    return this._otaManager;
  }

  configure(config: BotaConfig = {}): Promise<void> {
    if (this._configurePromise && !this._destroyPromise) {
      return this._configurePromise;
    }
    const normalized = normalizeConfig(config);
    const operation = this.enqueue(() => this.performConfigure(normalized));
    this._configurePromise = operation;
    void operation
      .finally(() => {
        if (this._configurePromise === operation) this._configurePromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async waitForBluetooth(timeoutMs: number = 10000): Promise<void> {
    if (!this._client || !this._nativeOwned) throw SdkError.notInitialized();
    if (this._bluetoothState === 'poweredOn') return;
    if (this._bluetoothState === 'unsupported') {
      throw BluetoothError.unavailable();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
      const capabilities = await this._client.getCapabilities();
      const state: BluetoothState = capabilities.bluetooth
        ? 'poweredOn'
        : 'unsupported';
      this.setBluetoothState(state);
      if (state === 'poweredOn') return;
      if (state === 'unsupported') {
        throw BluetoothError.unavailable();
      }
    }
    throw SdkError.timeout('Bluetooth ready');
  }

  setLogLevel(level: LogLevel): void {
    logger.setLevel(level);
    if (this._config) this._config.logLevel = level;
  }

  setLogHandler(handler: LogHandler | null): void {
    logger.setHandler(handler);
  }

  destroy(): Promise<void> {
    if (this._destroyPromise) return this._destroyPromise;
    const operation = this.enqueue(async () => {
      await this.releaseOwnerGraph();
      this.removeAllListeners();
    });
    this._destroyPromise = operation;
    void operation
      .finally(() => {
        if (this._destroyPromise === operation) this._destroyPromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this._operation.catch(() => undefined).then(operation);
    this._operation = queued.catch(() => undefined);
    return queued;
  }

  private async performConfigure(config: Required<BotaConfig>): Promise<void> {
    if (this._state !== 'uninitialized' || this._nativeOwned) {
      log.warn('SDK already configured, reconfiguring');
      await this.releaseOwnerGraph();
    }

    this._config = config;
    logger.setLevel(config.logLevel);
    this.setState('initializing');
    const client = getCompatibilityClient();
    this._client = client;
    this._nativeOwned = true;

    let deviceManager: DeviceManager | null = null;
    let recordingManager: RecordingManager | null = null;
    let otaManager: OTAManager | null = null;
    try {
      await client.configure({ logLevel: config.logLevel });
      const nativeState = await client.getState();
      if (nativeState !== 'ready') {
        throw SdkError.invalidState('ready', nativeState);
      }
      const capabilities = await client.getCapabilities();
      this.setBluetoothState(
        capabilities.bluetooth ? 'poweredOn' : 'unsupported'
      );

      deviceManager = new DeviceManager();
      await deviceManager.initialize();
      recordingManager = new RecordingManager();
      await recordingManager.initialize();
      otaManager = new OTAManager(deviceManager);

      this._deviceManager = deviceManager;
      this._recordingManager = recordingManager;
      this._otaManager = otaManager;
      this.setState(nativeState);
      log.info('SDK configured successfully', {
        environment: config.environment,
        bluetoothState: this._bluetoothState,
      });
    } catch (error) {
      deviceManager?.destroy();
      recordingManager?.destroy();
      otaManager?.destroy();
      await client.destroy().catch(() => undefined);
      this._nativeOwned = false;
      this._client = null;
      this.setState('error');
      const failure = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to configure SDK', failure);
      this.emit('error', failure);
      throw error;
    }
  }

  private async releaseOwnerGraph(): Promise<void> {
    this._deviceManager?.destroy();
    this._recordingManager?.destroy();
    this._otaManager?.destroy();
    this._deviceManager = null;
    this._recordingManager = null;
    this._otaManager = null;

    const client = this._client;
    this._client = null;
    if (client && this._nativeOwned) await client.destroy();
    this._nativeOwned = false;
    this._config = null;
    this.setState('uninitialized');
  }

  private setState(state: SdkState): void {
    if (state === this._state) return;
    this._state = state;
    this.emit('stateChanged', state);
  }

  private setBluetoothState(state: BluetoothState): void {
    if (state === this._bluetoothState) return;
    this._bluetoothState = state;
    this.emit('bluetoothStateChanged', state);
  }
}

export const BotaClient = new BotaClientImpl();

export type { BluetoothState, BotaConfig, SdkState };
