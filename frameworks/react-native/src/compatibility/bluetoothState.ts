import type { BotaDeviceSDKClient } from '../client';
import type { BluetoothState } from '../models/Status';

export interface CompatibilityBluetoothState {
  read(): Promise<BluetoothState>;
  watch(listener: (state: BluetoothState) => void): { remove(): void };
}
const states = new WeakMap<BotaDeviceSDKClient, CompatibilityBluetoothState>();

/** Private binding: native and legacy factories keep their existing contract. */
export function setCompatibilityBluetoothState(client: BotaDeviceSDKClient,
  state?: CompatibilityBluetoothState): void {
  if (state) states.set(client, state); else states.delete(client);
}
export function getCompatibilityBluetoothState(client: BotaDeviceSDKClient): CompatibilityBluetoothState | undefined {
  return states.get(client);
}
