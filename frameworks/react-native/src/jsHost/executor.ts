import type {
  BotaJsHostPorts, CoreCapability, GattAddress, JsEffectContext, JsEffectHandler,
  JsHostContext, JsHostSubscription, JsValue, JsWorkflowOptions, JsWorkflowResult,
  RawCoreEffect, RawCoreRequest, RawCoreResult, RawJsCoreEngine, RawJsCoreFactory,
} from './contracts';

export class BotaJsHostError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly retryable: boolean;
  readonly protocolStatus?: number;

  constructor(code: string, operation: string, retryable = false, protocolStatus?: number) {
    super(`${operation}: ${code}`);
    this.name = 'BotaJsHostError';
    this.code = code;
    this.operation = operation;
    this.retryable = retryable;
    this.protocolStatus = protocolStatus;
  }
}

interface Owner {
  kind: 'workflow' | 'direct';
  operation: string;
  operationId: string;
  generation: string;
  cancellation: number[];
  controller: AbortController;
  cleanupController: AbortController;
  requests: Map<string, RawCoreEffect>;
  queue: RawCoreEffect[];
  subscriptions: Map<string, JsHostSubscription>;
  bleSubscriptions: Map<string, { effect: RawCoreEffect; peripheralId?: string }>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  cleanups: Array<() => Promise<void>>;
  pending: Set<Promise<unknown>>;
  notifications: JsValue[];
  result: Promise<JsWorkflowResult>;
  resolve(value: JsWorkflowResult): void;
  reject(error: unknown): void;
  settled: Promise<void>;
  settle(): void;
  status: JsValue;
  command?: JsValue;
  options: JsWorkflowOptions;
  pumping: boolean;
  cancelling: boolean;
  finished: boolean;
  cleaning: boolean;
  started: boolean;
  failure?: unknown;
  cleanupFailure?: unknown;
  cancelPromise?: Promise<void>;
  removeExternalAbort?: () => void;
}

const record = (value: JsValue): { readonly [key: string]: JsValue } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotaJsHostError('invalid_core_effect', 'HostEffect');
  }
  return value as { readonly [key: string]: JsValue };
};
const tag = (value: JsValue): [string, JsValue] => {
  if (typeof value === 'string') return [value, null];
  const entries = Object.entries(record(value));
  if (entries.length !== 1) throw new BotaJsHostError('invalid_core_effect', 'HostEffect');
  return entries[0]!;
};
const string = (value: JsValue | undefined): string => {
  if (typeof value !== 'string') throw new BotaJsHostError('invalid_core_effect', 'HostEffect');
  return value;
};
const decimal = (value: JsValue | undefined): string => {
  const result = string(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(result) || BigInt(result) > 18446744073709551615n) {
    throw new BotaJsHostError('invalid_core_identity', 'HostEffect');
  }
  return result;
};
const bytes = (value: JsValue | undefined): Uint8Array => {
  if (!Array.isArray(value) || value.length > 65536 ||
      value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new BotaJsHostError('invalid_core_bytes', 'HostEffect');
  }
  return Uint8Array.from(value as number[]);
};
const hex = (value: readonly number[]): string => value.map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Executes shared-core effects over primitive OS capabilities with one exact owner. */
export class BotaJsHostExecutor {
  readonly ports: BotaJsHostPorts;
  readonly core: RawJsCoreFactory;
  private readonly engine: RawJsCoreEngine;
  private readonly handlers = new Map<string, JsEffectHandler>();
  private active: Owner | undefined;
  private generation = 0n;
  private destroyed = false;
  private destroyPromise: Promise<void> | undefined;
  private gattTail: Promise<void> = Promise.resolve();
  private peripheralId: string | undefined;
  private uncertainResourceFailure: unknown;
  private borrowedControl: Promise<unknown> | undefined;
  private readonly namespace: string;
  private readonly scopeSignal?: AbortSignal;
  private readonly scopeCheck?: () => void;
  private scopeInvalidated = false;
  private readonly invalidateScope = () => {
    this.scopeInvalidated = true;
    const owner = this.active;
    if (owner && !owner.finished) {
      owner.failure ??= new BotaJsHostError('scope_changed', owner.operation);
      void this.cancel(owner.operationId).catch(() => {});
    }
  };

  constructor(core: RawJsCoreFactory, ports: BotaJsHostPorts) {
    if (!ports.persistence.namespace.trim()) throw new BotaJsHostError('invalid_scope', 'Configure');
    this.core = core;
    this.ports = ports;
    this.namespace = ports.persistence.namespace;
    this.scopeSignal = ports.signal;
    this.scopeCheck = ports.checkScope;
    this.engine = core.createEngine();
    this.scopeSignal?.addEventListener('abort', this.invalidateScope, { once: true });
    if (this.scopeSignal?.aborted) this.invalidateScope();
  }

  get connectedPeripheralId(): string | undefined { return this.peripheralId; }
  get activeOperationId(): string | undefined { return this.active?.operationId; }

  /** A direct/passive port failed teardown; no new owner may reuse its resources. */
  markCleanupFailed(error: unknown): void {
    this.uncertainResourceFailure ??= error;
    const owner = this.active;
    if (owner) {
      owner.cleanupFailure ??= error;
      if (!owner.finished) void this.cancel(owner.operationId).catch(() => {});
    }
  }

  /** The owning host calls this only after its exact OS disconnect is confirmed. */
  didDisconnect(peripheralId: string): void {
    if (this.peripheralId === peripheralId) this.peripheralId = undefined;
  }

  /** Route this exact OS link event through the owning live core subscription. */
  async peripheralDisconnected(peripheralId: string, reasonCode: number | null = null): Promise<boolean> {
    if (this.peripheralId !== peripheralId) return false;
    this.peripheralId = undefined;
    const owner = this.active;
    if (!owner || owner.finished || owner.controller.signal.aborted) return true;
    const subscription = [...owner.bleSubscriptions.values()].find(value => value.peripheralId === peripheralId);
    if (owner.kind === 'workflow' && subscription) {
      await this.externalBleEvent(owner, subscription.effect, {
        Disconnected: { peripheral_id: peripheralId,
          reason_code: reasonCode !== null && Number.isInteger(reasonCode) && reasonCode >= 0 && reasonCode <= 65535 ? reasonCode : null },
      });
    } else if (owner.kind === 'workflow' && owner.operation === 'UpdateFirmware' &&
        owner.notifications.some(value => {
          const notification = record(value).FirmwareProgress;
          return notification !== undefined && record(record(notification).progress!).phase === 'Reconnecting';
        })) {
      // The core already accepted the closed status stream and began recovery.
      // A later OS event belongs to that lost link, not a replacement operation.
    } else {
      owner.failure ??= new BotaJsHostError('connection_failed', owner.operation, true);
      await this.cancel(owner.operationId);
    }
    return true;
  }

  /** Register JS mechanics for sink/material effects not handled by the generic executor. */
  registerHandler(family: string, handler: JsEffectHandler): void {
    if (this.active || this.destroyed) throw new BotaJsHostError('operation_in_progress', 'RegisterHost');
    if (this.handlers.has(family)) throw new BotaJsHostError('duplicate_host_handler', 'RegisterHost');
    this.handlers.set(family, handler);
  }

  async run(command: JsValue, options: JsWorkflowOptions,
    cleanup?: (context: JsHostContext) => Promise<void>): Promise<JsWorkflowResult> {
    const owner = this.claim(options, 'workflow');
    if (cleanup) owner.cleanups.push(() => cleanup(this.context(owner, '0')));
    owner.command = command;
    try {
      await this.initializeCancellation(owner);
      if (owner.controller.signal.aborted) throw new BotaJsHostError('operation_cancelled', owner.operation);
      owner.started = true;
      this.accept(owner, this.request(owner, {
        action: 'start', command, capabilities: options.capabilities ?? this.capabilities(),
      }));
      this.pump(owner);
    } catch (error) {
      owner.failure = error;
      if (owner.started) await this.cancel(owner.operationId);
      else await this.finish(owner);
    }
    return owner.result;
  }

  async direct<T>(operation: string, body: (context: JsHostContext) => Promise<T>,
    options: Pick<JsWorkflowOptions, 'operationId' | 'signal'> = {}): Promise<T> {
    const owner = this.claim({ ...options, operation }, 'direct');
    try {
      await this.initializeCancellation(owner);
      if (owner.controller.signal.aborted) throw new BotaJsHostError('operation_cancelled', owner.operation);
      const context = this.context(owner, '0');
      const value = await this.track(owner, body(context));
      this.check(context);
      await this.finish(owner);
      if (owner.cleanupFailure) throw owner.cleanupFailure;
      if (owner.failure) throw owner.failure;
      if (owner.controller.signal.aborted) throw new BotaJsHostError('operation_cancelled', operation);
      return value;
    } catch (error) {
      owner.failure = error;
      await this.finish(owner);
      throw error;
    }
  }

  /** The adapter admits the narrow control through shared Rust policy first. */
  async borrowDirect<T>(operationId: string, body: (context: JsHostContext) => Promise<T>): Promise<T> {
    const owner = this.active;
    if (!owner || owner.kind !== 'direct' || owner.operationId !== operationId || owner.cleaning ||
        owner.finished || this.borrowedControl) throw new BotaJsHostError('operation_in_progress', 'DeviceControl');
    const context = this.context(owner, '0');
    this.check(context);
    const work = this.track(owner, Promise.resolve().then(() => {
      this.check(context);
      return body(context);
    }));
    this.borrowedControl = work;
    try { const result = await work; this.check(context); return result; }
    finally { if (this.borrowedControl === work) this.borrowedControl = undefined; }
  }

  /** All active GATT effects and direct controls use this same ordered queue. */
  async gatt<T>(context: JsHostContext, body: () => Promise<T>): Promise<T> {
    this.check(context);
    const pending = this.gattTail.then(async () => {
      this.check(context);
      return body();
    });
    this.gattTail = pending.then(() => undefined, () => undefined);
    try { return await pending; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'cleanup_incomplete') {
        this.markCleanupFailed(error);
      }
      throw error;
    }
  }

  check(context: JsHostContext): void {
    const owner = this.active;
    if (!owner || owner.finished || owner.operation !== context.operation ||
        owner.operationId !== context.operationId || owner.generation !== context.generation ||
        hex(owner.cancellation) !== context.cancellationId || context.signal.aborted) {
      throw new BotaJsHostError('stale_host_owner', context.operation);
    }
    // Terminal cleanup uses the captured cleanup signal and resources; it may
    // settle after logout, but normal work cannot enter the replacement scope.
    if (context.signal === owner.controller.signal) this.requireScope(context.operation);
  }

  async cancel(operationId: string): Promise<void> {
    const owner = this.active;
    if (!owner || owner.operationId !== operationId) return;
    if (owner.cancelPromise) return owner.cancelPromise;
    owner.cancelling = true;
    owner.controller.abort();
    owner.queue.length = 0;
    owner.requests.clear();
    if (owner.kind === 'workflow' && owner.started) {
      try { this.accept(owner, this.request(owner, { action: 'cancel' })); }
      catch (error) { owner.failure ??= error; }
      this.pump(owner);
    }
    owner.cancelPromise = owner.settled.then(() => {
      if (owner.cleanupFailure) throw owner.cleanupFailure;
    });
    return owner.cancelPromise;
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = (async () => {
      let failure: unknown;
      const owner = this.active;
      if (owner) {
        try { await this.cancel(owner.operationId); } catch (error) { failure = error; }
      }
      await this.gattTail;
      if (this.peripheralId) {
        const context: JsHostContext = {
          operationId: 'destroy', operation: 'Disconnect', requestId: '0',
          cancellationId: '', generation: (++this.generation).toString(),
          signal: new AbortController().signal,
        };
        try { await this.ports.ble.disconnect(this.peripheralId, context); }
        catch (error) { failure ??= error; }
        this.peripheralId = undefined;
      }
      this.engine.dispose();
      this.scopeSignal?.removeEventListener('abort', this.invalidateScope);
      if (failure) throw failure;
    })();
    return this.destroyPromise;
  }

  private capabilities(): CoreCapability[] {
    const capabilities: CoreCapability[] = ['Ble', 'Timer', 'Persistence', 'Progress'];
    if (this.ports.files && this.handlers.has('RecordingSink')) capabilities.push('RecordingSink');
    if (this.ports.files && this.handlers.has('FirmwareBlob')) capabilities.push('FirmwareBlob');
    if (this.ports.network) capabilities.push('NetworkTransfer');
    if (this.handlers.has('HostMaterial')) capabilities.push('HostMaterial');
    return capabilities;
  }

  private claim(options: JsWorkflowOptions, kind: Owner['kind']): Owner {
    if (this.destroyed) throw new BotaJsHostError('runtime_destroyed', options.operation);
    this.requireScope(options.operation);
    if (this.uncertainResourceFailure) throw new BotaJsHostError('cleanup_incomplete', options.operation);
    if (this.active) throw new BotaJsHostError('operation_in_progress', options.operation);
    const generation = (++this.generation).toString();
    let resolve!: (value: JsWorkflowResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<JsWorkflowResult>((yes, no) => { resolve = yes; reject = no; });
    // Direct owners use the same settlement path without consuming workflow results.
    void result.catch(() => {});
    let settle!: () => void;
    const settled = new Promise<void>(yes => { settle = yes; });
    const owner: Owner = {
      kind,
      operation: options.operation, operationId: options.operationId ?? `js-${generation}`,
      generation, cancellation: [], controller: new AbortController(), cleanupController: new AbortController(),
      requests: new Map(), queue: [], subscriptions: new Map(), bleSubscriptions: new Map(), timers: new Map(), cleanups: [],
      pending: new Set(), notifications: [], result, resolve, reject, settled, settle,
      status: 'Idle', options, pumping: false, cancelling: false, finished: false,
      cleaning: false, started: false,
    };
    this.active = owner;
    if (options.signal) {
      const abort = () => { void this.cancel(owner.operationId).catch(() => {}); };
      options.signal.addEventListener('abort', abort, { once: true });
      owner.removeExternalAbort = () => options.signal!.removeEventListener('abort', abort);
      if (options.signal.aborted) owner.controller.abort();
    }
    return owner;
  }

  private requireScope(operation: string): void {
    if (this.scopeInvalidated || this.scopeSignal?.aborted || this.ports.persistence.namespace !== this.namespace) {
      this.scopeInvalidated = true;
      throw new BotaJsHostError('scope_changed', operation);
    }
    try { this.scopeCheck?.(); }
    catch { this.scopeInvalidated = true; throw new BotaJsHostError('scope_changed', operation); }
  }

  private async initializeCancellation(owner: Owner): Promise<void> {
    const random = await this.track(owner, Promise.resolve(this.ports.randomBytes(16)));
    if (!(random instanceof Uint8Array) || random.length !== 16) {
      throw new BotaJsHostError('invalid_entropy', owner.operation);
    }
    owner.cancellation = Array.from(random);
  }

  private context(owner: Owner, requestId: string): JsHostContext {
    return Object.freeze({
      operationId: owner.operationId, operation: owner.operation, requestId,
      cancellationId: hex(owner.cancellation), generation: owner.generation,
      signal: owner.cancelling || owner.controller.signal.aborted
        ? owner.cleanupController.signal : owner.controller.signal,
    });
  }

  private request(owner: Owner, input: Omit<RawCoreRequest, 'version' | 'generation' | 'operation' | 'cancellation_id'>): RawCoreResult {
    const response = this.engine.request({
      version: 1, generation: owner.generation, operation: owner.operation,
      cancellation_id: owner.cancellation, ...input,
    });
    if (!response.ok) throw new BotaJsHostError(response.error.code, response.error.operation,
      response.error.retryable, response.error.protocol_status);
    return response.result;
  }

  private accept(owner: Owner, result: RawCoreResult): void {
    if (!Array.isArray(result.effects)) throw new BotaJsHostError('invalid_core_effect', owner.operation);
    const status = tag(result.status)[0];
    if (['Completed', 'Cancelled', 'Failed'].includes(status)) {
      owner.requests.clear();
      owner.controller.abort();
    }
    for (const effect of result.effects) {
      decimal(effect.request_id);
      if (effect.operation !== owner.operation || hex(effect.cancellation_id) !== hex(owner.cancellation) ||
          effect.cancellation_id.length !== 16 || owner.requests.has(effect.request_id)) {
        throw new BotaJsHostError('invalid_core_identity', owner.operation);
      }
      owner.requests.set(effect.request_id, effect);
      owner.queue.push(effect);
    }
    owner.status = result.status;
  }

  private pump(owner: Owner): void {
    if (owner.pumping || owner.finished || owner.cleaning) return;
    owner.pumping = true;
    while (owner.queue.length) {
      const effect = owner.queue.shift()!;
      const cleanup = owner.cancelling || owner.controller.signal.aborted;
      // Core effects encode dependencies. Start unrelated timers/persistence now;
      // the GATT lane orders only physical I/O, never a timer behind a blocked read.
      void this.track(owner, this.execute(owner, effect)).catch(error => {
        if (owner.cancelling || owner.controller.signal.aborted) {
          if (cleanup) owner.cleanupFailure ??= error;
          return;
        }
        owner.failure ??= error;
        void this.cancel(owner.operationId).catch(() => {});
      }).finally(() => { this.pump(owner); });
    }
    owner.pumping = false;
    const status = tag(owner.status)[0];
    if (!owner.pending.size && (owner.cancelling || ['Completed', 'Cancelled', 'Failed'].includes(status))) {
      void this.finish(owner);
    }
  }

  private async emit(owner: Owner, effect: RawCoreEffect, kind: JsValue): Promise<void> {
    if (owner.finished || owner.cleaning || this.active !== owner || !owner.requests.has(effect.request_id)) return;
    if (['Completed', 'Cancelled', 'Failed'].includes(tag(owner.status)[0])) return;
    if (owner.controller.signal.aborted && !owner.cancelling) return;
    this.accept(owner, this.request(owner, { action: 'dispatch', event: { request_id: effect.request_id, kind } }));
    this.pump(owner);
  }

  private async externalBleEvent(owner: Owner, effect: RawCoreEffect, event: JsValue): Promise<void> {
    if (owner.finished || owner.controller.signal.aborted || this.active !== owner) return;
    const pending = Promise.resolve().then(async () => {
      this.requireScope(owner.operation);
      await this.emit(owner, effect, { Ble: event });
    });
    try { await this.track(owner, pending); }
    catch (error) {
      owner.failure ??= error;
      await this.cancel(owner.operationId);
    } finally { this.pump(owner); }
  }

  private async execute(owner: Owner, effect: RawCoreEffect): Promise<void> {
    const [family, value] = tag(effect.effect);
    const context: JsEffectContext = {
      ...this.context(owner, effect.request_id),
      emit: kind => this.emit(owner, effect, kind),
      addCleanup: cleanup => { owner.cleanups.push(cleanup); },
    };
    const handler = this.handlers.get(family);
    if (handler) {
      try {
        const event = await handler(value, context);
        if (event !== null) await this.emit(owner, effect, event);
      } catch (error) {
        if (context.signal.aborted) return;
        if (['Completed', 'Cancelled', 'Failed'].includes(tag(owner.status)[0])) throw error;
        const failures: Record<string, string> = {
          RecordingSink: 'RecordingSinkFailed', FirmwareBlob: 'FirmwareBlobFailed', HostMaterial: 'HostMaterialFailed',
        };
        const streaming = family === 'RecordingSink' && [
          'AppendStreamingPlaintext', 'BeginStreamingEncrypted', 'AppendStreamingEncrypted', 'FinalizeStreaming',
        ].includes(tag(value)[0]);
        const failure = streaming ? 'StreamingSinkFailed' : failures[family];
        if (!failure) throw error;
        await this.emit(owner, effect, { [failure]: { platform_code: platformCode(error) } });
      }
      return;
    }
    switch (family) {
      case 'Notify': {
        owner.notifications.push(value);
        owner.options.onNotification?.(value);
        const [notification, payload] = tag(value);
        if (notification === 'Failed') {
          const error = record(this.core.codec('normalizeWorkflowError', { error: record(payload).error! }));
          owner.failure = new BotaJsHostError(string(error.code), string(error.operation), error.retryable === true,
            typeof error.protocolStatus === 'number' ? error.protocolStatus : undefined);
        }
        return;
      }
      case 'Progress': {
        const progress = record(value);
        owner.options.onProgress?.(decimal(progress.completed_units), decimal(progress.total_units));
        return;
      }
      case 'Timer': await this.timer(owner, effect, value); return;
      case 'Ble':
        try { await this.ble(owner, effect, value, context); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'cleanup_incomplete') {
            this.markCleanupFailed(error);
          }
          if (context.signal.aborted) return;
          if (['Completed', 'Cancelled', 'Failed'].includes(tag(owner.status)[0])) throw error;
          if (error instanceof BotaJsHostError) throw error;
          await this.emit(owner, effect, { Ble: { Failed: { platform_code: platformCode(error) } } });
        }
        return;
      case 'Persistence':
        try { await this.persistence(owner, effect, value, context); }
        catch (error) {
          if (context.signal.aborted) return;
          if (['Completed', 'Cancelled', 'Failed'].includes(tag(owner.status)[0])) throw error;
          if (error instanceof BotaJsHostError) throw error;
          await this.emit(owner, effect, { PersistenceFailed: { platform_code: platformCode(error) } });
        }
        return;
      case 'Network':
        try { await this.network(owner, effect, value, context); }
        catch (error) {
          if (context.signal.aborted) return;
          if (['Completed', 'Cancelled', 'Failed'].includes(tag(owner.status)[0])) throw error;
          if (error instanceof BotaJsHostError) throw error;
          const [, payload] = tag(value);
          const fields = record(payload);
          const id = decimal(fields.download_id ?? fields.upload_id);
          const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : null;
          await this.emit(owner, effect, { Network: { Failed: { transfer_id: id,
            status_code: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          } } });
        }
        return;
      default: throw new BotaJsHostError(`missing_primitive:${family}`, owner.operation);
    }
  }

  private async timer(owner: Owner, effect: RawCoreEffect, value: JsValue): Promise<void> {
    const [kind, payload] = tag(value);
    const timer = record(payload);
    const id = decimal(timer.timer_id);
    const previous = owner.timers.get(id);
    if (previous) clearTimeout(previous);
    owner.timers.delete(id);
    if (kind === 'Cancel') return;
    if (kind !== 'Schedule') throw new BotaJsHostError('invalid_core_effect', owner.operation);
    const delay = Number(decimal(timer.delay_ms));
    if (!Number.isSafeInteger(delay) || delay > 2147483647) throw new BotaJsHostError('invalid_core_deadline', owner.operation);
    owner.timers.set(id, setTimeout(() => {
      owner.timers.delete(id);
      void this.emit(owner, effect, { TimerFired: { timer_id: id } }).catch(error => {
        owner.failure ??= error;
        void this.cancel(owner.operationId).catch(() => {});
      });
    }, delay));
  }

  private async ble(owner: Owner, effect: RawCoreEffect, value: JsValue, context: JsHostContext): Promise<void> {
    const [kind, payload] = tag(value);
    const fields = payload === null ? {} : record(payload);
    const address = (): GattAddress => ({
      serviceUuid: string(fields.service_uuid), characteristicUuid: string(fields.characteristic_uuid),
      ...(this.peripheralId ? { peripheralId: this.peripheralId } : {}),
    });
    const event = async (result: JsValue) => {
      if (!owner.cancelling || !context.signal.aborted) await this.emit(owner, effect, { Ble: result });
    };
    switch (kind) {
      case 'StartScan': {
        const subscription = await this.ports.ble.scan(fields.allow_duplicates === true, candidate => {
          void event({ ScanResult: { candidate: candidate as unknown as JsValue } }).catch(error => {
            owner.failure ??= error;
            void this.cancel(owner.operationId).catch(() => {});
          });
        }, context, error => {
          if (owner.finished || owner.controller.signal.aborted) return;
          owner.failure ??= error;
          void this.cancel(owner.operationId).catch(() => {});
        });
        owner.subscriptions.set('scan', subscription);
        return;
      }
      case 'StopScan': {
        const subscription = owner.subscriptions.get('scan');
        if (subscription) { await subscription.remove(); owner.subscriptions.delete('scan'); }
        await event('ScanStopped'); return;
      }
      case 'Connect': {
        const id = string(fields.peripheral_id);
        await this.gatt(context, () => this.ports.ble.connect(id, context));
        this.peripheralId = id;
        await event({ Connected: { peripheral_id: id } }); return;
      }
      case 'DiscoverServices': {
        const id = string(fields.peripheral_id);
        await this.gatt(context, () => this.ports.ble.discoverServices(id, context));
        await event({ ServicesDiscovered: { peripheral_id: id } }); return;
      }
      case 'Disconnect': {
        const id = string(fields.peripheral_id);
        await this.gatt(context, () => this.ports.ble.disconnect(id, context));
        if (this.peripheralId === id) this.peripheralId = undefined;
        await event({ Disconnected: { peripheral_id: id, reason_code: null } }); return;
      }
      case 'Read': {
        const result = await this.gatt(context, () => this.ports.ble.read(address(), context));
        if (!(result instanceof Uint8Array)) throw new BotaJsHostError('missing_primitive:opaque_gatt_read', owner.operation);
        await event({ ReadCompleted: { value: Array.from(result) } }); return;
      }
      case 'Write': {
        await this.gatt(context, () => this.ports.ble.write(address(), bytes(fields.payload), fields.with_response === true, context));
        await event('WriteCompleted'); return;
      }
      case 'Subscribe': {
        const characteristic = string(fields.characteristic_uuid);
        const key = `${string(fields.service_uuid)}/${characteristic}`;
        if (owner.subscriptions.has(key) || owner.bleSubscriptions.has(key)) throw new BotaJsHostError('duplicate_subscription', owner.operation);
        const binding = { effect, ...(this.peripheralId ? { peripheralId: this.peripheralId } : {}) };
        owner.bleSubscriptions.set(key, binding);
        const received: Uint8Array[] = [];
        const startupPolicy = record(this.core.codec('subscriptionStartupPolicy', { command: owner.command! }));
        const replayStartup = startupPolicy.replayBeforeSubscribed === true;
        let receivedBytes = 0;
        let ready = false;
        const subscription = await this.gatt(context, () => this.ports.ble.subscribe(address(), notification => {
          if (owner.bleSubscriptions.get(key) !== binding || owner.controller.signal.aborted) return;
          if (!(notification instanceof Uint8Array)) {
            owner.failure ??= new BotaJsHostError('missing_primitive:opaque_gatt_notification', owner.operation);
            void this.cancel(owner.operationId).catch(() => {}); return;
          }
          if (!ready) {
            if (!replayStartup) return;
            receivedBytes += notification.byteLength;
            if (receivedBytes > 1048576 || received.length >= 256) {
              owner.failure ??= new BotaJsHostError('notification_queue_exceeded', owner.operation);
              void this.cancel(owner.operationId).catch(() => {}); return;
            }
            received.push(notification.slice()); return;
          }
          void event({ Notification: { characteristic_uuid: characteristic, value: Array.from(notification) } }).catch(error => {
            owner.failure ??= error;
            void this.cancel(owner.operationId).catch(() => {});
          });
        }, context, error => {
          if (owner.bleSubscriptions.get(key) !== binding || owner.finished || owner.controller.signal.aborted) return;
          void this.externalBleEvent(owner, effect, { Failed: { platform_code: platformCode(error) } }).catch(() => {});
        }));
        owner.subscriptions.set(key, subscription);
        ready = true;
        await event({ Subscribed: { characteristic_uuid: characteristic } });
        for (const notification of received) await event({ Notification: {
          characteristic_uuid: characteristic, value: Array.from(notification),
        } });
        return;
      }
      case 'Unsubscribe': {
        const key = `${string(fields.service_uuid)}/${string(fields.characteristic_uuid)}`;
        owner.bleSubscriptions.delete(key);
        const subscription = owner.subscriptions.get(key);
        if (subscription) { await subscription.remove(); owner.subscriptions.delete(key); }
        return;
      }
      default: throw new BotaJsHostError(`missing_primitive:Ble.${kind}`, owner.operation);
    }
  }

  private async persistence(owner: Owner, effect: RawCoreEffect, value: JsValue, context: JsHostContext): Promise<void> {
    const [kind, payload] = tag(value);
    const key = `workflow/${owner.operationId}`;
    const fields = payload === null ? {} : record(payload);
    switch (kind) {
      case 'LoadCheckpoint': {
        const checkpoint = await this.ports.persistence.load(key, context);
        await this.emit(owner, effect, { CheckpointLoaded: { checkpoint } }); return;
      }
      case 'SaveCheckpoint':
        await this.ports.persistence.save(key, fields.checkpoint!, context);
        await this.emit(owner, effect, 'CheckpointSaved'); return;
      case 'DeleteCheckpoint': await this.ports.persistence.remove(key, context); return;
      case 'SaveConnectionIdentity':
        await this.ports.persistence.save(`connection/${string(fields.device)}`, payload, context);
        await this.emit(owner, effect, 'ConnectionIdentitySaved'); return;
      case 'SaveFactoryResetResult':
        await this.ports.persistence.save(`reset/${string(record(fields.result!).command_id)}`, fields.result!, context);
        await owner.options.beforeFactoryResetReceipt?.(fields.result!, context);
        await this.emit(owner, effect, 'FactoryResetResultSaved'); return;
      case 'DeleteFactoryResetResult':
        await this.ports.persistence.remove(`reset/${string(fields.command_id)}`, context);
        await this.emit(owner, effect, 'FactoryResetResultDeleted'); return;
      default: throw new BotaJsHostError(`missing_primitive:Persistence.${kind}`, owner.operation);
    }
  }

  private async network(owner: Owner, effect: RawCoreEffect, value: JsValue, context: JsHostContext): Promise<void> {
    const port = this.ports.network;
    if (!port) throw new BotaJsHostError('missing_primitive:network', owner.operation);
    const [kind, payload] = tag(value);
    const fields = record(payload);
    if (kind === 'Download') {
      const id = decimal(fields.download_id);
      const result = await port.download(id, (completed, total) => {
        void this.emit(owner, effect, { Network: { DownloadProgress: {
          download_id: id, completed_bytes: decimal(completed), total_bytes: total === null ? null : decimal(total),
        } } }).catch(error => { owner.failure ??= error; });
      }, context);
      await this.emit(owner, effect, { Network: { DownloadCompleted: { download_id: id, crc32: result.crc32 } } });
    } else if (kind === 'Upload') {
      const id = decimal(fields.upload_id);
      await port.upload(id, string(fields.source), (completed, total) => {
        void this.emit(owner, effect, { Network: { UploadProgress: {
          upload_id: id, completed_bytes: decimal(completed), total_bytes: decimal(total),
        } } }).catch(error => { owner.failure ??= error; });
      }, context);
      await this.emit(owner, effect, { Network: { UploadCompleted: { upload_id: id } } });
    } else throw new BotaJsHostError(`missing_primitive:Network.${kind}`, owner.operation);
  }

  private async track<T>(owner: Owner, promise: Promise<T>): Promise<T> {
    owner.pending.add(promise);
    try { return await promise; } finally { owner.pending.delete(promise); }
  }

  private async finish(owner: Owner): Promise<void> {
    if (owner.finished) return;
    if (owner.cleaning) { await owner.settled; return; }
    owner.cleaning = true;
    // A direct BYO owner may have admitted a Stop/read control. Keep its lease
    // and abort listener until all submitted sideband IO actually settles.
    if (owner.kind === 'direct') while (owner.pending.size) {
      await Promise.allSettled([...owner.pending]);
    }
    for (const timer of owner.timers.values()) clearTimeout(timer);
    owner.timers.clear();
    const actions = [...owner.subscriptions.values()].map(subscription => () => subscription.remove());
    actions.push(...owner.cleanups.reverse());
    for (const action of actions) {
      try { await action(); } catch (error) { owner.cleanupFailure ??= error; }
    }
    owner.subscriptions.clear();
    owner.bleSubscriptions.clear();
    owner.removeExternalAbort?.();
    owner.finished = true;
    // Ownership is retained after uncertain cleanup; only final destruction may proceed.
    if (!owner.cleanupFailure && this.active === owner) this.active = undefined;
    const result = { notifications: owner.notifications };
    if (owner.failure || owner.cleanupFailure) owner.reject(owner.failure ?? owner.cleanupFailure);
    else if (owner.cancelling) owner.reject(new BotaJsHostError('operation_cancelled', owner.operation));
    else owner.resolve(result);
    owner.settle();
  }
}

function platformCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('platformCode' in error)) return null;
  const code = error.platformCode;
  if (typeof code === 'number' && Number.isSafeInteger(code)) return code.toString();
  if (typeof code === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(code) &&
      BigInt(code) >= -9223372036854775808n && BigInt(code) <= 9223372036854775807n) return code;
  return null;
}
