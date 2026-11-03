import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpeechHost } from './speech-host.mjs'
import { startSpeechLab } from './serve-speech.mjs'

const sessionId = '11111111-1111-4111-8111-111111111111'
const a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const code = 'a'.repeat(40)
function fixture(overrides = {}) {
  const calls = []
  const view = {
    session: { id: sessionId, state: 'active', retention: 'live_only', allowed_languages: ['en', 'zh', 'ja'], rtc_ready: true },
    participants: [a, b].map(id => ({ id, generation: 2, state: 'active', source_kind: 'host_microphone',
      can_publish: true, can_subscribe: true, expires_at: '2099-01-01T00:00:00Z' })),
    subscriptions: [a, b].map(id => ({ participant_id: id, member_generation: 2, revision: 3,
      target_language: 'zh', mode: 'translated', source_participant_ids: [id === a ? b : a] })),
    sources: [{ id: sourceId, participant_id: a, member_generation: 2, epoch: 4, track_sid: 'TR_owned', state: 'active' }],
  }
  const grant = { protocol_version: 1, session_id: sessionId, participant_id: a, member_generation: 2,
    worker_generation: 3, provider: 'livekit', url: 'wss://synthetic.livekit.cloud', token: 'scoped-only',
    room: 'synthetic-room', identity: 'synthetic-member', processor_identity: 'synthetic-worker', expires_at: '2099-01-01T00:00:00Z' }
  const config = { origin: 'http://127.0.0.1:4173', apiOrigin: 'https://api.example.invalid', apiKey: 'server-only-key',
    projectId: 'prj_synthetic', sessionId, roles: { a: { participantId: a, memberGeneration: 2, code },
      b: { participantId: b, memberGeneration: 2, code: 'b'.repeat(40) } } }
  const upstream = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null })
    if (overrides.fetch) return overrides.fetch(url, init)
    if (String(url).endsWith('/grant')) return Response.json(grant)
    if (String(url).endsWith('/subscription')) return Response.json({ subscription: { ...view.subscriptions[0], revision: 4,
      target_language: 'ja' } })
    if (String(url).endsWith('/finish')) return Response.json({ source: view.sources[0] }, { status: 202 })
    if (String(url).includes('/captions?')) return Response.json({ history: 'unavailable', records: [] })
    return Response.json(view)
  }
  const handler = createSpeechHost(config, { fetch: upstream })
  const request = (action = 'join', body = {}, headers = {}) => handler(new Request(`${config.origin}/speech-host/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: config.origin,
      'x-speech-role': 'a', 'x-speech-code': code, ...headers }, body: JSON.stringify(body),
  }))
  return { request, calls, view, grant, config, handler, upstream }
}

test('role join uses server identity and sends only the scoped grant to the browser', async () => {
  const f = fixture(), response = await f.request(), body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(body.configuration.context.participantId, a)
  assert.deepEqual(body.configuration.subscription.sourceParticipantIds, [b])
  assert.equal(body.grant.token, 'scoped-only')
  assert.ok(!JSON.stringify(body).includes('server-only-key'))
  assert.equal(f.calls[1].init.headers.authorization, 'Bearer server-only-key')
  assert.deepEqual(f.calls[1].body, { member_generation: 2 })
})

test('wrong role credentials, cross-origin calls and browser identity overrides never reach Bota', async () => {
  const f = fixture()
  assert.equal((await f.request('join', {}, { 'x-speech-code': 'wrong' })).status, 403)
  assert.equal((await f.request('join', {}, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await f.request('join', { participantId: b })).status, 400)
  assert.equal((await f.handler(new Request('http://attacker.invalid/speech-host/join', { method: 'POST' }))).status, 403)
  assert.equal(f.calls.length, 0)
})

test('unsupported original archival, external sources and replaced members fail before grant or capture', async () => {
  for (const modify of [f => { f.view.session.retention = 'original_audio_and_text' },
    f => { f.view.participants[0].generation++ }, f => { f.view.participants[0].source_kind = 'host_external' }]) {
    const f = fixture(); modify(f)
    assert.equal((await f.request()).status, 409)
    assert.equal(f.calls.length, 1)
  }
})

test('language updates retain the caller revision and only select the other authorized role', async () => {
  const f = fixture()
  const response = await f.request('subscription', { expectedRevision: 3, targetLanguage: 'ja', mode: 'translated' })
  assert.equal(response.status, 200)
  assert.deepEqual(f.calls.at(-1).body, { member_generation: 2, expected_revision: 3,
    target_language: 'ja', mode: 'translated', source_participant_ids: [b] })
  assert.equal(f.calls.at(-1).init.method, 'PUT')
  assert.equal(f.calls.at(-1).init.redirect, 'error')
  assert.equal((await f.request('subscription', { expectedRevision: 3, targetLanguage: 'ja', mode: 'translated', sourceParticipantIds: [a] })).status, 400)
})

test('source finish resolves only the exact owned publication and preserves the pinned epoch', async () => {
  const f = fixture()
  const finish = { workerGeneration: 3, trackSid: 'TR_owned', sourceId: null, sourceEpoch: null }
  assert.equal((await f.request('finish', finish)).status, 202)
  assert.ok(f.calls.at(-1).url.endsWith(`/participants/${a}/sources/${sourceId}/finish`))
  assert.deepEqual(f.calls.at(-1).body, { member_generation: 2, worker_generation: 3, source_epoch: 4, track_sid: 'TR_owned' })
  assert.equal((await f.request('finish', { ...finish, trackSid: 'TR_foreign' })).status, 409)
  assert.equal((await f.request('finish', { ...finish, sourceId, sourceEpoch: 3 })).status, 409)
  assert.equal(f.calls.filter(call => call.url.endsWith('/finish')).length, 1)
})

test('another role leaving cannot block this owner from renewing or finishing accepted input', async () => {
  const f = fixture(); f.view.participants[1].state = 'revoked'
  assert.equal((await f.request('grant')).status, 200)
  assert.equal((await f.request('finish', { workerGeneration: 3, trackSid: 'TR_owned', sourceId: null, sourceEpoch: null })).status, 202)
  assert.equal((await f.request('join')).status, 409)
})

test('upstream conflicts are not retried and raw vendor or credential errors are never returned', async () => {
  const f = fixture({ fetch: async () => Response.json({ error: { code: 'speech_session_conflict', message: 'server-only-key' } }, { status: 409 }) })
  const result = await f.request()
  assert.equal(result.status, 409)
  assert.deepEqual(await result.json(), { error: { code: 'conflict' } })
  assert.equal(f.calls.length, 1)
  const failed = fixture({ fetch: async () => { throw Error('server-only-key') } })
  assert.deepEqual(await (await failed.request()).json(), { error: { code: 'unavailable' } })
})

test('caption proxy pins the member and forwards only bounded recovery fields', async () => {
  const f = fixture()
  const response = await f.request('captions', { subscriptionRevision: 3, limit: 8, cursor: 'opaque_cursor' })
  assert.equal(response.status, 200)
  const url = new URL(f.calls.at(-1).url)
  assert.equal(url.pathname, `/v1/speech-sessions/${sessionId}/participants/${a}/captions`)
  assert.equal(url.searchParams.get('member_generation'), '2')
  assert.equal(url.searchParams.get('cursor'), 'opaque_cursor')
  assert.equal((await f.request('captions', { subscriptionRevision: 3, limit: 51, cursor: null })).status, 400)
})

test('malformed or oversized input is rejected before upstream IO', async () => {
  const f = fixture()
  for (const [body, expected] of [['{', 400], [JSON.stringify({ value: 'x'.repeat(8192) }), 413]]) {
    const response = await f.handler(new Request(`${f.config.origin}/speech-host/join`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-speech-role': 'a', 'x-speech-code': code }, body }))
    assert.equal(response.status, expected)
  }
  assert.equal(f.calls.length, 0)
})

test('cancelled requests abort upstream IO and release bounded admission', async () => {
  const signals = []
  const f = fixture({ fetch: async (_, init) => new Promise((_, reject) => {
    signals.push(init.signal)
    init.signal.addEventListener('abort', () => reject(Error('private upstream failure')), { once: true })
  }) })
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const pending = controllers.map(controller => f.handler(new Request(`${f.config.origin}/speech-host/join`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-speech-role': 'a', 'x-speech-code': code },
    body: '{}', signal: controller.signal,
  })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signals.length, 4)
  assert.equal((await f.request()).status, 429)
  controllers.forEach(controller => controller.abort())
  for (const response of await Promise.all(pending)) assert.deepEqual(await response.json(), { error: { code: 'unavailable' } })
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal((await f.request('join', { invalid: true })).status, 400)
})

test('configuration refuses shared role credentials and non-loopback cleartext upstreams', () => {
  const { config } = fixture()
  assert.throws(() => createSpeechHost({ ...config, apiOrigin: 'http://foreign.invalid' }))
  assert.throws(() => createSpeechHost({ ...config, origin: 'http://0.0.0.0:4173' }))
  config.roles.b.code = config.roles.a.code
  assert.throws(() => createSpeechHost(config))
})

test('loopback server composes static isolation and real HTTP role authorization', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'bota-speech-lab-'))
  let lab
  try {
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'speech.html'), '<h1>Conversation lab</h1>')
    await writeFile(join(directory, 'speech-check.html'), '<h1>Synthetic harness</h1>')
    await writeFile(join(directory, 'assets', 'speech-check-seed.js'), 'synthetic')
    lab = await startSpeechLab(f.config, { directory, port: 0, fetch: f.upstream })
    const page = await fetch(lab.origin)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Conversation lab/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal((await fetch(`${lab.origin}/speech-check.html`)).status, 404)
    assert.equal((await fetch(`${lab.origin}/assets/speech-check-seed.js`)).status, 404)
    const result = await fetch(`${lab.origin}/speech-host/join`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-speech-role': 'a', 'x-speech-code': code, origin: lab.origin }, body: '{}' })
    assert.equal(result.status, 200)
    assert.equal((await result.json()).configuration.context.participantId, a)
  } finally { await lab?.close(); await rm(directory, { recursive: true, force: true }) }
})
