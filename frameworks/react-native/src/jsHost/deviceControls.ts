import type { NativeConnectedDevice } from '../specs/NativeBotaDeviceSDK';
import type {
  BotaJsHostPorts, GattAddress, JsGattValue, JsHostContext, JsHostSubscription,
  JsValue, RawJsCoreFactory,
} from './contracts';

export interface JsControlConnection {
  readonly device: NativeConnectedDevice;
  /** Changes on every physical connection, including reconnects to the same serial. */
  readonly generation: string;
}

export interface JsDeviceControlsOptions {
  readonly ports: Pick<BotaJsHostPorts, 'ble' | 'persistence' | 'signal' | 'checkScope'>;
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly connection: () => JsControlConnection | null;
  readonly emit: (event: string, value: unknown) => void;
  /** The executor's ordered GATT lane, shared with active workflows. */
  readonly gatt: <T>(context: JsHostContext, body: () => Promise<T>) => Promise<T>;
  /** Retains the shared owner when a submitted STOP or unsubscribe cannot be confirmed. */
  readonly onCleanupFailure?: (error: unknown, context?: JsHostContext) => void;
}

interface Observer {
  readonly connection: JsControlConnection;
  readonly context: JsHostContext;
  readonly subscription: JsHostSubscription;
  readonly decoderId?: string;
  closing: boolean;
  cleanup: Promise<void> | null;
  releaseSignal: () => void;
  cleanupFailed: boolean;
}

const UPDATE_OPERATIONS = {
  startStatusUpdates: ['status', 'SERVICE_BOTA_CONTROL', 'CHAR_DEVICE_STATUS',
    'decodeDeviceStatus', 'onDeviceStatusUpdated'],
  startRecordingStateUpdates: ['recording', 'SERVICE_BOTA_CONTROL', 'CHAR_RECORDING_STATUS',
    'decodeRecordingState', 'onRecordingStateUpdated'],
  startWiFiStatusUpdates: ['wifi', 'SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_STATUS',
    'decodeWiFiStatus', 'onWiFiStatusUpdated'],
} as const;

/** BLE integration only. Packet formats and Bota response policy are supplied by Rust. */
export class JsDeviceControls {
  private readonly metadata: Record<string, JsValue>;
  private readonly observers = new Map<string, Observer>();
  private readonly operations = new Set<AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private ownershipUncertain = false;
  private poisonedError: unknown;
  private readonly failedRemovals = new Map<JsHostSubscription, JsHostContext>();
  private readonly namespace: string;
  private readonly scopeSignal?: AbortSignal;
  private readonly scopeCheck?: () => void;
  private scopeInvalidated = false;
  private readonly invalidateScope = () => {
    this.scopeInvalidated = true;
    void this.close().catch(error => this.markCleanupFailure(error));
  };

  constructor(private readonly options: JsDeviceControlsOptions) {
    this.metadata = record(options.core.codec('protocolMetadata', {}));
    this.namespace = options.ports.persistence.namespace;
    this.scopeSignal = options.ports.signal;
    this.scopeCheck = options.ports.checkScope;
    this.scopeSignal?.addEventListener('abort', this.invalidateScope, { once: true });
    if (this.scopeSignal?.aborted) this.invalidateScope();
  }

  /** Run within the executor's direct lease so workflows share the same owner. */
  execute(operation: string, args: readonly unknown[], context: JsHostContext): Promise<unknown> {
    if (this.ownershipUncertain) return Promise.reject(this.poisonedError);
    if (this.closed) return Promise.reject(controlError('cancelled', operation));
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    this.operations.add(controller);
    const local = { ...context, signal: controller.signal };
    const task = this.tail.catch(() => undefined).then(async () => {
      if (this.ownershipUncertain) throw this.poisonedError;
      throwIfAborted(local);
      return this.perform(operation, args, local);
    });
    this.tail = task;
    return task.finally(() => {
      const observer = [...this.observers.values()].find(owner => owner.context.signal === controller.signal);
      const release = () => {
        this.operations.delete(controller);
        context.signal.removeEventListener('abort', abort);
      };
      if (observer) observer.releaseSignal = release;
      else release();
    });
  }

  close(context?: JsHostContext): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.scopeSignal?.removeEventListener('abort', this.invalidateScope);
    const observers = [...this.observers];
    // Preserve the captured owners until the current close lease can issue STOP.
    for (const [, owner] of observers) owner.closing = true;
    for (const controller of this.operations) controller.abort();
    this.closePromise = this.tail.catch(() => undefined).then(async () => {
      const observerSubscriptions = new Set(observers.map(([, owner]) => owner.subscription));
      const pendingRemovals = [...this.failedRemovals].filter(([subscription]) => !observerSubscriptions.has(subscription));
      let failed = false;
      let failure: unknown;
      for (const [key, owner] of observers) {
        if (owner.cleanupFailed) { owner.cleanup = null; owner.cleanupFailed = false; }
        try { await this.closeObserver(key, owner, context); }
        catch (error) { if (!failed) failure = error; failed = true; }
      }
      for (const [subscription, priorContext] of pendingRemovals) {
        try { await this.removeSubscription(subscription, context ?? priorContext); }
        catch (error) { if (!failed) failure = error; failed = true; }
      }
      if (failed) throw failure;
    });
    return this.closePromise;
  }

  private async perform(operation: string, args: readonly unknown[], context: JsHostContext): Promise<unknown> {
    const stopKey = ({ stopStatusUpdates: 'status', stopRecordingStateUpdates: 'recording',
      stopWiFiStatusUpdates: 'wifi', stopDeviceLogs: 'logs' } as Record<string, string>)[operation];
    if (stopKey) {
      const observer = this.observers.get(stopKey);
      if (observer) await this.closeObserver(stopKey, observer, context);
      return;
    }
    const connection = this.capture(args[0], context);
    await this.verifySerial(connection, context);
    const update = UPDATE_OPERATIONS[operation as keyof typeof UPDATE_OPERATIONS];
    if (update) {
      const [key, service, characteristic, decoder, event] = update;
      await this.startObserver(key, service, characteristic, decoder, event, connection, context);
      return;
    }
    switch (operation) {
      case 'readStatus':
        return this.decodeRead('decodeDeviceStatus', 'SERVICE_BOTA_CONTROL', 'CHAR_DEVICE_STATUS', connection, context,
          { timestampMs: Date.now() });
      case 'readConnectionSettings':
        return this.decodeRead('decodeConnectionSettings', 'SERVICE_BOTA_PROVISIONING', 'CHAR_DEVICE_SETTINGS', connection, context);
      case 'writeConnectionSettings':
        return this.writeEncoded('encodeConnectionSettings', { settings: json(args[1]), model: connection.device.deviceType },
          'SERVICE_BOTA_PROVISIONING', 'CHAR_DEVICE_SETTINGS', connection, context);
      case 'isProvisioned':
        return this.decodeRead('decodeProvisioningState', 'SERVICE_BOTA_PROVISIONING', 'CHAR_PAIRING_STATE', connection, context);
      case 'readPublicKey':
        return this.decodeRead('decodeHex', 'SERVICE_BOTA_AUTH', 'CHAR_PK_D', connection, context, { length: 64 });
      case 'readAuthNonce':
        return this.decodeRead('decodeHex', 'SERVICE_BOTA_AUTH', 'CHAR_AUTH_NONCE', connection, context, { length: 16 });
      case 'readIdentity': {
        const serialNumber = await this.decodeRead('decodeText', 'SERVICE_DEVICE_INFO', 'CHAR_SERIAL_NUMBER', connection, context, { required: true });
        const deviceType = await this.decodeRead('decodeText', 'SERVICE_DEVICE_INFO', 'CHAR_MODEL_NUMBER', connection, context, { required: true });
        const firmwareVersion = await this.decodeRead('decodeText', 'SERVICE_DEVICE_INFO', 'CHAR_FIRMWARE_REVISION', connection, context, { required: true });
        const hardwareRevision = await this.decodeRead('decodeText', 'SERVICE_DEVICE_INFO', 'CHAR_HARDWARE_REVISION', connection, context, { required: false });
        return { serialNumber, deviceType, firmwareVersion, hardwareRevision };
      }
      case 'setApiEndpoint':
        return this.writeEncoded('encodeApiEndpoint', { environment: json(args[1]) },
          'SERVICE_BOTA_PROVISIONING', 'CHAR_API_ENDPOINT', connection, context);
      case 'deliverCertificate': {
        const chunks = array(this.codec('encodeCertificateChunks', {
          certificatePem: json(args[1]), privateKeyPem: json(args[2]), mtu: connection.device.mtu,
        }));
        for (const chunk of chunks) await this.writeBytes(bytes(chunk),
          'SERVICE_BOTA_AUTH', 'CHAR_DEVICE_CERT', connection, context);
        return;
      }
      case 'deliverBackendPublicKey':
        return this.writeEncoded('encodeBackendPublicKey', { publicKeyHex: json(args[1]) },
          'SERVICE_BOTA_AUTH', 'CHAR_BACKEND_PUBKEY', connection, context);
      case 'writeGrant':
        return this.writeEncoded('encodeGrant', { grantBlob: json(args[1]), capacity: this.capacity(connection) },
          'SERVICE_BOTA_CONTROL', 'CHAR_DEVICE_COMMAND', connection, context);
      case 'syncTime': {
        const now = new Date();
        return this.writeEncoded('encodeTimeSync', { epochMilliseconds: String(now.getTime()),
          timezoneOffsetMinutes: -now.getTimezoneOffset() },
        'SERVICE_BOTA_CONTROL', 'CHAR_TIME_SYNC', connection, context);
      }
      case 'readRecordingState':
        return this.decodeRead('decodeRecordingState', 'SERVICE_BOTA_CONTROL', 'CHAR_RECORDING_STATUS', connection, context);
      case 'requestStartRecording':
      case 'requestStopRecording':
        return this.recordingControl(operation === 'requestStartRecording' ? 'start' : 'stop', args[1], connection, context);
      case 'configureWiFi':
        return this.configureWiFi(json(args[1]), json(args[2]), json(args[3]), connection, context);
      case 'disconnectWiFi':
        return this.configureWiFi('', '', undefined, connection, context);
      case 'readWiFiStatus':
        return this.decodeRead('decodeWiFiStatus', 'SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_STATUS', connection, context);
      case 'scanWiFiNetworks':
        return this.scanWiFi(connection, context);
      case 'startDeviceLogs':
        return this.startLogs(connection, context);
      case 'readDiagnosticEvents':
        return this.readDiagnostics(connection, context);
      case 'acknowledgeDiagnosticEvents':
        return this.acknowledgeDiagnostics(args[1], connection, context);
      default:
        throw controlError('unsupported_capability', operation);
    }
  }

  private capture(requested: unknown, context: JsHostContext): JsControlConnection {
    const current = this.options.connection();
    if (!current) throw controlError('not_connected', context.operation);
    if (requested !== undefined) {
      if (typeof requested !== 'object' || !requested
        || (requested as NativeConnectedDevice).id !== current.device.id
        || (requested as NativeConnectedDevice).serialNumber !== current.device.serialNumber) {
        throw controlError('identity_mismatch', context.operation);
      }
    }
    return { device: { ...current.device }, generation: current.generation };
  }

  private requireOwner(connection: JsControlConnection, context: JsHostContext): void {
    throwIfAborted(context);
    if (this.scopeInvalidated || this.scopeSignal?.aborted || this.options.ports.persistence.namespace !== this.namespace) {
      this.scopeInvalidated = true;
      throw controlError('scope_changed', context.operation);
    }
    try { this.scopeCheck?.(); }
    catch { this.invalidateScope(); throw controlError('scope_changed', context.operation); }
    const current = this.options.connection();
    if (!current || current.generation !== connection.generation
      || current.device.id !== connection.device.id
      || current.device.serialNumber !== connection.device.serialNumber) {
      throw controlError('identity_mismatch', context.operation);
    }
  }

  private async verifySerial(connection: JsControlConnection, context: JsHostContext): Promise<void> {
    const actual = await this.decodeRead('decodeText', 'SERVICE_DEVICE_INFO', 'CHAR_SERIAL_NUMBER', connection, context, { required: true });
    if (actual !== connection.device.serialNumber) throw controlError('identity_mismatch', context.operation);
  }

  private address(service: string, characteristic: string, connection: JsControlConnection): GattAddress {
    const serviceUuid = this.metadata[service];
    const characteristicUuid = this.metadata[characteristic];
    if (typeof serviceUuid !== 'string' || typeof characteristicUuid !== 'string') {
      throw controlError('unsupported_capability', 'protocolMetadata');
    }
    return { peripheralId: connection.device.id, serviceUuid, characteristicUuid };
  }

  private async step<T>(connection: JsControlConnection, context: JsHostContext, body: () => Promise<T>): Promise<T> {
    this.requireOwner(connection, context);
    // Keep the lease until an in-flight OS effect settles, even after cancellation.
    const value = await this.options.gatt(context, body);
    this.requireOwner(connection, context);
    return value;
  }

  private async decodeRead(name: string, service: string, characteristic: string,
    connection: JsControlConnection, context: JsHostContext, input: Record<string, JsValue> = {}): Promise<JsValue> {
    const value = await this.step(connection, context, () => this.options.ports.ble.read(this.address(service, characteristic, connection), context));
    return this.codec(name, { ...input, bytes: publicBytes(value) });
  }

  private capacity(connection: JsControlConnection): number { return connection.device.mtu - 3; }

  private codec(name: string, input: JsValue): JsValue { return this.options.core.codec(name, input); }

  private async writeEncoded(name: string, input: JsValue, service: string, characteristic: string,
    connection: JsControlConnection, context: JsHostContext): Promise<void> {
    await this.writeBytes(bytes(this.codec(name, input)), service, characteristic, connection, context);
  }

  private async writeBytes(value: Uint8Array, service: string, characteristic: string,
    connection: JsControlConnection, context: JsHostContext): Promise<void> {
    try {
      await this.step(connection, context, () => this.options.ports.ble.write(this.address(service, characteristic, connection), value, true, context));
    } finally { value.fill(0); }
  }

  private async recordingControl(action: 'start' | 'stop', grant: unknown,
    connection: JsControlConnection, context: JsHostContext): Promise<JsValue> {
    const encodedGrant = bytes(this.codec('encodeGrant', { grantBlob: json(grant), capacity: this.capacity(connection) }));
    const command = bytes(this.codec('encodeRecordingControlCommand', { action }));
    try {
      return await this.withResult('SERVICE_BOTA_CONTROL', 'CHAR_RECORDING_STATUS', connection, context,
        value => this.codec('decodeRecordingControlNotification', { bytes: publicBytes(value), action }),
        async beginResults => {
          await this.writeBytes(encodedGrant, 'SERVICE_BOTA_CONTROL', 'CHAR_DEVICE_COMMAND', connection, context);
          if (action === 'stop') await this.delay(this.numberMetadata('recordingStopDelayMs'), context);
          beginResults();
          await this.writeBytes(command, 'SERVICE_BOTA_CONTROL', 'CHAR_RECORDING_CONTROL', connection, context);
        });
    } finally { encodedGrant.fill(0); command.fill(0); }
  }

  private async configureWiFi(ssid: JsValue, password: JsValue, grant: unknown,
    connection: JsControlConnection, context: JsHostContext): Promise<JsValue> {
    const credentials = bytes(this.codec('encodeWiFiCredentials', { ssid, password }));
    const encodedGrant = grant === undefined ? null : bytes(this.codec('encodeWiFiGrant', {
      grant: json(grant), capacity: this.capacity(connection),
    }));
    try {
      return await this.withResult('SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_CREDENTIAL', connection, context,
        value => this.codec('decodeWiFiConfigResult', { bytes: publicBytes(value) }), async beginResults => {
          if (encodedGrant) await this.writeBytes(encodedGrant, 'SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_GRANT', connection, context);
          beginResults();
          await this.writeBytes(credentials, 'SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_CREDENTIAL', connection, context);
        });
    } finally { credentials.fill(0); encodedGrant?.fill(0); }
  }

  private async scanWiFi(connection: JsControlConnection, context: JsHostContext): Promise<JsValue> {
    return this.withResult('SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_SCAN', connection, context, value => {
      const update = record(this.codec('decodeWiFiScanUpdate', { bytes: publicBytes(value) }));
      return update.kind === 'pending' ? null : update.result ?? update;
    }, beginResults => {
      beginResults();
      return this.writeEncoded('encodeWiFiScanCommand', {}, 'SERVICE_BOTA_WIFI_CONFIG', 'CHAR_WIFI_SCAN', connection, context);
    });
  }

  private requireDiagnosticsIdle(context: JsHostContext): void {
    if (this.observers.has('logs')) throw controlError('operation_in_progress', context.operation);
  }

  private async readDiagnostics(connection: JsControlConnection, context: JsHostContext): Promise<JsValue> {
    this.requireDiagnosticsIdle(context);
    const decoderId = `${context.operationId}:${connection.generation}:diagnostics`;
    const command = bytes(this.codec('encodeDiagnosticsList', {}));
    try {
      this.codec('resetDiagnostics', { decoderId });
      return await this.withResult('SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_DATA', connection, context,
        value => this.codec('decodeDiagnostics', { decoderId, bytes: publicBytes(value) }),
        async beginResults => {
          beginResults();
          await this.writeBytes(command, 'SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_CONTROL', connection, context);
        });
    } finally {
      command.fill(0);
      this.codec('resetDiagnostics', { decoderId });
    }
  }

  private async acknowledgeDiagnostics(acceptedEventIds: unknown, connection: JsControlConnection,
    context: JsHostContext): Promise<void> {
    this.requireDiagnosticsIdle(context);
    if (!Array.isArray(acceptedEventIds)) throw controlError('invalid_input', context.operation);
    const commands: Uint8Array[] = [];
    try {
      // Validate the complete caller-selected batch in Rust before acknowledging any event.
      for (const eventId of acceptedEventIds) {
        commands.push(bytes(this.codec('encodeDiagnosticsAcknowledge', { eventId: json(eventId) })));
      }
      for (const command of commands) {
        await this.writeBytes(command, 'SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_CONTROL', connection, context);
      }
    } finally { for (const command of commands) command.fill(0); }
  }

  private async withResult(service: string, characteristic: string, connection: JsControlConnection,
    context: JsHostContext, decode: (value: JsGattValue) => JsValue | null, command: (beginResults: () => void) => Promise<void>): Promise<JsValue> {
    let accepting = false;
    let resolve!: (value: JsValue) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<JsValue>((yes, no) => { resolve = yes; reject = no; });
    // A synchronous callback may fail before a submitted command has settled.
    void result.catch(() => undefined);
    // Subscribe may synchronously deliver a stale snapshot. Ignore until command starts.
    this.requireOwner(connection, context);
    const subscription = await this.options.gatt(context, () => this.options.ports.ble.subscribe(this.address(service, characteristic, connection), value => {
      if (!accepting) return;
      try {
        this.requireOwner(connection, context);
        const decoded = decode(value);
        if (decoded !== null) resolve(decoded);
      } catch (error) { reject(error); }
    }, context, reject));
    try {
      this.requireOwner(connection, context);
      await command(() => { accepting = true; });
      return await waitResult(result, this.numberMetadata('operationTimeoutMs'), context);
    } finally {
      accepting = false;
      await this.removeSubscription(subscription, context);
    }
  }

  private async startObserver(key: string, service: string, characteristic: string,
    decoder: string, event: string, connection: JsControlConnection, context: JsHostContext): Promise<void> {
    const prior = this.observers.get(key);
    if (prior) await this.closeObserver(key, prior, context);
    let owner: Observer | null = null;
    this.requireOwner(connection, context);
    const subscription = await this.options.gatt(context, () => this.options.ports.ble.subscribe(this.address(service, characteristic, connection), value => {
      if (!owner || owner.closing || this.closed) return;
      try {
        this.requireOwner(connection, context);
        this.options.emit(event, this.codec(decoder, { bytes: publicBytes(value), timestampMs: Date.now() }));
      } catch { void this.closeObserver(key, owner).catch(() => undefined); }
    }, context, error => {
      this.markCleanupFailure(error, context);
      if (owner) void this.closeObserver(key, owner).catch(() => undefined);
    }));
    owner = { connection, context, subscription, closing: false, cleanup: null, releaseSignal: () => undefined, cleanupFailed: false };
    try {
      this.requireOwner(connection, context);
      this.observers.set(key, owner);
      const captured = owner;
      context.signal.addEventListener('abort', () => {
        if (!captured.closing) void this.closeObserver(key, captured).catch(() => undefined);
      }, { once: true });
    } catch (error) { await this.removeSubscription(subscription, context); throw error; }
  }

  private async startLogs(connection: JsControlConnection, context: JsHostContext): Promise<void> {
    const prior = this.observers.get('logs');
    if (prior) await this.closeObserver('logs', prior, context);
    const decoderId = `${context.operationId}:${connection.generation}`;
    this.codec('resetDeviceLogs', { decoderId });
    let owner: Observer | null = null;
    const pending: JsGattValue[] = [];
    const deliver = (value: JsGattValue) => {
      if (!owner) { pending.push(value instanceof Uint8Array ? value.slice() : value); return; }
      if (owner.closing || this.closed) return;
      try {
        this.requireOwner(connection, context);
        for (const line of array(this.codec('decodeDeviceLogs', { bytes: publicBytes(value), decoderId }))) {
          this.options.emit('onDeviceLog', line);
        }
      } catch { void this.closeObserver('logs', owner).catch(() => undefined); }
    };
    this.requireOwner(connection, context);
    const subscription = await this.options.gatt(context, () => this.options.ports.ble.subscribe(
      this.address('SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_DATA', connection), deliver, context, error => {
        this.markCleanupFailure(error, context);
        if (owner) void this.closeObserver('logs', owner).catch(() => undefined);
      }));
    owner = { connection, context, subscription, decoderId, closing: false, cleanup: null, releaseSignal: () => undefined, cleanupFailed: false };
    this.observers.set('logs', owner);
    try {
      await this.writeEncoded('encodeDeviceLogControl', { enabled: true }, 'SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_CONTROL', connection, context);
      for (const value of pending) deliver(value);
      const captured = owner;
      context.signal.addEventListener('abort', () => {
        if (!captured.closing) void this.closeObserver('logs', captured).catch(() => undefined);
      }, { once: true });
    } catch (error) { await this.closeObserver('logs', owner, context); throw error; }
  }

  private closeObserver(key: string, owner: Observer, cleanupContext?: JsHostContext): Promise<void> {
    if (owner.cleanup) return owner.cleanup;
    owner.closing = true;
    if (this.observers.get(key) === owner) this.observers.delete(key);
    owner.cleanup = (async () => {
      let failed = false;
      let failure: unknown;
      try {
        if (key === 'logs' && cleanupContext) {
          const context = { ...cleanupContext, signal: new AbortController().signal };
          const current = this.options.connection();
          if (current?.generation === owner.connection.generation
            && current.device.id === owner.connection.device.id
            && current.device.serialNumber === owner.connection.device.serialNumber) {
            await this.writeEncoded('encodeDeviceLogControl', { enabled: false }, 'SERVICE_BOTA_DIAGNOSTICS', 'CHAR_DEVICE_LOG_CONTROL', owner.connection, context);
          }
        }
      } catch (error) {
        this.markCleanupFailure(error, cleanupContext ?? owner.context);
        failed = true;
        failure = error;
      }
      try { await this.removeSubscription(owner.subscription, cleanupContext ?? owner.context); }
      catch (error) { if (!failed) failure = error; failed = true; }
      owner.releaseSignal();
      try { if (owner.decoderId) this.codec('resetDeviceLogs', { decoderId: owner.decoderId }); }
      catch (error) {
        this.markCleanupFailure(error, cleanupContext ?? owner.context);
        if (!failed) failure = error;
        failed = true;
      }
      if (failed) {
        owner.cleanupFailed = true;
        this.observers.set(key, owner);
        throw failure;
      }
    })();
    return owner.cleanup;
  }

  private markCleanupFailure(error: unknown, context?: JsHostContext): void {
    if (!this.ownershipUncertain) this.poisonedError = error;
    this.ownershipUncertain = true;
    // Keep the original OS failure even if the owner-retention callback also rejects.
    try { this.options.onCleanupFailure?.(error, context); } catch {}
  }

  private async removeSubscription(subscription: JsHostSubscription, context: JsHostContext): Promise<void> {
    try {
      await subscription.remove();
      this.failedRemovals.delete(subscription);
    } catch (error) {
      this.failedRemovals.set(subscription, context);
      this.markCleanupFailure(error, context);
      throw error;
    }
  }

  private numberMetadata(name: string): number {
    const value = this.metadata[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw controlError('unsupported_capability', 'protocolMetadata');
    }
    return value;
  }

  private delay(milliseconds: number, context: JsHostContext): Promise<void> {
    return waitResult(new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
      milliseconds + this.numberMetadata('operationTimeoutMs'), context);
  }
}

function json(value: unknown): JsValue {
  if (value === undefined) throw controlError('invalid_input', 'device_control');
  return value as JsValue;
}

function record(value: JsValue): Record<string, JsValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('protocol_error', 'codec');
  return value as Record<string, JsValue>;
}

function array(value: JsValue): readonly JsValue[] {
  if (!Array.isArray(value)) throw controlError('protocol_error', 'codec');
  return value;
}

function bytes(value: JsValue): Uint8Array {
  const values = array(value);
  if (values.some(item => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255)) {
    throw controlError('protocol_error', 'codec');
  }
  return Uint8Array.from(values as readonly number[]);
}

function publicBytes(value: JsGattValue): number[] {
  if (!(value instanceof Uint8Array)) throw controlError('unsupported_capability', 'public_device_read');
  return Array.from(value);
}

function controlError(code: string, operation: string): Error & { code: string; operation: string; retryable: boolean } {
  return Object.assign(new Error(`${operation}: ${code}`), { code, operation, retryable: false });
}

function throwIfAborted(context: JsHostContext): void {
  if (context.signal.aborted) throw controlError('cancelled', context.operation);
}

async function waitResult<T>(promise: Promise<T>, timeoutMs: number, context: JsHostContext): Promise<T> {
  throwIfAborted(context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interruption = new Promise<never>((_, reject) => {
    abort = () => reject(controlError('cancelled', context.operation));
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(controlError('timeout', context.operation)), timeoutMs);
  });
  try { return await Promise.race([promise, interruption]); }
  finally { if (timer !== undefined) clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
}
