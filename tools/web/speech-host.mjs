import { createHash, timingSafeEqual } from 'node:crypto'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647
const modes = ['translated', 'original', 'captions_only']
const digest = value => createHash('sha256').update(value).digest()
class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const fail = (status, code) => { throw new Failure(status, code) }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'invalid_input')
}
async function json(message, maximum, signal) {
  const reader = message.body?.getReader()
  if (!reader) fail(400, 'invalid_input')
  const chunks = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) fail(413, 'invalid_input')
      chunks.push(value)
    }
    signal?.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { signal?.removeEventListener('abort', cancel); cancel() }
}
function subscription(value, member, peer) {
  if (!value || value.participant_id !== member.participantId || value.member_generation !== member.memberGeneration ||
      !integer(value.revision) || !modes.includes(value.mode) || typeof value.target_language !== 'string' ||
      !Array.isArray(value.source_participant_ids) || value.source_participant_ids.length !== 1 ||
      value.source_participant_ids[0] !== peer.participantId) fail(409, 'unsupported_session')
  return { revision: value.revision, targetLanguage: value.target_language, mode: value.mode,
    sourceParticipantIds: [peer.participantId] }
}

/** Local lab only: fixed role credentials bind pre-admitted members. Production hosts must
 * replace this login with their own authenticated principal and current membership checks. */
export function createSpeechHost(config, dependencies = {}) {
  const fixed = structuredClone(config), base = new URL(fixed.apiOrigin), origin = new URL(fixed.origin)
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || origin.origin !== fixed.origin ||
      base.origin !== fixed.apiOrigin || base.username || base.password ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) ||
      !uuid(fixed.sessionId) || typeof fixed.projectId !== 'string' || !fixed.projectId ||
      typeof fixed.apiKey !== 'string' || !fixed.apiKey || fixed.roles?.a?.participantId === fixed.roles?.b?.participantId) throw Error('Invalid speech lab configuration')
  for (const role of ['a', 'b']) {
    const member = fixed.roles?.[role]
    if (!uuid(member?.participantId) || !integer(member?.memberGeneration) ||
        typeof member?.code !== 'string' || member.code.length < 32 || member.code.length > 128) throw Error('Invalid speech lab configuration')
  }
  if (fixed.roles.a.code === fixed.roles.b.code) throw Error('Invalid speech lab configuration')
  const fetch = dependencies.fetch ?? globalThis.fetch
  const root = `/v1/speech-sessions/${fixed.sessionId}`
  const inFlight = { a: 0, b: 0 }
  return async request => {
    let owned
    try {
      const url = new URL(request.url), role = request.headers.get('x-speech-role'), code = request.headers.get('x-speech-code') ?? ''
      if (url.origin !== fixed.origin || (request.headers.has('origin') && request.headers.get('origin') !== fixed.origin) ||
          request.headers.get('sec-fetch-site') === 'cross-site' || !['a', 'b'].includes(role) ||
          code.length > 128 || !timingSafeEqual(digest(code), digest(fixed.roles[role].code))) fail(403, 'unauthorized')
      if (request.method !== 'POST' || url.search || request.headers.get('content-type') !== 'application/json') fail(400, 'invalid_input')
      if (inFlight[role] >= 4) fail(429, 'busy')
      inFlight[role]++; owned = role
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)])
      let body
      const maximumBody = url.pathname === '/speech-host/capture_chunk' ? 140000 : url.pathname === '/speech-host/capture_complete' ? 48000 : 8192
      try { body = await json(request, maximumBody, signal) }
      catch (error) { if (error instanceof SyntaxError) fail(400, 'invalid_input'); throw error }
      const member = fixed.roles[role], peer = fixed.roles[role === 'a' ? 'b' : 'a']
      const memberPath = `${root}/participants/${member.participantId}`
      async function upstream(path, data, method = 'POST') {
        const response = await fetch(`${fixed.apiOrigin}${path}`, { method: data === undefined ? 'GET' : method,
          headers: { authorization: `Bearer ${fixed.apiKey}`, 'content-type': 'application/json' },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal, redirect: 'error', cache: 'no-store' })
        const value = await json(response, 512 * 1024, signal)
        if (!response.ok) {
          if ([401, 403].includes(response.status)) fail(403, 'unauthorized')
          if (response.status === 409) {
            const code = value?.error?.code
            fail(409, code === 'speech_session_not_ready' ? 'not_ready' : code === 'speech_session_stale_source' ? 'stale_source' : 'conflict')
          }
          fail(response.status === 429 ? 429 : 503, 'unavailable')
        }
        return { value, status: response.status }
      }
      async function snapshot(requirePeer = false, originalCapable = true) {
        const { value } = await upstream(root)
        const session = value?.session
        if (session?.id !== fixed.sessionId || session.state !== 'active' ||
            !['live_only', 'text_only', ...(originalCapable ? ['original_audio_and_text'] : [])].includes(session.retention) || !Array.isArray(session.allowed_languages)) fail(409, 'unsupported_session')
        for (const expected of requirePeer ? [member, peer] : [member]) {
          const matches = value.participants?.filter(item => item.id === expected.participantId)
          const item = matches?.[0]
          if (matches?.length !== 1 || item.generation !== expected.memberGeneration || item.state !== 'active' ||
              item.source_kind !== 'host_microphone' || !item.can_publish || !item.can_subscribe ||
              !(Date.parse(item.expires_at) > Date.now())) fail(409, 'unsupported_session')
        }
        return value
      }
      let result, status = 200
      switch (url.pathname) {
        case '/speech-host/join': {
          fields(body, ['captureProfile'])
          if (body.captureProfile !== undefined && body.captureProfile !== 'speech_capture_pcm_v1') fail(400, 'invalid_input')
          const view = await snapshot(true, body.captureProfile === 'speech_capture_pcm_v1')
          const matches = view.subscriptions?.filter(item => item.participant_id === member.participantId)
          if (matches?.length !== 1) fail(409, 'not_ready')
          const selected = subscription(matches[0], member, peer)
          const { value: grant } = await upstream(`${memberPath}/grant`, { member_generation: member.memberGeneration })
          result = { role, peer: { role: role === 'a' ? 'b' : 'a', participantId: peer.participantId },
            allowedLanguages: view.session.allowed_languages, configuration: { context: { projectId: fixed.projectId,
              sessionId: fixed.sessionId, participantId: member.participantId, memberGeneration: member.memberGeneration,
              retention: view.session.retention, canPublish: true, canSubscribe: true }, subscription: selected }, grant }
          break
        }
        case '/speech-host/capture_prepare':
        case '/speech-host/capture_key':
        case '/speech-host/capture_chunk':
        case '/speech-host/capture_complete':
        case '/speech-host/capture_status':
        case '/speech-host/capture_transcript': {
          const action = url.pathname.slice('/speech-host/capture_'.length)
          fields(body, ['captureId', ...(action === 'chunk' || action === 'complete' ? ['packet'] :
            action === 'status' ? ['afterSequence', 'afterGap'] : action === 'transcript' ? ['afterSegment', 'resultSha256'] : [])])
          if (!uuid(body.captureId)) fail(400, 'invalid_input')
          const capturePath = `${memberPath}/captures/${body.captureId}`
          // The backend reauthorizes current ownership on every request, while
          // archival remains independent of the RTC session's lifetime.
          let response
          if (action === 'status' || action === 'transcript') {
            const query = new URLSearchParams({ member_generation: String(member.memberGeneration) })
            if (body.afterSequence !== undefined) {
              if (!Number.isInteger(body.afterSequence) || body.afterSequence < -1 || body.afterSequence > 14399) fail(400, 'invalid_input')
              query.set('after_sequence', String(body.afterSequence))
            }
            if (body.afterGap !== undefined) {
              if (!Number.isInteger(body.afterGap) || body.afterGap < 0 || body.afterGap > 14656) fail(400, 'invalid_input')
              query.set('after_gap', String(body.afterGap))
            }
            if (body.afterSegment !== undefined) {
              if (!Number.isInteger(body.afterSegment) || body.afterSegment < 0 || body.afterSegment > 100000) fail(400, 'invalid_input')
              query.set('after_segment', String(body.afterSegment))
            }
            if (body.resultSha256 !== undefined) {
              if (typeof body.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.resultSha256)) fail(400, 'invalid_input')
              query.set('result_sha256', body.resultSha256)
            }
            response = await upstream(`${capturePath}${action === 'transcript' ? '/transcript' : ''}?${query}`)
          } else if (action === 'prepare') {
            response = await upstream(`${memberPath}/captures`, { member_generation: member.memberGeneration,
              capture_id: body.captureId, profile: 'speech_capture_pcm_v1' })
          } else {
            if (action !== 'key') {
              fields(body.packet, action === 'chunk' ? ['nonce', 'ciphertext', 'header'] : ['nonce', 'ciphertext'])
              if (typeof body.packet.nonce !== 'string' || body.packet.nonce.length !== 16 ||
                typeof body.packet.ciphertext !== 'string' || body.packet.ciphertext.length > (action === 'chunk' ? 128024 : 43712)) fail(400, 'invalid_input')
            }
            response = await upstream(`${capturePath}/${action}`, { member_generation: member.memberGeneration,
              ...(action === 'key' ? {} : { packet: body.packet }) })
          }
          result = response.value; status = response.status
          break
        }
        case '/speech-host/capture_bind': {
          fields(body, ['captureId', 'workerGeneration', 'trackSid'])
          if (!uuid(body.captureId) || !integer(body.workerGeneration) || typeof body.trackSid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.trackSid)) fail(400, 'invalid_input')
          // Source registration can arrive after capture/publication or RTC retirement.
          // The backend rechecks current member/recording authority and exact source identity.
          const { value: view } = await upstream(root)
          if (view?.session?.id !== fixed.sessionId || view.session.retention !== 'original_audio_and_text') fail(409, 'unsupported_session')
          const sources = view.sources?.filter(item => item.participant_id === member.participantId &&
            item.member_generation === member.memberGeneration && item.track_sid === body.trackSid)
          if (sources?.length !== 1 || !uuid(sources[0].id) || !integer(sources[0].epoch)) fail(409, 'not_ready')
          const response = await upstream(`${memberPath}/captures/${body.captureId}/bind`, { member_generation: member.memberGeneration,
            source_id: sources[0].id, source_epoch: sources[0].epoch, worker_generation: body.workerGeneration, track_sid: body.trackSid })
          result = response.value; status = response.status
          break
        }
        case '/speech-host/grant': {
          fields(body, []); await snapshot()
          result = (await upstream(`${memberPath}/grant`, { member_generation: member.memberGeneration })).value
          break
        }
        case '/speech-host/subscription': {
          fields(body, ['expectedRevision', 'targetLanguage', 'mode'])
          if (!integer(body.expectedRevision) || !modes.includes(body.mode) || typeof body.targetLanguage !== 'string') fail(400, 'invalid_input')
          const view = await snapshot(true)
          if (!view.session.allowed_languages.includes(body.targetLanguage)) fail(400, 'invalid_input')
          // PUT is the existing Bota contract; neither revision conflicts nor uncertain writes are retried.
          const { value } = await upstream(`${memberPath}/subscription`, { member_generation: member.memberGeneration,
            expected_revision: body.expectedRevision, target_language: body.targetLanguage, mode: body.mode,
            source_participant_ids: [peer.participantId] }, 'PUT')
          result = subscription(value.subscription, member, peer)
          break
        }
        case '/speech-host/captions': {
          fields(body, ['subscriptionRevision', 'limit', 'cursor'])
          if (!integer(body.subscriptionRevision) || !integer(body.limit) || body.limit > 50 ||
              (body.cursor != null && (typeof body.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(body.cursor)))) fail(400, 'invalid_input')
          const query = new URLSearchParams({ member_generation: String(member.memberGeneration),
            subscription_revision: String(body.subscriptionRevision), limit: String(body.limit) })
          if (body.cursor) query.set('cursor', body.cursor)
          result = (await upstream(`${memberPath}/captions?${query}`)).value
          break
        }
        case '/speech-host/finish': {
          fields(body, ['workerGeneration', 'trackSid', 'sourceId', 'sourceEpoch'])
          if (!integer(body.workerGeneration) || typeof body.trackSid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.trackSid) ||
              !((body.sourceId === null && body.sourceEpoch === null) || (uuid(body.sourceId) && integer(body.sourceEpoch)))) fail(400, 'invalid_input')
          const view = await snapshot()
          const sources = view.sources?.filter(item => item.participant_id === member.participantId &&
            item.member_generation === member.memberGeneration && item.track_sid === body.trackSid)
          if (sources?.length !== 1) fail(409, body.sourceId === null ? 'not_ready' : 'stale_source')
          const source = sources[0]
          if (body.sourceId !== null && (source.id !== body.sourceId || source.epoch !== body.sourceEpoch)) fail(409, 'stale_source')
          if (!uuid(source.id) || !integer(source.epoch)) fail(409, 'stale_source')
          const response = await upstream(`${memberPath}/sources/${source.id}/finish`, { member_generation: member.memberGeneration,
            worker_generation: body.workerGeneration, source_epoch: source.epoch, track_sid: body.trackSid })
          result = response.value; status = response.status
          break
        }
        default: fail(404, 'not_found')
      }
      return Response.json(result, { status, headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return Response.json({ error: { code: error instanceof Failure ? error.code : 'unavailable' } },
        { status: error instanceof Failure ? error.status : 503, headers: { 'cache-control': 'no-store' } })
    } finally { if (owned) inFlight[owned]-- }
  }
}
