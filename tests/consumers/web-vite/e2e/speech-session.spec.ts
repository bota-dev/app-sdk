import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('../../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'))
const a = fixture.grant.participant_id, b = fixture.configuration.subscription.sourceParticipantIds[0]
async function prepare(page: Page, options: { delayJoin?: boolean; denied?: boolean } = {}) {
  const calls: { action: string; role: string; body: Record<string, unknown> }[] = []
  let resolveJoin = () => {}
  const joining = new Promise<void>(resolve => { resolveJoin = resolve })
  await page.route('**/speech-host/**', async route => {
    const request = route.request(), action = request.url().split('/').at(-1)!, role = request.headers()['x-speech-role']!
    const body = request.postDataJSON(), member = role === 'b' ? b : a, peer = role === 'b' ? a : b
    calls.push({ action, role, body })
    if (options.denied) { await route.fulfill({ status: 403, json: { error: { code: 'unauthorized' } } }); return }
    const configuration = structuredClone(fixture.configuration)
    configuration.context.participantId = member
    configuration.subscription.sourceParticipantIds = [peer]
    const room = 'speech_' + createHash('sha256').update(JSON.stringify(['prj_synthetic', fixture.grant.session_id, member, 2, 3])).digest('hex')
    const grant = { ...fixture.grant, room, participant_id: member, identity: `member_${member}_2`, expires_at: new Date(Date.now() + 100_000).toISOString() }
    if (action === 'join') {
      if (options.delayJoin) await joining
      await route.fulfill({ json: { configuration, grant, role, peer: { role: role === 'a' ? 'b' : 'a', participantId: peer }, allowedLanguages: ['en', 'zh', 'ja'] } })
    } else if (action === 'subscription') {
      await route.fulfill({ json: { revision: Number(body.expectedRevision) + 1, targetLanguage: body.targetLanguage,
        mode: body.mode, sourceParticipantIds: [peer] } })
    } else if (action === 'finish') {
      await route.fulfill({ json: { source: { id: '44444444-4444-4444-8444-444444444444', epoch: 1,
        participant_id: member, member_generation: 2, track_sid: 'TR_owned', state: 'ended',
        finish: { state: 'completed', worker_generation: 3, sequence: '1', samples: '480' } } } })
    } else await route.fulfill({ json: grant })
  })
  await page.goto('/speech-check.html')
  return { calls, resolveJoin }
}
async function join(page: Page, role = 'a') {
  await page.getByLabel('Your role').selectOption(role)
  await page.getByLabel('Role access code').fill('synthetic-role-code')
  await page.getByRole('button', { name: 'Join conversation', exact: true }).click()
  await expect(page.getByTestId('connection')).toHaveText('Connected')
}
async function state(page: Page) { return page.evaluate(() => (window as any).__speechGate.state()) }

test('a real SDK consumer joins silent, keeps input and listening independent, and finishes without leaving', async ({ page }) => {
  const f = await prepare(page); await join(page)
  expect((await state(page)).capture).toBe(false)
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start listening', exact: true }).click()
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click()
  expect((await state(page)).capture).toBe(true)
  await page.getByRole('button', { name: 'Finish speaking', exact: true }).click()
  await expect(page.getByTestId('source-finish')).toHaveText('Input processing completed')
  expect((await state(page)).capture).toBe(false)
  expect(f.calls.filter(call => call.action === 'finish')).toHaveLength(1)
  await expect(page.getByTestId('connection')).toHaveText('Connected')
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  expect((await state(page)).closed).toBe(1)
  await expect(page.getByTestId('connection')).toHaveText('Not connected')
})

test('roles and receiving-language changes remain independent across two browser owners', async ({ page, context }) => {
  const other = await context.newPage(), aHost = await prepare(page), bHost = await prepare(other)
  await join(page, 'a'); await join(other, 'b')
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click()
  await page.getByLabel('Receive in').selectOption('ja')
  await page.getByRole('button', { name: 'Apply listening preference' }).click()
  await expect.poll(() => aHost.calls.filter(call => call.action === 'subscription').length).toBe(1)
  expect(bHost.calls.filter(call => call.action === 'subscription')).toHaveLength(0)
  expect((await state(page)).capture).toBe(true)
  await expect(other.getByLabel('Receive in')).toHaveValue('zh')
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  await other.getByRole('button', { name: 'Leave', exact: true }).click()
})

test('paired captions are upserted safely, stay volatile and disappear on leave', async ({ page }) => {
  await prepare(page); await join(page)
  await page.evaluate(() => (window as any).__speechGate.caption('Hello <img src=x onerror=alert(1)>', false, false))
  await page.evaluate(() => (window as any).__speechGate.caption('Hello <img src=x onerror=alert(1)>', true, false))
  await page.evaluate(() => (window as any).__speechGate.caption('你好', true, true))
  await expect(page.getByTestId('caption-pair')).toHaveCount(1)
  await expect(page.getByTestId('caption-pair')).toContainText('你好')
  await expect(page.locator('[data-testid=caption-pair] img')).toHaveCount(0)
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  await expect(page.getByTestId('caption-pair')).toHaveCount(0)
})

test('leave during authorization fences late grant and never creates media', async ({ page }) => {
  const f = await prepare(page, { delayJoin: true })
  await page.getByLabel('Role access code').fill('synthetic-role-code')
  await page.getByRole('button', { name: 'Join conversation', exact: true }).click()
  await expect.poll(() => f.calls.length).toBe(1)
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  f.resolveJoin()
  await expect(page.getByTestId('connection')).toHaveText('Not connected')
  expect((await state(page)).created).toBe(0)
})

test('authorization refusal exposes a fixed message and never opens capture', async ({ page }) => {
  await prepare(page, { denied: true })
  await page.getByLabel('Role access code').fill('synthetic-role-code')
  await page.getByRole('button', { name: 'Join conversation', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Authorization failed')
  expect((await state(page)).created).toBe(0)
})

test('uncertain native cleanup prevents a successor owner', async ({ page }) => {
  const f = await prepare(page); await join(page)
  await page.evaluate(() => (window as any).__speechGate.failCleanup())
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  await expect(page.getByTestId('connection')).toHaveText('Cleanup required')
  await expect(page.getByRole('button', { name: 'Join conversation', exact: true })).toBeDisabled()
  await expect(page.getByRole('alert')).toContainText('Audio cleanup could not be confirmed')
  expect(f.calls.filter(call => call.action === 'join')).toHaveLength(1)
})

test('normal entry loads the real vendor bundle without opening media or contacting a host', async ({ page }) => {
  const errors: string[] = [], requests: string[] = []
  page.on('pageerror', value => errors.push(value.message))
  page.on('request', value => { if (value.url().includes('/speech-host/')) requests.push(value.url()) })
  await page.goto('/speech.html')
  await expect(page.getByRole('button', { name: 'Join conversation', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start microphone', exact: true })).toBeDisabled()
  expect(errors).toEqual([]); expect(requests).toEqual([])
  expect(await page.evaluate(() => '__speechGate' in window)).toBe(false)
})

test('terminal media loss clears the view and late callbacks cannot repopulate it', async ({ page }) => {
  await prepare(page); await join(page)
  await page.evaluate(() => (window as any).__speechGate.caption('Before loss', true, false))
  await expect(page.getByTestId('caption-pair')).toHaveCount(1)
  await page.evaluate(() => (window as any).__speechGate.failMedia())
  await expect(page.getByTestId('connection')).toHaveText('Not connected')
  await page.evaluate(() => (window as any).__speechGate.caption('Late callback', true, true))
  await expect(page.getByTestId('caption-pair')).toHaveCount(0)
  expect((await state(page)).closed).toBe(1)
})
