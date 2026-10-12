import type { ConnectedDevice } from './models/Device';
import { requireUploadBackend } from './runtimeAdapter';
import type { BotaUploadBackendAdapter } from './runtimeAdapter';

export interface ByoStorageBackendOptions {
  /** Customer-authenticated HTTPS proxy for Bota device BYO/context routes. */
  baseUrl: string;
  scopeKey: string;
  organizationId: string;
  projectId: string;
  environment: 'development' | 'gamma' | 'production';
  /** Abort on logout, project change or device reassignment. */
  signal: AbortSignal;
  getAccessToken(signal: AbortSignal): Promise<string>;
}
export interface ByoRecording { uuid: string; generation: number }
export interface ByoSyncTarget { deviceId: string; bindingGeneration: number; signal?: AbortSignal }
export interface ByoUploadResult { recordingId: string; uploadSessionId: string }
export interface ByoStorageBackend {
  /** Native owns BLE, HTTP, opaque documents, durable recovery and receipt cleanup. */
  sync(device: ConnectedDevice, recording: ByoRecording, target: ByoSyncTarget): Promise<ByoUploadResult>;
  stream(device: ConnectedDevice, recording: ByoRecording | null, target: ByoSyncTarget): Promise<ByoUploadResult>;
  list(device: ConnectedDevice, target: ByoSyncTarget): Promise<ByoRecording[]>;
  dispose(): Promise<void>;
}
/** @internal Shared implementation for the production factory and host tests. */
export function createManagedByoStorageBackend(native: BotaUploadBackendAdapter | null, options: ByoStorageBackendOptions): ByoStorageBackend {
  const config = { ...options };
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !config.scopeKey || !config.organizationId || !config.projectId || !config.signal ||
    !['development', 'gamma', 'production'].includes(config.environment)) throw new Error('Invalid BYO configuration');
  let disposed = false;
  const attempts = new Set<{ cancel(): Promise<void>; settled: Promise<void> }>();
  const perform = async (device: ConnectedDevice, recording: ByoRecording | null, target: ByoSyncTarget, live = false): Promise<ByoUploadResult | ByoRecording[]> => {
      requireUploadBackend(native, 'byoStorageBackend', ['syncByo', 'cancelByo',
        'onCredentialsRequested', 'resolveCredentials', 'rejectCredentials']);
      device = { ...device }; recording = recording && { ...recording }; target = { ...target };
      if ((recording !== null && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(recording.uuid) ||
        !Number.isSafeInteger(recording.generation) || recording.generation < 0 || recording.generation > 0xffffffff)) ||
        !Number.isSafeInteger(target.bindingGeneration) || target.bindingGeneration < 1 || target.bindingGeneration > 0xffffffff) {
        throw new Error('Invalid BYO recording identity');
      }
      const operationId = 'byo-' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, key => {
        const value = Math.floor(Math.random() * 16); return (key === 'x' ? value : (value & 3) | 8).toString(16);
      });
      const controller = new AbortController();
      let cancelTask: Promise<void> | undefined;
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      const check = () => {
        if (disposed || controller.signal.aborted || config.signal.aborted || target.signal?.aborted) throw new Error('BYO upload cancelled');
      };
      const cancel = () => {
        controller.abort();
        return cancelTask ??= Promise.resolve().then(() => native.cancelByo(operationId));
      };
      const abort = () => { void cancel().catch(() => {}); };
      const attempt = { cancel, settled }; attempts.add(attempt);
      let subscription: { remove(): void } | undefined;
      let completed = false;
      try {
        config.signal.addEventListener('abort', abort, { once: true }); target.signal?.addEventListener('abort', abort, { once: true });
        check();
        subscription = native.onCredentialsRequested(event => {
          if (event.operationId !== operationId) return;
          void (async () => {
            try { check(); const token = await config.getAccessToken(controller.signal); check(); await native.resolveCredentials(event.requestId, token); }
            catch { await native.rejectCredentials(event.requestId).catch(() => {}); }
          })();
        });
        const value: unknown = JSON.parse(await native.syncByo(JSON.stringify({operationId, mode: live ? 'stream' : recording === null ? 'list' : 'sync', device, recording,
          scope: { baseUrl: url.href, scopeKey: config.scopeKey, organizationId: config.organizationId,
            projectId: config.projectId, environment: config.environment, deviceId: target.deviceId, bindingGeneration: target.bindingGeneration } })));
        check();
        if (recording === null && !live) {
          if (!Array.isArray(value) || value.length > 4096 || value.some(item => !item ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.uuid) ||
            !Number.isSafeInteger(item.generation) || item.generation < 0 || item.generation > 0xffffffff)) throw new Error('Invalid BYO native catalog');
          completed = true; return value.map(item => ({ uuid: item.uuid as string, generation: item.generation as number }));
        }
        const result = value as ByoUploadResult;
        if (!result || !/^rec_[A-Za-z0-9_-]+$/.test(result.recordingId) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.uploadSessionId)) throw new Error('Invalid BYO native result');
        completed = true; return { recordingId: result.recordingId, uploadSessionId: result.uploadSessionId };
      } finally {
        try { if (!completed) await cancel(); }
        finally {
          attempts.delete(attempt); config.signal.removeEventListener('abort', abort); target.signal?.removeEventListener('abort', abort);
          subscription?.remove(); settle();
        }
      }
  };
  return {
    async sync(device, recording, target) { return await perform(device, recording, target) as ByoUploadResult; },
    async stream(device, recording, target) { return await perform(device, recording, target, true) as ByoUploadResult; },
    async list(device, target) { return await perform(device, null, target) as ByoRecording[]; },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...attempts].map(async attempt => {
        try { await attempt.cancel(); } finally { await attempt.settled; }
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('BYO cancellation failed');
    },
  };
}
