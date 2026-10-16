import EventEmitter from 'eventemitter3';
import type { BotaDeviceSDKRecordingClient, BotaRecordingTransferProgress } from '../client';
import type { UploadInfo, UploadRecoveryProvider, UploadTask } from '../models/Recording';
import type { RecordingManagerEvents } from '../models/Status';
import { persistedUploadQueue, restoreUploadQueue } from './uploadRecoveryMetadata';
import { UploadVerificationPendingError } from './uploadVerificationPending';

const journalOperations = new WeakMap<object, Promise<unknown>>();
const journalOwners = new WeakMap<object, NativeUploadQueue>();
const retryDelays = [30_000, 120_000, 600_000, 3_600_000, 14_400_000];
export type CompatibilityUploadPolicyCodec = (name: string, input: Record<string, unknown>) => Record<string, unknown>;
const codecPolicies = new WeakMap<BotaDeviceSDKRecordingClient, CompatibilityUploadPolicyCodec>();
/** Internal: only generated runtimes bind shared Rust policy; legacy factories retain defaults. */
export function setCompatibilityUploadPolicy(client: BotaDeviceSDKRecordingClient, codec?: CompatibilityUploadPolicyCodec): void {
  if (codec) codecPolicies.set(client, codec); else codecPolicies.delete(client);
}
const cancelled = () => new Error('Upload cancelled');
const dispose = (info: UploadInfo | null | undefined) => {
  try { info?.dispose?.(); } catch { /* Cleanup cannot change an acknowledged result. */ }
};

type Attempt = {
  controller: AbortController;
  nativeId: string;
  promise: Promise<void>;
};

/** Races application callbacks, not native teardown. Late credentials still release their lease. */
const abortable = <T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(cancelled()); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (settled) { late?.(value); return; }
      settled = true;
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });

/** Only metadata crosses this owner. Native hosts retain and upload every byte. */
export class NativeUploadQueue extends EventEmitter<RecordingManagerEvents> {
  private tasks: UploadTask[] = [];
  private readonly active = new Map<string, Attempt>();
  private readonly credentials = new Map<string, UploadInfo>();
  private readonly cancelledTasks = new Set<string>();
  private paused = false;
  private destroyed = false;
  private initialized = false;
  private initialization?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: BotaDeviceSDKRecordingClient,
    private readonly provider?: UploadRecoveryProvider,
    private readonly automaticSyncEnabled = true
  ) { super(); }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.destroyed) return Promise.reject(cancelled());
    const owner = journalOwners.get(this.client);
    if (owner && owner !== this) return Promise.reject(new Error('Upload recovery journal is already owned by another RecordingManager'));
    journalOwners.set(this.client, this);
    this.initialization = this.serialize(async () => {
      this.checkAlive();
      const loaded = await this.client.loadUploadQueue();
      this.checkAlive();
      const restored = restoreUploadQueue(loaded);
      if (restored.length > 0) await this.client.saveUploadQueue(restored);
      this.checkAlive();
      this.tasks = restored;
      this.initialized = true;
    }).then(() => {
      if (this.automaticSyncEnabled) {
        for (const task of this.tasks.filter(value => value.status === 'completed')) {
          void this.release(task).catch(() => undefined);
        }
      }
      this.schedule();
    }).catch(error => {
      if (journalOwners.get(this.client) === this) journalOwners.delete(this.client);
      throw error;
    });
    return this.initialization;
  }

  all(): UploadTask[] { return this.tasks.map(task => ({ ...task, createdAt: new Date(task.createdAt), updatedAt: new Date(task.updatedAt) })); }
  get(id: string): UploadTask | undefined { return this.all().find(task => task.id === id); }

  async add(task: UploadTask, info: UploadInfo): Promise<void> {
    await this.mutate(tasks => [...tasks, ...persistedUploadQueue([task])]);
    this.credentials.set(task.id, info);
  }

  offerCredentials(id: string, info: UploadInfo): boolean {
    if (this.active.has(id) || this.get(id)?.status === 'completed' || this.paused) return false;
    this.discardCredentials(id);
    this.credentials.set(id, info);
    return true;
  }

  async update(id: string, patch: Partial<UploadTask>, check?: () => void): Promise<void> {
    await this.mutate(tasks => {
      check?.();
      if (!tasks.some(task => task.id === id) || this.cancelledTasks.has(id)) throw cancelled();
      return tasks.map(task => task.id === id ? { ...task, ...patch, updatedAt: new Date() } : task);
    });
    const info = this.credentials.get(id);
    if (info && patch.relayUpload === false) this.credentials.set(id, { ...info, relay: undefined });
  }

  run(id: string, onProgress?: (value: BotaRecordingTransferProgress) => void): Promise<void> {
    if (this.active.has(id)) return this.active.get(id)!.promise;
    if (this.get(id)?.status === 'completed') return Promise.resolve();
    if (this.paused || this.destroyed || this.cancelledTasks.has(id)) return Promise.reject(cancelled());
    const attempt: Attempt = {
      controller: new AbortController(),
      nativeId: `${id}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      promise: Promise.resolve(),
    };
    this.active.set(id, attempt);
    attempt.promise = this.perform(id, attempt, onProgress).finally(() => {
      if (this.active.get(id) === attempt) this.active.delete(id);
      this.schedule();
    });
    return attempt.promise;
  }

  private async perform(id: string, attempt: Attempt, onProgress?: (value: BotaRecordingTransferProgress) => void): Promise<void> {
    const signal = attempt.controller.signal;
    const check = () => {
      if (this.destroyed || signal.aborted || this.cancelledTasks.has(id) || !this.get(id) || this.active.get(id) !== attempt) throw cancelled();
    };
    let info: UploadInfo | null | undefined;
    let hostAbort: (() => void) | undefined;
    let initialSignal: AbortSignal | undefined;
    const initialAbort = () => attempt.controller.abort();
    let nativeStarted = false;
    let nativeCancellation: Promise<void> | undefined;
    const cancelNative = () => {
      if (nativeStarted && !nativeCancellation) {
        nativeCancellation = this.client.cancelRecordingUpload(attempt.nativeId);
        void nativeCancellation.catch(() => undefined);
      }
    };
    signal.addEventListener('abort', cancelNative);
    try {
      check();
      const task = this.get(id)!;
      const codec = codecPolicies.get(this.client);
      info = this.credentials.get(id);
      this.credentials.delete(id);
      initialSignal = info?.signal;
      initialSignal?.addEventListener('abort', initialAbort, { once: true });
      if (initialSignal?.aborted) initialAbort();
      check();
      const initialExpiry = info?.expiresAt?.getTime();
      const credentials = codec?.('planCompatibilityUploadCredentials', { hasCredentials: !!info, hasProvider: !!this.provider,
        aborted: info?.signal?.aborted === true, completionPending: task.completionPending === true,
        alreadyUploaded: info?.alreadyUploaded === true, targetPresent: !!(info?.relay ? info.relay.url : info?.uploadUrl),
        expiresAtMs: Number.isFinite(initialExpiry) ? initialExpiry : null, nowMs: Date.now(), hasRecordingUuid: !!task.recordingUuid });
      if (credentials ? credentials.refresh === true : info && this.provider && !info.signal?.aborted && (task.completionPending || (!info.alreadyUploaded && (
        !(info.relay ? info.relay.url : info.uploadUrl) || (info.expiresAt && info.expiresAt.getTime() <= Date.now())
      )))) {
        dispose(info);
        info = undefined;
      }
      if (!info) {
        if (credentials ? credentials.recoveryAllowed !== true : !this.provider || !task.recordingUuid) throw new Error('Upload recovery requires a provider and recordingUuid');
        info = await abortable(Promise.resolve().then(() => {
          check();
          return this.provider!({
            taskId: id, recordingId: task.recordingId, deviceId: task.deviceId,
            recordingUuid: task.recordingUuid!, recoveryScope: task.recoveryScope,
            fileSizeBytes: task.fileSizeBytes, relayUpload: !!task.relayUpload,
            contentType: task.contentType, contentSha256: task.contentSha256, signal,
            completionPending: task.completionPending,
          });
        }), signal, dispose);
      }
      check();
      if (!info) {
        if (!codec) await this.update(id, { status: 'pending', nextAttemptAt: Date.now() + 30_000 }, check);
        throw new Error('Upload waiting for its original account');
      }
      if (!codec && (info.recordingId !== task.recordingId || info.recoveryScope !== task.recoveryScope)) {
        throw new Error('Upload recovery identity changed');
      }
      const expiresAt = info.expiresAt?.getTime();
      const route = codec?.('planCompatibilityUploadQueueRoute', { alreadyUploaded: info.alreadyUploaded === true,
        completionPending: task.completionPending === true, reuploadRequired: info.reuploadRequired === true,
        routeChanged: !!info.relay !== !!task.relayUpload, hasComplete: !!info.complete,
        hasProvider: !!this.provider, relay: !!info.relay, completeUrlAndToken: !!(info.completeUrl && info.uploadToken),
        recordingId: info.recordingId ?? null, expectedRecordingId: task.recordingId, recoveryScope: info.recoveryScope ?? null,
        expectedRecoveryScope: task.recoveryScope ?? null, expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : null, nowMs: Date.now() });
      const uploadRequired = route ? route.uploadRequired === true
        : !info.alreadyUploaded && (!task.completionPending || info.reuploadRequired === true);
      if (!route && uploadRequired && !!info.relay !== !!task.relayUpload) throw new Error('Upload recovery route changed');
      if (!route && task.completionPending && !info.complete) throw new Error('Pending upload requires durable host completion acknowledgement');
      hostAbort = () => attempt.controller.abort();
      info.signal?.addEventListener('abort', hostAbort, { once: true });
      if (info.signal?.aborted) hostAbort();
      check();
      if (!codec && info.expiresAt && info.expiresAt.getTime() <= Date.now() && uploadRequired) throw new Error('Upload credentials expired');
      await this.update(id, { status: 'uploading', errorMessage: undefined, nextAttemptAt: undefined }, check);
      check();
      this.emit('uploadStarted', id);
      check();
      if (uploadRequired) {
        if (task.completionPending) await this.update(id, { completionPending: false }, check);
        check();
        nativeStarted = true;
        await this.client.uploadRecordingFile({
          ...task, id: attempt.nativeId, uploadUrl: info.uploadUrl,
          contentType: info.contentType ?? task.contentType,
          uploadToken: info.complete ? undefined : info.uploadToken,
          completeUrl: info.complete ? undefined : info.completeUrl,
          relay: info.relay,
        }, value => {
          try { check(); } catch { return; }
          onProgress?.(value);
          this.emit('uploadProgress', id, value.totalBytes > 0 ? Math.min(value.completedBytes / value.totalBytes, 1) : 0);
        });
        check();
      }
      if (info.complete) {
        if (task.fileSizeBytes === undefined) throw new Error('Upload completion requires known file size');
        await this.update(id, { completionPending: true }, check);
        check();
        await abortable(Promise.resolve().then(() => {
          check();
          return info!.complete!({ fileSizeBytes: task.fileSizeBytes!, contentSha256: task.contentSha256, signal });
        }), signal);
      } else if (route ? route.missingCompletionAcknowledgement === true
        : info.alreadyUploaded || (this.provider && !info.relay && !(info.completeUrl && info.uploadToken))) {
        throw new Error('Recoverable upload requires durable host completion acknowledgement');
      }
      check();
      await this.update(id, { status: 'completed', completionPending: undefined, errorMessage: undefined, nextAttemptAt: undefined }, check);
      check();
      await this.release(this.get(id)!).catch(() => undefined);
      check();
      this.emit('uploadCompleted', id, task.recordingId);
    } catch (error) {
      if (!this.destroyed && !this.cancelledTasks.has(id) && this.get(id)?.status !== 'completed') {
        const task = this.get(id)!;
        const verificationPending = error instanceof UploadVerificationPendingError;
        const codec = codecPolicies.get(this.client);
        const decision = codec ? codec('planCompatibilityUploadQueueFailure', { nowMs: Date.now(),
          createdAtMs: task.createdAt.getTime(), retryCount: task.retryCount, hasProvider: !!this.provider,
          credentialUnavailable: info === null, aborted: signal.aborted, verificationPending,
          completionPending: task.completionPending ?? null }) : (() => {
            const parked = info === null || signal.aborted || verificationPending;
            const retry = !!this.provider && task.retryCount < 6 && Date.now() - task.createdAt.getTime() < 86_400_000;
            return { parked, status: parked || retry ? 'pending' : 'failed', retryCount: task.retryCount + (parked ? 0 : 1),
              nextAttemptAt: parked ? Date.now() + 30_000 : retry ? Date.now() + retryDelays[Math.min(task.retryCount, 4)] : undefined,
              errorMessage: verificationPending ? 'Upload verification pending' : parked ? 'Upload waiting for its original account' : 'Upload attempt failed',
              completionPending: verificationPending ? true : task.completionPending };
          })();
        const parked = decision.parked === true;
        await this.update(id, {
          status: decision.status as UploadTask['status'],
          retryCount: decision.retryCount as number,
          nextAttemptAt: decision.nextAttemptAt == null ? undefined : decision.nextAttemptAt as number,
          errorMessage: decision.errorMessage as string,
          completionPending: decision.completionPending == null ? undefined : decision.completionPending as boolean,
        }).catch(() => { this.pause(); });
        if (!this.destroyed) this.emit('uploadFailed', id, new Error(verificationPending ? 'Upload verification pending' : parked ? 'Upload paused' : 'Upload attempt failed'));
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancelNative);
      initialSignal?.removeEventListener('abort', initialAbort);
      if (hostAbort) info?.signal?.removeEventListener('abort', hostAbort);
      // Credential-only legacy callers can explicitly retry during this process.
      if (!this.provider && info && !info.dispose && !info.signal && !this.destroyed && !this.cancelledTasks.has(id) && this.get(id)?.status !== 'completed') this.credentials.set(id, info);
      dispose(info);
      await nativeCancellation?.catch(() => { this.pause(); });
    }
  }

  private async release(task: UploadTask): Promise<void> {
    this.checkAlive();
    await this.client.releaseRecordingFile(task.id, task.localPath);
  }

  async cancel(id: string): Promise<void> {
    this.cancelledTasks.add(id);
    const active = this.active.get(id);
    active?.controller.abort();
    this.discardCredentials(id);
    if (!active) await this.client.cancelRecordingUpload(id);
    await this.mutate(tasks => tasks.filter(task => task.id !== id));
  }

  discardCredentials(id: string): void {
    const credential = this.credentials.get(id);
    this.credentials.delete(id);
    dispose(credential);
  }

  async clearCompleted(): Promise<void> {
    const snapshot = this.all().filter(value => value.status === 'completed');
    for (const task of snapshot) await this.release(task);
    await this.mutate(tasks => tasks.filter(task => !snapshot.some(released =>
      task.status === 'completed' && task.id === released.id && task.localPath === released.localPath &&
      task.recordingId === released.recordingId && task.deviceId === released.deviceId &&
      task.recordingUuid === released.recordingUuid && task.recoveryScope === released.recoveryScope
    )));
  }

  async clearAll(): Promise<void> { for (const task of this.all()) await this.cancel(task.id); }

  async retryFailed(): Promise<void> {
    const retry = this.all().filter(task => (task.status === 'failed' || (task.status === 'pending' && task.nextAttemptAt)) && !this.active.has(task.id) && !!task.localPath);
    for (const task of retry) await this.update(task.id, { status: 'pending', retryCount: 0, nextAttemptAt: undefined, createdAt: new Date() });
    if (!this.paused) for (const task of retry) await this.run(task.id).catch(() => undefined);
  }

  pause(): void { this.paused = true; if (this.timer) clearTimeout(this.timer); }
  resume(): void { this.checkAlive(); this.paused = false; this.schedule(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (journalOwners.get(this.client) === this) {
      // New owners must read only after old persistence and native stop have settled.
      const stopped = this.client.destroyCompatibilityOperations();
      void stopped.catch(() => undefined);
      void this.serialize(() => stopped).catch(() => undefined);
      journalOwners.delete(this.client);
    }
    this.pause();
    for (const attempt of this.active.values()) attempt.controller.abort();
    for (const info of this.credentials.values()) dispose(info);
    this.credentials.clear();
    this.removeAllListeners();
  }

  private schedule(): void {
    if (!this.initialized || this.destroyed || this.paused || !this.automaticSyncEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    let wake = Infinity;
    for (const task of this.tasks) {
      const codec = codecPolicies.get(this.client);
      if (codec) {
        const decision = codec('planCompatibilityUploadQueueSchedule', { status: task.status, localPath: task.localPath,
          active: this.active.has(task.id), cancelled: this.cancelledTasks.has(task.id), hasCredentials: this.credentials.has(task.id),
          hasProvider: !!this.provider, activeCount: this.active.size, nextAttemptAt: task.nextAttemptAt ?? null, nowMs: Date.now() });
        if (decision.action === 'wait') wake = Math.min(wake, decision.wakeAt as number);
        else if (decision.action === 'run') void this.run(task.id).catch(() => undefined);
        continue;
      }
      if (task.status !== 'pending' || !task.localPath || this.active.has(task.id) || this.cancelledTasks.has(task.id) || (!this.provider && !this.credentials.has(task.id))) continue;
      if ((task.nextAttemptAt ?? 0) > Date.now()) { wake = Math.min(wake, task.nextAttemptAt!); continue; }
      if (this.active.size >= 2) continue;
      void this.run(task.id).catch(() => undefined);
    }
    if (Number.isFinite(wake)) this.timer = setTimeout(() => this.schedule(), Math.max(1, wake - Date.now()));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = (journalOperations.get(this.client) ?? Promise.resolve()).catch(() => undefined).then(operation);
    journalOperations.set(this.client, next.catch(() => undefined));
    return next;
  }

  private mutate(change: (tasks: UploadTask[]) => UploadTask[]): Promise<void> {
    return this.serialize(async () => {
      this.checkAlive();
      const next = change(this.tasks);
      await this.client.saveUploadQueue(persistedUploadQueue(next));
      this.checkAlive();
      this.tasks = next;
      this.emit('queueUpdated', this.all());
    });
  }

  private checkAlive(): void { if (this.destroyed) throw cancelled(); }
}
