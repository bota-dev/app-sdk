import type { BluetoothState } from '../models/Status';
import type { CompatibilityBluetoothState } from '../compatibility/bluetoothState';
import type { BotaJsHostPorts, JsHostContext, JsHostSubscription, RawJsCoreFactory } from './contracts';
import { BotaJsHostError } from './executor';

/** Captured OS observations only; shared Rust normalizes the public states. */
export function createJsBluetoothState(core: Pick<RawJsCoreFactory, 'codec'>, ports: BotaJsHostPorts,
  onCleanupFailure: (error: unknown) => void): CompatibilityBluetoothState & { dispose(): Promise<void> } {
  const namespace = ports.persistence.namespace;
  const scopeSignal = ports.signal;
  const checkScope = ports.checkScope;
  const controller = new AbortController();
  const abort = () => controller.abort();
  scopeSignal?.addEventListener('abort', abort, { once: true });
  if (scopeSignal?.aborted) abort();
  const context: JsHostContext = Object.freeze({ operation: 'BluetoothState', operationId: 'runtime-bluetooth',
    requestId: '0', generation: '0', cancellationId: '', signal: controller.signal });
  const listeners = new Set<(state: BluetoothState) => void>();
  const pending = new Set<Promise<BluetoothState>>();
  let state: BluetoothState = 'unknown';
  let revision = 0;
  let closed = false;
  let invalidated = false;
  let observer: JsHostSubscription | undefined;
  let starting: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const check = () => {
    if (closed || invalidated || context.signal.aborted || ports.persistence.namespace !== namespace) {
      invalidated = true; controller.abort();
      throw new BotaJsHostError('scope_changed', 'BluetoothState');
    }
    try { checkScope?.(); }
    catch { invalidated = true; controller.abort(); throw new BotaJsHostError('scope_changed', 'BluetoothState'); }
  };
  const publish = (value: BluetoothState) => {
    state = value; revision++;
    for (const listener of listeners) { try { listener(state); } catch {} }
  };
  const normalize = (value: string): BluetoothState => core.codec('normalizeBluetoothState', { state: value }) as BluetoothState;
  const start = () => starting ??= (async () => {
    check();
    if (ports.ble.observeBluetoothState) observer = await ports.ble.observeBluetoothState(value => {
      try { check(); publish(normalize(value)); } catch {}
    }, context, onCleanupFailure);
    check();
  })();
  return {
    read() {
      const work = (async () => {
        check(); await start(); check();
        if (!ports.ble.readBluetoothState) return state;
        const before = revision;
        const value = await ports.ble.readBluetoothState(context);
        check();
        if (before === revision) publish(normalize(value));
        return state;
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    watch(listener) {
      check(); listeners.add(listener); listener(state);
      return { remove() { listeners.delete(listener); } };
    },
    dispose() {
      if (!disposal) {
        closed = true; controller.abort(); publish('unknown');
        disposal = (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          try { await observer?.remove(); }
          catch (error) { onCleanupFailure(error); throw error; }
          finally { listeners.clear(); scopeSignal?.removeEventListener('abort', abort); }
        })();
      }
      return disposal;
    },
  };
}
