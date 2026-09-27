import EventEmitter from 'eventemitter3';

import type {
  BotaDeviceSDKClient,
  BotaRecordingTransferProgress,
  BotaUploadOwnershipResult,
} from '../client';
import { getCompatibilityClient } from '../compatibility/runtime';
import type { ConnectedDevice, StorageInfo } from '../models/Device';
import type {
  DeviceRecording,
  SyncProgress,
  StreamingSyncOptions,
  StreamingUploadProvider,
  UploadInfo,
  UploadTask,
} from '../models/Recording';
import type { RecordingManagerEvents } from '../models/Status';
import type { RecordingManagerOptions, UploadInfoProvider } from './types';
import { NativeUploadQueue } from './NativeUploadQueue';
import { rejectRecordingDataStore } from './uploadRecoveryMetadata';
import {
  StreamingSession,
  setStreamingSessionTerminalHandler,
} from './StreamingSession';

type DeviceUploadMonitorOutcome = 'completed' | 'failed' | 'detached';

interface TriggerDeviceUploadResponse {
  accepted: boolean;
  errorCode?: number;
}

type ProgressiveOperation<T> = {
  next(): Promise<IteratorResult<BotaRecordingTransferProgress, T>>;
};

const createTaskId = (): string =>
  `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const createOpaqueId = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const nibble = value === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const observeProgress = <T>(
  start: (onProgress: (progress: BotaRecordingTransferProgress) => void) => Promise<T>
): ProgressiveOperation<T> => {
  const queued: BotaRecordingTransferProgress[] = [];
  const waiting: Array<() => void> = [];
  let result: T | undefined;
  let failure: unknown;
  let settled = false;
  const wake = () => waiting.splice(0).forEach((resolve) => resolve());
  void start((progress) => {
    queued.push(progress);
    wake();
  }).then(
    (value) => {
      result = value;
      settled = true;
      wake();
    },
    (error) => {
      failure = error;
      settled = true;
      wake();
    }
  );
  return {
    async next() {
      while (queued.length === 0 && !settled) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      const progress = queued.shift();
      if (progress) return { done: false, value: progress };
      if (failure !== undefined) throw failure;
      return { done: true, value: result as T };
    },
  };
};

export class RecordingManager extends EventEmitter<RecordingManagerEvents> {
  private readonly client: BotaDeviceSDKClient;
  private readonly queue: NativeUploadQueue;
  private initialized = false;
  private destroyed = false;
  private activeStreamingSession: StreamingSession | null = null;

  constructor();
  constructor(options: RecordingManagerOptions);
  constructor(options: RecordingManagerOptions = {}) {
    super();
    rejectRecordingDataStore(options.recordingDataStore);
    this.client = getCompatibilityClient();
    this.queue = new NativeUploadQueue(this.client.recordings, options.uploadRecoveryProvider);
    this.queue.on('queueUpdated', tasks => this.emit('queueUpdated', tasks));
    this.queue.on('uploadStarted', id => this.emit('uploadStarted', id));
    this.queue.on('uploadProgress', (id, progress) => this.emit('uploadProgress', id, progress));
    this.queue.on('uploadCompleted', (id, recordingId) => this.emit('uploadCompleted', id, recordingId));
    this.queue.on('uploadFailed', (id, error) => this.emit('uploadFailed', id, error));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.assertAlive();
    await this.queue.initialize();
    this.assertAlive();
    this.initialized = true;
  }

  async getStorageInfo(device: ConnectedDevice): Promise<StorageInfo> {
    this.assertReady();
    const [status, recordings] = await Promise.all([
      this.client.devices.readStatus(),
      this.client.recordings.listRecordings(device),
    ]);
    return {
      totalKb: status.storageTotalMb * 1024,
      usedKb: status.storageUsedMb * 1024,
      totalRecordings: recordings.length,
      pendingSyncCount: status.pendingRecordings,
    };
  }

  async listRecordings(device: ConnectedDevice): Promise<DeviceRecording[]> {
    this.assertReady();
    return this.client.recordings.listRecordings(device);
  }

  async *syncRecording(
    device: ConnectedDevice,
    recording: DeviceRecording,
    uploadInfo: UploadInfo
  ): AsyncGenerator<SyncProgress> {
    this.assertReady();
    if (uploadInfo.signal?.aborted) {
      uploadInfo.dispose?.();
      throw new Error('Upload authorization context cancelled');
    }
    this.emit('syncStarted', recording.uuid);
    const sinkId = createOpaqueId();
    const now = new Date();
    const task: UploadTask = {
      id: createTaskId(),
      recordingId: uploadInfo.recordingId,
      deviceId: device.id,
      recordingUuid: recording.uuid,
      recoveryScope: uploadInfo.recoveryScope,
      fileSizeBytes: recording.fileSizeBytes,
      localPath: '',
      uploadUrl: uploadInfo.uploadUrl,
      ...(uploadInfo.uploadToken ? { uploadToken: uploadInfo.uploadToken } : {}),
      ...(uploadInfo.completeUrl ? { completeUrl: uploadInfo.completeUrl } : {}),
      ...(uploadInfo.contentType ? { contentType: uploadInfo.contentType } : {}),
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const recovered = uploadInfo.recoveryScope && this.queue.all().find(value =>
      value.recoveryScope === uploadInfo.recoveryScope && value.recordingId === uploadInfo.recordingId &&
      value.deviceId === device.id && value.recordingUuid === recording.uuid && !!value.localPath
    );
    if (recovered) {
      const adopted = this.queue.offerCredentials(recovered.id, uploadInfo);
      try {
        await this.queue.run(recovered.id);
        this.assertReady();
        if (uploadInfo.signal?.aborted) throw new Error('Upload authorization context cancelled');
        await this.client.recordings.confirmRecording(device, recording.uuid);
        this.assertReady();
        yield this.emitSyncProgress(recording.uuid, { stage: 'completed', progress: 1, recordingId: recovered.recordingId, contentSha256: recovered.contentSha256 });
        this.emit('syncCompleted', recording.uuid, recovered.recordingId);
      } finally {
        if (!adopted) uploadInfo.dispose?.();
      }
      return;
    }
    try {
      await this.queue.add(task, uploadInfo);
    } catch (error) {
      uploadInfo.dispose?.();
      throw error;
    }

    let uploadAttempted = false;
    try {
      yield this.emitSyncProgress(recording.uuid, {
        stage: 'preparing',
        progress: 0,
        totalBytes: recording.fileSizeBytes,
      });

      const transfer = observeProgress((onProgress) =>
        this.client.recordings.syncRecording(
          device,
          recording,
          onProgress,
          sinkId
        )
      );
      let transferResult: Awaited<
        ReturnType<BotaDeviceSDKClient['recordings']['syncRecording']>
      >;
      while (true) {
        const value = await transfer.next();
        if (value.done) {
          transferResult = value.value;
          break;
        }
        yield this.emitSyncProgress(recording.uuid, {
          stage: 'transferring',
          progress:
            value.value.totalBytes > 0
              ? Math.min(value.value.completedBytes / value.value.totalBytes, 1)
              : 0,
          bytesTransferred: value.value.completedBytes,
          totalBytes: value.value.totalBytes,
        });
      }
      if (transferResult.e2eEncrypted && !uploadInfo.relay) {
        throw new Error(
          'Device delivered encrypted recording data without an upload relay'
        );
      }
      this.assertReady();
      if (uploadInfo.signal?.aborted || !this.queue.get(task.id)) throw new Error('Upload cancelled');
      const nativeSize = 'fileSizeBytes' in transferResult && typeof transferResult.fileSizeBytes === 'number'
        ? transferResult.fileSizeBytes : undefined;
      if (nativeSize !== undefined && (!Number.isSafeInteger(nativeSize) || nativeSize < 0)) throw new Error('Invalid native recording file size');
      if (nativeSize === undefined && uploadInfo.complete) throw new Error('Host completion requires actual native recording file size');
      // Route selection comes from native transfer metadata, never list flags.
      uploadInfo = { ...uploadInfo, relay: transferResult.e2eEncrypted ? uploadInfo.relay : undefined };
      await this.queue.update(task.id, {
        localPath: transferResult.localPath,
        fileSizeBytes: nativeSize ?? (transferResult.e2eEncrypted ? undefined : recording.fileSizeBytes),
        contentSha256: transferResult.contentSha256,
        relayUpload: transferResult.e2eEncrypted,
      });

      yield this.emitSyncProgress(recording.uuid, {
        stage: 'uploading',
        progress: 0,
        bytesUploaded: 0,
        totalBytes: recording.fileSizeBytes,
        contentSha256: transferResult.contentSha256,
      });
      uploadAttempted = true;
      const upload = observeProgress((onProgress) =>
        this.queue.run(task.id, onProgress)
      );
      while (true) {
        const value = await upload.next();
        if (value.done) break;
        const progress =
          value.value.totalBytes > 0
            ? Math.min(value.value.completedBytes / value.value.totalBytes, 1)
            : 0;
        yield this.emitSyncProgress(recording.uuid, {
          stage: 'uploading',
          progress,
          bytesUploaded: value.value.completedBytes,
          totalBytes: value.value.totalBytes,
        });
      }

      yield this.emitSyncProgress(recording.uuid, {
        stage: 'completing',
        progress: 0.5,
      });
      this.assertReady();
      if (uploadInfo.signal?.aborted || !this.queue.get(task.id)) throw new Error('Upload cancelled');
      await this.client.recordings.confirmRecording(device, recording.uuid);
      this.assertReady();
      const completed = this.emitSyncProgress(recording.uuid, {
        stage: 'completed',
        progress: 1,
        recordingId: uploadInfo.recordingId,
        contentSha256: transferResult.contentSha256,
      });
      yield completed;
      this.emit('syncCompleted', recording.uuid, uploadInfo.recordingId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.destroyed && this.queue.get(task.id)?.status === 'pending' && !this.queue.get(task.id)?.localPath) {
        await this.queue.update(task.id, {
          status: 'failed',
          errorMessage: 'Recording transfer failed',
        });
      }
      if (this.destroyed) throw failure;
      yield this.emitSyncProgress(recording.uuid, {
        stage: 'failed',
        progress: 0,
        error: failure.message,
      });
      this.emit('syncFailed', recording.uuid, failure);
      throw failure;
    } finally {
      if (!uploadAttempted) this.queue.discardCredentials(task.id);
    }
  }

  async triggerDeviceUpload(
    device: ConnectedDevice
  ): Promise<TriggerDeviceUploadResponse | null> {
    this.assertReady();
    const result = await this.client.recordings.observeUploadOwnership(device, {
      recordingUuid: '00000000-0000-0000-0000-000000000000',
      uploadId: 'ownership-probe',
      destinationId: 'ownership-probe',
    });
    return result.kind === 'bluetooth_fallback'
      ? { accepted: false }
      : { accepted: true };
  }

  async *monitorDeviceUpload(
    device: ConnectedDevice,
    initialPendingCount: number
  ): AsyncGenerator<
    SyncProgress & { recordingIndex?: number; totalRecordings?: number },
    DeviceUploadMonitorOutcome
  > {
    this.assertReady();
    yield {
      stage: 'device_uploading',
      progress: 0,
      recordingIndex: 0,
      totalRecordings: initialPendingCount,
    };
    try {
      const result = await this.client.recordings.observeUploadOwnership(device, {
        recordingUuid: '00000000-0000-0000-0000-000000000000',
        uploadId: 'ownership-probe',
        destinationId: 'ownership-probe',
      });
      if (result.kind === 'device_upload_completed') {
        yield {
          stage: 'completed',
          progress: 1,
          recordingIndex: initialPendingCount,
          totalRecordings: initialPendingCount,
        };
        return 'completed';
      }
      return result.kind === 'bluetooth_fallback' ? 'failed' : 'detached';
    } catch {
      return 'detached';
    }
  }

  async *syncAllRecordings(
    device: ConnectedDevice,
    uploadInfoProvider: UploadInfoProvider
  ): AsyncGenerator<
    SyncProgress & { recordingIndex?: number; totalRecordings?: number }
  > {
    this.assertReady();
    const recordings = await this.listRecordings(device);
    if (recordings.length === 0) return;

    const ownership = observeProgress((onProgress) =>
      this.client.recordings.observeUploadOwnership(
        device,
        {
          recordingUuid: recordings[0].uuid,
          uploadId: 'ownership-probe',
          destinationId: 'ownership-probe',
        },
        onProgress
      )
    );
    let result: BotaUploadOwnershipResult;
    try {
      while (true) {
        const value = await ownership.next();
        if (value.done) {
          result = value.value;
          break;
        }
        yield {
          stage: 'device_uploading',
          progress:
            value.value.totalBytes > 0
              ? Math.min(value.value.completedBytes / value.value.totalBytes, 1)
              : 0,
          recordingIndex: value.value.completedBytes,
          totalRecordings: recordings.length,
        };
      }
    } catch {
      yield {
        stage: 'device_uploading',
        progress: 0,
        recordingIndex: 0,
        totalRecordings: recordings.length,
      };
      return;
    }

    if (result.kind === 'device_upload_completed') {
      yield {
        stage: 'completed',
        progress: 1,
        recordingIndex: recordings.length,
        totalRecordings: recordings.length,
      };
      return;
    }
    if (result.kind === 'device_upload_preserved') return;

    for (let index = 0; index < recordings.length; index += 1) {
      const recording = recordings[index];
      try {
        const uploadInfo = await uploadInfoProvider(recording);
        for await (const progress of this.syncRecording(
          device,
          recording,
          uploadInfo
        )) {
          yield {
            ...progress,
            recordingIndex: index,
            totalRecordings: recordings.length,
          };
        }
      } catch (error) {
        yield {
          stage: 'failed',
          progress: 0,
          error: errorMessage(error),
          recordingIndex: index,
          totalRecordings: recordings.length,
        };
      }
    }
  }

  getPendingUploads(): UploadTask[] {
    return this.queue.all().filter(
      (task) => task.status === 'pending' || task.status === 'uploading'
    );
  }

  getAllUploads(): UploadTask[] {
    return this.queue.all();
  }

  startStreamingSync(
    device: ConnectedDevice,
    recordingUuid: string,
    uploadInfoProvider: StreamingUploadProvider,
    options: StreamingSyncOptions = {}
  ): StreamingSession {
    this.assertReady();
    if (this.activeStreamingSession?.isActive) {
      throw new Error('A streaming session is already active');
    }
    const session = new StreamingSession(
      null,
      null,
      device,
      recordingUuid,
      uploadInfoProvider,
      options.chunkSizeKb,
      options.flushIntervalMs
    );
    this.activeStreamingSession = session;
    setStreamingSessionTerminalHandler(session, () => {
      if (this.activeStreamingSession === session) {
        this.activeStreamingSession = null;
      }
    });
    void session.start().catch(() => undefined);
    return session;
  }

  getActiveStreamingSession(): StreamingSession | null {
    return this.activeStreamingSession;
  }

  async cancelUpload(taskId: string): Promise<void> {
    this.assertReady();
    await this.queue.cancel(taskId);
  }

  async retryFailedUploads(): Promise<void> {
    this.assertReady();
    await this.queue.retryFailed();
  }

  async clearCompletedUploads(): Promise<void> {
    this.assertReady();
    await this.queue.clearCompleted();
  }

  async clearAllUploads(): Promise<void> {
    this.assertReady();
    await this.queue.clearAll();
  }

  pauseUploads(): void {
    this.queue.pause();
  }

  resumeUploads(): void {
    this.queue.resume();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue.destroy();
    this.activeStreamingSession?.abort();
    this.activeStreamingSession = null;
    this.removeAllListeners();
    this.initialized = false;
  }

  private emitSyncProgress(
    recordingUuid: string,
    progress: SyncProgress
  ): SyncProgress {
    this.emit('syncProgress', recordingUuid, progress);
    return progress;
  }

  private assertReady(): void {
    this.assertAlive();
    if (!this.initialized) {
      throw new Error('RecordingManager has not been initialized');
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('RecordingManager has been destroyed');
  }
}
