import type {
  BotaJsHostPorts, GattAddress, JsEffectContext, JsEffectHandler, JsGattValue, JsHostContext, JsHostSubscription, JsValue,
  OpaqueHostHandle, RawJsCoreFactory,
} from './contracts';
import { BotaJsHostError } from './executor';

export interface JsEncryptedUploadV2Options {
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly ports: Pick<BotaJsHostPorts, 'persistence' | 'files'> & Partial<Pick<BotaJsHostPorts, 'ble' | 'randomBytes'>>;
  /** Validated, non-secret Rust EncryptedUploadV2BatchRequest metadata. */
  readonly request: JsValue;
  /** Stable scoped registration key; reconnects use the same key. */
  readonly journalKey: string;
  readonly sink: OpaqueHostHandle;
  /** Checks the executor owner and the exact captured physical connection. */
  readonly checkOwner: (context: JsHostContext) => void;
  readonly peripheralId?: string;
  readonly maximumWriteBytes?: number;
  readonly gatt?: <T>(context: JsHostContext, body: () => Promise<T>) => Promise<T>;
  readonly material?: JsEncryptedUploadV2Material;
  readonly priorCheckpoint?: JsValue;
  readonly expectedMarkersRequired?: boolean;
  readonly onCleanupFailure?: (error: unknown, context?: JsHostContext) => void;
}

export interface JsEncryptedUploadV2MarkerDocument {
  readonly index: number;
  readonly count: number;
  readonly sha256: JsValue;
  readonly handle: OpaqueHostHandle;
}

/** App-scoped HTTP/material registrations. These callbacks do not verify signatures or decrypt. */
export interface JsEncryptedUploadV2Material {
  authorization(context: JsHostContext): Promise<Uint8Array>;
  readonly uploadContext?: {
    challenge(attemptId: number, nonce: Uint8Array, context: JsHostContext): Promise<Uint8Array>;
    result(attemptId: number, proof: Uint8Array, context: JsHostContext): Promise<Uint8Array>;
  };
  /** Rust-validated backend reconciliation; true authorizes the ciphertext PUT. */
  reconcileStaging?(manifest: Uint8Array, evidence: JsValue, context: JsHostContext): Promise<boolean>;
  stageCiphertext(sink: OpaqueHostHandle, evidence: JsValue, context: JsHostContext): Promise<void>;
  submitManifest(manifest: Uint8Array, evidence: JsValue, context: JsHostContext): Promise<void>;
  submitMarkers?(documents: readonly JsEncryptedUploadV2MarkerDocument[], evidence: JsValue,
    context: JsHostContext): Promise<void>;
  finalize(evidence: JsValue, context: JsHostContext): Promise<void>;
  completionReceipt(evidence: JsValue, context: JsHostContext): Promise<Uint8Array>;
  confirmed?(context: JsHostContext): Promise<void>;
  cancel?(context: JsHostContext): Promise<void>;
}

export interface JsEncryptedUploadV2CatalogOptions {
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly ports: Pick<BotaJsHostPorts, 'ble'>;
  readonly peripheralId: string;
  readonly checkOwner: (context: JsHostContext) => void;
  readonly gatt: <T>(context: JsHostContext, body: () => Promise<T>) => Promise<T>;
  readonly onCleanupFailure?: (error: unknown, context?: JsHostContext) => void;
}

/** Public recording metadata only; catalog framing, digest and admission are Rust-owned. */
export class JsEncryptedUploadV2Catalog {
  private active = false;
  private readonly metadata: Record<string, JsValue>;
  private poisonedError: unknown;
  private poisoned = false;

  constructor(private readonly options: JsEncryptedUploadV2CatalogOptions) {
    this.metadata = object(options.core.codec('protocolMetadata', {}));
  }

  async read(context: JsHostContext, transportSessionId: string): Promise<JsValue> {
    if (this.poisoned) throw this.poisonedError;
    if (this.active) throw new BotaJsHostError('operation_in_progress', context.operation);
    this.active = true;
    try {
      const initial = this.options.core.codec('planEncryptedUploadV2Catalog', { transportSessionId, previousError: null, attempt: 1 });
      try { return await this.readAttempt(context, transportSessionId, initial); }
      catch (error) {
        if (this.poisoned) throw this.poisonedError;
        this.requireOwner(context);
        let retry: JsValue;
        try {
          const failure = error && typeof error === 'object' ? error as { code?: unknown; protocolStatus?: unknown } : {};
          retry = this.options.core.codec('planEncryptedUploadV2Catalog', { transportSessionId, attempt: 2,
            previousError: { code: typeof failure.code === 'string' ? failure.code : 'internal',
              ...(typeof failure.protocolStatus === 'number' ? { protocolStatus: failure.protocolStatus } : {}) } });
        } catch { throw error; }
        this.requireOwner(context);
        return await this.readAttempt(context, transportSessionId, retry);
      }
    } finally { this.active = false; }
  }

  private async readAttempt(context: JsHostContext, transportSessionId: string, plan: JsValue): Promise<JsValue> {
    const decoderId = `${context.operationId}:${context.generation}:${transportSessionId}`;
    const subscriptions: JsHostSubscription[] = [];
    let accepting = false;
    let transportFailed = false;
    let transportError: unknown;
    let resolve!: (value: JsValue) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<JsValue>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => undefined);
    const onError = (error: unknown) => { transportFailed = true; transportError = error; reject(error); };
    try {
      this.requireOwner(context);
      decimal(transportSessionId);
      this.options.core.codec('decodeEncryptedUploadV2Catalog', { decoderId, transportSessionId, bytes: [] });
      subscriptions.push(await this.options.gatt(context, () => this.options.ports.ble.subscribe(
        this.address('CHAR_RECORDING_LIST_V2'), value => {
          if (!accepting) return;
          try {
            this.requireOwner(context);
            const catalog = this.options.core.codec('decodeEncryptedUploadV2Catalog', {
              decoderId, transportSessionId, bytes: publicMetadataBytes(value),
            });
            if (catalog !== null) resolve(catalog);
          } catch (error) { reject(error); }
        }, context, onError)));
      this.requireOwner(context);
      if (transportFailed) throw transportError;
      subscriptions.push(await this.options.gatt(context, () => this.options.ports.ble.subscribe(
        this.address('CHAR_RECORDING_TRANSFER_V2'), value => {
          if (!accepting) return;
          try {
            this.requireOwner(context);
            const failure = this.options.core.codec('decodeEncryptedUploadV2CatalogError', {
              transportSessionId, bytes: publicMetadataBytes(value),
            });
            if (failure !== null) {
              const fields = object(failure);
              if (typeof fields.code !== 'string') throw new BotaJsHostError('invalid_core_error', context.operation);
              reject(new BotaJsHostError(fields.code, context.operation, fields.retryable === true,
                typeof fields.protocolStatus === 'number' ? fields.protocolStatus : undefined));
            }
          } catch (error) { reject(error); }
        }, context, onError)));
      this.requireOwner(context);
      if (transportFailed) throw transportError;
      const command = wireBytes(object(plan).command!);
      try {
        accepting = true;
        await this.options.gatt(context, () => this.options.ports.ble.write(
          this.address('CHAR_TRANSFER_CONTROL_V2'), command, true, context));
        this.requireOwner(context);
        const timeoutMs = this.metadata.operationTimeoutMs;
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
          throw new BotaJsHostError('invalid_core_deadline', context.operation);
        }
        return await catalogResult(result, timeoutMs, context);
      } finally { command.fill(0); }
    } finally {
      accepting = false;
      let cleanupFailure: unknown;
      for (const subscription of subscriptions.reverse()) {
        try { await subscription.remove(); } catch (error) {
          cleanupFailure ??= error;
          this.poisoned = true;
          this.poisonedError ??= error;
          try { this.options.onCleanupFailure?.(error, context); } catch {}
        }
      }
      try { this.options.core.codec('resetEncryptedUploadV2Catalog', { decoderId }); }
      catch (error) { cleanupFailure ??= error; }
      if (cleanupFailure) throw cleanupFailure;
    }
  }

  private requireOwner(context: JsHostContext): void {
    if (context.signal.aborted) throw new BotaJsHostError('operation_cancelled', context.operation);
    this.options.checkOwner(context);
  }

  private address(characteristic: string): GattAddress {
    const serviceUuid = this.metadata.SERVICE_BOTA_STORAGE;
    const characteristicUuid = this.metadata[characteristic];
    if (typeof serviceUuid !== 'string' || typeof characteristicUuid !== 'string') {
      throw new BotaJsHostError('invalid_core_metadata', 'ListRecordings');
    }
    return { peripheralId: this.options.peripheralId, serviceUuid, characteristicUuid };
  }
}

export interface JsUploadContextExchangeOptions {
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly ports: Pick<BotaJsHostPorts, 'ble' | 'randomBytes'>;
  readonly peripheralId: string;
  readonly maximumWriteBytes: number;
  readonly maximumSignedBlobBytes: number;
  readonly gatt: <T>(context: JsHostContext, body: () => Promise<T>) => Promise<T>;
  readonly checkOwner: (context: JsHostContext) => void;
  readonly onCleanupFailure?: (error: unknown, context?: JsHostContext) => void;
}

/** The same bounded Rust context/signed-document mechanics serve managed and BYO flows. */
export class JsUploadContextExchange {
  private readonly metadata: Record<string, JsValue>;
  private owner: { operationId: string; generation: string; cancellationId: string } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  private poisoned = false;
  private poison: unknown;
  private closePromise?: Promise<void>;
  private readonly failedSubscriptions = new Map<JsHostSubscription, JsHostContext | undefined>();

  constructor(private readonly options: JsUploadContextExchangeOptions) {
    this.metadata = object(options.core.codec('protocolMetadata', {}));
  }

  refresh(provider: NonNullable<JsEncryptedUploadV2Material['uploadContext']>, context: JsHostContext): Promise<void> {
    return this.enqueue(context, () => this.refreshContext(provider, context));
  }
  sendSignedBlob(blobKind: number, bytes: Uint8Array, context: JsHostContext): Promise<void> {
    return this.enqueue(context, () => this.sendBlob(blobKind, bytes, context));
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.catch(() => undefined).then(async () => {
      this.closed = true;
      let failure: unknown;
      for (const [subscription, context] of this.failedSubscriptions) {
        try { await this.removeSubscription(subscription, context); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    });
    void this.closePromise.catch(() => { this.closePromise = undefined; });
    return this.closePromise;
  }

  private enqueue(context: JsHostContext, body: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new BotaJsHostError('stale_host_owner', context.operation));
    this.requireOwner(context);
    const pending = this.tail.catch(() => undefined).then(body);
    this.tail = pending;
    return pending;
  }
  private requireOwner(context: JsHostContext): void {
    if (this.poisoned) throw this.poison;
    this.owner ??= { operationId: context.operationId, generation: context.generation, cancellationId: context.cancellationId };
    if (this.closed || context.signal.aborted || this.owner.operationId !== context.operationId ||
        this.owner.generation !== context.generation || this.owner.cancellationId !== context.cancellationId) {
      throw new BotaJsHostError('stale_host_owner', context.operation);
    }
    this.options.checkOwner(context);
  }
  private async step<T>(context: JsHostContext, body: () => Promise<T>): Promise<T> {
    this.requireOwner(context);
    const result = await body();
    this.requireOwner(context);
    return result;
  }
  private codec(name: string, input: JsValue): JsValue { return this.options.core.codec(name, input); }

  private address(characteristic: string): GattAddress {
    const serviceUuid = this.metadata?.SERVICE_BOTA_STORAGE;
    const characteristicUuid = this.metadata?.[characteristic];
    if (typeof serviceUuid !== 'string' || typeof characteristicUuid !== 'string') {
      throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
    }
    return { peripheralId: this.options.peripheralId, serviceUuid, characteristicUuid };
  }

  private async write(value: Uint8Array, characteristic: string, context: JsHostContext): Promise<void> {
    this.requireOwner(context);
    if (value.length > this.options.maximumWriteBytes!) throw new BotaJsHostError('payload_too_large', context.operation);
    await this.options.gatt!(context, () => this.options.ports.ble!.write(this.address(characteristic), value, true, context));
    this.requireOwner(context);
  }

  private async randomId(context: JsHostContext): Promise<number> {
    const value = await this.step(context, () => Promise.resolve(this.options.ports.randomBytes(4)));
    if (!(value instanceof Uint8Array) || value.length !== 4) throw new BotaJsHostError('invalid_entropy', context.operation);
    const number = value.reduce((sum, byte, index) => sum + byte * 2 ** (index * 8), 0);
    if (number === 0) throw new BotaJsHostError('invalid_entropy', context.operation);
    return number;
  }

  private async sendBlob(blobKind: number, value: Uint8Array, context: JsHostContext): Promise<void> {
    const writeId = await this.randomId(context);
    const plan = object(this.codec('planEncryptedUploadV2SignedBlob', { blobKind, writeId, bytes: publicMetadataBytes(value),
      capacity: this.options.maximumWriteBytes!, maximumBlobBytes: this.options.maximumSignedBlobBytes }));
    const done = deferred<JsValue>();
    void done.promise.catch(() => undefined);
    let accepting = false;
    let began = false;
    let accepted = false;
    let primary: unknown;
    let failed = false;
    let transportFailed = false;
    let transportError: unknown;
    const subscription = await this.options.gatt!(context, () => this.options.ports.ble!.subscribe(
      this.address('CHAR_TRANSFER_SIGNED_BLOB_V2'), notification => {
        if (!accepting) return;
        try {
          this.requireOwner(context);
          const result = this.codec('acceptEncryptedUploadV2SignedBlobResult', { blobKind, writeId, bytes: publicMetadataBytes(notification) });
          if (result === 'accepted') { accepted = true; done.resolve(result); }
        } catch (error) { done.reject(error); }
      }, context, error => { transportFailed = true; transportError = error; done.reject(error); }));
    try {
      this.requireOwner(context);
      if (transportFailed) throw transportError;
      const frames = array(plan.frames!);
      for (let index = 0; index < frames.length; index++) {
        const frame = wireBytes(frames[index]!);
        try {
          if (index === frames.length - 1) accepting = true;
          began = true;
          await this.write(frame, 'CHAR_TRANSFER_SIGNED_BLOB_V2', context);
          if (transportFailed) throw transportError;
        } finally { frame.fill(0); }
      }
      await catalogResult(done.promise, this.timeout(), context);
    } catch (error) { failed = true; primary = error; }
    accepting = false;
    if (failed && began && !accepted) {
      try { await this.cleanupWrite(wireBytes(plan.abortFrame!), 'CHAR_TRANSFER_SIGNED_BLOB_V2', context); }
      catch (error) { primary = error; this.markCleanupFailure(error, context); }
    }
    try { await this.removeSubscription(subscription, context); }
    catch (error) { primary = error; failed = true; this.markCleanupFailure(error, context); }
    if (failed) throw primary;
  }

  private timeout(): number {
    const value = this.metadata?.operationTimeoutMs;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new BotaJsHostError('invalid_core_deadline', 'TransferRecording');
    return value;
  }

  private async refreshContext(provider: NonNullable<JsEncryptedUploadV2Material['uploadContext']>, context: JsHostContext): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let expired = false;
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.timeout());
    const scoped = { ...context, signal: controller.signal };
    try {
      const attemptId = await this.randomId(scoped);
      const begin = wireBytes(this.codec('encodeUploadContextBegin', { attemptId }));
      try { await this.write(begin, 'CHAR_UPLOAD_CONTEXT_V2', scoped); }
      finally { begin.fill(0); }
      const nonce = await this.contextSnapshot(attemptId, 1, scoped);
      let challenge: Uint8Array | null = null;
      try {
        challenge = await this.providerBytes(provider.challenge(attemptId, nonce, scoped), scoped);
        this.codec('validateUploadContextDocument', { kind: 3, bytes: publicMetadataBytes(challenge) });
        await this.sendBlob(3, challenge, scoped);
      } finally { nonce.fill(0); challenge?.fill(0); }
      const proof = await this.contextSnapshot(attemptId, 2, scoped);
      let result: Uint8Array | null = null;
      try {
        result = await this.providerBytes(provider.result(attemptId, proof, scoped), scoped);
        this.codec('validateUploadContextDocument', { kind: 4, bytes: publicMetadataBytes(result) });
        await this.sendBlob(4, result, scoped);
      } finally { proof.fill(0); result?.fill(0); }
      await this.contextSnapshot(attemptId, 3, scoped);
    } catch (error) {
      if (this.poisoned) throw this.poison;
      if (expired) throw new BotaJsHostError('timeout', context.operation, true);
      throw error;
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
  }

  private async providerBytes(promise: Promise<Uint8Array>, context: JsHostContext): Promise<Uint8Array> {
    try {
      const value = await catalogResult(promise, this.timeout(), context);
      this.requireOwner(context);
      if (!(value instanceof Uint8Array)) throw new BotaJsHostError('invalid_material', context.operation);
      return value;
    } catch (error) {
      void promise.then(value => { if (value instanceof Uint8Array) value.fill(0); }, () => undefined);
      throw error;
    }
  }

  private async contextSnapshot(attemptId: number, expectedState: number, context: JsHostContext): Promise<Uint8Array> {
    const deadline = Date.now() + this.timeout();
    for (;;) {
      const value = await this.step(context, () => this.options.gatt!(context,
        () => this.options.ports.ble!.read(this.address('CHAR_UPLOAD_CONTEXT_V2'), context)));
      const accepted = this.codec('acceptUploadContextSnapshot', { attemptId, expectedState, bytes: publicMetadataBytes(value) });
      if (accepted !== null) return wireBytes(accepted);
      if (Date.now() >= deadline) throw new BotaJsHostError('operation_timeout', context.operation);
      const interval = this.metadata.contextPollIntervalMs;
      if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) throw new BotaJsHostError('invalid_core_deadline', context.operation);
      await delay(interval, context);
    }
  }

  private async cleanupWrite(value: Uint8Array, characteristic: string, context: JsHostContext): Promise<void> {
    const cleanup = { ...context, signal: new AbortController().signal };
    try {
      this.options.checkOwner(cleanup);
      await this.options.gatt!(cleanup, () => this.options.ports.ble!.write(this.address(characteristic), value, true, cleanup));
      this.options.checkOwner(cleanup);
    } finally { value.fill(0); }
  }

  private markCleanupFailure(error: unknown, context?: JsHostContext): void {
    if (!this.poisoned) this.poison = error;
    this.poisoned = true;
    try { this.options.onCleanupFailure?.(error, context); } catch {}
  }

  private async removeSubscription(subscription: JsHostSubscription, context?: JsHostContext): Promise<void> {
    try { await subscription.remove(); this.failedSubscriptions.delete(subscription); }
    catch (error) { this.failedSubscriptions.set(subscription, context); this.markCleanupFailure(error, context); throw error; }
  }
}

interface CheckpointJournal {
  readonly version: 1;
  readonly scope: string;
  readonly checkpoint: JsValue;
  readonly receiverCheckpoint?: JsValue;
  readonly sinkRegistrationId?: string;
}

/** Non-secret durable host mechanics for the shared encrypted-v2 coordinator. */
export class JsEncryptedUploadV2Host {
  readonly handle: JsEffectHandler;
  private readonly request: JsValue;
  private readonly scope: string;
  private readonly key: string;
  private owner: { operationId: string; generation: string; cancellationId: string } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private metadata: Record<string, JsValue> | null = null;
  private receiverId: number | null = null;
  private startContext: JsEffectContext | null = null;
  private targetContext: JsEffectContext | null = null;
  private subscription: JsHostSubscription | null = null;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private queueWake = deferred<void>();
  private queueFailure: unknown;
  private queueFailed = false;
  private confirmationListener: ((value: JsGattValue) => void) | null = null;
  private confirmationError: ((error: unknown) => void) | null = null;
  private pumpPromise: Promise<void> | null = null;
  private boundaryGate: ReturnType<typeof deferred<void>> | null = null;
  private pendingCheckpoint: { requestId: string; native: JsValue; core: JsValue } | null = null;
  private savedCheckpoint: JsValue | null = null;
  private loadedReceiverCheckpoint: JsValue | null = null;
  private pendingRepair: { frame: Uint8Array; missing: JsValue } | null = null;
  private boundary: JsValue | null = null;
  private manifest: Uint8Array | null = null;
  private evidence: JsValue | null = null;
  private markers: JsEncryptedUploadV2MarkerDocument[] = [];
  private markersRequired = false;
  private authorizationSha256: JsValue | null = null;
  private receipt: { bytes: Uint8Array; sha256: JsValue; blobKind: number } | null = null;
  private transferAttempted = false;
  private confirmationAttempted = false;
  private confirmed = false;
  private poison: unknown;
  private poisoned = false;
  private exchange: JsUploadContextExchange | undefined;
  private hasherId: string | null = null;
  private hashedBytes = 0n;

  constructor(private readonly options: JsEncryptedUploadV2Options) {
    this.scope = options.ports.persistence.namespace;
    if (!this.scope.trim() || !options.journalKey.trim()
      || options.sink.kind !== 'file' || options.sink.scope !== this.scope) {
      throw new BotaJsHostError('invalid_scope', 'TransferRecording');
    }
    this.request = clone(options.request);
    this.key = `encrypted-upload-v2/${options.journalKey}`;
    this.handle = (effect, context) => {
      const pending = this.tail.catch(() => undefined).then(() => this.execute(effect, context));
      this.tail = pending;
      return pending;
    };
  }

  /** Joins submitted storage/file operations; never deletes a recording or sink. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelReceiver();
    this.queueWake.resolve();
    this.boundaryGate?.resolve();
    this.closePromise = this.tail.catch(() => undefined).then(async () => {
      await this.pumpPromise?.catch(() => undefined);
      await this.exchange?.close();
      await this.cleanupTransfer(this.startContext);
      this.receipt?.bytes.fill(0);
      this.receipt = null;
      this.manifest?.fill(0);
      this.manifest = null;
      if (this.hasherId) { this.codec('hasherFree', { decoderId: this.hasherId }); this.hasherId = null; }
    });
    return this.closePromise;
  }

  private async execute(effect: JsValue, context: JsEffectContext): Promise<JsValue | null> {
    this.claim(context);
    this.requireOwner(context);
    // Bota identities and checkpoint bounds remain validated in shared Rust.
    this.options.core.codec('validateEncryptedUploadV2HostIdentity', { request: this.request, effect });
    const [kind, payload] = tagged(effect);
    switch (kind) {
      case 'LoadCheckpoint': {
        const journal = await this.step(context, () => this.options.ports.persistence.load(this.key, context));
        this.loadedReceiverCheckpoint = journal === null ? null : object(journal).receiverCheckpoint ?? null;
        return event('CheckpointLoaded', this.readCheckpoint(journal));
      }
      case 'DeleteCheckpoint':
        await this.step(context, () => this.options.ports.persistence.remove(this.key, context));
        return null;
      case 'TruncateSink': {
        const fields = object(payload);
        if (!this.options.ports.files) throw new BotaJsHostError('unsupported_capability', context.operation);
        await this.step(context, () => this.options.ports.files!.truncate(this.options.sink,
          decimal(fields.next_ciphertext_offset), context));
        return event('SinkTruncated');
      }
      case 'SaveCheckpoint': {
        const checkpoint = this.normalize(object(payload).checkpoint ?? null);
        if (checkpoint === null) throw new BotaJsHostError('invalid_core_checkpoint', context.operation);
        if (this.options.material && (!this.pendingCheckpoint
          || canonical(this.pendingCheckpoint.core) !== canonical(checkpoint))) {
          throw new BotaJsHostError('checkpoint_commit_mismatch', context.operation);
        }
        const sinkRegistrationId = object(this.request).sink_id;
        const journal: CheckpointJournal = { version: 1, scope: this.scope, checkpoint,
          ...(typeof sinkRegistrationId === 'string' ? { sinkRegistrationId } : {}),
          ...(this.pendingCheckpoint ? { receiverCheckpoint: this.pendingCheckpoint.native } : {}) };
        const expected = clone(journal as unknown as JsValue);
        await this.step(context, () => this.options.ports.persistence.save(this.key, clone(expected), context));
        // An acknowledgement follows only after durable save and exact readable replacement.
        const actual = await this.step(context, () => this.options.ports.persistence.load(this.key, context));
        if (canonical(this.readCheckpoint(actual)) !== canonical(checkpoint) || canonical(actual) !== canonical(expected)) {
          throw new BotaJsHostError('checkpoint_commit_mismatch', context.operation);
        }
        this.savedCheckpoint = checkpoint;
        return event('CheckpointSaved');
      }
      case 'AbortV2':
        this.cancelReceiver();
        this.queueWake.resolve();
        this.boundaryGate?.resolve();
        await this.pumpPromise?.catch(() => undefined);
        await this.cleanupTransfer(context);
        await this.options.material?.cancel?.(context);
        return null;
      case 'PrepareSession': return this.prepareSession(context);
      case 'StartTransfer': return this.startTransfer(object(payload), context);
      case 'RepairWindow': return this.repairWindow(object(payload), context);
      case 'AcknowledgeWindow': return this.acknowledgeWindow(object(payload), context);
      case 'StageArtifacts': return this.stageArtifacts(object(payload), context);
      case 'AwaitCompletionReceipt': return this.awaitReceipt(object(payload), context);
      case 'ConfirmWithReceipt': return this.confirmReceipt(object(payload), context);
      default:
        // A missing effect implementation cannot bypass the generated admission rules.
        throw new BotaJsHostError('encrypted_upload_v2_protected_host_unavailable', context.operation);
    }
  }

  private claim(context: JsEffectContext): void {
    if (this.owner) return;
    this.owner = { operationId: context.operationId, generation: context.generation,
      cancellationId: context.cancellationId };
    context.addCleanup(() => this.close());
  }

  private requireOwner(context: JsHostContext): void {
    if (this.poisoned) throw this.poison;
    const owner = this.owner;
    if (this.closed || context.signal.aborted || !owner
      || owner.operationId !== context.operationId || owner.generation !== context.generation
      || owner.cancellationId !== context.cancellationId
      || this.options.ports.persistence.namespace !== this.scope) {
      throw new BotaJsHostError('stale_host_owner', context.operation);
    }
    this.options.checkOwner(context);
  }

  private async step<T>(context: JsHostContext, body: () => Promise<T>): Promise<T> {
    this.requireOwner(context);
    const result = await body();
    this.requireOwner(context);
    return result;
  }

  private readCheckpoint(value: JsValue | null): JsValue | null {
    if (value === null) return null;
    const journal = object(value);
    if (journal.version !== 1 || journal.scope !== this.scope || journal.checkpoint === undefined) {
      throw new BotaJsHostError('checkpoint_scope_mismatch', 'TransferRecording');
    }
    if (this.options.material && journal.sinkRegistrationId !== object(this.request).sink_id) {
      throw new BotaJsHostError('checkpoint_scope_mismatch', 'TransferRecording');
    }
    return this.normalize(journal.checkpoint);
  }

  private normalize(checkpoint: JsValue): JsValue {
    return this.options.core.codec('normalizeEncryptedUploadV2Checkpoint', {
      request: this.request, checkpoint,
    });
  }

  private codec(name: string, input: JsValue): JsValue { return this.options.core.codec(name, input); }

  private protectedPorts(context: JsHostContext): void {
    if (!this.options.material || !this.options.ports.ble || !this.options.ports.files
      || !this.options.ports.randomBytes || !this.options.gatt || !this.options.peripheralId
      || !this.options.maximumWriteBytes || typeof this.options.ports.files.flush !== 'function') {
      throw new BotaJsHostError('encrypted_upload_v2_protected_host_unavailable', context.operation);
    }
    this.metadata ??= object(this.codec('protocolMetadata', {}));
  }

  private address(characteristic: string): GattAddress {
    const serviceUuid = this.metadata?.SERVICE_BOTA_STORAGE;
    const characteristicUuid = this.metadata?.[characteristic];
    if (typeof serviceUuid !== 'string' || typeof characteristicUuid !== 'string') {
      throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
    }
    return { peripheralId: this.options.peripheralId, serviceUuid, characteristicUuid };
  }

  private async write(value: Uint8Array, characteristic: string, context: JsHostContext): Promise<void> {
    this.requireOwner(context);
    if (value.length > this.options.maximumWriteBytes!) throw new BotaJsHostError('payload_too_large', context.operation);
    await this.options.gatt!(context, () => this.options.ports.ble!.write(this.address(characteristic), value, true, context));
    this.requireOwner(context);
  }


  private async prepareSession(context: JsEffectContext): Promise<JsValue> {
    this.protectedPorts(context);
    await this.refreshContext(context);
    const authorization = await this.step(context, () => this.options.material!.authorization(context));
    try {
      const admitted = object(this.codec('validateEncryptedUploadV2Authorization', { request: this.request,
        bytes: publicMetadataBytes(authorization), checkpoint: this.options.priorCheckpoint ?? null,
        ...(this.options.expectedMarkersRequired === undefined ? {} : { markersRequired: this.options.expectedMarkersRequired }) }));
      this.markersRequired = admitted.markersRequired === true;
      if (this.markersRequired && !this.options.material!.submitMarkers) throw new BotaJsHostError('missing_primitive:markers', context.operation);
      this.authorizationSha256 = admitted.sha256 ?? null;
      await this.sendSignedBlob(number(admitted.blobKind), authorization, context);
      return event('SessionPrepared', { authorization_sha256: this.authorizationSha256 });
    } finally { authorization.fill(0); }
  }

  private contextExchange(): JsUploadContextExchange {
    if (!this.exchange) {
      const capabilities = object(object(this.request).capabilities!);
      this.exchange = new JsUploadContextExchange({ core: this.options.core,
        ports: { ble: this.options.ports.ble!, randomBytes: this.options.ports.randomBytes! },
        peripheralId: this.options.peripheralId!, maximumWriteBytes: this.options.maximumWriteBytes!,
        maximumSignedBlobBytes: number(capabilities.maximum_signed_blob_bytes),
        gatt: this.options.gatt!, checkOwner: this.options.checkOwner,
        onCleanupFailure: (error, context) => this.markCleanupFailure(error, context) });
    }
    return this.exchange;
  }
  private refreshContext(context: JsHostContext): Promise<void> {
    const provider = this.options.material!.uploadContext;
    if (!provider) throw new BotaJsHostError('missing_primitive:upload_context', context.operation);
    return this.contextExchange().refresh(provider, context);
  }
  private sendSignedBlob(blobKind: number, value: Uint8Array, context: JsHostContext): Promise<void> {
    return this.contextExchange().sendSignedBlob(blobKind, value, context);
  }
  private timeout(): number {
    const value = this.metadata?.operationTimeoutMs;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new BotaJsHostError('invalid_core_deadline', 'TransferRecording');
    return value;
  }

  private async startTransfer(fields: Record<string, JsValue>, context: JsEffectContext): Promise<JsValue | null> {
    this.protectedPorts(context);
    if (canonical(fields.authorization_sha256!) !== canonical(this.authorizationSha256)) throw new BotaJsHostError('identity_mismatch', context.operation);
    await this.cleanupTransfer(context);
    this.startContext = context;
    this.targetContext = context;
    this.transferAttempted = false;
    this.confirmationAttempted = false;
    this.confirmed = false;
    this.queue = [];
    this.queuedBytes = 0;
    this.queueWake = deferred<void>();
    this.pendingCheckpoint = null;
    this.pendingRepair = null;
    this.markers = [];
    this.manifest?.fill(0);
    this.manifest = null;
    this.evidence = null;
    this.queueFailed = false;
    this.queueFailure = undefined;
    const request = object(this.request);
    const checkpoint = fields.checkpoint ?? null;
    let native = this.codec('initialEncryptedUploadV2ReceiverCheckpoint', {});
    if (checkpoint !== null) {
      if (!this.loadedReceiverCheckpoint) throw new BotaJsHostError('checkpoint_integrity_missing', context.operation);
      native = this.loadedReceiverCheckpoint;
    }
    const capabilities = object(request.capabilities!);
    const created = object(this.codec('createEncryptedUploadV2Receiver', { config: {
      transport_session_id: request.transport_session_id!, expected_ciphertext_length: request.ciphertext_length!,
      expected_ciphertext_sha256: request.ciphertext_sha256!, maximum_data_payload_bytes: request.data_payload_bytes!,
      maximum_window_packets: request.window_packets!, maximum_missing_sequences: capabilities.maximum_missing_sequences!,
      checkpoint: native, markers_required: this.markersRequired,
    } }));
    this.receiverId = number(created.receiverId);
    await this.applyAction(this.codec('startEncryptedUploadV2Receiver', { receiverId: this.receiverId }), context);
    const opened = deferred<JsValue>();
    void opened.promise.catch(() => undefined);
    let accepting = false;
    let opening = true;
    this.subscription = await this.options.gatt!(context, () => this.options.ports.ble!.subscribe(
      this.address('CHAR_RECORDING_TRANSFER_V2'), value => {
        if (!accepting || this.closed) return;
        if (this.confirmationListener) { this.confirmationListener(value); return; }
        try {
          this.requireOwner(context);
          const bytes = Uint8Array.from(publicMetadataBytes(value));
          if (opening) {
            const result = this.codec('acceptEncryptedUploadV2Opening', { request: this.request, checkpoint,
              bytes: publicMetadataBytes(bytes) });
            if (result !== null) { opening = false; opened.resolve(result); }
            return;
          }
          this.enqueue(bytes);
        } catch (error) {
          opened.reject(error);
          this.queueFailure = error;
          this.queueFailed = true;
          this.queueWake.resolve();
        }
      }, context, error => {
        if (this.confirmationError) { this.confirmationError(error); return; }
        opened.reject(error);
        this.queueFailure = error;
        this.queueFailed = true;
        this.queueWake.resolve();
        this.boundaryGate?.resolve();
      }));
    try {
      this.requireOwner(context);
      if (this.queueFailed) throw this.queueFailure;
      const command = wireBytes(this.codec('planEncryptedUploadV2Opening', {
        request: this.request, checkpoint, authorizationSha256: fields.authorization_sha256!,
      }));
      try { accepting = true; this.transferAttempted = true; await this.write(command, 'CHAR_TRANSFER_CONTROL_V2', context); }
      finally { command.fill(0); }
      const result = await catalogResult(opened.promise, this.timeout(), context);
      if (result === 'resume_rejected') { this.transferAttempted = false; await this.cleanupTransfer(context); return event('ResumeRejected'); }
      await context.emit(event('TransferStarted'));
      this.pumpPromise = this.pump();
      void this.pumpPromise.catch(() => undefined);
      return null;
    } catch (error) { await this.cleanupTransfer(context); throw error; }
  }

  private enqueue(value: Uint8Array): void {
    if (this.queuedBytes + value.length > 1024 * 1024) throw new BotaJsHostError('payload_too_large', 'TransferRecording');
    this.queue.push(value);
    this.queuedBytes += value.length;
    this.queueWake.resolve();
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && this.receiverId !== null) {
        const context = this.targetContext!;
        this.requireOwner(context);
        if (this.boundaryGate) { await catalogResult(this.boundaryGate.promise.then(() => null), this.timeout(), context); continue; }
        if (this.queueFailed) throw this.queueFailure;
        const value = this.queue.shift();
        if (!value) { await catalogResult(this.queueWake.promise.then(() => null), this.timeout(), context); this.queueWake = deferred<void>(); continue; }
        this.queuedBytes -= value.length;
        try {
          const parsed = object(this.codec('decodeEncryptedUploadV2Transfer', { bytes: publicMetadataBytes(value) }));
          if (parsed.kind === 'window_end') this.boundary = parsed;
          await this.applyAction(this.codec('receiveEncryptedUploadV2Receiver', { receiverId: this.receiverId,
            bytes: publicMetadataBytes(value) }), context);
          if (this.evidence) return;
        } finally { value.fill(0); }
      }
    } catch (error) {
      if (this.closed || this.startContext?.signal.aborted) return;
      await this.targetContext!.emit(this.codec('encryptedUploadV2Failure', errorMetadata(error)));
    }
  }

  private async applyAction(action: JsValue, context: JsEffectContext): Promise<void> {
    while (action !== 'None') {
      this.requireOwner(context);
      const [kind, payload] = tagged(action);
      const fields = object(payload);
      let response: JsValue;
      switch (kind) {
        case 'InspectSink': {
          const proof = await this.inspectFile(this.options.sink, decimal(fields.prefix_length), fields.flush === true, context, true);
          response = { SinkProof: { request_id: fields.request_id!, byte_length: proof.length, prefix_sha256: proof.sha256 } };
          break;
        }
        case 'TruncateSink':
          await this.step(context, () => this.options.ports.files!.truncate(this.options.sink, decimal(fields.length), context));
          response = { Applied: { request_id: fields.request_id! } };
          break;
        case 'AppendCiphertext': {
          const bytes = wireBytes(fields.bytes!);
          try {
            const offset = decimal(fields.offset);
            if (BigInt(offset) < this.hashedBytes) this.resetHasher();
            const append = await this.step(context, () => this.options.ports.files!.append(this.options.sink, offset, bytes, context));
            if (BigInt(append.durableUnits) !== BigInt(offset) + BigInt(bytes.length)) throw new BotaJsHostError('durable_file_mismatch', context.operation);
          } finally { bytes.fill(0); }
          response = { Applied: { request_id: fields.request_id! } };
          break;
        }
        case 'AppendMarkerDocument': {
          const bytes = wireBytes(fields.document!);
          try {
            const index = number(fields.document_index);
            const handle = await this.step(context, () => this.options.ports.files!.open(`${this.key}/marker/${index}`, 'file', context));
            if (handle.kind !== 'file' || handle.scope !== this.scope) throw new BotaJsHostError('invalid_scope', context.operation);
            const metadata = await this.step(context, () => this.options.ports.files!.metadata(handle, context));
            const retained = await this.step(context, () => this.options.ports.files!.read(handle, '0', bytes.length, context));
            if (!(retained instanceof Uint8Array)) throw new BotaJsHostError('missing_primitive:marker_file_read', context.operation);
            const recovery = object(this.codec('planEncryptedUploadV2MarkerFileRecovery', {
              bytes: publicMetadataBytes(bytes), existingBytes: publicMetadataBytes(retained), durableLength: metadata.durableUnits,
            }));
            retained.fill(0);
            if (recovery.truncate === true) await this.step(context, () => this.options.ports.files!.truncate(handle, '0', context));
            if (recovery.write === true) {
              const appended = await this.step(context, () => this.options.ports.files!.append(handle, '0', bytes, context));
              if (appended.durableUnits !== bytes.length.toString()) throw new BotaJsHostError('durable_file_mismatch', context.operation);
            }
            const proof = await this.inspectFile(handle, bytes.length.toString(), true, context, false);
            if (proof.length !== bytes.length.toString() || canonical(proof.sha256) !== canonical(fields.document_sha256!)) throw new BotaJsHostError('integrity_failed', context.operation);
            this.markers.push({ index, count: number(fields.document_count), sha256: fields.document_sha256!, handle });
          } finally { bytes.fill(0); }
          response = { Applied: { request_id: fields.request_id! } };
          break;
        }
        case 'PersistCheckpoint': {
          this.pendingCheckpoint = { requestId: decimal(fields.request_id), native: fields.checkpoint!, core: this.coreCheckpoint(fields.checkpoint!) };
          this.boundaryGate = deferred<void>();
          await context.emit(event('WindowStaged', { checkpoint: this.pendingCheckpoint.core, missing_sequences: [] }));
          return;
        }
        case 'Control': {
          const frame = wireBytes(fields.frame!);
          const decoded = object(this.codec('decodeEncryptedUploadV2Transfer', { bytes: publicMetadataBytes(frame) }));
          this.pendingRepair = { frame, missing: decoded.missingSequences! };
          this.boundaryGate = deferred<void>();
          const boundary = object(this.boundary!);
          const native = { revision: boundary.checkpointRevision!, next_ciphertext_offset: boundary.nextCiphertextOffset!,
            prefix_sha256: boundary.prefixSha256!, highest_contiguous_sequence: boundary.lastSequence! };
          await context.emit(event('WindowStaged', { checkpoint: this.coreCheckpoint(native), missing_sequences: decoded.missingSequences! }));
          return;
        }
        case 'Complete':
          this.manifest = wireBytes(fields.manifest!);
          this.evidence = fields.evidence!;
          await context.emit(event('TransferCompleted', this.evidence));
          return;
        default: throw new BotaJsHostError('invalid_core_receiver_action', context.operation);
      }
      action = this.codec('applyEncryptedUploadV2Receiver', { receiverId: this.receiverId!, event: response });
    }
  }

  private coreCheckpoint(native: JsValue): JsValue {
    const request = object(this.request);
    const checkpoint = object(native);
    return { device: request.device!, recording: request.recording!, recording_generation: request.recording_generation!,
      upload_session_uuid: request.upload_session_uuid!, owner_revision: request.owner_revision!,
      transport_session_id: request.transport_session_id!, checkpoint_revision: checkpoint.revision!,
      next_ciphertext_offset: checkpoint.next_ciphertext_offset!, prefix_sha256: checkpoint.prefix_sha256!,
      window_packets: request.window_packets!, data_payload_bytes: request.data_payload_bytes! };
  }

  private async repairWindow(fields: Record<string, JsValue>, context: JsEffectContext): Promise<null> {
    this.protectedPorts(context);
    if (!this.pendingRepair || canonical(fields.missing_sequences!) !== canonical(this.pendingRepair.missing)) throw new BotaJsHostError('identity_mismatch', context.operation);
    const repair = this.pendingRepair;
    this.pendingRepair = null;
    this.targetContext = context;
    try { await this.write(repair.frame, 'CHAR_TRANSFER_CONTROL_V2', context); }
    finally { repair.frame.fill(0); }
    const gate = this.boundaryGate;
    this.boundaryGate = null;
    gate?.resolve();
    return null;
  }

  private async acknowledgeWindow(fields: Record<string, JsValue>, context: JsEffectContext): Promise<null> {
    this.protectedPorts(context);
    if (!this.pendingCheckpoint || canonical(fields.checkpoint!) !== canonical(this.pendingCheckpoint.core)
      || canonical(fields.checkpoint!) !== canonical(this.savedCheckpoint)) throw new BotaJsHostError('checkpoint_commit_mismatch', context.operation);
    const action = this.codec('applyEncryptedUploadV2Receiver', { receiverId: this.receiverId!,
      event: { Applied: { request_id: this.pendingCheckpoint.requestId } } });
    const [kind, payload] = tagged(action);
    if (kind !== 'Control') throw new BotaJsHostError('invalid_core_receiver_action', context.operation);
    const frame = wireBytes(object(payload).frame!);
    try { await this.write(frame, 'CHAR_TRANSFER_CONTROL_V2', context); }
    finally { frame.fill(0); }
    await context.emit(event('WindowAcknowledged', { checkpoint: fields.checkpoint! }));
    this.pendingCheckpoint = null;
    this.savedCheckpoint = null;
    this.targetContext = this.startContext;
    const gate = this.boundaryGate;
    this.boundaryGate = null;
    gate?.resolve();
    return null;
  }

  private async stageArtifacts(fields: Record<string, JsValue>, context: JsEffectContext): Promise<JsValue> {
    this.protectedPorts(context);
    if (!this.manifest || !this.evidence || canonical(fields.evidence!) !== canonical(this.evidence)) throw new BotaJsHostError('integrity_failed', context.operation);
    const material = this.options.material!;
    const put = material.reconcileStaging ? await this.step(context,
      () => material.reconcileStaging!(this.manifest!, this.evidence!, context)) : true;
    if (put) await this.step(context, () => material.stageCiphertext(this.options.sink, this.evidence!, context));
    await this.step(context, () => material.submitManifest(this.manifest!, this.evidence!, context));
    if (this.markersRequired) await this.step(context, () => material.submitMarkers!(this.markers, this.evidence!, context));
    return event('ArtifactsStaged');
  }

  private async awaitReceipt(fields: Record<string, JsValue>, context: JsEffectContext): Promise<JsValue> {
    this.protectedPorts(context);
    await this.step(context, () => this.options.material!.finalize(fields.evidence!, context));
    const bytes = await this.step(context, () => this.options.material!.completionReceipt(fields.evidence!, context));
    try {
      const admitted = object(this.codec('validateEncryptedUploadV2Receipt', { request: this.request,
        markersRequired: this.markersRequired, bytes: publicMetadataBytes(bytes) }));
      this.receipt = { bytes, sha256: admitted.sha256!, blobKind: number(admitted.blobKind) };
      return event('CompletionReceiptAccepted', { receipt_sha256: admitted.sha256! });
    } catch (error) { bytes.fill(0); throw error; }
  }

  private async confirmReceipt(fields: Record<string, JsValue>, context: JsEffectContext): Promise<JsValue> {
    this.protectedPorts(context);
    if (!this.receipt || canonical(fields.receipt_sha256!) !== canonical(this.receipt.sha256)) throw new BotaJsHostError('identity_mismatch', context.operation);
    await this.refreshContext(context);
    await this.sendSignedBlob(this.receipt.blobKind, this.receipt.bytes, context);
    this.receipt.bytes.fill(0);
    let rejected = false;
    let rejection: unknown;
    this.confirmationError = error => { rejected = true; rejection = error; };
    this.confirmationListener = value => {
      try {
        this.requireOwner(context);
        this.codec('acceptEncryptedUploadV2Confirm', { request: this.request,
          receiptSha256: this.receipt!.sha256, bytes: publicMetadataBytes(value) });
      } catch (error) { rejected = true; rejection = error; }
    };
    const frame = wireBytes(this.codec('planEncryptedUploadV2Confirm', { request: this.request, receiptSha256: this.receipt.sha256 }));
    try {
      this.confirmationAttempted = true;
      await this.write(frame, 'CHAR_TRANSFER_CONTROL_V2', context);
      if (rejected) throw rejection;
      if (this.subscription) {
        const subscription = this.subscription;
        await this.removeSubscription(subscription, context);
        this.subscription = null;
      }
      if (rejected) throw rejection;
      this.confirmed = true;
      await this.step(context, () => this.options.material!.confirmed?.(context) ?? Promise.resolve());
      return event('RecordingConfirmed');
    } catch (error) {
      const status = error && typeof error === 'object' && 'protocolStatus' in error ? error.protocolStatus : undefined;
      const uncertain = new BotaJsHostError('upload_ownership_unknown', context.operation, false,
        typeof status === 'number' ? status : undefined);
      Object.assign(uncertain, { cause: error });
      throw uncertain;
    } finally { frame.fill(0); this.confirmationListener = null; this.confirmationError = null; }
  }

  private resetHasher(): void {
    if (this.hasherId) this.codec('hasherFree', { decoderId: this.hasherId });
    this.hasherId = null;
    this.hashedBytes = 0n;
  }

  private async inspectFile(handle: OpaqueHostHandle, prefix: string, flush: boolean, context: JsHostContext,
    cumulative: boolean): Promise<{ length: string; sha256: JsValue }> {
    const files = this.options.ports.files!;
    if (flush) await this.step(context, () => (files as typeof files & {
      flush(handle: OpaqueHostHandle, context: JsHostContext): Promise<void>;
    }).flush(handle, context));
    const metadata = await this.step(context, () => files.metadata(handle, context));
    const length = BigInt(decimal(prefix));
    if (BigInt(decimal(metadata.durableUnits)) < length) throw new BotaJsHostError('integrity_failed', context.operation);
    if (cumulative && length < this.hashedBytes) this.resetHasher();
    const id = cumulative ? this.hasherId ?? `${context.operationId}:ciphertext` : `${context.operationId}:marker`;
    let offset = cumulative ? this.hashedBytes : 0n;
    const fresh = !cumulative || !this.hasherId;
    if (fresh) this.codec('hasherNew', { decoderId: id });
    if (cumulative) this.hasherId = id;
    try {
      while (offset < length) {
        const count = Number(length - offset > 65536n ? 65536n : length - offset);
        const value = await this.step(context, () => files.read(handle, offset.toString(), count, context));
        if (!(value instanceof Uint8Array) || value.length !== count) throw new BotaJsHostError('integrity_failed', context.operation);
        try { this.codec('hasherUpdate', { decoderId: id, bytes: publicMetadataBytes(value) }); }
        finally { value.fill(0); }
        offset += BigInt(count);
        if (cumulative) this.hashedBytes = offset;
      }
      return { length: metadata.durableUnits, sha256: object(this.codec('hasherSnapshot', { decoderId: id })).sha256! };
    } finally { if (!cumulative) this.codec('hasherFree', { decoderId: id }); }
  }

  private cancelReceiver(): void {
    if (this.receiverId !== null) this.codec('cancelEncryptedUploadV2Receiver', { receiverId: this.receiverId });
  }

  private async cleanupTransfer(context: JsHostContext | null): Promise<void> {
    let failed = false;
    let failure: unknown;
    if (context && this.transferAttempted && !this.confirmationAttempted && !this.confirmed) {
      try { await this.cleanupWrite(wireBytes(this.codec('planEncryptedUploadV2Abort', { request: this.request })), 'CHAR_TRANSFER_CONTROL_V2', context); }
      catch (error) { failed = true; failure = error; this.markCleanupFailure(error, context); }
    }
    if (this.subscription) {
      const subscription = this.subscription;
      this.subscription = null;
      try { await this.removeSubscription(subscription, context ?? undefined); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
    if (this.receiverId !== null) {
      this.codec('freeEncryptedUploadV2Receiver', { receiverId: this.receiverId });
      this.receiverId = null;
    }
    this.transferAttempted = false;
    for (const value of this.queue) value.fill(0);
    this.queue = [];
    this.queuedBytes = 0;
    if (failed) throw failure;
  }

  private async cleanupWrite(value: Uint8Array, characteristic: string, context: JsHostContext): Promise<void> {
    const cleanup = { ...context, signal: new AbortController().signal };
    try {
      this.options.checkOwner(cleanup);
      await this.options.gatt!(cleanup, () => this.options.ports.ble!.write(this.address(characteristic), value, true, cleanup));
      this.options.checkOwner(cleanup);
    } finally { value.fill(0); }
  }

  private markCleanupFailure(error: unknown, context?: JsHostContext): void {
    if (!this.poisoned) this.poison = error;
    this.poisoned = true;
    try { this.options.onCleanupFailure?.(error, context); } catch {}
  }

  private async removeSubscription(subscription: JsHostSubscription, context?: JsHostContext): Promise<void> {
    try { await subscription.remove(); }
    catch (error) { this.markCleanupFailure(error, context); throw error; }
  }
}

function event(name: string, payload?: JsValue): JsValue {
  return { EncryptedUploadV2: payload === undefined ? name : { [name]: payload } };
}

function tagged(value: JsValue): [string, JsValue] {
  if (typeof value === 'string') return [value, null];
  const fields = Object.entries(object(value));
  if (fields.length !== 1) throw new BotaJsHostError('invalid_core_effect', 'TransferRecording');
  return fields[0]!;
}

function object(value: JsValue): Record<string, JsValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
  }
  return value as Record<string, JsValue>;
}

function decimal(value: JsValue | undefined): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)
    || BigInt(value) > 18446744073709551615n) {
    throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
  }
  return value;
}

function clone(value: JsValue): JsValue {
  return JSON.parse(JSON.stringify(value)) as JsValue;
}

/** Generic JSON equality only; it does not interpret Bota checkpoint fields. */
function canonical(value: JsValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicMetadataBytes(value: JsGattValue): number[] {
  if (!(value instanceof Uint8Array)) throw new BotaJsHostError('public_metadata_unavailable', 'ListRecordings');
  if (value.length > 65536) throw new BotaJsHostError('payload_too_large', 'TransferRecording');
  return Array.from(value);
}

function wireBytes(value: JsValue): Uint8Array {
  if (!Array.isArray(value) || value.some(byte => typeof byte !== 'number'
    || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new BotaJsHostError('invalid_core_bytes', 'ListRecordings');
  }
  return Uint8Array.from(value as number[]);
}

function number(value: JsValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
  return value;
}

function array(value: JsValue): readonly JsValue[] {
  if (!Array.isArray(value)) throw new BotaJsHostError('invalid_core_metadata', 'TransferRecording');
  return value;
}

function deferred<T>() {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = value => yes(value as T); reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function delay(milliseconds: number, context: JsHostContext): Promise<void> {
  await catalogResult(new Promise<null>(resolve => setTimeout(() => resolve(null), milliseconds)), milliseconds + 1000, context);
}

function errorMetadata(error: unknown): JsValue {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return { code: typeof value.code === 'string' ? value.code : 'internal',
    ...(typeof value.protocolStatus === 'number' ? { protocolStatus: value.protocolStatus } : {}),
    detail: 'encrypted upload host effect failed' };
}

async function catalogResult<T>(promise: Promise<T>, timeoutMs: number, context: JsHostContext): Promise<T> {
  if (context.signal.aborted) throw new BotaJsHostError('operation_cancelled', context.operation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new BotaJsHostError('operation_cancelled', context.operation));
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new BotaJsHostError('operation_timeout', context.operation)), timeoutMs);
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { if (timer !== undefined) clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
}
