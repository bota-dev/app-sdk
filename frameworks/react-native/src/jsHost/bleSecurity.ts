import { createBlePlxPort } from './blePlx';
import type { BlePlxManager } from './blePlx';
import type { JsBlePort, JsGattValue, JsHostContext, JsHostSubscription } from './contracts';
import { createGeneratedJsCore } from './core';

/** OS bonding only. Neither method reads or returns Bluetooth keys. */
export interface BleBondingBridge {
  ensureBond(peripheralId: string, requestId: string, timeoutMs: number): Promise<void>;
  cancelBond(requestId: string): Promise<void>;
}

export interface BleLinkSecurityOptions {
  platform: string;
  /** Required on Android; iOS pairs through the protected GATT probe. */
  bonding?: BleBondingBridge | null;
  /** Bounded security deadline, separate from scan/connect deadlines. Default 60 seconds. */
  timeoutMs?: number;
}

let nextRequest = 0;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const required = () => failure('ble_security_required', 'Secure Bluetooth pairing is required before device access.');

/** BLE PLX transport with mandatory per-connection security admission. Install this
 * port in the generated runtime; it calls ensureSecure before adopting a link.
 * Unsupported firmware or missing Android native code fails without a downgrade. */
export function createSecureBlePlxPort(manager: BlePlxManager, options: BleLinkSecurityOptions): JsBlePort {
  const base = createBlePlxPort(manager);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('BLE security timeout must be between 1 and 120000 milliseconds');
  }
  type Link = { ready: boolean; cancelled: AbortController; listeners: Set<(error?: string) => void>; observer?: JsHostSubscription };
  const links = new Map<string, Link>();
  const current = (id: string | undefined, expected?: Link): Link => {
    const link = id ? links.get(id) : undefined;
    if (!link || expected && link !== expected || link.cancelled.signal.aborted) throw required();
    return link;
  };
  const admitted = (id: string | undefined) => {
    const link = current(id);
    if (!link.ready) throw required();
    return link;
  };
  const check = (context: JsHostContext, id: string, link: Link) => {
    if (context.signal.aborted) throw failure('cancelled', 'Bluetooth security request was cancelled.');
    current(id, link);
  };
  const retire = async (id: string) => {
    const link = links.get(id);
    if (!link) return;
    link.ready = false;
    link.cancelled.abort();
    link.listeners.clear();
    await link.observer?.remove();
    if (links.get(id) === link) links.delete(id);
  };
  return {
    ...base,
    async connect(id, context, mode) {
      if (!['android', 'ios'].includes(options.platform) || options.platform === 'android' &&
          (typeof options.bonding?.ensureBond !== 'function' || typeof options.bonding?.cancelBond !== 'function')) {
        throw failure('ble_security_unavailable', 'Install an app build with Bluetooth security support.');
      }
      await retire(id);
      await base.connect(id, context, mode);
      const link: Link = { ready: false, cancelled: new AbortController(), listeners: new Set() };
      links.set(id, link);
      try {
        link.observer = await base.observeDisconnect!(id, error => {
          if (links.get(id) !== link) return;
          link.ready = false;
          link.cancelled.abort();
          const listeners = Array.from(link.listeners);
          link.listeners.clear();
          for (const notify of listeners) notify(error);
        }, context);
        check(context, id, link);
      } catch (error) {
        await retire(id);
        await base.disconnect(id, { ...context, signal: new AbortController().signal });
        throw error;
      }
    },
    async observeDisconnect(id, notify, context) {
      const link = current(id);
      check(context, id, link);
      link.listeners.add(notify);
      return { async remove() { link.listeners.delete(notify); } };
    },
    async disconnect(id, context) {
      await base.disconnect(id, context);
      await retire(id);
    },
    async ensureSecure(id, context) {
      const link = current(id);
      check(context, id, link);
      // Never treat an earlier read or a retained bond as evidence for this attempt.
      link.ready = false;
      const controller = new AbortController();
      let reason: Error | undefined;
      const cancel = () => {
        reason ??= failure('cancelled', 'Bluetooth security request was cancelled.');
        controller.abort();
      };
      context.signal.addEventListener('abort', cancel, { once: true });
      link.cancelled.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        reason = failure('ble_security_timeout', 'Bluetooth pairing timed out. Retry the connection.');
        controller.abort();
      }, timeoutMs);
      const scoped = { ...context, signal: controller.signal };
      let bondRequest: string | undefined;
      let cancelBond: Promise<void> | undefined;
      const cancelNative = () => {
        if (bondRequest && !cancelBond) {
          const request = bondRequest;
          cancelBond = Promise.resolve().then(() => options.bonding!.cancelBond(request));
          void cancelBond.catch(() => {});
        }
      };
      controller.signal.addEventListener('abort', cancelNative);
      const work = async () => {
        if (options.platform === 'android') {
          bondRequest = `bota-security:${++nextRequest}`;
          await options.bonding!.ensureBond(id, bondRequest, timeoutMs);
        }
        if (controller.signal.aborted) throw reason ?? required();
        check(context, id, link);
        const core = createGeneratedJsCore();
        try {
          const metadata = core.codec('protocolMetadata', {}) as Record<string, string>;
          let value: JsGattValue;
          try {
            value = await base.read({ peripheralId: id, serviceUuid: metadata.SERVICE_BOTA_AUTH!,
              characteristicUuid: metadata.CHAR_LINK_SECURITY! }, scoped);
          } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === 'characteristic_not_found' || code === 'service_not_found') {
              throw failure('ble_security_firmware_required',
                'This device lacks Bluetooth security support. Update its firmware before connecting.');
            }
            throw error;
          }
          if (!(value instanceof Uint8Array) || core.codec('validateBleLinkSecurity', { bytes: Array.from(value) }) !== true) {
            throw required();
          }
          if (controller.signal.aborted) throw reason ?? required();
          check(context, id, link);
          link.ready = true;
        } finally { core.dispose(); }
      };
      // Join submitted native/GATT work after cancellation before releasing its owner.
      try { await work(); }
      catch (error) {
        link.ready = false;
        if (reason) throw reason;
        const code = (error as { code?: string } | null)?.code;
        if (code === 'ble_security_firmware_required') throw error;
        if (code && ['ble_pairing_rejected', 'ble_pairing_failed', 'ble_pairing_busy',
          'ble_permission_required', 'ble_security_timeout', 'ble_security_cleanup_failed', 'cancelled'].includes(code)) {
          throw failure(code, 'Bluetooth pairing did not complete.');
        }
        throw failure('ble_security_failed', 'Bluetooth security could not be established. Check pairing and firmware support.');
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', cancel);
        link.cancelled.signal.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', cancelNative);
        await cancelBond;
      }
    },
    async read(address, context) {
      const link = current(address.peripheralId);
      // The shared connection workflow verifies the public full serial before admission.
      const uuid = address.characteristicUuid.toLowerCase();
      const service = address.serviceUuid.toLowerCase();
      const publicSerial = ['180a', '0000180a-0000-1000-8000-00805f9b34fb'].includes(service) &&
        ['2a25', '00002a25-0000-1000-8000-00805f9b34fb'].includes(uuid);
      if (!publicSerial) admitted(address.peripheralId);
      const value = await base.read(address, context);
      current(address.peripheralId, link);
      return value;
    },
    async write(address, value, withResponse, context) {
      const link = admitted(address.peripheralId);
      await base.write(address, value, withResponse, context);
      current(address.peripheralId, link);
    },
    async subscribe(address, onValue, context, onError) {
      const link = admitted(address.peripheralId);
      const subscription = await base.subscribe(address, value => {
        if (links.get(address.peripheralId!) === link && link.ready && !link.cancelled.signal.aborted) onValue(value);
      }, context, error => {
        if (links.get(address.peripheralId!) === link && !link.cancelled.signal.aborted) onError?.(error);
      });
      try { current(address.peripheralId, link); return subscription; }
      catch (error) { await subscription.remove(); throw error; }
    },
  };
}
