import assert from 'node:assert/strict'
import test from 'node:test'

import { BotaSDKError, normalizeCoreError } from '../errors.ts'

interface ReachableGraph {
  objects: Set<object>
  text: string
}

function reachableGraph(root: unknown): ReachableGraph {
  const objects = new Set<object>()
  const strings: string[] = []
  const pending: unknown[] = [root]

  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') {
      strings.push(value)
      continue
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || !value) {
      continue
    }
    if (objects.has(value)) continue
    objects.add(value)
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if ('value' in descriptor) pending.push(descriptor.value)
    }
  }

  return { objects, text: strings.join('\n') }
}

test('public SDK errors never retain recursive structured secrets', () => {
  const packetBody = Uint8Array.of(0xde, 0xad, 0xbe, 0xef)
  const authorization = { value: 'Bearer private-authorization' }
  const credentials = { accessKey: 'credential-private-value' }
  const grant = { token: 'grant-private-value' }
  const receipt = { value: 'receipt-private-value' }
  const rawError = {
    code: 'DownloadFailed',
    operation: 'Upload',
    retryable: true,
    protocol_status: 503,
    detail: {
      destination: {
        url: 'https://upload.example/private?signature=secret',
        headers: { Authorization: authorization },
      },
      credentials,
      grant,
      response: { receipt, packetBody },
    },
  }

  const error = normalizeCoreError(rawError, 'unknown')

  assert.equal(error.code, 'upload_failed')
  assert.equal(error.operation, 'upload')
  assert.equal(error.retryable, true)
  assert.equal(error.protocolStatus, 503)
  assert.equal(error.cause, undefined)
  assert.equal('context' in error, false)
  const reachable = reachableGraph(error)
  for (const secretObject of [
    rawError,
    rawError.detail,
    authorization,
    credentials,
    grant,
    receipt,
    packetBody,
  ]) {
    assert.equal(reachable.objects.has(secretObject), false)
  }
  assert.doesNotMatch(
    reachable.text,
    /https:\/\/|private-authorization|credential-private|grant-private|receipt-private|signature=secret/,
  )
})

test('explicit public error causes are accepted but never retained', () => {
  const packetBody = Uint8Array.of(1, 2, 3)
  const rawCause = {
    url: 'https://upload.example/private',
    headers: { Authorization: 'Bearer private-token' },
    packetBody,
  }

  const error = new BotaSDKError('upload_failed', 'upload', {
    retryable: true,
    cause: rawCause,
  })

  assert.equal(error.code, 'upload_failed')
  assert.equal(error.operation, 'upload')
  assert.equal(error.retryable, true)
  assert.equal(error.cause, undefined)
  const reachable = reachableGraph(error)
  assert.equal(reachable.objects.has(rawCause), false)
  assert.equal(reachable.objects.has(rawCause.headers), false)
  assert.equal(reachable.objects.has(packetBody), false)
  assert.doesNotMatch(reachable.text, /https:\/\/|private-token/)
})
