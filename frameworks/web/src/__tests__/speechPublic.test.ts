import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWebSpeechSession } from '../speech.ts'

test('the optional Web entry executes actual WASM and keeps device SDK imports independent', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'))
  const wasm = await readFile(new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url))
  let capture = false
  const session = await createWebSpeechSession({
    configuration: fixture.configuration,
    grant: { ...fixture.grant, expires_at: new Date(Date.now() + 60_000).toISOString() },
    wasm,
    host: { renewGrant: async () => { throw Error('unused') }, changeSubscription: async () => { throw Error('unused') } },
    mediaFactory: () => ({ async connect() {}, silencePlayback() {}, muteMicrophone() { capture = false },
      async clearPlayback() {}, async setPlayback() {}, async setMicrophone(enabled) { capture = enabled }, async close() {} }),
  })
  try {
    await session.ready
    assert.equal(session.state.canCapture, false)
    await session.setMicrophone(true)
    assert.equal(session.state.canCapture, true)
    assert.equal(capture, true)
    await session.setListening(false)
    assert.equal(capture, true)
  } finally { await session.close() }
  assert.equal(capture, false)
})
