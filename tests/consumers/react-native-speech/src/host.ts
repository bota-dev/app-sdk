import { SpeechCaptionReadError, SpeechSessionError, SpeechSourceFinishError,
  type SpeechConfiguration, type SpeechGrant, type SpeechHostCallbacks, type SpeechSubscription } from '@bota.dev/react-native-app-sdk/speech';

export interface NativeHost {
  request(id: string, origin: string, role: string, code: string, action: string, body: string): Promise<{ status: number; body: string }>;
  cancel(id: string): Promise<void>;
  microphonePermission(): Promise<boolean>;
  originalView?(): Promise<string>;
  startOriginal?(): Promise<void>;
  finishOriginal?(): Promise<void>;
  closeSession?(): Promise<void>;
}
export interface Joined {
  role: 'a' | 'b'; peer: { role: 'a' | 'b'; participantId: string }; allowedLanguages: string[];
  configuration: SpeechConfiguration; grant: SpeechGrant;
}
class HostError extends Error {
  constructor(readonly status = 0, readonly code = 'unavailable') { super(code); }
}
let nextRequest = 0;
export function labHost(native: NativeHost, origin: string, role: string, accessCode: string) {
  if (!/^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?$/.test(origin) || !['a', 'b'].includes(role) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(accessCode)) throw new HostError();
  let code = accessCode, closed = false;
  const pending = new Map<string, { settled: Promise<void>; cancel(): Promise<void> }>();
  let closing: Promise<void> | undefined;
  async function request<T>(action: string, body: unknown, signal: AbortSignal): Promise<T> {
    if (closed || signal.aborted) throw new HostError();
    const id = String(++nextRequest);
    let cancellation: Promise<void> | undefined, done!: () => void;
    const settled = new Promise<void>(resolve => { done = resolve; });
    const cancel = () => cancellation ??= native.cancel(id);
    const abort = () => { void cancel().catch(() => {}); };
    pending.set(id, { settled, cancel }); signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await native.request(id, origin, role, code, action, JSON.stringify(body));
      if (signal.aborted || closed || response.body.length > 524288) throw new HostError();
      const value = JSON.parse(response.body);
      if (response.status < 200 || response.status >= 300) {
        const allowed = ['unauthorized', 'not_ready', 'conflict', 'stale_source', 'unsupported_session', 'busy'];
        throw new HostError(response.status, allowed.includes(value?.error?.code) ? value.error.code : 'unavailable');
      }
      return value as T;
    } finally {
      signal.removeEventListener('abort', abort);
      try { await cancellation; } finally { pending.delete(id); done(); }
    }
  }
  return {
    async join(signal: AbortSignal): Promise<Joined> {
      const value = await request<Joined>('join', {}, signal);
      const { context, subscription } = value.configuration;
      if (value.role !== role || value.peer.role === role || !['a', 'b'].includes(value.peer.role) ||
          value.peer.participantId === context.participantId || subscription.sourceParticipantIds.length !== 1 ||
          subscription.sourceParticipantIds[0] !== value.peer.participantId || !context.canPublish || !context.canSubscribe ||
          !['live_only', 'text_only', ...(native.originalView && native.startOriginal && native.finishOriginal && native.closeSession ? ['original_audio_and_text'] : [])].includes(context.retention) || value.allowedLanguages.length > 7 ||
          new Set(value.allowedLanguages).size !== value.allowedLanguages.length ||
          !value.allowedLanguages.includes(subscription.targetLanguage)) throw new HostError(409, 'unsupported_session');
      return value;
    },
    callbacks(initial: Joined, denied: () => void): SpeechHostCallbacks {
      let revision = initial.configuration.subscription.revision;
      const context = initial.configuration.context;
      const owns = (value: { projectId: string; sessionId: string; participantId: string; memberGeneration: number }) =>
        value.projectId === context.projectId && value.sessionId === context.sessionId &&
        value.participantId === context.participantId && value.memberGeneration === context.memberGeneration;
      return {
        async changeSubscription(selection, signal) {
          if (selection.sourceParticipantIds.length !== 1 || selection.sourceParticipantIds[0] !== initial.peer.participantId ||
              !initial.allowedLanguages.includes(selection.targetLanguage)) throw new SpeechSessionError('invalid_input');
          try {
            const value = await request<SpeechSubscription>('subscription', { expectedRevision: revision,
              targetLanguage: selection.targetLanguage, mode: selection.mode }, signal);
            revision = value.revision; return value;
          } catch (error) { if (error instanceof HostError && error.status === 403) denied(); throw error; }
        },
        renewGrant: signal => request<SpeechGrant>('grant', {}, signal),
        async readCaptions(input, signal) {
          if (!owns(input)) throw new SpeechCaptionReadError('unauthorized');
          try { return await request('captions', { subscriptionRevision: input.subscriptionRevision, limit: input.limit, cursor: input.cursor }, signal); }
          catch (error) { throw new SpeechCaptionReadError(error instanceof HostError && error.status === 403 ? 'unauthorized' :
            error instanceof HostError && error.status === 409 ? 'stale_subscription' : 'unavailable'); }
        },
        async finishSource(input, signal) {
          if (!owns(input)) throw new SpeechSourceFinishError('unauthorized');
          try { return await request('finish', { workerGeneration: input.workerGeneration, trackSid: input.trackSid,
            sourceId: input.sourceId, sourceEpoch: input.sourceEpoch }, signal); }
          catch (error) { throw new SpeechSourceFinishError(error instanceof HostError && error.status === 403 ? 'unauthorized' :
            error instanceof HostError && error.status === 409 && error.code !== 'not_ready' ? 'stale_source' : 'unavailable'); }
        },
      };
    },
    close() {
      if (closing) return closing;
      closed = true; code = '';
      const tasks = [...pending.values()];
      closing = Promise.allSettled([...tasks.flatMap(task => [task.cancel(), task.settled]), native.closeSession?.()]).then(results => {
        if (results.some(result => result.status === 'rejected')) throw new HostError();
      });
      return closing;
    },
  };
}
