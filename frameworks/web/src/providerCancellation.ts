import { BotaSDKError, type BotaOperation } from './errors.ts'

type ProviderOutcome<T> =
  | { kind: 'fulfilled'; value: T }
  | { kind: 'rejected'; error: unknown }

export async function awaitProviderCall<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  operation: BotaOperation,
): Promise<T> {
  const observed = promise.then<ProviderOutcome<T>, ProviderOutcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (error: unknown) => ({ kind: 'rejected', error }),
  )

  let cancel!: () => void
  const cancelled = new Promise<ProviderOutcome<T>>((resolve) => {
    cancel = () => resolve({
      kind: 'rejected',
      error: new BotaSDKError('cancelled', operation),
    })
  })
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    const outcome = await Promise.race([observed, cancelled])
    if (outcome.kind === 'rejected') throw outcome.error
    return outcome.value
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
