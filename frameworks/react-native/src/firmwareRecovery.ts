import type { Spec, NativeConnectedDevice, NativeFirmwareImage, NativeFirmwareUpdateProgress } from './specs/NativeBotaDeviceSDK';
import { BotaRuntimeCompatibilityError } from './runtimeAdapter';
// React Native's setup and portable JavaScript hosts provide performance.now().
declare const performance: { now(): number };

export interface BotaFirmwareRecoveryPolicy {
  /** Entire post-verification budget, including time already spent in native recovery. */
  timeoutMs?: number;
  delayMs?: number;
}

export function normalizeFirmwareRecoveryPolicy(policy: BotaFirmwareRecoveryPolicy = {}) {
  const timeoutMs = policy.timeoutMs ?? 120_000;
  const delayMs = policy.delayMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > timeoutMs) {
    throw new Error('Invalid firmware recovery policy');
  }
  return { timeoutMs, delayMs };
}

export interface FirmwareRecoveryOwner {
  signal: AbortSignal;
  recovering: boolean;
}

async function wait(delay: number, signal: AbortSignal) {
  if (signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware'));
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Read-back recovery only: never retransmit bytes, reissue verification or authorize cleanup. */
export async function updateFirmwareWithRecovery(
  module: Spec, device: NativeConnectedDevice, image: NativeFirmwareImage,
  progress: (event: NativeFirmwareUpdateProgress) => void,
  owner: FirmwareRecoveryOwner, policy: ReturnType<typeof normalizeFirmwareRecoveryPolicy>,
) {
  // Legacy progress events have no native timestamp. A delayed bridge callback
  // must not extend the native recovery window, so use an operation-start cap.
  const requestDeadline = performance.now() + policy.timeoutMs;
  let verifiedAt: number | undefined;
  let phase: string | undefined;
  let subscribed = true;
  const subscription = module.onFirmwareUpdateProgress(event => {
    phase = event.phase;
    // The native contract emits these only after image verification succeeds.
    if (verifiedAt === undefined && (phase === 'rebooting' || phase === 'reconnecting')) {
      verifiedAt = performance.now();
    }
    if (!owner.signal.aborted) progress(event);
  });
  const removeSubscription = () => { if (subscribed) { subscribed = false; subscription.remove(); } };
  try {
    if (owner.signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
    try {
      await module.updateFirmware(device, image);
      if (owner.signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
      return;
    } catch (failure) {
      removeSubscription();
      if (owner.signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
      if (verifiedAt === undefined || (phase !== 'rebooting' && phase !== 'reconnecting')) throw failure;
      if (failure && typeof failure === 'object' && 'retryable' in failure && failure.retryable === false) throw failure;
      const deadline = Math.min(requestDeadline, verifiedAt + policy.timeoutMs);
      owner.recovering = true;
      while (performance.now() < deadline) {
        await wait(Math.min(policy.delayMs, Math.max(0, deadline - performance.now())), owner.signal);
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 2) break;
        progress({ phase: 'reconnecting', completedUnits: image.sizeUnits, totalUnits: image.sizeUnits });
        let connected: NativeConnectedDevice;
        try {
          connected = await module.reconnect(device.serialNumber, {
            scanTimeoutMs: Math.max(1, Math.min(5000, Math.floor(remaining / 3))),
            connectionTimeoutMs: Math.max(1, Math.min(10_000, remaining - Math.min(5000, Math.floor(remaining / 3)))),
          });
        } catch (error) {
          if (owner.signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
          if (error instanceof BotaRuntimeCompatibilityError ||
            (error && typeof error === 'object' && 'retryable' in error && error.retryable === false)) throw error;
          continue;
        }
        if (owner.signal.aborted) throw new BotaRuntimeCompatibilityError('operation_cancelled', 'updateFirmware');
        if (performance.now() >= deadline) throw failure;
        if (connected.serialNumber !== device.serialNumber) {
          await module.disconnect();
          throw new BotaRuntimeCompatibilityError('device_identity_mismatch', 'updateFirmware');
        }
        if (connected.firmwareVersion !== image.version) {
          throw new BotaRuntimeCompatibilityError('firmware_version_mismatch', 'updateFirmware');
        }
        progress({ phase: 'complete', completedUnits: image.sizeUnits, totalUnits: image.sizeUnits });
        return;
      }
      throw failure;
    }
  } finally {
    owner.recovering = false;
    removeSubscription();
  }
}
