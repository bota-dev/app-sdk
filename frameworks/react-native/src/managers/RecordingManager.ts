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
  UploadInfo,
  UploadTask,
} from '../models/Recording';
import type { RecordingManagerEvents } from '../models/Status';
import type { UploadInfoProvider } from './types';

type IndexedSyncProgress = SyncProgress & {
  recordingIndex?: number;
  totalRecordings?: number;
};

type DeviceUploadMonitorOutcome = 'completed' | 'failed' | 'detached';

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
  private tasks: UploadTask[] = [];
  private initialized = false;
  private paused = false;
  private destroyed = false;

  constructor() {
    super();
    this.client = getCompatibilityClient();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.assertAlive();
    this.tasks = (await this.client.recordings.loadUploadQueue()).map((task) => ({
      ...task,
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
      status: task.status === 'uploading' ? 'pending' : task.status,
    }));
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
    this.emit('syncStarted', recording.uuid);
    const sinkId = createOpaqueId();
    const now = new Date();
    const task: UploadTask = {
      id: createTaskId(),
      recordingId: uploadInfo.recordingId,
      deviceId: device.id,
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
    this.tasks.push(task);
    await this.persistTasks();
    this.emitQueueUpdated();

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
      await this.updateTask(task.id, {
        localPath: transferResult.localPath,
        contentSha256: transferResult.contentSha256,
        relay: transferResult.e2eEncrypted ? uploadInfo.relay : undefined,
      });

      yield this.emitSyncProgress(recording.uuid, {
        stage: 'uploading',
        progress: 0,
        bytesUploaded: 0,
        totalBytes: recording.fileSizeBytes,
        contentSha256: transferResult.contentSha256,
      });
      const upload = observeProgress((onProgress) =>
        this.runUpload(task.id, onProgress)
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
      await this.client.recordings.confirmRecording(device, recording.uuid);
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
      if (this.requireTask(task.id).status !== 'completed') {
        await this.updateTask(task.id, {
          status: 'failed',
          errorMessage: failure.message,
        });
      }
      yield this.emitSyncProgress(recording.uuid, {
        stage: 'failed',
        progress: 0,
        error: failure.message,
      });
      this.emit('syncFailed', recording.uuid, failure);
      throw failure;
    }
  }

  async triggerDeviceUpload(
    device: ConnectedDevice
  ): Promise<{ accepted: boolean; errorCode?: number } | null> {
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
  ): AsyncGenerator<IndexedSyncProgress, DeviceUploadMonitorOutcome> {
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
  ): AsyncGenerator<IndexedSyncProgress> {
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
    return this.tasks.filter(
      (task) => task.status === 'pending' || task.status === 'uploading'
    );
  }

  getAllUploads(): UploadTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  async cancelUpload(taskId: string): Promise<void> {
    await this.client.recordings.cancelRecordingUpload(taskId);
    this.tasks = this.tasks.filter((task) => task.id !== taskId);
    await this.persistTasks();
    this.emitQueueUpdated();
  }

  async retryFailedUploads(): Promise<void> {
    this.assertReady();
    if (this.paused) return;
    for (const task of this.tasks.filter((value) => value.status === 'failed')) {
      await this.updateTask(task.id, {
        status: 'pending',
        retryCount: task.retryCount + 1,
        errorMessage: undefined,
      });
      try {
        await this.runUpload(task.id);
      } catch {
        // Keep failed tasks available for the next explicit retry.
      }
    }
  }

  async clearCompletedUploads(): Promise<void> {
    this.tasks = this.tasks.filter((task) => task.status !== 'completed');
    await this.persistTasks();
    this.emitQueueUpdated();
  }

  async clearAllUploads(): Promise<void> {
    const ids = this.tasks.map((task) => task.id);
    await Promise.all(
      ids.map((taskId) =>
        this.client.recordings.cancelRecordingUpload(taskId).catch(() => undefined)
      )
    );
    this.tasks = [];
    await this.persistTasks();
    this.emitQueueUpdated();
  }

  pauseUploads(): void {
    this.paused = true;
  }

  resumeUploads(): void {
    this.paused = false;
    void this.retryFailedUploads();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.client.recordings.destroyCompatibilityOperations().catch(() => undefined);
    this.removeAllListeners();
    this.initialized = false;
  }

  private async runUpload(
    taskId: string,
    onProgress?: (progress: BotaRecordingTransferProgress) => void
  ): Promise<void> {
    if (this.paused) throw new Error('Upload queue is paused');
    const task = this.requireTask(taskId);
    await this.updateTask(taskId, { status: 'uploading', errorMessage: undefined });
    this.emit('uploadStarted', taskId);
    try {
      await this.client.recordings.uploadRecordingFile(
        this.requireTask(taskId),
        (progress) => {
          onProgress?.(progress);
          const ratio =
            progress.totalBytes > 0
              ? Math.min(progress.completedBytes / progress.totalBytes, 1)
              : 0;
          this.emit('uploadProgress', taskId, ratio);
        }
      );
      await this.updateTask(taskId, { status: 'completed', errorMessage: undefined });
      this.emit('uploadCompleted', taskId, task.recordingId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.updateTask(taskId, {
        status: 'failed',
        errorMessage: failure.message,
      });
      this.emit('uploadFailed', taskId, failure);
      throw failure;
    }
  }

  private emitSyncProgress(
    recordingUuid: string,
    progress: SyncProgress
  ): SyncProgress {
    this.emit('syncProgress', recordingUuid, progress);
    return progress;
  }

  private requireTask(taskId: string): UploadTask {
    const task = this.tasks.find((value) => value.id === taskId);
    if (!task) throw new Error(`Upload task not found: ${taskId}`);
    return task;
  }

  private async updateTask(
    taskId: string,
    patch: Partial<UploadTask>
  ): Promise<void> {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Upload task not found: ${taskId}`);
    this.tasks[index] = {
      ...this.tasks[index],
      ...patch,
      updatedAt: new Date(),
    };
    await this.persistTasks();
    this.emitQueueUpdated();
  }

  private async persistTasks(): Promise<void> {
    await this.client.recordings.saveUploadQueue(this.tasks);
  }

  private emitQueueUpdated(): void {
    this.emit('queueUpdated', this.getAllUploads());
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
