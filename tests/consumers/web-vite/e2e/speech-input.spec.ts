import { expect, test } from '@playwright/test'

test('external speech input preserves host mute and owns only its browser audio branch', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof window.__botaExternalSpeechTest === 'function')
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  expect(await page.evaluate(() => window.__botaExternalSpeechTest())).toEqual({
    separate: true, held: true, publication: 'TR_branch', retired: true,
    publishes: 1, disconnects: 1, hostStillLive: true, hostMuteRespected: true, hostUnmuteRespected: true,
  })
})
