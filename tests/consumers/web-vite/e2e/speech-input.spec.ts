import { expect, test } from '@playwright/test'

test('packaged original capture encrypts real worklet PCM and recovers through IndexedDB before exact receipt cleanup', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof window.__botaSpeechCaptureTest === 'function')
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  expect(await page.evaluate(() => window.__botaSpeechCaptureTest())).toEqual({
    acquisitions: 1, independent: true, audio: true, sealed: true, deleted: true, receipt: true, errors: [],
  })
})

test('external speech input preserves host mute and owns only its browser audio branch', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof window.__botaExternalSpeechTest === 'function')
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  expect(await page.evaluate(() => window.__botaExternalSpeechTest())).toEqual({
    separate: true, held: true, publication: 'TR_branch', retired: true,
    publishes: 1, disconnects: 1, hostStillLive: true, hostMuteRespected: true, hostUnmuteRespected: true,
  })
})
