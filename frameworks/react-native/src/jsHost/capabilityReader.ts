import type { GattAddress, JsGattValue } from './contracts';

/** Discovery only: shared Rust validates and hashes the selected whole snapshot. */
export async function readUploadCapabilities(
  read: (address: GattAddress) => Promise<JsGattValue>, legacy: GattAddress, extension: GattAddress,
): Promise<JsGattValue> {
  try { return await read(extension); }
  catch (error) {
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const absent = (failure.code === 'characteristic_not_found' && failure.characteristicUuid === extension.characteristicUuid) ||
      (failure.code === 'service_not_found' && failure.serviceUuid === extension.serviceUuid);
    if (!absent || failure.peripheralId !== extension.peripheralId) throw error;
    return read(legacy);
  }
}
