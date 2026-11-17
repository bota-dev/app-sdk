import type { SpeechMediaCallbacks, SpeechMediaPort, SpeechGrant } from '@bota.dev/web-app-sdk/speech'
import { mountSpeechApp } from './speechApp'

// Synthetic IO lives on a separate test page. The operator host never serves this page.
let callbacks: SpeechMediaCallbacks, grant: SpeechGrant
let capture = false, publication = false, created = 0, closed = 0, sequence = 0
let revision = 1, targetLanguage = 'zh'
let cleanupFailure = false
let cleanup: Promise<void> | undefined, completeCleanup = () => {}
const peer = () => grant.participant_id === '22222222-2222-4222-8222-222222222222' ?
  '33333333-3333-4333-8333-333333333333' : '22222222-2222-4222-8222-222222222222'
function base() { return { protocolVersion: 1, projectId: 'prj_synthetic', sessionId: grant.session_id,
  retention: 'live_only', participantId: grant.participant_id, memberGeneration: 2, workerGeneration: 3, subscriptionRevision: revision } }
function applied() { callbacks.text(grant.processor_identity, JSON.stringify({ ...base(), type: 'subscription_applied', targetLanguage, mode: 'translated' })) }
const gate = {
  state: () => ({ capture, created, closed }),
  caption(text: string, final: boolean, translated: boolean) {
    applied()
    const sourceId = '44444444-4444-4444-8444-444444444444'
    const record = { protocolVersion: 1, projectId: 'prj_synthetic', sessionId: grant.session_id, retention: 'live_only',
      sourceId, sourceEpoch: 1, sourceParticipantId: peer(), sourceMemberGeneration: 2, unitId: `${sourceId}:1:1:1`,
      sourceFirstSeq: 1, sourceLastSeq: 1, startMs: 0, endMs: 100, sourceLanguage: 'en', text,
      ...(translated ? { targetLanguage } : {}) }
    callbacks.text(grant.processor_identity, JSON.stringify({ ...base(), type: 'caption', eventSequence: ++sequence,
      sourceId, sourceEpoch: 1, sourceParticipantId: peer(), sourceMemberGeneration: 2, record, final }))
  },
  apply(next: number, language: string) { revision = next; targetLanguage = language; applied() },
  failCleanup() { cleanupFailure = true },
  failMedia() { callbacks.failed() },
  holdCleanup() { cleanup = new Promise(resolve => { completeCleanup = resolve }) },
  completeCleanup() { completeCleanup() },
}
declare global { interface Window { __speechGate: typeof gate } }
window.__speechGate = gate
mountSpeechApp(document.querySelector('#app')!, notices => {
  callbacks = notices; created++
  const port: SpeechMediaPort = {
    async connect(value) { grant = value },
    muteMicrophone() { capture = false }, holdMicrophone() { capture = false },
    microphonePublication() { return publication ? 'TR_owned' : null },
    silencePlayback() {}, async clearPlayback() {}, async setPlayback() {}, async resumeAudio() {},
    async setMicrophone(enabled) { capture = enabled; publication = enabled },
    async close() { closed++; capture = false; publication = false; await cleanup; if (cleanupFailure) throw Error('synthetic cleanup failure') },
  }
  return port
})
