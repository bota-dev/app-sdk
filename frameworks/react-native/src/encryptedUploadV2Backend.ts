import type { BotaDeviceSDKRecordingClient, BotaEncryptedUploadV2Recording,
  BotaEncryptedUploadV2ProfileDecision, BotaEncryptedUploadV2Progress } from './client';
import type { ConnectedDevice } from './models/Device';
import type { Spec } from './specs/NativeBotaUploadV2Backend';

export interface EncryptedUploadV2BackendOptions {
  /** Customer-authenticated HTTPS proxy exposing the v2 routes, e.g. https://api.example.com/v1. */
  baseUrl: string;
  /** Stable, non-secret account/project/environment identity. */
  scopeKey: string;
  accountId: string;
  projectId: string;
  endUserId: string;
  environment: string;
  /** Only needed by an organization-scoped backend bridge. */
  organizationId?: string;
  /** Abort permanently on logout or any account/project/binding change. */
  signal: AbortSignal;
  /** Return an application access token, never a Bota secret API key. */
  getAccessToken(signal: AbortSignal): Promise<string>;
}

export interface EncryptedUploadV2SyncTarget {
  deviceId: string;
  bindingGeneration: number;
  signal?: AbortSignal;
  onProgress?: (progress: BotaEncryptedUploadV2Progress) => void;
  /** Optional import of an existing integration's exact cloud identity. */
  priorUpload?: { recordingId: string; sessionId?: string; ownerRevision?: number };
}

export interface EncryptedUploadV2Backend {
  /** Reinvoking after restart/reconnect resumes the native journal for this exact recording. */
  sync(device: ConnectedDevice, recording: BotaEncryptedUploadV2Recording,
    target: EncryptedUploadV2SyncTarget): Promise<{ recordingId: string }>;
  dispose(): Promise<void>;
}

/** @internal Dependency injection keeps the public facade and host tests on the same implementation. */
export function createManagedEncryptedUploadV2Backend(
  native: Spec | null, recordings: BotaDeviceSDKRecordingClient,
  options: EncryptedUploadV2BackendOptions,
): EncryptedUploadV2Backend {
  // Capture identity once; mutating the caller's object cannot repoint an active request.
  const config = { ...options };
  const url = new URL(config.baseUrl);
  const path = url.pathname.replace(/\/$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !/^(\/[A-Za-z0-9_-]+)+$/.test(path) || !config.scopeKey || !config.signal) {
    throw new Error('Invalid encrypted upload backend configuration');
  }
  const apiOrigin = url.origin;
  const attempts = new Set<{ cancel(): Promise<void>; settled: Promise<void> }>();
  let disposed = false;
  const backend: EncryptedUploadV2Backend = {
    async sync(device, recording, target) {
      device = { ...device };
      recording = { ...recording };
      target = { ...target, priorUpload: target.priorUpload && { ...target.priorUpload } };
      if (!native) throw new Error('Encrypted upload backend requires the matching native SDK binary');
      if (disposed || config.signal.aborted || target.signal?.aborted) throw new Error('Encrypted upload cancelled');
      const signal = new AbortController();
      let operationId: string | undefined;
      let selected: (BotaEncryptedUploadV2ProfileDecision & { recordingId: string }) | undefined;
      let cancelTask: Promise<void> | undefined;
      let completed = false;
      const check = () => {
        if (disposed || signal.signal.aborted || config.signal.aborted || target.signal?.aborted) {
          throw new Error('Encrypted upload cancelled');
        }
      };
      const cancel = () => {
        signal.abort();
        if (operationId) cancelTask ??= Promise.resolve().then(() => native.cancel(operationId!));
        return cancelTask ?? Promise.resolve();
      };
      // Event callbacks must not create unhandled rejections; disposal awaits the same task.
      const abort = () => { void cancel().catch(() => {}); };
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      const attempt = { cancel, settled };
      attempts.add(attempt);
      let subscription: { remove(): void } | undefined;
      try {
        config.signal.addEventListener('abort', abort, { once: true });
        target.signal?.addEventListener('abort', abort, { once: true });
        subscription = native.onCredentialsRequested(event => {
          if (!operationId || event.operationId !== operationId) return;
          void (async () => {
            try {
              check();
              const token = await config.getAccessToken(signal.signal);
              check();
              await native.resolveCredentials(event.requestId, token);
            } catch { await native.rejectCredentials(event.requestId).catch(() => {}); }
          })();
        });
        check();
        await recordings.syncEncryptedRecordingV2(device, recording, async context => {
          check();
          if (!context.operationId || (operationId && operationId !== context.operationId)) {
            throw new Error('Encrypted upload operation changed');
          }
          operationId = context.operationId;
          const value: unknown = JSON.parse(await native.prepare(JSON.stringify({
            operationId,
            scope: { apiOrigin, apiBasePath: path, scopeKey: config.scopeKey,
              accountId: config.accountId, projectId: config.projectId, endUserId: config.endUserId,
              organizationId: config.organizationId ?? '', environment: config.environment,
              deviceId: target.deviceId, bindingGeneration: target.bindingGeneration,
              serialNumber: device.serialNumber, nativeDeviceId: device.id },
            recording: { uuid: context.recording.uuid, generation: context.recording.generation,
              ciphertextLength: context.recording.ciphertextLength, ciphertextSha256: context.recording.ciphertextSha256,
              startedAtMs: context.recording.startedAtMs, durationMs: context.recording.durationMs,
              plaintextLength: context.recording.plaintextLength, storageFormat: context.recording.storageFormat,
              ...(context.recording.markersRequired ? { markersRequired: true } : {}) },
            capability: { rawValueHex: context.capability.rawValueHex, flags: context.capability.flags },
            ...(context.checkpoint === undefined ? {} : { checkpoint: {
              version: context.checkpoint.version, uploadSessionId: context.checkpoint.uploadSessionId,
              ownerRevision: context.checkpoint.ownerRevision, revision: context.checkpoint.revision,
              nextCiphertextOffset: context.checkpoint.nextCiphertextOffset, prefixSha256: context.checkpoint.prefixSha256,
              highestContiguousSequence: context.checkpoint.highestContiguousSequence,
              transportSessionId: context.checkpoint.transportSessionId, sinkRegistrationId: context.checkpoint.sinkRegistrationId,
              windowPackets: context.checkpoint.windowPackets, dataPayloadBytes: context.checkpoint.dataPayloadBytes,
            } }),
            ...(target.priorUpload === undefined ? {} : { priorJournalEntry: {
              recordingId: target.priorUpload.recordingId, sessionId: target.priorUpload.sessionId,
              ownerRevision: target.priorUpload.ownerRevision } }),
          })));
          check();
          const result = value as NonNullable<typeof selected>;
          if (!result || result.profile !== 'encrypted_upload_v2' ||
            !/^rec_[A-Za-z0-9_-]+$/.test(result.recordingId) ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.uploadSessionId) ||
            !Number.isSafeInteger(result.ownerRevision) || result.ownerRevision < 1 ||
            !result.materialRegistrationId || !['legacy_allowed', 'v2_preferred', 'v2_required'].includes(result.securityPolicy)) {
            throw new Error('Invalid encrypted upload backend response');
          }
          selected = result;
          return { profile: result.profile, uploadSessionId: result.uploadSessionId,
            ownerRevision: result.ownerRevision, securityPolicy: result.securityPolicy,
            materialRegistrationId: result.materialRegistrationId };
        }, progress => { if (!signal.signal.aborted) target.onProgress?.(progress); }, { signal: signal.signal });
        check();
        if (!operationId || !selected) throw new Error('Encrypted upload confirmation is missing');
        // The native sync only resolves after signed receipt/CONFIRM. Never infer this from HTTP 2xx.
        await native.complete(operationId);
        completed = true;
        return { recordingId: selected.recordingId };
      } finally {
        // Native complete already releases the operation. A later bridge cancellation
        // failure must not turn confirmed device cleanup into a retryable sync failure.
        try { if (completed) signal.abort(); else await cancel(); }
        finally {
          attempts.delete(attempt);
          config.signal.removeEventListener('abort', abort);
          target.signal?.removeEventListener('abort', abort);
          subscription?.remove();
          settle();
        }
      }
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...attempts].map(async attempt => {
        try { await attempt.cancel(); } finally { await attempt.settled; }
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('Encrypted upload cancellation failed');
    },
  };
  return backend;
}
