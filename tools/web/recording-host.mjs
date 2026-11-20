import { createHash, timingSafeEqual } from 'node:crypto'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const digest = value => createHash('sha256').update(value).digest()
const languages = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de']
class Failure extends Error { constructor(status, code) { super(code); this.status = status; this.code = code } }
const fail = (status, code) => { throw new Failure(status, code) }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'invalid_input')
}
async function json(message, limit, signal) {
  const reader = message.body?.getReader(), chunks = []; let length = 0
  if (!reader) fail(400, 'invalid_input')
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read(); if (done) break
      length += value.byteLength; if (length > limit) fail(413, 'invalid_input'); chunks.push(value)
    }
    signal.throwIfAborted()
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail(400, 'invalid_input') }
  } finally { signal.removeEventListener('abort', cancel); cancel(); for (const chunk of chunks) chunk.fill(0) }
}

// REST admission and the WebSocket upgrade use different hosts on Bota deployments.
const platformSocketOrigins = new Map([
  ['https://api.dev.bota.dev', 'wss://platform.dev.bota.dev'],
  ['https://api.gamma.bota.dev', 'wss://platform.gamma.bota.dev'],
  ['https://api.bota.dev', 'wss://platform.bota.dev'],
])

export function recordingSocketOrigin(apiOrigin) {
  return platformSocketOrigins.get(apiOrigin) ?? new URL(apiOrigin).origin.replace(/^https:/, 'wss:')
}

/** Operator-only loopback adapter for one authenticated end user. Production
 * hosts must resolve this identity from their own login. API keys stay here;
 * the client gets only a one-use activity grant and its own archive key. */
export function createRecordingHost(config, dependencies = {}) {
  const fixed = structuredClone(config), origin = new URL(fixed.origin), api = new URL(fixed.apiOrigin)
  if (origin.origin !== fixed.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
      api.origin !== fixed.apiOrigin || api.username || api.password ||
      api.protocol !== 'https:' ||
      !/^(?:proj|prj)_[A-Za-z0-9_-]+$/.test(fixed.projectId) || !/^eu_[A-Za-z0-9_-]{1,76}$/.test(fixed.endUserId) ||
      typeof fixed.apiKey !== 'string' || !fixed.apiKey || !/^[A-Za-z0-9_-]{32,128}$/.test(fixed.code)) throw Error('Invalid recording lab configuration')
  const fetch = dependencies.fetch ?? globalThis.fetch, attempted = new Set(), admitted = new Set()
  const root = '/v1/recording-speech'
  let pending = 0
  return async request => {
    let owns = false
    try {
      const url = new URL(request.url), code = request.headers.get('x-recording-code') ?? ''
      if (url.origin !== fixed.origin || (request.headers.has('origin') && request.headers.get('origin') !== fixed.origin) ||
          request.headers.get('sec-fetch-site') === 'cross-site' || code.length > 128 ||
          !timingSafeEqual(digest(code), digest(fixed.code))) fail(403, 'unauthorized')
      if (request.method !== 'POST' || url.search || request.headers.get('content-type') !== 'application/json') fail(400, 'invalid_input')
      if (pending >= 4) fail(429, 'busy')
      pending++; owns = true
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
      const body = await json(request, url.pathname === '/recording-host/capture_chunk' ? 270000 :
        url.pathname === '/recording-host/capture_complete' ? 48000 : 8192, signal)
      async function upstream(path, data) {
        const response = await fetch(fixed.apiOrigin + path, { method: data === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${fixed.apiKey}`, 'content-type': 'application/json' },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal, redirect: 'error', cache: 'no-store' })
        const value = await json(response, 524288, signal)
        if (!response.ok) fail([401,403].includes(response.status) ? 403 : response.status === 409 ? 409 : response.status === 429 ? 429 : 503,
          [401,403].includes(response.status) ? 'unauthorized' : response.status === 409 ? 'conflict' : 'unavailable')
        return value
      }
      async function prepareCapture(captureId) {
        if (!uuid(captureId)) fail(400, 'invalid_input')
        const capture = await upstream(`${root}/captures`, { end_user_id: fixed.endUserId, capture_id: captureId, profile: 'speech_capture_pcm_v1' })
        if (capture.capture_id !== captureId || !/^rec_[A-Za-z0-9_-]+$/.test(capture.recording_id)) fail(503, 'unavailable')
        return capture
      }
      let result
      const action = url.pathname.slice('/recording-host/'.length)
      if (!url.pathname.startsWith('/recording-host/')) fail(404, 'not_found')
      if (action === 'context') {
        fields(body, [])
        result = { scope: JSON.stringify([fixed.projectId, fixed.endUserId]) }
      } else if (action === 'capture_prepare') {
        fields(body, ['captureId'])
        result = { scope: JSON.stringify([fixed.projectId, fixed.endUserId]), prepared: await prepareCapture(body.captureId) }
      } else if (action === 'models') {
        fields(body, [])
        result = await upstream(`${root}/models?end_user_id=${encodeURIComponent(fixed.endUserId)}`)
      } else if (action === 'start') {
        fields(body, ['activityId','clockId','captureId','realtimeTranscription','retention','targetLanguage','sourceLanguage','models','modelCatalogRevision'])
        if (body.realtimeTranscription !== true) fail(400, 'invalid_input')
        if (!uuid(body.activityId) || !uuid(body.clockId) || !languages.includes(body.targetLanguage) ||
            !['en','zh','multi'].includes(body.sourceLanguage) || !['original_audio_and_text','text_only','live_only'].includes(body.retention) ||
            (body.retention === 'original_audio_and_text' ? !uuid(body.captureId) : body.captureId !== undefined)) fail(400, 'invalid_input')
        if (body.models !== undefined) {
          fields(body.models, ['asr', 'translation', 'tts'])
          if (Object.values(body.models).some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_]{1,79}$/.test(id))) fail(400, 'invalid_input')
        }
        if (body.modelCatalogRevision !== undefined && (typeof body.modelCatalogRevision !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(body.modelCatalogRevision))) fail(400, 'invalid_input')
        // Never retry uncertain creation or grant issuance. A new explicit run
        // gets a new activity ID; expired slots are retired by the backend.
        if (attempted.has(body.activityId)) fail(409, 'conflict')
        if (attempted.size >= 32) fail(429, 'busy')
        attempted.add(body.activityId)
        const prepared = body.retention === 'original_audio_and_text' ? await prepareCapture(body.captureId) : undefined
        const value = await upstream(root, { id: body.activityId, end_user_id: fixed.endUserId, realtime_transcription: true,
          ...(prepared ? { recording_id: prepared.recording_id } : {}), retention: body.retention,
          ...(body.models === undefined ? {} : { models: body.models }),
          ...(body.modelCatalogRevision === undefined ? {} : { model_catalog_revision: body.modelCatalogRevision }),
          target_language: body.targetLanguage, audience: 'personal', duration_seconds: 7200,
          sources: [{ id: 'microphone', epoch: 1, role: 'mixed', speaker: 'unknown', language: body.sourceLanguage, startSample: 0, captureClockId: body.clockId }] })
        if (value.activity?.id !== body.activityId) fail(503, 'unavailable')
        // A failed or uncertain create does not establish ownership. In
        // particular, a conflicting ID may belong to a different end user.
        admitted.add(body.activityId)
        const grant = await upstream(`${root}/${body.activityId}/grant`, {})
        result = { scope: JSON.stringify([fixed.projectId, fixed.endUserId]), activity: value.activity, configuration: { projectId: fixed.projectId, activityId: body.activityId,
          endpoint: recordingSocketOrigin(fixed.apiOrigin) + `${root}/ws` }, grant, clockId: body.clockId, ...(prepared ? { prepared } : {}) }
      } else if (['grant','end'].includes(action)) {
        fields(body, ['activityId'])
        if (!uuid(body.activityId) || !admitted.has(body.activityId)) fail(403, 'unauthorized')
        result = await upstream(`${root}/${body.activityId}/${action}`, {})
      } else if (['capture_key','capture_chunk','capture_complete','capture_status','capture_transcript'].includes(action)) {
        const kind = action.slice(8)
        fields(body, ['captureId', ...(kind === 'chunk' || kind === 'complete' ? ['packet'] : kind === 'transcript' ? ['afterSegment','resultSha256'] : [])])
        if (!uuid(body.captureId)) fail(400, 'invalid_input')
        const path = `${root}/captures/${body.captureId}`, owner = { end_user_id: fixed.endUserId }
        if (kind === 'status' || kind === 'transcript') {
          const query = new URLSearchParams(owner)
          if (body.afterSegment !== undefined) {
            if (!Number.isSafeInteger(body.afterSegment) || body.afterSegment < 0 || body.afterSegment > 100000) fail(400,'invalid_input')
            query.set('after_segment', String(body.afterSegment))
          }
          if (body.resultSha256 !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(body.resultSha256)) fail(400,'invalid_input')
            query.set('result_sha256', body.resultSha256)
          }
          result = await upstream(path + (kind === 'transcript' ? '/transcript' : '') + '?' + query)
        } else {
          if (kind !== 'key') {
            fields(body.packet, kind === 'chunk' ? ['nonce','ciphertext','header'] : ['nonce','ciphertext'])
            if (typeof body.packet.nonce !== 'string' || body.packet.nonce.length !== 16 || typeof body.packet.ciphertext !== 'string' ||
                body.packet.ciphertext.length > (kind === 'chunk' ? 256024 : 43712)) fail(400,'invalid_input')
          }
          result = await upstream(`${path}/${kind}`, { ...owner, ...(kind === 'key' ? {} : { packet: body.packet }) })
        }
      } else fail(404, 'not_found')
      return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return Response.json({ error: { code: error instanceof Failure ? error.code : 'unavailable' } },
        { status: error instanceof Failure ? error.status : 503, headers: { 'cache-control': 'no-store' } })
    } finally { if (owns) pending-- }
  }
}
