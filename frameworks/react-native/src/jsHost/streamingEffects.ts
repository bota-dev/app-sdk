import type { NativeStreamingStartRequest, NativeStreamingUploadDestination } from '../specs/NativeBotaDeviceSDK';
import type { JsEffectContext, JsEffectHandler, JsFilePort, JsHostContext, JsValue, OpaqueHostHandle, RawJsCoreFactory } from './contracts';
import { BotaJsHostError } from './executor';

export interface JsStreamingEffectsOptions {
  core: Pick<RawJsCoreFactory, 'codec'>;
  files: JsFilePort;
  namespace: string;
  emit(event: string, value: unknown): void;
  checkOwner(context: JsHostContext, serialNumber: string): void;
  /** Generic HTTP upload, with the supplied exact destination/body and abort ownership. */
  upload(destination: Readonly<NativeStreamingUploadDestination>, body: Uint8Array, context: JsHostContext): Promise<void>;
  now?: () => number;
}
interface Session {
  operationId: string;
  input: Readonly<NativeStreamingStartRequest & { serialNumber: string }>;
  context?: JsEffectContext;
  handle?: OpaqueHostHandle;
  tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  backgroundFailure?: unknown;
  encrypted?: boolean;
  key?: number[];
  salt?: number[];
  durable: bigint;
  uploadedOffset: bigint;
  receivedUnits: bigint;
  uploadedChunks: number;
  nextPlaintextSequence: number;
  startedAt: number;
  closed: boolean;
  cleaned: boolean;
  finalized: boolean;
  cleanup?: Promise<void>;
}
interface Pending {
  kind: 'destination' | 'finalize';
  session: Session;
  context: JsHostContext;
  resolve(value: NativeStreamingUploadDestination | null): void;
  reject(error: unknown): void;
}

/** Durable chunk I/O and scoped application callbacks; Rust owns packet/workflow policy. */
export class JsStreamingEffects {
  private readonly options: JsStreamingEffectsOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, Pending>();
  private requestSequence = 0;

  constructor(options: JsStreamingEffectsOptions) { this.options = options; }

  register(operationId: string, input: NativeStreamingStartRequest & { serialNumber: string }): void {
    if (!operationId || !input.sessionId || input.sessionId.length > 256 || !input.serialNumber ||
        this.sessions.has(input.sessionId) || !Number.isInteger(input.chunkSizeBytes) ||
        input.chunkSizeBytes < 65536 || input.chunkSizeBytes > 1048576 ||
        !Number.isSafeInteger(input.flushIntervalMs) || input.flushIntervalMs < 0 || input.flushIntervalMs > 2147483647) {
      throw new BotaJsHostError('invalid_streaming_registration', 'TransferRecording');
    }
    this.sessions.set(input.sessionId, {
      operationId, input: Object.freeze({ ...input }), tail: Promise.resolve(), durable: 0n,
      uploadedOffset: 0n, receivedUnits: 0n, uploadedChunks: 0, nextPlaintextSequence: 1,
      startedAt: this.now(), closed: false, cleaned: false, finalized: false,
    });
  }

  /** Register this composition once for RecordingSink; ordinary file operations are delegated. */
  recordingSink(normalHandler: JsEffectHandler): JsEffectHandler {
    return (effect, context) => {
      const [kind] = tagged(effect);
      return streamingKinds.has(kind) ? this.handler(effect, context) : normalHandler(effect, context);
    };
  }

  handler: JsEffectHandler = async (effect, context) => {
    const [kind, fields] = tagged(effect);
    if (!streamingKinds.has(kind)) throw new BotaJsHostError('invalid_streaming_effect', context.operation);
    const session = this.sessions.get(text(fields.sink_id));
    if (!session || session.operationId !== context.operationId) throw new BotaJsHostError('streaming_identity_mismatch', context.operation);
    if (kind === 'DiscardStreaming') {
      if (session.context && (session.context.generation !== context.generation ||
          session.context.cancellationId !== context.cancellationId)) throw new BotaJsHostError('streaming_identity_mismatch', context.operation);
      await this.cleanup(session, context); return null;
    }
    this.bind(session, context);
    return this.enqueue(session, async () => {
      this.check(session, context);
      if (session.backgroundFailure) throw session.backgroundFailure;
      const handle = await this.file(session, context);
      if (kind === 'AppendStreamingPlaintext') {
        session.encrypted = false;
        const payload = bytes(fields.payload);
        await this.append(session, handle, payload, context);
        session.receivedUnits += this.units(false, payload.length);
        await this.flush(session, context, false);
        this.scheduleFlush(session, context);
        return this.accepted(session);
      }
      if (kind === 'BeginStreamingEncrypted') {
        session.encrypted = true;
        session.key = Array.from(bytes(fields.ephemeral_public_key, 32));
        session.salt = Array.from(bytes(fields.salt, 4));
        return this.accepted(session);
      }
      if (kind === 'AppendStreamingEncrypted') {
        const payload = bytes(fields.payload);
        const sequence = uint(fields.sequence, 0xffff);
        await this.append(session, handle, payload, context);
        // Framing and ciphertext overhead are shared Rust codecs, never host wire rules.
        const body = bytes(this.options.core.codec('encodeStreamingRelayChunk', {
          ephemeralPublicKey: session.key ?? [], salt: session.salt ?? [], sequence, ciphertext: Array.from(payload),
        }));
        const uploaded = await this.upload(session, sequence, true, body, context);
        if (uploaded) session.uploadedChunks += 1;
        session.receivedUnits += this.units(true, payload.length);
        session.uploadedOffset = session.durable;
        return this.accepted(session);
      }
      if (kind === 'FinalizeStreaming') {
        this.cancelTimer(session);
        const encrypted = fields.encrypted;
        const total = decimal(fields.total_units);
        if (typeof encrypted !== 'boolean' || encrypted !== session.encrypted || total !== session.receivedUnits) {
          throw new BotaJsHostError('streaming_finalize_mismatch', context.operation);
        }
        if (!encrypted) await this.flush(session, context, true);
        const totalChunks = encrypted ? uint(fields.expected_chunks, 0xffffffff) : session.uploadedChunks;
        await this.request(session, context, 'finalize', { totalChunks,
          durationMs: Math.max(0, Math.floor(this.now() - session.startedAt)),
          fileSizeBytes: safeNumber(session.receivedUnits), encrypted });
        this.check(session, context);
        session.finalized = true;
        return { StreamingSinkFinalized: { uploaded_chunks: session.uploadedChunks, total_units: session.receivedUnits.toString() } };
      }
      throw new BotaJsHostError('invalid_streaming_effect', context.operation);
    });
  };

  result(sessionId: string): { totalBytes: number } {
    const session = this.sessions.get(sessionId);
    if (!session?.finalized) throw new BotaJsHostError('streaming_not_finalized', 'TransferRecording');
    return { totalBytes: safeNumber(session.receivedUnits) };
  }

  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.context) await this.cleanup(session, session.context);
    this.sessions.delete(sessionId);
  }

  async resolveStreamingChunkDestination(requestId: string, destination: NativeStreamingUploadDestination): Promise<void> {
    const request = this.require(requestId, 'destination');
    try {
      this.check(request.session, request.context);
      request.resolve(validateDestination(destination));
    } catch (error) { request.reject(error); throw error; }
  }
  async rejectStreamingChunkDestination(requestId: string, _message?: string): Promise<void> {
    const request = this.requests.get(requestId);
    if (request?.kind === 'destination') request.reject(new BotaJsHostError('streaming_destination_rejected', 'TransferRecording'));
  }
  async resolveStreamingFinalize(requestId: string): Promise<void> {
    const request = this.require(requestId, 'finalize');
    try { this.check(request.session, request.context); request.resolve(null); }
    catch (error) { request.reject(error); throw error; }
  }
  async rejectStreamingFinalize(requestId: string, _message?: string): Promise<void> {
    const request = this.requests.get(requestId);
    if (request?.kind === 'finalize') request.reject(new BotaJsHostError('streaming_finalize_rejected', 'TransferRecording'));
  }

  private bind(session: Session, context: JsEffectContext): void {
    if (!session.context) {
      session.context = context;
      context.addCleanup(() => this.cleanup(session, context));
    }
    this.check(session, context);
  }
  private check(session: Session, context: JsHostContext): void {
    if (session.closed || context.signal.aborted || session.context?.generation !== context.generation ||
        session.context.cancellationId !== context.cancellationId || session.operationId !== context.operationId) {
      throw new BotaJsHostError('operation_cancelled', context.operation);
    }
    this.options.checkOwner(context, session.input.serialNumber);
  }
  private enqueue<T>(session: Session, action: () => Promise<T>): Promise<T> {
    const result = session.tail.then(action);
    session.tail = result.then(() => {}, () => {});
    return result;
  }
  private async file(session: Session, context: JsHostContext): Promise<OpaqueHostHandle> {
    if (session.handle) return session.handle;
    const handle = await this.options.files.open(`streaming/${session.input.sessionId}/${session.operationId}`, 'file', context);
    if (handle.kind !== 'file' || handle.scope !== this.options.namespace || !handle.id) {
      throw new BotaJsHostError('foreign_file_handle', context.operation);
    }
    session.handle = Object.freeze({ ...handle });
    await this.options.files.truncate(session.handle, '0', context);
    this.check(session, context);
    return session.handle;
  }
  private async append(session: Session, handle: OpaqueHostHandle, payload: Uint8Array, context: JsHostContext): Promise<void> {
    const expected = session.durable + BigInt(payload.length);
    const result = await this.options.files.append(handle, session.durable.toString(), payload, context);
    if (decimal(result.durableUnits) !== expected) throw new BotaJsHostError('durable_file_mismatch', context.operation);
    this.check(session, context);
    session.durable = expected;
  }
  private async flush(session: Session, context: JsHostContext, partial: boolean): Promise<void> {
    while (session.durable - session.uploadedOffset >= BigInt(session.input.chunkSizeBytes) ||
           (partial && session.durable > session.uploadedOffset)) {
      this.check(session, context);
      const size = Number(min(session.durable - session.uploadedOffset, BigInt(session.input.chunkSizeBytes)));
      const body = await this.options.files.read(session.handle!, session.uploadedOffset.toString(), size, context);
      if (!(body instanceof Uint8Array) || body.length !== size) throw new BotaJsHostError('streaming_read_bound', context.operation);
      await this.upload(session, session.nextPlaintextSequence, false, body, context);
      this.check(session, context);
      session.nextPlaintextSequence += 1;
      session.uploadedChunks += 1;
      session.uploadedOffset += BigInt(size);
    }
  }
  private async upload(session: Session, sequence: number, encrypted: boolean, body: Uint8Array, context: JsHostContext): Promise<boolean> {
    const policy = record(this.options.core.codec('streamingUploadPolicy', { encrypted, sequence }));
    const attempts = uint(policy.attempts, 16);
    const delays = policy.retryDelaysMs;
    if (attempts < 1 || !Array.isArray(delays) || delays.length !== attempts - 1 || typeof policy.allowGap !== 'boolean') {
      throw new BotaJsHostError('invalid_streaming_policy', context.operation);
    }
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.check(session, context);
      try {
        const destination = await this.request(session, context, 'destination', { sequence, encrypted });
        await this.options.upload(destination!, body, context);
        this.check(session, context);
        return true;
      } catch (error) {
        this.check(session, context);
        failure = error;
        if (attempt + 1 < attempts) await delay(uint(delays[attempt], 2147483647), context.signal);
      }
    }
    if (policy.allowGap) return false;
    throw failure;
  }
  private units(encrypted: boolean, length: number): bigint {
    return decimal(this.options.core.codec('streamingAcceptedUnits', { encrypted, ciphertextLength: String(length) }));
  }
  private accepted(session: Session): JsValue {
    return { StreamingSinkAccepted: { received_units: session.receivedUnits.toString() } };
  }
  private scheduleFlush(session: Session, context: JsEffectContext): void {
    this.cancelTimer(session);
    if (!session.input.flushIntervalMs || session.durable === session.uploadedOffset) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.enqueue(session, () => this.flush(session, context, true)).catch(error => { session.backgroundFailure ??= error; });
    }, session.input.flushIntervalMs);
  }
  private cancelTimer(session: Session): void { if (session.timer) clearTimeout(session.timer); session.timer = undefined; }
  private request(session: Session, context: JsHostContext, kind: Pending['kind'], fields: Record<string, unknown>): Promise<NativeStreamingUploadDestination | null> {
    this.check(session, context);
    const requestId = `stream:${context.operationId}:${context.generation}:${context.requestId}:${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const release = () => { this.requests.delete(requestId); context.signal.removeEventListener('abort', abort); };
      const request: Pending = { kind, session, context,
        resolve(value) { release(); resolve(value); }, reject(error) { release(); reject(error); } };
      const abort = () => request.reject(new BotaJsHostError('operation_cancelled', context.operation));
      this.requests.set(requestId, request);
      context.signal.addEventListener('abort', abort, { once: true });
      try { this.options.emit(kind === 'destination' ? 'onStreamingChunkDestinationRequested' : 'onStreamingFinalizeRequested',
        { requestId, sessionId: session.input.sessionId, ...fields }); }
      catch (error) { request.reject(error); }
    });
  }
  private require(requestId: string, kind: Pending['kind']): Pending {
    const request = this.requests.get(requestId);
    if (!request || request.kind !== kind) throw new BotaJsHostError('stale_streaming_request', 'TransferRecording');
    return request;
  }
  private cleanup(session: Session, context: JsHostContext): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.closed = true;
    this.cancelTimer(session);
    for (const request of [...this.requests.values()]) {
      if (request.session === session) request.reject(new BotaJsHostError('operation_cancelled', context.operation));
    }
    // Cleanup cannot restart old I/O. Its fresh signal only removes this captured scoped staging file.
    const cleanupContext = { ...context, signal: new AbortController().signal };
    session.cleanup = session.tail.then(async () => {
      if (session.handle) await this.options.files.remove(session.handle, cleanupContext);
      session.key = undefined; session.salt = undefined; session.cleaned = true;
    });
    return session.cleanup;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}

const streamingKinds = new Set(['AppendStreamingPlaintext', 'BeginStreamingEncrypted', 'AppendStreamingEncrypted', 'FinalizeStreaming', 'DiscardStreaming']);
function record(value: JsValue): { readonly [key: string]: JsValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotaJsHostError('invalid_streaming_effect', 'TransferRecording');
  return value as { readonly [key: string]: JsValue };
}
function tagged(value: JsValue): [string, { readonly [key: string]: JsValue }] {
  const entries = Object.entries(record(value));
  if (entries.length !== 1) throw new BotaJsHostError('invalid_streaming_effect', 'TransferRecording');
  return [entries[0]![0], record(entries[0]![1])];
}
function text(value: JsValue | undefined): string {
  if (typeof value !== 'string' || !value) throw new BotaJsHostError('invalid_streaming_effect', 'TransferRecording');
  return value;
}
function bytes(value: JsValue | undefined, length?: number): Uint8Array {
  if (!Array.isArray(value) || value.length > 1048612 || (length !== undefined && value.length !== length) ||
      value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new BotaJsHostError('invalid_streaming_bytes', 'TransferRecording');
  }
  return Uint8Array.from(value as number[]);
}
function decimal(value: JsValue | undefined): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) {
    throw new BotaJsHostError('invalid_streaming_units', 'TransferRecording');
  }
  return BigInt(value);
}
function uint(value: JsValue | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) throw new BotaJsHostError('invalid_streaming_integer', 'TransferRecording');
  return value;
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BotaJsHostError('streaming_public_integer_bound', 'TransferRecording');
  return Number(value);
}
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function validateDestination(value: NativeStreamingUploadDestination): Readonly<NativeStreamingUploadDestination> {
  try {
    const url = new URL(value.url);
    if (value.url.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.hash ||
        !['PUT', 'POST'].includes(value.method) || !/^[\x20-\x7e]{1,256}$/.test(value.contentType) ||
        (value.bearerToken !== undefined && !/^[\x21-\x7e]{1,65536}$/.test(value.bearerToken))) throw new Error();
    return Object.freeze({ url: value.url, method: value.method, contentType: value.contentType, bearerToken: value.bearerToken });
  } catch { throw new BotaJsHostError('invalid_streaming_destination', 'TransferRecording'); }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new BotaJsHostError('operation_cancelled', 'TransferRecording')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
