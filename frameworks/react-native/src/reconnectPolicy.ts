import { BotaRuntimeCompatibilityError } from './runtimeAdapter';

export interface BotaReconnectPolicy {
  /** Foreground retries only. Native transport/background scheduling remains platform-owned. */
  maxAttempts?: number;
  delayMs?: number;
}

export function normalizeReconnectPolicy(policy: BotaReconnectPolicy = {}): Required<BotaReconnectPolicy> {
  const maxAttempts = policy.maxAttempts ?? 1;
  const delayMs = policy.delayMs ?? 3000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
    !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('Invalid foreground reconnect policy');
  }
  return { maxAttempts, delayMs };
}

export async function reconnectWithPolicy<T>(
  attempt: () => Promise<T>, policy: Required<BotaReconnectPolicy>, signal: AbortSignal,
): Promise<T> {
  for (let index = 0; ; index++) {
    if (signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'reconnect');
    try {
      const result = await attempt();
      if (signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'reconnect');
      return result;
    } catch (error) {
      if (signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'reconnect');
      if (index + 1 >= policy.maxAttempts || !error ||
        typeof error !== 'object' || !('retryable' in error) || error.retryable !== true) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(new BotaRuntimeCompatibilityError('operation_cancelled', 'reconnect'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, policy.delayMs);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
}
