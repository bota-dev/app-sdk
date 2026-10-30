import type { BotaJsHostPorts, GattAddress, JsHostContext, JsHostSubscription, JsValue, OpaqueHostHandle, RawJsCoreFactory } from './contracts';
import { BotaJsHostError } from './executor';

/** Ephemeral secure-BLE material. Never log, persist, notify or reuse across connections. */
export interface JsLocalWifiMaterial {
  ssid: string;
  password: Uint8Array;
  ipv4: readonly number[];
  port: number;
  expiresInSeconds: number;
  tlsSpkiSha256: Uint8Array;
  downloadToken: Uint8Array;
}
export interface JsLocalWifiReader {
  readonly response: {
    status: number; content_length: string; content_range: string | null;
    etag: string; content_encoding: string | null;
  };
  /** At most maximumLength bytes; null only at EOF. Cancellation must settle read. */
  read(maximumLength: number, context: JsHostContext): Promise<Uint8Array | null>;
  /** Abort and join the actual socket reader before resolving, including after cancellation. */
  close(): Promise<void>;
}
export interface JsLocalWifiLease {
  /** TLS 1.3 + exact SPKI pin, Bearer base64url(token), identity encoding, no redirects.
   * Route this socket through the acquired AP network; do not bind cloud traffic globally.
   * Apply Range/If-Match only for offset > 0. Resolve after response headers, before body reads.
   * If open fails or is cancelled, it must close/join every socket it created. */
  open(request: { path: string; offset: string; etag: string }, context: JsHostContext): Promise<JsLocalWifiReader>;
  /** Release the captured network lease only; resolve after OS cleanup. */
  close(): Promise<void>;
}
export interface JsLocalWifiPort {
  /** Verify OS availability and current App owner. Shared Rust control authentication
   * runs separately before any local command or hotspot material is accepted. */
  preflight(peripheralId: string, context: JsHostContext): Promise<void>;
  /** Join WPA2-CCMP SoftAP. Never infer authorization from a BLE name/JustWorks.
   * On rejection/cancellation, join must clean up any partially acquired network. */
  join(material: JsLocalWifiMaterial, context: JsHostContext): Promise<JsLocalWifiLease>;
}
interface Options {
  core: Pick<RawJsCoreFactory, 'codec'>;
  ports: Pick<BotaJsHostPorts, 'ble' | 'files' | 'persistence' | 'localWifi'>;
  request: JsValue;
  sink: OpaqueHostHandle;
  journalKey: string;
  peripheralId: string;
  maximumWriteBytes: number;
  gatt<T>(context: JsHostContext, body: () => Promise<T>): Promise<T>;
  checkOwner(context: JsHostContext): void;
  inspect(prefix: string, flush: boolean, context: JsHostContext): Promise<{ length: string; sha256: JsValue }>;
  controlGrant(sessionId: string, context: JsHostContext): Promise<string>;
  recovery?(checkpoint: JsValue, context: JsHostContext): Promise<JsValue>;
  sendSignedBlob(kind: number, envelope: Uint8Array, context: JsHostContext): Promise<void>;
  onTransferEvent(value: Uint8Array): void;
  onCleanupFailure(error: unknown): void;
}
/** I/O executor only. Rust decides frame acceptance, ranges, durability and FINISH. */
export class JsLocalWifiTransfer {
  private readonly metadata: Record<string, JsValue>;
  private readonly request: Record<string, JsValue>;
  private readonly controller = new AbortController();
  private readonly subscriptions: JsHostSubscription[] = [];
  private readonly queue: Uint8Array[] = [];
  private wake: (() => void) | undefined;
  private failure: unknown;
  private receiverId: number | undefined;
  private controlId: number | undefined;
  private controlExpiry: ReturnType<typeof setTimeout> | undefined;
  private reader: JsLocalWifiReader | undefined;
  private lease: JsLocalWifiLease | undefined;
  private material: JsLocalWifiMaterial | undefined;
  private active: Promise<{ manifest: Uint8Array; evidence: JsValue }> | undefined;
  private closePromise: Promise<void> | undefined;
  private context: JsHostContext | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private controlAttempted = false;
  private controlFinished = false;
  private transferred = false;
  private closeContext: JsHostContext | undefined;
  private closeListener: ((frame: Uint8Array) => void) | undefined;
  private closed = false;
  private preflightDone = false;
  private readonly key: string;

  constructor(private readonly options: Options) {
    this.metadata = obj(options.core.codec('protocolMetadata', {}));
    for (const key of ['SERVICE_BOTA_LOCAL_WIFI', 'CHAR_LOCAL_WIFI_CAPABILITIES', 'CHAR_LOCAL_WIFI_CONTROL', 'CHAR_LOCAL_WIFI_EVENT', 'SERVICE_BOTA_STORAGE', 'CHAR_RECORDING_TRANSFER_V2']) {
      if (typeof this.metadata[key] !== 'string') throw new BotaJsHostError('unsupported_capability', 'TransferRecording');
    }
    this.request = obj(JSON.parse(JSON.stringify(options.request)) as JsValue);
    this.key = `encrypted-upload-v2/${options.journalKey}/local-wifi`;
  }
  async preflight(context: JsHostContext): Promise<void> {
    this.check(context);
    if (!this.options.ports.localWifi || !this.options.ports.files?.flush || this.options.maximumWriteBytes < 182) {
      throw new BotaJsHostError('unsupported_capability', context.operation);
    }
    await this.step(context, () => this.options.ports.localWifi!.preflight(this.options.peripheralId, context));
    const value = await this.step(context, () => this.options.gatt(context, () =>
      this.options.ports.ble.read(this.address('CHAR_LOCAL_WIFI_CAPABILITIES'), context)));
    this.rpc('Capabilities', { bytes: Array.from(bytes(value)), att_mtu: this.options.maximumWriteBytes + 3 });
    this.preflightDone = true;
  }
  run(context: JsHostContext, authorizationSha256: JsValue): Promise<{ manifest: Uint8Array; evidence: JsValue }> {
    if (this.active || !this.preflightDone || this.closed) throw new BotaJsHostError('stale_host_owner', context.operation);
    const abort = () => { this.controller.abort(); this.wake?.(); };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    this.context = { ...context, signal: this.controller.signal };
    this.active = this.transfer(this.context, authorizationSha256).finally(async () => {
      context.signal.removeEventListener('abort', abort);
      await this.releaseNetwork();
    });
    return this.active;
  }
  assertHealthy(context: JsHostContext): void { this.check(context); }
  cancel(): void { this.controller.abort(); this.wake?.(); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancel();
    this.closePromise = (async () => {
      await this.active?.catch(() => undefined);
      let failure: unknown;
      try { await this.releaseNetwork(); } catch (error) { failure = error; }
      // A failed close remains owned and retryable; never forget a live subscription.
      for (const subscription of [...this.subscriptions].reverse()) {
        try { await subscription.remove(); this.subscriptions.splice(this.subscriptions.indexOf(subscription), 1); }
        catch (error) { failure ??= error; this.options.onCleanupFailure(error); }
      }
      if (this.receiverId !== undefined) {
        this.rpc('Free', { id: this.receiverId }); this.receiverId = undefined;
      }
      this.retireControl();
      for (const frame of this.queue) frame.fill(0);
      this.queue.length = 0;
      if (failure) throw failure;
    })();
    void this.closePromise.catch(() => { this.closePromise = undefined; });
    return this.closePromise;
  }
  async removeCheckpoint(context: JsHostContext): Promise<void> {
    await this.step(context, () => this.options.ports.persistence.remove(this.key, context));
  }
  private async transfer(context: JsHostContext, authorizationSha256: JsValue): Promise<{ manifest: Uint8Array; evidence: JsValue }> {
    const created = obj(this.rpc('Create', { request: this.request, authorization_sha256: authorizationSha256 }));
    this.receiverId = number(created.id);
    const accept = (characteristic: string, value: unknown) => {
      if (characteristic === 'CHAR_LOCAL_WIFI_EVENT' && this.controlFinished) return;
      let frame: Uint8Array | undefined;
      try {
        this.options.checkOwner(this.closeContext ?? context);
        frame = characteristic === 'CHAR_LOCAL_WIFI_EVENT'
          ? bytes(this.rpc('ControlOpen', { id: this.controlId!, bytes: Array.from(bytes(value)) })) : bytes(value).slice();
        if (characteristic === 'CHAR_LOCAL_WIFI_EVENT' && this.closeListener) { this.closeListener(frame); return; }
        if (this.closed || this.controller.signal.aborted) return;
        this.check(context);
        if (frame.length > 182 || this.queue.length >= 32) throw new BotaJsHostError('payload_too_large', context.operation);
        if (this.transferred) {
          if (characteristic === 'CHAR_RECORDING_TRANSFER_V2') this.options.onTransferEvent(frame);
          return;
        }
        this.queue.push(frame.slice()); this.wake?.();
      } catch (error) { this.failure ??= error; this.cancel(); }
      finally { frame?.fill(0); }
    };
    const onError = (error: unknown) => { this.failure = error; this.cancel(); };
    for (const characteristic of ['CHAR_LOCAL_WIFI_EVENT', 'CHAR_RECORDING_TRANSFER_V2']) {
      // Keep acquired handles even when cancellation wins the awaited subscribe.
      const subscription = await this.options.gatt(context, () => this.options.ports.ble.subscribe(
        this.address(characteristic), value => accept(characteristic, value), context, onError));
      this.subscriptions.push(subscription); this.check(context);
    }
    // The original upload authorization has already consumed its own nonce.
    // Allow at most 270 seconds locally: the device nonce can be 30 seconds old.
    this.controlExpiry = setTimeout(() => this.cancel(), 270000);
    let grant = await this.step(context, () => this.options.controlGrant(String(this.request.transport_session_id), context));
    let admitted: Record<string, JsValue>;
    try { admitted = obj(this.rpc('ControlCreate', { session_id: this.request.transport_session_id!, response_json: grant })); }
    finally { grant = ''; }
    this.controlId = number(admitted.id);
    const envelope = bytes(admitted.envelope);
    try { await this.options.sendSignedBlob(number(admitted.blobKind), envelope, context); }
    finally { envelope.fill(0); (admitted.envelope as number[]).fill(0); }
    const query = number(this.metadata.LOCAL_WIFI_LINK_QUERY);
    await this.write(bytes(this.rpc('Link', { command: query, session_id: this.request.transport_session_id! })), context);
    const keyProof = await this.next('link', context);
    try {
      const result = obj(this.rpc('LinkState', { bytes: Array.from(keyProof), session_id: this.request.transport_session_id!, command: query }));
      if (result.state !== 0) throw new BotaJsHostError('protocol_rejected', context.operation);
    } finally { keyProof.fill(0); }
    this.controlAttempted = true;
    await this.write(bytes(created.frame), context);
    this.rpc('Prepared', { id: this.receiverId, bytes: Array.from(await this.next('prepared', context)) });
    while (this.rpc('Manifest', { id: this.receiverId, bytes: Array.from(await this.next('manifest', context)) }) !== true) { /* bounded by Rust */ }
    const journal = await this.step(context, () => this.options.ports.persistence.load(this.key, context));
    const saved = journal === null ? null : obj(journal);
    if (saved && (saved.scope !== this.options.sink.scope || saved.sinkId !== this.options.sink.id)) {
      throw new BotaJsHostError('checkpoint_scope_mismatch', context.operation);
    }
    let checkpoint = saved?.checkpoint ?? null;
    let rebased = false;
    if (checkpoint !== null && this.options.recovery) {
      const recovery = await this.step(context, () => this.options.recovery!(checkpoint, context));
      if (recovery !== null) {
        checkpoint = this.rpc('Rebase', { id: this.receiverId, checkpoint, recovery });
        rebased = true;
      }
    }
    const prefix = decimal(this.rpc('Prefix', { id: this.receiverId, checkpoint }));
    const proof = await this.options.inspect(prefix, false, context);
    this.check(context);
    const plan = obj(this.rpc('Resume', { id: this.receiverId, checkpoint,
      proof: { byte_length: proof.length, prefix_sha256: proof.sha256 } }));
    if (plan.truncate_to !== null) await this.step(context, () => this.options.ports.files!.truncate(
      this.options.sink, decimal(plan.truncate_to), context));
    // Commit only after Rust verifies the retained prefix against actual bytes.
    // A crash before or after this write retains the provider's recovery lineage.
    if (rebased) await this.saveCheckpoint(checkpoint, context);
    if (plan.download === true) await this.download(plan, context);
    await this.write(bytes(this.rpc('Finish', { id: this.receiverId })), context);
    const result = obj(this.rpc('Eof', { id: this.receiverId, bytes: Array.from(await this.next('eof', context)) }));
    this.transferred = true;
    return { manifest: bytes(result.manifest), evidence: result.evidence! };
  }
  private async download(plan: Record<string, JsValue>, context: JsHostContext): Promise<void> {
    const command = number(this.metadata.LOCAL_WIFI_LINK_OPEN);
    await this.write(bytes(this.rpc('Link', { command, session_id: this.request.transport_session_id! })), context);
    const linkDeadline = Date.now() + number(this.metadata.operationTimeoutMs);
    for (;;) {
      const frame = await this.next('link', context, linkDeadline);
      let link: Record<string, JsValue>;
      try { link = obj(this.rpc('LinkState', { bytes: Array.from(frame), session_id: this.request.transport_session_id!, command })); }
      finally { frame.fill(0); }
      if (link.state === 1) continue;
      if (link.state !== 2 || !link.material) throw new BotaJsHostError('protocol_rejected', context.operation);
      const m = obj(link.material);
      this.material = { ssid: String(m.ssid), password: bytes(m.password), ipv4: m.ipv4 as number[],
        port: number(m.port), expiresInSeconds: number(m.expiresInSeconds), tlsSpkiSha256: bytes(m.tlsSpkiSha256), downloadToken: bytes(m.downloadToken) };
      // Scrub transient arrays after copying into the ephemeral native-port input.
      for (const key of ['password', 'tlsSpkiSha256', 'downloadToken']) (m[key] as number[]).fill(0);
      break;
    }
    this.expiry = setTimeout(() => this.cancel(), Math.min(this.material.expiresInSeconds, 2147483) * 1000);
    this.lease = await this.options.ports.localWifi!.join(this.material, context); this.check(context);
    this.reader = await this.lease.open({ path: String(plan.path), offset: decimal(plan.offset), etag: String(plan.etag) }, context); this.check(context);
    this.rpc('Response', { id: this.receiverId!, response: this.reader.response as unknown as JsValue });
    let offset = BigInt(decimal(plan.offset));
    for (;;) {
      const value = await this.step(context, () => this.reader!.read(65536, context));
      if (value === null) break;
      try {
        const start = decimal(this.rpc('Chunk', { id: this.receiverId!, length: value.length }));
        await this.step(context, () => this.options.ports.files!.append(this.options.sink, start, value, context));
        offset += BigInt(value.length);
        const proof = await this.options.inspect(offset.toString(), true, context); this.check(context);
        const checkpoint = this.rpc('Flushed', { id: this.receiverId!, proof: { byte_length: proof.length, prefix_sha256: proof.sha256 } });
        await this.saveCheckpoint(checkpoint, context);
        this.rpc('Saved', { id: this.receiverId!, checkpoint });
      } finally { value.fill(0); }
    }
    await this.reader.close(); this.reader = undefined;
    this.check(context); this.rpc('ReaderClosed', { id: this.receiverId! });
  }
  private async saveCheckpoint(checkpoint: JsValue, context: JsHostContext): Promise<void> {
    const journal = { scope: this.options.sink.scope, sinkId: this.options.sink.id, checkpoint };
    const expected = JSON.stringify(journal);
    await this.step(context, () => this.options.ports.persistence.save(this.key, JSON.parse(expected) as JsValue, context));
    const actual = await this.step(context, () => this.options.ports.persistence.load(this.key, context));
    if (JSON.stringify(actual) !== expected) throw new BotaJsHostError('checkpoint_commit_mismatch', context.operation);
  }
  private async releaseNetwork(): Promise<void> {
    let failure: unknown;
    try { await this.reader?.close(); this.reader = undefined; } catch (error) { failure = error; }
    try { await this.lease?.close(); this.lease = undefined; } catch (error) { failure ??= error; }
    if (this.expiry) clearTimeout(this.expiry);
    if (this.controlAttempted && this.context) {
      const cancellation = new AbortController();
      const cleanup = { ...this.context, signal: cancellation.signal };
      try {
        this.options.checkOwner(cleanup);
        const command = number(this.metadata.LOCAL_WIFI_LINK_CLOSE);
        const plain = bytes(this.rpc('Link', { command, session_id: this.request.transport_session_id! }));
        const frame = this.seal(plain); plain.fill(0);
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const stopped = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        void stopped.catch(() => undefined);
        // The same deadline bounds both the submitted GATT write and OFF wait.
        // Cancelling a port must settle its real IO; do not race and abandon it.
        const timer = setTimeout(() => {
          cancellation.abort();
          reject(new BotaJsHostError('timeout', cleanup.operation));
        }, number(this.metadata.operationTimeoutMs));
        this.closeContext = cleanup;
        this.closeListener = value => {
          try {
            this.options.checkOwner(cleanup);
            const state = obj(this.rpc('LinkState', { bytes: Array.from(value), session_id: this.request.transport_session_id!, command })).state;
            if (state === 0) resolve();
            else if (state !== 3) reject(new BotaJsHostError('protocol_rejected', cleanup.operation));
          } catch (error) { reject(error); }
        };
        try {
          await this.options.gatt(cleanup, () => this.options.ports.ble.write(this.address('CHAR_LOCAL_WIFI_CONTROL'), frame, true, cleanup));
          await stopped;
          this.controlAttempted = false;
        } finally { clearTimeout(timer); this.closeListener = undefined; this.closeContext = undefined; frame.fill(0); }
      } catch (error) { failure ??= error; }
    }
    this.material?.password.fill(0); this.material?.tlsSpkiSha256.fill(0); this.material?.downloadToken.fill(0); this.material = undefined;
    if (failure) {
      this.options.onCleanupFailure(failure);
      throw new BotaJsHostError('cleanup_incomplete', this.context?.operation ?? 'TransferRecording');
    }
    // Cloud publication/receipt keeps its existing owner and storage listener,
    // but no longer needs the hotspot control key or its short expiry timer.
    if (this.transferred && !this.controlAttempted) this.retireControl();
  }
  private retireControl(): void {
    if (this.controlExpiry) clearTimeout(this.controlExpiry);
    this.controlExpiry = undefined;
    if (this.controlId !== undefined) { this.rpc('ControlFree', { id: this.controlId }); this.controlId = undefined; }
    this.controlFinished = true;
  }
  private async next(kind: string, context: JsHostContext, deadline = Date.now() + number(this.metadata.operationTimeoutMs)): Promise<Uint8Array> {
    for (;;) {
      this.check(context);
      const frame = this.queue.shift();
      if (frame) {
        try {
          if (this.rpc('Event', { bytes: Array.from(frame), session_id: this.request.transport_session_id! }) !== kind) {
            throw new BotaJsHostError('unexpected_event', context.operation);
          }
          return frame;
        } catch (error) { frame.fill(0); throw error; }
      }
      if (Date.now() >= deadline) throw new BotaJsHostError('timeout', context.operation);
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, deadline - Date.now());
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }
  private address(characteristic: string): GattAddress {
    const service = characteristic === 'CHAR_RECORDING_TRANSFER_V2' ? 'SERVICE_BOTA_STORAGE' : 'SERVICE_BOTA_LOCAL_WIFI';
    return { peripheralId: this.options.peripheralId, serviceUuid: String(this.metadata[service]), characteristicUuid: String(this.metadata[characteristic]) };
  }
  private async write(frame: Uint8Array, context: JsHostContext): Promise<void> {
    let wire: Uint8Array | undefined;
    try { wire = this.seal(frame); await this.step(context, () => this.options.gatt(context, () => this.options.ports.ble.write(this.address('CHAR_LOCAL_WIFI_CONTROL'), wire!, true, context))); }
    finally { frame.fill(0); wire?.fill(0); }
  }
  private seal(frame: Uint8Array): Uint8Array {
    if (this.controlId === undefined) throw new BotaJsHostError('unsupported_capability', 'TransferRecording');
    return bytes(this.rpc('ControlSeal', { id: this.controlId, bytes: Array.from(frame) }));
  }
  private check(context: JsHostContext): void {
    if (this.failure) throw this.failure;
    if (this.closed || context.signal.aborted) throw new BotaJsHostError('operation_cancelled', context.operation);
    this.options.checkOwner(context);
  }
  private async step<T>(context: JsHostContext, body: () => Promise<T>): Promise<T> { this.check(context); const value = await body(); this.check(context); return value; }
  private rpc(op: string, value: Record<string, JsValue>): JsValue { return this.options.core.codec('localWifiTransfer', { op, ...value }); }
}
function obj(value: JsValue): Record<string, JsValue> { if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid local transfer metadata'); return value as Record<string, JsValue>; }
function bytes(value: unknown): Uint8Array { if (value instanceof Uint8Array) return value; if (Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return Uint8Array.from(value); throw new Error('Invalid local transfer bytes'); }
function number(value: JsValue | undefined): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid local transfer integer'); return value; }
function decimal(value: JsValue | undefined): string { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid local transfer offset'); return value; }
