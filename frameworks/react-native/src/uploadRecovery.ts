import type { UploadInfo, UploadRecoveryContext, UploadRecoveryProvider } from './models/Recording';

/** A host-owned, authenticated lease. It must permanently reject changed identities. */
export interface UploadRecoveryBackend {
  scopeKey: string;
  signal: AbortSignal;
  checkScope(): void;
  dispose(): void;
  getRecording(id: string, signal: AbortSignal): Promise<{
    id: string; status: string; metadata?: Record<string, unknown>;
    content_sha256?: string | null; file_size_bytes?: number | null;
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
      if (recording.id !== task.recordingId || (!task.relayUpload && (
        (task.contentSha256 && recording.content_sha256 && task.contentSha256 !== recording.content_sha256) ||
        (task.fileSizeBytes !== undefined && recording.file_size_bytes != null && task.fileSizeBytes !== recording.file_size_bytes)
      ))) throw new Error('Upload recovery identity or evidence changed');
      if (!['pending', 'uploaded', 'integrity_failure'].includes(recording.status)) throw new Error('Recording unavailable for recovery');
      const start = Date.parse(String(recording.metadata?.started_at ?? ''));
      const end = Date.parse(String(recording.metadata?.ended_at ?? ''));
      const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.floor((end - start) / 1000) : undefined;
      const target = recording.status === 'uploaded' ? { uploadUrl: '' }
        : await api.getUploadInfo(task.recordingId, task.relayUpload, task.contentType, task.signal);
      check();
      return {
        ...target, recordingId: task.recordingId, recoveryScope: task.recoveryScope,
        alreadyUploaded: recording.status === 'uploaded', signal: api.signal, dispose: () => api.dispose(),
        complete: async ({ fileSizeBytes, contentSha256, signal }) => {
          check(signal);
          await api.completeRecording(task.recordingId, {
            duration_seconds: duration, file_size_bytes: fileSizeBytes, content_sha256: contentSha256,
          }, signal);
          check(signal);
        },
      };
    } catch {
      backend?.dispose();
      throw new Error('Upload recovery request failed');
    }
  };
}
