import { Buffer } from 'buffer';
import type { JsBlePort, JsHostCandidate, JsHostContext, JsHostSubscription } from './contracts';
import { createGeneratedJsCore } from './core';

interface Subscription { remove(): void | Promise<void> }
interface Characteristic { value?: string | null }
interface Peripheral {
  id: string;
  name: string | null;
  localName?: string | null;
  rssi: number | null;
  mtu: number;
  discoverAllServicesAndCharacteristics(): Promise<Peripheral>;
}
/** Structural subset of react-native-ble-plx. The host owns permissions and manager lifetime. */
export interface BlePlxManager {
  state?(): Promise<string>;
  onStateChange?(listener: (state: string) => void, emitCurrentState?: boolean): Subscription;
  startDeviceScan(uuids: string[] | null, options: { allowDuplicates: boolean },
    listener: (error: Error | null, device: Peripheral | null) => void): void | Promise<void>;
  stopDeviceScan(): void | Promise<void>;
  connectToDevice(id: string, options?: { requestMTU?: number }): Promise<Peripheral>;
  cancelDeviceConnection(id: string): Promise<Peripheral>;
  devices(ids: string[]): Promise<Peripheral[]>;
  readCharacteristicForDevice(id: string, service: string, characteristic: string,
    transactionId?: string): Promise<Characteristic>;
  writeCharacteristicWithResponseForDevice(id: string, service: string, characteristic: string,
    base64: string, transactionId?: string): Promise<Characteristic>;
  writeCharacteristicWithoutResponseForDevice(id: string, service: string, characteristic: string,
    base64: string, transactionId?: string): Promise<Characteristic>;
  monitorCharacteristicForDevice(id: string, service: string, characteristic: string,
    listener: (error: Error | null, value: Characteristic | null) => void,
    transactionId?: string): Subscription;
  onDeviceDisconnected(id: string, listener: (error: Error | null, device: Peripheral | null) => void): Subscription;
  cancelTransaction(transactionId: string): void | Promise<void>;
}

/** JS OS integration through an installed BLE library; contains no Bota packet formats. */
export function createBlePlxPort(manager: BlePlxManager): JsBlePort {
  const policy = (() => {
    const core = createGeneratedJsCore();
    try {
      return core.codec('protocolMetadata', {}) as { DEFAULT_MTU: number; MAX_MTU: number;
        mtuObservationAttempts: number; mtuObservationDelayMs: number };
    } finally { core.dispose(); }
  })();
  let scan: JsHostSubscription | undefined;
  const connected = new Map<string, Peripheral>();
  const connectionGenerations = new Map<string, bigint>();
  let connectionGeneration = 0n;
  const uncertainConnections = new Set<string>();
  const id = (value: string | undefined): string => {
    if (!value) throw new Error('GATT call requires a captured peripheral ID');
    return value;
  };
  const check = (context: JsHostContext) => {
    if (context.signal.aborted) throw Object.assign(new Error('BLE operation cancelled'), { code: 'cancelled' });
  };
  const cleanupFailure = (cause: unknown) => Object.assign(new Error('BLE cleanup incomplete'), {
    code: 'cleanup_incomplete', cause,
  });
  let transaction = 0;
  const oneShot = async <T>(context: JsHostContext, body: (transactionId: string) => Promise<T>): Promise<T> => {
    check(context);
    const transactionId = `bota:${context.generation}:${context.requestId}:${++transaction}`;
    let cancellation: Promise<void> | undefined;
    let cancellationFailed = false;
    let cancellationError: unknown;
    const abort = () => {
      cancellation ??= Promise.resolve().then(() => manager.cancelTransaction(transactionId)).then(
        () => {}, error => { cancellationFailed = true; cancellationError = error; });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await body(transactionId);
      check(context);
      return result;
    } finally {
      context.signal.removeEventListener('abort', abort);
      // A failed cancel cannot escape the listener or release this submitted IO.
      await cancellation;
      if (cancellationFailed) throw cleanupFailure(cancellationError);
    }
  };
  return {
    ...(manager.state ? { async readBluetoothState(context: JsHostContext) {
      check(context); const value = await manager.state!(); check(context); return value;
    } } : {}),
    ...(manager.onStateChange ? { async observeBluetoothState(onState: (state: string) => void,
      context: JsHostContext, onError?: (error: unknown) => void): Promise<JsHostSubscription> {
      check(context);
      let active = true, removed = false;
      let removal: Promise<void> | undefined;
      const subscription = manager.onStateChange!(value => {
        if (active && !context.signal.aborted) onState(value);
      }, false);
      const remove = () => {
        if (removed) return Promise.resolve();
        active = false; context.signal.removeEventListener('abort', abort);
        removal ??= Promise.resolve().then(() => subscription.remove()).then(
          () => { removed = true; }, error => { removal = undefined; throw cleanupFailure(error); });
        return removal;
      };
      const abort = () => { void remove().catch(error => { try { onError?.(error); } catch {} }); };
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) await remove();
      return { remove };
    } } : {}),
    async scan(allowDuplicates, onCandidate, context, onError) {
      check(context);
      if (scan) throw new Error('A BLE scan already owns this port');
      let active = true;
      let removed = false;
      let startup: Promise<void> | undefined;
      let removal: Promise<void> | undefined;
      const subscription: JsHostSubscription = { remove() {
        if (removed) return Promise.resolve();
        active = false;
        context.signal.removeEventListener('abort', abort);
        removal ??= (async () => {
          await startup?.catch(() => {});
          try { await manager.stopDeviceScan(); } catch (error) { throw cleanupFailure(error); }
          removed = true;
          if (scan === subscription) scan = undefined;
        })().catch(error => { removal = undefined; throw error; });
        return removal;
      } };
      const abort = () => { void subscription.remove().catch(error => { try { onError?.(error); } catch {} }); };
      scan = subscription;
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        startup = Promise.resolve().then(() => manager.startDeviceScan(null, { allowDuplicates }, (error, device) => {
          if (!active || context.signal.aborted) return;
          if (error) { onError?.(error); return; }
          if (!device) return;
          const candidate: JsHostCandidate = {
            peripheral_id: device.id, name: device.localName ?? device.name,
            advertised_address: null, rssi: device.rssi ?? -127,
          };
          onCandidate(candidate);
        }));
        await startup;
        check(context);
        return subscription;
      } catch (error) { await subscription.remove(); throw error; }
    },
    async connect(peripheralId, context) {
      check(context);
      if (uncertainConnections.has(peripheralId)) throw cleanupFailure('Connection cleanup pending');
      let cancellation: Promise<void> | undefined;
      let cancellationFailed = false;
      let cancellationError: unknown;
      let connectionSettled = false;
      let cancellationBeforeConnection = false;
      const abort = () => {
        if (cancellation) return;
        try {
          cancellation = Promise.resolve(manager.cancelDeviceConnection(peripheralId)).then(
            () => { cancellationBeforeConnection = !connectionSettled; },
            error => { cancellationFailed = true; cancellationError = error; });
        } catch (error) {
          cancellationFailed = true;
          cancellationError = error;
          cancellation = Promise.resolve();
        }
      };
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        let device: Peripheral | undefined;
        let connectionError: unknown;
        try { device = await manager.connectToDevice(peripheralId, { requestMTU: policy.MAX_MTU }); }
        catch (error) { connectionError = error; }
        if (device) {
          connected.set(peripheralId, device);
          connectionGenerations.set(peripheralId, ++connectionGeneration);
        }
        connectionSettled = true;
        if (context.signal.aborted) {
          abort();
          // Join the first cancellation after Connect itself has actually settled.
          await cancellation;
          if (device && (cancellationBeforeConnection || cancellationFailed)) {
            try { await manager.cancelDeviceConnection(peripheralId); }
            catch (error) { cancellationError ??= error; cancellationFailed = true; }
          }
          if (cancellationFailed) {
            uncertainConnections.add(peripheralId);
            throw cleanupFailure(cancellationError);
          }
          connected.delete(peripheralId);
          connectionGenerations.delete(peripheralId);
          check(context);
        }
        if (!device) throw connectionError;
      } finally { context.signal.removeEventListener('abort', abort); }
    },
    async discoverServices(peripheralId, context) {
      check(context);
      const device = connected.get(peripheralId);
      if (!device) throw new Error('Peripheral has no local connection');
      const discovered = await device.discoverAllServicesAndCharacteristics();
      check(context);
      connected.set(peripheralId, discovered);
    },
    async disconnect(peripheralId) {
      if (!connected.has(peripheralId) && !uncertainConnections.has(peripheralId)) return;
      await manager.cancelDeviceConnection(peripheralId);
      connected.delete(peripheralId);
      connectionGenerations.delete(peripheralId);
      uncertainConnections.delete(peripheralId);
    },
    async getMtu(peripheralId, context) {
      check(context);
      const device = connected.get(peripheralId);
      if (!device) throw new Error('Peripheral has no local connection');
      const generation = connectionGenerations.get(peripheralId);
      for (let attempt = 0; attempt < policy.mtuObservationAttempts; attempt++) {
        const devices = await manager.devices([peripheralId]);
        check(context);
        if (connectionGenerations.get(peripheralId) !== generation) throw Object.assign(
          new Error('Peripheral connection changed during MTU observation'), { code: 'identity_mismatch' });
        const fresh = devices[0];
        if (devices.length !== 1 || !fresh || fresh.id !== peripheralId) throw Object.assign(
          new Error('MTU observation returned a foreign peripheral'), { code: 'identity_mismatch' });
        if (!Number.isInteger(fresh.mtu) || fresh.mtu < policy.DEFAULT_MTU) throw Object.assign(
          new Error('MTU observation returned an invalid value'), { code: 'invalid_mtu' });
        connected.set(peripheralId, fresh);
        if (fresh.mtu > policy.DEFAULT_MTU || attempt + 1 === policy.mtuObservationAttempts) return fresh.mtu;
        await new Promise<void>((resolve, reject) => {
          const done = () => { context.signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(done, policy.mtuObservationDelayMs);
          const abort = () => {
            clearTimeout(timer); context.signal.removeEventListener('abort', abort);
            try { check(context); } catch (error) { reject(error); }
          };
          context.signal.addEventListener('abort', abort, { once: true });
          if (context.signal.aborted) abort();
        });
      }
      throw Object.assign(new Error('MTU observation policy rejected the request'), { code: 'invalid_mtu' });
    },
    async observeDisconnect(peripheralId, onDisconnect, context) {
      check(context);
      const generation = connectionGenerations.get(peripheralId);
      if (generation === undefined) throw new Error('Peripheral has no local connection');
      let active = true;
      let removed = false;
      const subscription = manager.onDeviceDisconnected(peripheralId, error => {
        if (!active || connectionGenerations.get(peripheralId) !== generation) return;
        connected.delete(peripheralId);
        connectionGenerations.delete(peripheralId);
        uncertainConnections.delete(peripheralId);
        onDisconnect(error?.message);
      });
      return { async remove() {
        if (removed) return;
        active = false;
        await subscription.remove();
        removed = true;
      } };
    },
    async read(address, context) {
      let result: Characteristic;
      try {
        result = await oneShot(context, transactionId => manager.readCharacteristicForDevice(
          id(address.peripheralId), address.serviceUuid, address.characteristicUuid, transactionId));
      } catch (error) {
        if (error && typeof error === 'object' && 'errorCode' in error && error.errorCode === 404) {
          throw Object.assign(new Error('Requested BLE characteristic is absent'), {
            code: 'characteristic_not_found', characteristicUuid: address.characteristicUuid,
            peripheralId: address.peripheralId,
          });
        }
        throw error;
      }
      if (result.value == null) throw new Error('BLE read returned no value');
      return Uint8Array.from(Buffer.from(result.value, 'base64'));
    },
    async write(address, value, withResponse, context) {
      const method = withResponse ? manager.writeCharacteristicWithResponseForDevice : manager.writeCharacteristicWithoutResponseForDevice;
      await oneShot(context, transactionId => method.call(manager, id(address.peripheralId),
        address.serviceUuid, address.characteristicUuid, Buffer.from(value).toString('base64'), transactionId));
    },
    async subscribe(address, onValue, context, onError) {
      check(context);
      let active = true;
      let removed = false;
      const transactionId = `bota:monitor:${context.generation}:${context.requestId}:${++transaction}`;
      manager.monitorCharacteristicForDevice(id(address.peripheralId),
        address.serviceUuid, address.characteristicUuid, (error, result) => {
          if (!active || context.signal.aborted) return;
          if (error) { onError?.(error); return; }
          if (result?.value == null) return;
          onValue(Uint8Array.from(Buffer.from(result.value, 'base64')));
        }, transactionId);
      let removal: Promise<void> | undefined;
      const remove = () => {
        if (removed) return Promise.resolve();
        active = false;
        context.signal.removeEventListener('abort', abort);
        // The library's monitor remove() hides its native cancellation promise.
        // Public cancellation acknowledges OS teardown and settles that monitor.
        removal ??= Promise.resolve().then(() => manager.cancelTransaction(transactionId)).then(
          () => { removed = true; }, error => { removal = undefined; throw cleanupFailure(error); });
        return removal;
      };
      const abort = () => { void remove().catch(error => { try { onError?.(error); } catch {} }); };
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) await remove();
      return { remove };
    },
  };
}
