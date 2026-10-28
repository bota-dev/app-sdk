import { Buffer } from 'buffer';
import type { DeviceType } from './models/Device';

export type AdvertisedDeviceType = DeviceType | 'bota_pin_pro';

export interface BotaAdvertisementMetadata {
  macAddress: string;
  version?: number;
  deviceType?: AdvertisedDeviceType;
  serialSuffix?: string;
}

const MODEL_BY_CODE: Readonly<Record<number, AdvertisedDeviceType>> = {
  1: 'bota_pin', 2: 'bota_note', 3: 'bota_pin_pro',
};
const DISPLAY_BY_TYPE: Readonly<Record<AdvertisedDeviceType, string>> = {
  bota_pin: 'Bota Pin', bota_pin_4g: 'Bota Pin 4G', bota_note: 'Bota Note', bota_pin_pro: 'Bota Pin Pro',
};

/** Normalize known GATT model aliases without deriving identity from a display name. */
export function normalizeConnectedDeviceType(model: string): string {
  switch (model.trim()) {
    case 'pin': case 'Bota Pin': case 'bota-pin': case 'bota_pin': return 'bota_pin';
    case 'pin_4g': case 'Bota Pin 4G': case 'bota-pin-4g': case 'bota_pin_4g': return 'bota_pin_4g';
    case 'note': case 'Bota Note': case 'bota-note': case 'bota_note': return 'bota_note';
    default: return model;
  }
}

/** Decode versioned manufacturer data. Legacy eight-byte payloads expose MAC only. */
export function decodeBotaAdvertisement(base64: string | null | undefined): BotaAdvertisementMetadata | undefined {
  if (!base64) return undefined;
  const bytes = Buffer.from(base64, 'base64');
  if ((bytes.length !== 8 && bytes.length !== 14) || bytes[0] !== 0x7a || bytes[1] !== 0xb0) return undefined;
  const macAddress = [...bytes.subarray(2, 8)]
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
  if (bytes.length === 8) return { macAddress };
  const version = bytes[8];
  if (version !== 1) return { macAddress, version };
  const deviceType = MODEL_BY_CODE[bytes[9]];
  const suffixBytes = bytes.subarray(10, 14);
  const emptySuffix = suffixBytes.every(byte => byte === 0);
  const validSuffix = suffixBytes.every(byte =>
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a));
  return { macAddress, version, ...(deviceType ? { deviceType } : {}),
    ...(!emptySuffix && validSuffix ? { serialSuffix: String.fromCharCode(...suffixBytes) } : {}) };
}

/** Format a user-facing label from structured advertising metadata. */
export function formatAdvertisedDeviceName(deviceType: AdvertisedDeviceType, serialSuffix?: string): string {
  const model = DISPLAY_BY_TYPE[deviceType];
  return serialSuffix && /^[A-Za-z0-9]{4}$/.test(serialSuffix) ? `${model} ${serialSuffix}` : model;
}

/** Preserve the frozen public Pin family while retaining Pin Pro in the display label. */
export function publicDeviceType(deviceType: AdvertisedDeviceType | undefined): DeviceType | undefined {
  return deviceType === 'bota_pin_pro' ? 'bota_pin' : deviceType;
}
