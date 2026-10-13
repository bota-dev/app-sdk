import { Buffer } from 'buffer';
import type { NativeRecordingUploadRequest } from '../specs/NativeBotaDeviceSDK';
import { UploadVerificationPendingError } from '../managers/uploadVerificationPending';
import type { JsFilePort, JsHostContext, JsPersistencePort, JsValue, OpaqueHostHandle, RawJsCoreFactory } from './contracts';
import { BotaJsHostError } from './executor';
import type { JsV2Fetch, JsV2HttpResponse } from './uploadBackendV2';

export interface JsRecordingUploadTarget {
  readonly url: string;
  readonly method: 'PUT' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
}
export interface JsOwnedRecordingFile {
  readonly handle: OpaqueHostHandle;
  readonly localPath: string;
  readonly durableUnits: string;
}
export interface JsRecordingUploadsOptions {
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly files: JsFilePort;
  readonly persistence: JsPersistencePort;
  readonly fetch: JsV2Fetch;
  /** Generic installed HTTP/file IO; must refuse redirects before forwarding data. */
  readonly uploadFile: (target: JsRecordingUploadTarget, file: OpaqueHostHandle,
    progress: (completedBytes: string, totalBytes: string) => void, context: JsHostContext) => Promise<void>;
  readonly lookup: (taskId: string, localPath: string, context: JsHostContext,
    identity?: { recordingId: string; deviceId: string }) => Promise<JsOwnedRecordingFile>;
  readonly checkOwner: (context: JsHostContext) => void;
  readonly onProgress: (progress: { taskId: string; completedBytes: number; totalBytes: number }) => void;
}
interface UploadOwner {
  readonly controller: AbortController;
  readonly context: JsHostContext;
  readonly removeAbort: () => void;
  work: Promise<void>;
  fileKey?: string;
  filePath?: string;
}

/** HTTP and durable file mechanics; generated Rust owns upload and release admission. */
export class JsRecordingUploads {
  private readonly namespace: string;
  private readonly options: JsRecordingUploadsOptions;
  private readonly active = new Map<string, UploadOwner>();
  private readonly cancelled = new Set<string>();
  private readonly heldFiles = new Map<string, UploadOwner>();
  private readonly heldPaths = new Map<string, UploadOwner>();
  private readonly writingPaths = new Set<string>();
  private readonly writers = new Map<string, object>();
  private queueTail: Promise<unknown> = Promise.resolve();
  private journalWriteUncertain = false;
  private closed = false;
  private closing?: Promise<void>;
  private cancellingAll?: Promise<void>;

  constructor(options: JsRecordingUploadsOptions) {
    this.options = { ...options };
    this.namespace = options.persistence.namespace;
  }

  upload(request: NativeRecordingUploadRequest, context: JsHostContext): Promise<void> {
    try {
      this.check(context);
      if (this.cancellingAll) throw failure('operation_cancelled');
      request = JSON.parse(JSON.stringify(request, (_key, value: unknown) =>
        typeof value === 'number' && !Number.isFinite(value) ? `non-json-number:${value}` : value));
      if (this.cancelled.has(request.taskId)) throw failure('operation_cancelled');
      if (this.active.has(request.taskId)) throw failure('operation_in_progress');
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener('abort', abort, { once: true });
      const owner: UploadOwner = { controller, context: Object.freeze({ ...context, signal: controller.signal }),
        removeAbort: () => context.signal.removeEventListener('abort', abort), work: Promise.resolve() };
      if (context.signal.aborted) controller.abort();
      this.active.set(request.taskId, owner);
      owner.work = this.perform(request, owner).finally(() => {
        if (owner.fileKey && this.heldFiles.get(owner.fileKey) === owner) this.heldFiles.delete(owner.fileKey);
        if (owner.filePath && this.heldPaths.get(owner.filePath) === owner) this.heldPaths.delete(owner.filePath);
        owner.removeAbort();
        if (this.active.get(request.taskId) === owner) this.active.delete(request.taskId);
        owner.controller.abort();
      });
      void owner.work.catch(() => {});
      return owner.work;
    } catch (error) { return Promise.reject(error); }
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
    const owner = this.active.get(taskId);
    if (!owner) return;
    owner.controller.abort();
    await owner.work.catch(() => {});
  }

  assertWritable(handle: OpaqueHostHandle): void {
    const key = this.fileKey(handle);
    if (this.heldFiles.has(key) || this.writers.has(key)) throw failure('operation_in_progress');
  }

  /** Keep an already dispatched mutation visible until its actual IO settles. */
  acquireWritable(handle: OpaqueHostHandle): () => void {
    this.assertWritable(handle);
    const key = this.fileKey(handle), owner = {};
    this.writers.set(key, owner);
    return () => { if (this.writers.get(key) === owner) this.writers.delete(key); };
  }

  cancelAll(): Promise<void> {
    if (this.cancellingAll) return this.cancellingAll;
    const work = [...this.active.entries()].map(([taskId, owner]) => {
      this.cancelled.add(taskId); owner.controller.abort(); return owner.work;
    });
    const drain = Promise.allSettled(work).then(async () => { await this.queueTail.catch(() => {}); });
    this.cancellingAll = drain.finally(() => { this.cancellingAll = undefined; });
    return this.cancellingAll;
  }

  loadQueue(context: JsHostContext): Promise<string> {
    return this.journal(async () => {
      this.check(context);
      const value = await this.options.persistence.load('compatibility/upload-queue', context);
      this.check(context);
      return JSON.stringify(this.codec('sanitizeCompatibilityUploadQueue', { tasks: value ?? [] }));
    });
  }

  saveQueue(serialized: string, context: JsHostContext): Promise<void> {
    return this.journal(async () => {
      this.check(context);
      let value: JsValue;
      try { value = JSON.parse(serialized); } catch { throw failure('invalid_upload_journal'); }
      const clean = this.codec('sanitizeCompatibilityUploadQueue', { tasks: value });
      this.journalWriteUncertain = true;
      await this.options.persistence.save('compatibility/upload-queue', clean, context);
      this.check(context);
      const proof = await this.options.persistence.load('compatibility/upload-queue', context);
      this.check(context);
      if (canonical(proof) !== canonical(clean)) throw failure('upload_journal_commit_mismatch');
      this.journalWriteUncertain = false;
    });
  }

  release(taskId: string, localPath: string, context: JsHostContext): Promise<void> {
    return this.journal(async () => {
      this.check(context);
      const tasks = await this.options.persistence.load('compatibility/upload-queue', context);
      this.check(context);
      // Admit the queue identity before reopening any file after process loss.
      this.codec('recordingFileLookupAdmission', { tasks: tasks ?? [], taskId, localPath, completedOnly: true,
        journalWriteUncertain: this.journalWriteUncertain });
      const file = await this.options.lookup(taskId, localPath, context);
      this.check(context);
      if (this.heldPaths.has(localPath)) throw failure('operation_in_progress');
      const release = this.acquireWritable(file.handle);
      this.writingPaths.add(localPath);
      try {
        this.codec('releaseRecordingFileAdmission', { tasks: tasks ?? [], taskId, localPath,
          file: this.proof(file), namespace: this.namespace, journalWriteUncertain: this.journalWriteUncertain });
        await this.options.files.remove(file.handle, context);
        this.check(context);
      } finally { this.writingPaths.delete(localPath); release(); }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const owner of this.active.values()) owner.controller.abort();
    this.closing = Promise.allSettled([...this.active.values()].map(owner => owner.work))
      .then(async () => { await this.queueTail.catch(() => {}); });
    return this.closing;
  }

  private async perform(request: NativeRecordingUploadRequest, owner: UploadOwner): Promise<void> {
    const context = owner.context;
    this.check(context);
    const file = await this.options.lookup(request.taskId, request.localPath, context,
      { recordingId: request.recordingId, deviceId: request.deviceId });
    this.check(context);
    this.codec('planRecordingFileUpload', { request: request as unknown as JsValue, file: this.proof(file), namespace: this.namespace });
    const key = this.fileKey(file.handle);
    if (this.heldFiles.has(key) || this.heldPaths.has(file.localPath) || this.writingPaths.has(file.localPath) || this.writers.has(key)) throw failure('operation_in_progress');
    owner.fileKey = key; owner.filePath = file.localPath;
    this.heldFiles.set(key, owner); this.heldPaths.set(file.localPath, owner);
    const metadata = await this.options.files.metadata(file.handle, context);
    this.check(context);
    const fresh = { ...file, durableUnits: metadata.durableUnits, localPath: metadata.localPath ?? file.localPath };
    const plan = object(this.codec('planRecordingFileUpload', {
      request: request as unknown as JsValue, file: this.proof(fresh), namespace: this.namespace,
    }));
    const target = object(plan.target) as unknown as JsRecordingUploadTarget;
    exactUrl(target.url);
    let previous = '0';
    let progressFailure: unknown;
    const progress = (completedBytes: string, totalBytes: string) => {
      if (this.active.get(request.taskId) !== owner) return;
      try {
        this.check(context);
        const admitted = object(this.codec('recordingFileUploadProgress', { completedBytes, totalBytes,
          expectedBytes: plan.totalBytes!, previousBytes: previous }));
        previous = completedBytes;
        this.options.onProgress({ taskId: request.taskId, completedBytes: admitted.completedBytes as number,
          totalBytes: admitted.totalBytes as number });
      } catch (error) { progressFailure ??= error; owner.controller.abort(); }
    };
    progress('0', plan.totalBytes as string);
    if (progressFailure) throw progressFailure;
    await this.options.uploadFile(target, file.handle, progress, context);
    if (progressFailure) throw progressFailure;
    this.check(context);
    if (plan.completion !== null) {
      const complete = object(plan.completion);
      const url = exactUrl(complete.url as string);
      const response = await this.options.fetch(url, { method: 'POST', headers: complete.headers as Record<string, string>,
        body: complete.bodyJSON as string, redirect: 'error', credentials: 'omit', signal: context.signal });
      this.check(context);
      if (response.redirected || response.url !== url) throw failure('invalid_upload_response');
      const body = await smallBody(response, context.signal);
      this.check(context);
      const policy = object(this.codec('recordingFileUploadResponse', { status: response.status, responseJson: body }));
      if (policy.verificationPending === true) {
        const error = new UploadVerificationPendingError();
        Object.assign(error, { status: policy.status, data: policy.data, completionPending: true });
        throw error;
      }
      if (policy.success !== true) {
        const error = new Error(`recording upload failed with HTTP ${response.status}`);
        Object.assign(error, { status: response.status });
        throw error;
      }
    }
    this.check(context);
    progress(plan.totalBytes as string, plan.totalBytes as string);
    if (progressFailure) throw progressFailure;
  }

  private proof(file: JsOwnedRecordingFile): JsValue {
    return { localPath: file.localPath, durableUnits: file.durableUnits, kind: file.handle.kind, scope: file.handle.scope };
  }
  private fileKey(handle: OpaqueHostHandle): string {
    if (!handle || handle.scope !== this.namespace || handle.kind !== 'file' || !handle.id) throw failure('foreign_file_handle');
    return JSON.stringify([handle.scope, handle.kind, handle.id]);
  }
  private codec(name: string, value: JsValue): JsValue { return this.options.core.codec(name, value); }
  private check(context: JsHostContext): void {
    if (this.closed || context.signal.aborted) throw failure('operation_cancelled');
    if (this.options.persistence.namespace !== this.namespace) throw failure('identity_mismatch');
    this.options.checkOwner(context);
  }
  private journal<T>(body: () => Promise<T>): Promise<T> {
    const work = this.queueTail.then(body);
    this.queueTail = work.catch(() => {});
    return work;
  }
}
function object(value: JsValue): Record<string, JsValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_core_upload_plan');
  return value as Record<string, JsValue>;
}
function failure(code: string): BotaJsHostError { return new BotaJsHostError(code, 'UploadRecording'); }
function exactUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname || url.href !== value) throw failure('invalid_upload_target');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function smallBody(response: JsV2HttpResponse, signal: AbortSignal): Promise<string> {
  const maximum = 16384;
  const size = response.headers?.get('content-length');
  if (size != null && (!/^(0|[1-9][0-9]*)$/.test(size) || BigInt(size) > BigInt(maximum))) throw failure('invalid_upload_response');
  if (!response.body) {
    const text = await response.text();
    if (signal.aborted) throw failure('operation_cancelled');
    if (Buffer.byteLength(text, 'utf8') > maximum) throw failure('invalid_upload_response');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw failure('operation_cancelled');
      const part = await reader.read();
      if (signal.aborted) throw failure('operation_cancelled');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.length > maximum - length) throw failure('invalid_upload_response');
      chunks.push(part.value); length += part.value.length;
    }
    const bytes = Buffer.concat(chunks, length), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw failure('invalid_upload_response');
    return text;
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock?.(); }
}
