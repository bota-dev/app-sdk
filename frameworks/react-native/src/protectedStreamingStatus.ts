import type { Spec } from './specs/NativeBotaUploadV2Backend';

/** Read-only protected STREAMING metadata. None of these values authorize cleanup. */
export interface ProtectedStreamingIdentity {
  recordingId: string;
  sessionId: string;
  recordingGeneration: number;
  /** Canonical positive int64 decimal; never convert through a JS number. */
  writerEpoch: string;
}

export interface ProtectedStreamingStatus extends ProtectedStreamingIdentity {
  profile: 'recording_markers_stream_v1';
  /** Canonical nonnegative int64 decimal; a newly admitted stream starts at zero. */
  revision: string;
  receivedCount: number;
  contiguousSequence: number;
  /** Marker metadata state, independent from audio completion or publication. */
  state: 'open' | 'sealing' | 'sealed' | 'aborted';
  expectedCount: number | null;
  authorizationExpired: boolean;
}

export interface ProtectedStreamingStatusBackendOptions {
  /** Scoped read proxy, e.g. https://api.example/dashboard/projects/proj_123. */
  baseUrl: string;
  organizationId?: string;
  /** Permanently abort on logout, account/project/environment or binding change. */
  signal: AbortSignal;
  /** Fresh application read credential. Never embed a secret API key in an App. */
  getAccessToken(signal: AbortSignal): Promise<string>;
}

export interface ProtectedStreamingStatusBackend {
  /** Requires an exact known session/owner; does not select a newer owner implicitly. */
  getStatus(identity: ProtectedStreamingIdentity, signal?: AbortSignal): Promise<ProtectedStreamingStatus>;
  dispose(): void;
}

const decimal = (value: unknown): value is string => typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const count = (value: unknown): value is number => typeof value === 'number' &&
  Number.isInteger(value) && value >= 0 && value <= 65535;
const generation = (value: unknown): value is number => typeof value === 'number' &&
  Number.isInteger(value) && value >= 1 && value <= 4294967295;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const keys = ['profile', 'recording_id', 'session_id', 'recording_generation', 'writer_epoch', 'revision',
  'received_count', 'contiguous_sequence', 'state', 'expected_count', 'authorization_expired'];

function decode(value: unknown, identity: ProtectedStreamingIdentity): ProtectedStreamingStatus {
  const invalid = () => new Error('Invalid protected streaming status response');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(v, key)) ||
    v.profile !== 'recording_markers_stream_v1' || v.recording_id !== identity.recordingId ||
    v.session_id !== identity.sessionId || v.recording_generation !== identity.recordingGeneration ||
    v.writer_epoch !== identity.writerEpoch || !decimal(v.revision) || !count(v.received_count) ||
    !count(v.contiguous_sequence) || v.contiguous_sequence > v.received_count ||
    !['open', 'sealing', 'sealed', 'aborted'].includes(v.state as string) ||
    (v.expected_count !== null && (!count(v.expected_count) || v.expected_count < v.received_count)) ||
    (v.state === 'open' && v.expected_count !== null) ||
    ((v.state === 'sealing' || v.state === 'sealed') && v.expected_count === null) ||
    (v.state === 'sealed' && (v.expected_count !== v.received_count || v.contiguous_sequence !== v.received_count)) ||
    typeof v.authorization_expired !== 'boolean') throw invalid();
  return { ...identity, profile: v.profile, revision: v.revision, receivedCount: v.received_count,
    contiguousSequence: v.contiguous_sequence, state: v.state as ProtectedStreamingStatus['state'],
    expectedCount: v.expected_count as number | null, authorizationExpired: v.authorization_expired };
}

/** Public read provider. Protected START/relay and signed ACKs remain native-only. */
export function createManagedProtectedStreamingStatusBackend(native: Pick<Spec, 'readProtectedStreamingStatus' | 'cancelProtectedStreamingStatus'> | null, options: ProtectedStreamingStatusBackendOptions): ProtectedStreamingStatusBackend {
  const config = { ...options };
  const url = new URL(config.baseUrl);
  const path = url.pathname.replace(/\/$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !/^(\/[A-Za-z0-9_-]+)+$/.test(path) || !config.signal || typeof config.getAccessToken !== 'function' ||
    (config.organizationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(config.organizationId))) {
    throw new Error('Invalid protected streaming status configuration');
  }
  const baseUrl = `${url.origin}${path}`;
  const active = new Set<AbortController>();
  let requestSequence = 0;
  const instance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let disposed = false;
  return {
    async getStatus(request, callerSignal) {
      const identity = { recordingId: request.recordingId, sessionId: request.sessionId,
        recordingGeneration: request.recordingGeneration, writerEpoch: request.writerEpoch };
      if (!/^rec_[A-Za-z0-9_-]{1,128}$/.test(identity.recordingId) || !uuid.test(identity.sessionId) ||
        !generation(identity.recordingGeneration) || !decimal(identity.writerEpoch) || identity.writerEpoch === '0') {
        throw new Error('Invalid protected streaming identity');
      }
      if (!native?.readProtectedStreamingStatus) throw new Error('Protected streaming status requires the matching native SDK binary');
      const controller = new AbortController();
      const requestId = `${instance}-${++requestSequence}`;
      let dispatched = false;
      const cancel = () => controller.abort();
      controller.signal.addEventListener('abort', () => { if (dispatched) void native.cancelProtectedStreamingStatus(requestId).catch(() => {}); }, { once: true });
      const check = () => {
        if (disposed || config.signal.aborted || callerSignal?.aborted || controller.signal.aborted) {
          throw new Error('Protected streaming status cancelled');
        }
      };
      active.add(controller);
      config.signal.addEventListener('abort', cancel, { once: true });
      callerSignal?.addEventListener('abort', cancel, { once: true });
      try {
        check();
        const token = await config.getAccessToken(controller.signal);
        check();
        if (typeof token !== 'string' || !/^[!-~]{1,16384}$/.test(token)) {
          throw new Error('Invalid protected streaming credentials');
        }
        const requestUrl = `${baseUrl}/recordings/${identity.recordingId}/streaming-status?session_id=${identity.sessionId}`;
        let body: string;
        try {
          dispatched = true;
          body = await native.readProtectedStreamingStatus(requestId, JSON.stringify({ url: requestUrl,
            token, organizationId: config.organizationId ?? '' }));
        } catch {
          check();
          throw new Error('Protected streaming status request failed');
        }
        check();
        if (body.length > 16384) throw new Error('Invalid protected streaming status response');
        let value: unknown;
        try { value = JSON.parse(body); } catch { throw new Error('Invalid protected streaming status response'); }
        return decode(value, identity);
      } finally {
        active.delete(controller);
        config.signal.removeEventListener('abort', cancel);
        callerSignal?.removeEventListener('abort', cancel);
      }
    },
    dispose() { disposed = true; for (const controller of active) controller.abort(); },
  };
}
