import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecordingHost, recordingSocketOrigin } from './recording-host.mjs'

const id = '11111111-1111-4111-8111-111111111111', clockId = '22222222-2222-4222-8222-222222222222'
const platformProjectId = 'proj_0123456789ABCDEFGHIJKLMN'
function fixture(createStatus = 200, projectId = platformProjectId) {
  const calls = [], code = 'a'.repeat(40), origin = 'http://127.0.0.1:4173'
  const config = { origin, apiOrigin: 'https://api.example.invalid', apiKey: 'server-only', projectId, endUserId: 'eu_test', code }
  const host = createRecordingHost(config, { fetch: async (url, options) => {
    const body = options.body && JSON.parse(options.body); calls.push({ url, ...options, body })
    if (url.endsWith('/captures')) return Response.json({ capture_id: clockId, recording_id: 'rec_test' })
    if (url.endsWith('/grant')) return Response.json({ activity_id: id, project_id: config.projectId, url: 'wss://api.example.invalid/v1/recording-speech/ws', token: 'one-use' })
    if (url.endsWith('/recording-speech')) return Response.json({ activity: { ...body, expires_at: '2099-01-01T00:00:00Z' } }, { status: createStatus })
    return Response.json({ state: 'published' })
  } })
  const request = (action, body, headers = {}) => host(new Request(`${origin}/recording-host/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-recording-code': code, ...headers }, body: JSON.stringify(body) }))
  return { request, calls }
}
test('returns the fixed Platform or legacy project ID unchanged and rejects malformed IDs', async () => {
  for (const id of [platformProjectId, 'prj_test']) {
    const { request } = fixture(200, id)
    const response = await request('context', {})
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).scope, JSON.stringify([id, 'eu_test']))
  }
  for (const id of ['proj_', 'proj_a/b', 'org_0123456789ABCDEFGHIJKLMN']) {
    assert.throws(() => fixture(200, id), /Invalid recording lab configuration/)
  }
})
const input = { realtimeTranscription: true, activityId: id, clockId, captureId: clockId, retention: 'original_audio_and_text', targetLanguage: 'zh', sourceLanguage: 'multi' }
test('passes opaque model choices and catalog revision to admission without exposing credentials', async () => {
  const f = fixture(), models = { asr: 'asr_deepgram_nova3', translation: 'mt_amazon_translate', tts: 'tts_elevenlabs_flash25' }
  const response = await f.request('start', { ...input, models, modelCatalogRevision: 'catalog_revision' })
  assert.equal(response.status, 200)
  assert.deepEqual(f.calls[1].body.models, models)
  assert.equal(f.calls[1].body.model_catalog_revision, 'catalog_revision')
  assert.ok(!JSON.stringify(await response.json()).includes('server-only'))
})
test('model catalog reads are fixed to the host owner and never create an activity', async () => {
  const f = fixture()
  assert.equal((await f.request('models', {})).status, 200)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'GET')
  assert.ok(f.calls[0].url.endsWith('/models?end_user_id=eu_test'))
  assert.equal((await f.request('models', { projectId: 'foreign' })).status, 400)
})
test('failed or uncertain creation never authorizes a grant or end against an existing foreign activity', async () => {
  for (const status of [409, 503]) {
    const f = fixture(status)
    assert.equal((await f.request('start', { ...input, retention: 'text_only', captureId: undefined })).status, status)
    assert.equal((await f.request('grant', { activityId: id })).status, 403)
    assert.equal((await f.request('end', { activityId: id })).status, 403)
    assert.equal((await f.request('start', input)).status, 409)
    assert.equal(f.calls.length, 1)
  }
})
test('admission binds one owner, original recording and physical clock; only a scoped grant leaves the host', async () => {
  const f = fixture(), response = await f.request('start', input), value = await response.json()
  assert.equal(response.status, 200)
  assert.equal(value.configuration.activityId, id)
  assert.equal(value.prepared.recording_id, 'rec_test')
  assert.equal(value.clockId, clockId)
  assert.ok(!JSON.stringify(value).includes('server-only'))
  assert.deepEqual(f.calls[1].body.sources, [{ id: 'microphone', epoch: 1, role: 'mixed', speaker: 'unknown', language: 'multi', startSample: 0, captureClockId: clockId }])
  assert.equal(f.calls[1].body.end_user_id, 'eu_test')
  assert.equal(f.calls[1].body.recording_id, 'rec_test')
  assert.ok(f.calls.every(call => call.redirect === 'error' && call.headers.authorization === 'Bearer server-only'))
})
test('text-only creates no original; foreign activities, identity overrides and origins never dispatch', async () => {
  const f = fixture()
  assert.equal((await f.request('grant', { activityId: id })).status, 403)
  assert.equal((await f.request('start', { ...input, end_user_id: 'eu_foreign' })).status, 400)
  assert.equal((await f.request('start', input, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.request('start', { ...input, captureId: undefined, retention: 'text_only' })).status, 200)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].body.recording_id, undefined)
  assert.equal((await f.request('grant', { activityId: id })).status, 200)
})
test('archive operations retain the fixed owner independently of the live connection', async () => {
  const f = fixture(), packet = { nonce: 'a'.repeat(16), ciphertext: 'b'.repeat(40), header: {} }
  assert.equal((await f.request('capture_chunk', { captureId: clockId, packet })).status, 200)
  assert.deepEqual(f.calls[0].body, { end_user_id: 'eu_test', packet })
  assert.equal((await f.request('capture_chunk', { captureId: '../foreign', packet })).status, 400)
  assert.equal((await f.request('capture_transcript', { captureId: clockId, afterSegment: 20, resultSha256: 'a'.repeat(64) })).status, 200)
  assert.ok(f.calls.at(-1).url.includes('end_user_id=eu_test'))
  assert.ok(f.calls.at(-1).url.includes('after_segment=20'))
})

test('pins each Bota API to its own Platform socket and keeps custom origins isolated', () => {
  assert.equal(recordingSocketOrigin('https://api.dev.bota.dev'), 'wss://platform.dev.bota.dev')
  assert.equal(recordingSocketOrigin('https://api.gamma.bota.dev'), 'wss://platform.gamma.bota.dev')
  assert.equal(recordingSocketOrigin('https://api.bota.dev'), 'wss://platform.bota.dev')
  assert.equal(recordingSocketOrigin('https://api.bota.dev.example.invalid'), 'wss://api.bota.dev.example.invalid')
  assert.equal(recordingSocketOrigin('https://api.example.invalid'), 'wss://api.example.invalid')
})

test('archive-only preparation creates no activity or grant; live start requires explicit opt-in', async () => {
  const f = fixture()
  for (const realtimeTranscription of [false, undefined]) {
    assert.equal((await f.request('start', { ...input, realtimeTranscription })).status, 400)
  }
  assert.equal(f.calls.length, 0)
  const result = await f.request('capture_prepare', { captureId: clockId })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).prepared.capture_id, clockId)
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].url.endsWith('/captures'))
  assert.equal((await f.request('grant', { activityId: id })).status, 403)
})
