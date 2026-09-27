import type { CoreBridge } from './core.ts'
import { BotaSDKError } from './errors.ts'
import { awaitProviderCall } from './providerCancellation.ts'

export interface UploadContextExchange {
  challenge: Uint8Array
  exchangeProof(proof: Uint8Array, signal: AbortSignal): Promise<Uint8Array>
}
interface ContextIO {
  begin(bytes: Uint8Array): Promise<void>
  read(): Promise<Uint8Array>
  sendDocument(kind: 3 | 4, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  uncertain(): void
}

/** Transport/lifecycle only: all context frame validation stays in Rust. */
export async function exchangeUploadContext(
  core: CoreBridge, io: ContextIO,
  prepare: (nonce: Uint8Array, signal: AbortSignal) => Promise<UploadContextExchange>,
  attemptId: number, signal: AbortSignal,
): Promise<void> {
  const deadline = new AbortController()
  const active = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), 30_000)
  const held: Uint8Array[] = []
  const check = () => { if (active.aborted) throw new BotaSDKError('cancelled', 'transfer_recording') }
  async function ioStep<T>(operation: () => Promise<T>): Promise<T> {
    check()
    let settled = false
    const pending = Promise.resolve().then(() => { check(); return operation() }).finally(() => { settled = true })
    try { return await awaitProviderCall(pending, active, 'transfer_recording') }
    finally { if (active.aborted && !settled) io.uncertain() }
  }
  async function waitFor(state: number): Promise<Uint8Array> {
    for (;;) {
      const raw = await ioStep(() => io.read())
      let value
      try { value = core.decodeUploadContextSnapshot(raw) } finally { raw.fill(0) }
      if (value.attemptId === attemptId) {
        if (value.state === 4 || value.state > state) {
          value.payload.fill(0)
          throw new BotaSDKError('protocol_error', 'transfer_recording')
        }
        if (value.state === state) { held.push(value.payload); return value.payload }
      }
      value.payload.fill(0)
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(poll); active.removeEventListener('abort', done); resolve() }
        const poll = setTimeout(done, 150)
        active.addEventListener('abort', done, { once: true })
        if (active.aborted) done()
      })
    }
  }
  try {
    await ioStep(() => io.begin(core.encodeUploadContextBegin(attemptId)))
    const nonce = await waitFor(1)
    const pending = prepare(nonce, active)
    const exchange = await awaitProviderCall(pending, active, 'transfer_recording').catch(error => {
      void pending.then(late => late.challenge?.fill(0)).catch(() => undefined)
      throw error
    })
    held.push(exchange.challenge)
    core.validateUploadContextDocument(3, exchange.challenge)
    await ioStep(() => io.sendDocument(3, exchange.challenge, active))
    const proof = await waitFor(2)
    const resultPromise = exchange.exchangeProof(proof, active)
    const result = await awaitProviderCall(resultPromise, active, 'transfer_recording').catch(error => {
      void resultPromise.then(late => late.fill(0)).catch(() => undefined)
      throw error
    })
    held.push(result)
    core.validateUploadContextDocument(4, result)
    await ioStep(() => io.sendDocument(4, result, active))
    await waitFor(3)
  } finally {
    clearTimeout(timer)
    deadline.abort()
    for (const value of held) value.fill(0)
  }
}
