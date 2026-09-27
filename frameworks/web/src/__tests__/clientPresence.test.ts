import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ConnectionClientPresence } from '../clientPresence.ts'

test('client presence follows the shared passive lifecycle fixtures without HTTP', async t => {
  const fixture = JSON.parse(await readFile(new URL('../../../../protocol/client-presence/v1.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('metadata must not fetch') })
  let next = 0
  const owner = new ConnectionClientPresence(() => fixture.sessions[next++])
  const disconnects = new Map<string, () => void>()
  for (const step of fixture.steps) {
    if (step.action === 'verified_connect') disconnects.set(step.connection, owner.connected(step.device_id))
    else if (step.action === 'disconnect') disconnects.get(step.connection)!()
    else if (step.action === 'destroy') owner.destroy()
    else {
      const report = await owner.nextReport(step.device_id)
      if (step.expected === null) assert.equal(report, null)
      else {
        assert.deepEqual(report, {
          schema_version: 1, platform: 'web', sdk_package: '@bota.dev/web-app-sdk',
          sdk_version: pkg.version, session_id: fixture.sessions[step.expected.session],
          sequence: step.expected.sequence,
        })
      }
    }
  }
  assert.equal(fetch.mock.callCount(), 0)
})
