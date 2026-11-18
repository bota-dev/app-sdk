import type { RecordingSpeechConfiguration, RecordingSpeechGrant, RecordingSpeechModelSelection, RecordingSpeechModelIdentity } from '@bota.dev/web-app-sdk/speech/recording'
import type { SpeechCaptureHost, SpeechCapturePreparation } from '@bota.dev/web-app-sdk/speech/capture'

export interface RecordingAdmission {
  scope: string; clockId: string; configuration: RecordingSpeechConfiguration; grant: RecordingSpeechGrant
  activity: { id: string; expires_at: string; models?: Record<'asr' | 'translation' | 'tts', RecordingSpeechModelIdentity | null> }; prepared?: SpeechCapturePreparation
}
export function recordingHost(code: string) {
  async function request<T>(action: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetch(`/recording-host/${action}`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-recording-code': code }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
    if (!response.ok) throw Error(response.status === 403 ? 'unauthorized' : 'recording_host_unavailable')
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try {
      while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.length
        if (bytes > 524288) throw Error('recording_host_unavailable'); chunks.push(value.value) }
      const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as T } finally { data.fill(0) }
    } finally { await reader.cancel(); for (const chunk of chunks) chunk.fill(0) }
  }
  return {
    models: (signal: AbortSignal) => request<{ revision: string; stages?: Record<string, boolean>; defaults: Record<string, string>; models: { id: string; label: string; stage: string; available: boolean }[] }>('models', {}, signal),
    start: (body: { activityId: string; clockId: string; captureId?: string; retention: string; targetLanguage: string; sourceLanguage: string; models?: RecordingSpeechModelSelection['models']; modelCatalogRevision?: string }, signal: AbortSignal) =>
      request<RecordingAdmission>('start', body, signal),
    end: (activityId: string, signal: AbortSignal) => request('end', { activityId }, signal),
    capture(captureId: string): SpeechCaptureHost {
      return { upload: (packet, signal) => request('capture_chunk', { captureId, packet }, signal),
        complete: (packet, signal) => request('capture_complete', { captureId, packet }, signal),
        status: signal => request('capture_status', { captureId }, signal) }
    },
    transcript: (captureId: string, afterSegment: number, resultSha256: string | undefined, signal: AbortSignal) =>
      request<Record<string, any>>('capture_transcript', { captureId, afterSegment, resultSha256 }, signal),
  }
}
