import type { UploadTask } from '../models/Recording';

const invalid = (): never => { throw new Error('Invalid upload recovery journal'); };

/** Whitelist, never spread a runtime object into persistent storage. */
export function persistedUploadQueue(tasks: UploadTask[]): UploadTask[] {
  return tasks.map((task) => ({
    id: task.id,
    recordingId: task.recordingId,
    deviceId: task.deviceId,
    localPath: task.localPath,
    uploadUrl: '',
    status: task.status,
    retryCount: task.retryCount,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    ...(task.recordingUuid === undefined ? {} : { recordingUuid: task.recordingUuid }),
    ...(task.recoveryScope === undefined ? {} : { recoveryScope: task.recoveryScope }),
    ...(task.fileSizeBytes === undefined ? {} : { fileSizeBytes: task.fileSizeBytes }),
    ...(task.nextAttemptAt === undefined ? {} : { nextAttemptAt: task.nextAttemptAt }),
    ...(task.contentType === undefined ? {} : { contentType: task.contentType }),
    ...(task.contentSha256 === undefined ? {} : { contentSha256: task.contentSha256 }),
    relayUpload: task.relayUpload ?? !!task.relay,
  }));
}

export function restoreUploadQueue(value: unknown): UploadTask[] {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  const validated = value.map((entry): UploadTask => {
    if (!entry || typeof entry !== 'object') return invalid();
    const task = entry as UploadTask;
    for (const field of ['id', 'recordingId', 'deviceId'] as const) {
      if (typeof task[field] !== 'string' || !task[field]) return invalid();
    }
    if (typeof task.localPath !== 'string' || ids.has(task.id)) return invalid();
    ids.add(task.id);
    if (!['pending', 'uploading', 'failed', 'completed'].includes(task.status)) return invalid();
    if (!Number.isSafeInteger(task.retryCount) || task.retryCount < 0) return invalid();
    for (const field of ['recordingUuid', 'recoveryScope', 'contentType', 'contentSha256'] as const) {
      if (task[field] !== undefined && typeof task[field] !== 'string') return invalid();
    }
    for (const field of ['fileSizeBytes', 'nextAttemptAt'] as const) {
      if (task[field] !== undefined && (!Number.isSafeInteger(task[field]) || task[field]! < 0)) return invalid();
    }
    if (task.relayUpload !== undefined && typeof task.relayUpload !== 'boolean') return invalid();
    const createdAt = new Date(task.createdAt);
    const updatedAt = new Date(task.updatedAt);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(updatedAt.getTime())) return invalid();
    return { ...task, createdAt, updatedAt, status: task.status === 'uploading' ? 'pending' : task.status };
  });
  return persistedUploadQueue(validated);
}

export function rejectRecordingDataStore(value: unknown): void {
  if (value !== undefined) {
    throw new Error('RecordingDataStore byte callbacks are unsupported; recording files are native-owned');
  }
}
