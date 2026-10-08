import type { UploadInfo, UploadRecoveryContext, UploadRecoveryProvider } from './models/Recording';
import { isUploadVerificationPending, UploadVerificationPendingError } from './managers/uploadVerificationPending';

const waitForCompletion = (milliseconds: number, signals: AbortSignal[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const unique = [...new Set(signals)];
    const clean = () => { clearTimeout(timer); unique.forEach(signal => signal.removeEventListener('abort', abort)); };
    const abort = () => { clean(); reject(new Error('Upload recovery cancelled')); };
    const timer = setTimeout(() => { clean(); resolve(); }, milliseconds);
    unique.forEach(signal => signal.addEventListener('abort', abort, { once: true }));
    if (unique.some(signal => signal.aborted)) abort();
  });

/** A host-owned, authenticated lease. It must permanently reject changed identities. */
export interface UploadRecoveryBackend {
  scopeKey: string;
  signal: AbortSignal;
  checkScope(): void;
  dispose(): void;
  getRecording(id: string, signal: AbortSignal): Promise<{
    id: string; status: string; metadata?: Record<string, unknown>;
    content_sha256?: string | null; file_size_bytes?: number | string | null;
  }>;
  getUploadInfo(id: string, relay: boolean, contentType: string | undefined, signal: AbortSignal): Promise<Pick<UploadInfo, 'uploadUrl' | 'relay' | 'contentType'>>;
  completeRecording(id: string, data: { duration_seconds?: number; file_size_bytes: number; content_sha256?: string }, signal: AbortSignal): Promise<unknown>;
}

/** Build scoped metadata recovery while native SDK storage retains recording bytes.
 * A null host lease parks work until its original account is available.
 * Even an already-uploaded recording requires the exact backend completion ACK.
 */
export function createUploadRecoveryProvider(
  openBackend: (task: UploadRecoveryContext) => Promise<UploadRecoveryBackend | null>,
): UploadRecoveryProvider {
  return async (task) => {
    if (!task.recoveryScope || task.signal.aborted) return null;
    let backend: UploadRecoveryBackend | null = null;
    try {
      backend = await openBackend(task);
      if (!backend) return null;
      const api = backend;
      const check = (signal = task.signal) => {
        api.checkScope();
        if (api.signal.aborted || task.signal.aborted || signal.aborted) throw new Error('Upload recovery cancelled');
      };
      if (api.scopeKey !== task.recoveryScope) { api.dispose(); return null; }
      check();
      const recording = await api.getRecording(task.recordingId, task.signal);
      check();
      const wireSize = recording.file_size_bytes;
      if (typeof wireSize === 'string' && !/^(0|[1-9][0-9]*)$/.test(wireSize)) throw new Error('Invalid upload recovery file size');
      const fileSize = typeof wireSize === 'string' ? Number(wireSize) : wireSize;
      if (fileSize != null && (typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize) || fileSize < 0)) {
        throw new Error('Invalid upload recovery file size');
      }
      if (recording.id !== task.recordingId || (!task.relayUpload && (
        (task.contentSha256 && recording.content_sha256 && task.contentSha256 !== recording.content_sha256) ||
        (task.fileSizeBytes !== undefined && fileSize != null && task.fileSizeBytes !== fileSize)
      ))) throw new Error('Upload recovery identity or evidence changed');
      if (!['pending', 'uploaded', 'integrity_failure'].includes(recording.status)) throw new Error('Recording unavailable for recovery');
      const start = Date.parse(String(recording.metadata?.started_at ?? ''));
      const end = Date.parse(String(recording.metadata?.ended_at ?? ''));
      const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.floor((end - start) / 1000) : undefined;
      const alreadyUploaded = recording.status === 'uploaded' || (task.completionPending === true && recording.status === 'pending');
      const target = alreadyUploaded ? { uploadUrl: '' }
        : await api.getUploadInfo(task.recordingId, task.relayUpload, task.contentType, task.signal);
      check();
      return {
        ...target, recordingId: task.recordingId, recoveryScope: task.recoveryScope,
        alreadyUploaded, reuploadRequired: recording.status === 'integrity_failure',
        signal: api.signal, dispose: () => api.dispose(),
        complete: async ({ fileSizeBytes, contentSha256, signal }) => {
          const data = {
            duration_seconds: duration, file_size_bytes: fileSizeBytes, content_sha256: contentSha256,
          };
          const deadline = Date.now() + 120_000;
          for (let poll = 0; ; poll++) {
            check(signal);
            if (poll > 0 && (Date.now() >= deadline || poll >= 120)) throw new UploadVerificationPendingError();
            try {
              await api.completeRecording(task.recordingId, data, signal);
              check(signal);
              return;
            } catch (error) {
              check(signal);
              if (!isUploadVerificationPending(error)) throw error;
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw new UploadVerificationPendingError();
              await waitForCompletion(Math.min(1_000 + Math.floor(Math.random() * 1_000), remaining),
                [signal, task.signal, api.signal]);
            }
          }
        },
      };
    } catch {
      backend?.dispose();
      throw new Error('Upload recovery request failed');
    }
  };
}
