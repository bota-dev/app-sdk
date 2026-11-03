import { SpeechCaptionReadError, SpeechSessionError, SpeechSourceFinishError,
  type SpeechConfiguration, type SpeechGrant, type SpeechHostCallbacks, type SpeechSubscription } from '@bota.dev/web-app-sdk/speech'

export interface SpeechJoin {
  role: 'a' | 'b'
  peer: { role: 'a' | 'b'; participantId: string }
  allowedLanguages: string[]
  configuration: SpeechConfiguration
  grant: SpeechGrant
}
export class HostError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export function speechHost(role: string, code: string) {
  async function request<T>(action: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetch(`/speech-host/${action}`, { method: 'POST', credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      headers: { 'content-type': 'application/json', 'x-speech-role': role, 'x-speech-code': code }, body: JSON.stringify(body) })
    if (!response.ok) {
      const value = await response.json().catch(() => null)
      const safe = ['unauthorized', 'not_ready', 'conflict', 'stale_source', 'unsupported_session', 'busy']
      throw new HostError(response.status, safe.includes(value?.error?.code) ? value.error.code : 'unavailable')
    }
    return await response.json() as T
  }
  return {
    join: (signal: AbortSignal) => request<SpeechJoin>('join', {}, signal),
    callbacks(initial: SpeechJoin, denied: () => void): SpeechHostCallbacks {
      let revision = initial.configuration.subscription.revision
      const { context } = initial.configuration
      function own(request: { projectId: string; sessionId: string; participantId: string; memberGeneration: number }) {
        return request.projectId === context.projectId && request.sessionId === context.sessionId &&
          request.participantId === context.participantId && request.memberGeneration === context.memberGeneration
      }
      return {
        async changeSubscription(selection, signal) {
          if (selection.sourceParticipantIds.length !== 1 || selection.sourceParticipantIds[0] !== initial.peer.participantId)
            throw new SpeechSessionError('invalid_input')
          try {
            const value = await request<SpeechSubscription>('subscription', { expectedRevision: revision,
              targetLanguage: selection.targetLanguage, mode: selection.mode }, signal)
            revision = value.revision
            return value
          } catch (error) {
            // The SDK reports ordinary subscription IO failures without retiring capture.
            // An explicit host denial instead retires this App owner immediately.
            if (error instanceof HostError && error.status === 403) denied()
            throw error
          }
        },
        renewGrant: signal => request<SpeechGrant>('grant', {}, signal),
        async readCaptions(input, signal) {
          if (!own(input)) throw new SpeechCaptionReadError('unauthorized')
          try {
            return await request('captions', { subscriptionRevision: input.subscriptionRevision, limit: input.limit, cursor: input.cursor }, signal)
          } catch (error) {
            throw new SpeechCaptionReadError(error instanceof HostError && error.status === 403 ? 'unauthorized' :
              error instanceof HostError && error.status === 409 ? 'stale_subscription' : 'unavailable')
          }
        },
        async finishSource(input, signal) {
          if (!own(input)) throw new SpeechSourceFinishError('unauthorized')
          try {
            return await request('finish', { workerGeneration: input.workerGeneration, trackSid: input.trackSid,
              sourceId: input.sourceId, sourceEpoch: input.sourceEpoch }, signal)
          } catch (error) {
            throw new SpeechSourceFinishError(error instanceof HostError && error.status === 403 ? 'unauthorized' :
              error instanceof HostError && error.status === 409 && error.code !== 'not_ready' ? 'stale_source' : 'unavailable')
          }
        },
      }
    },
  }
}
