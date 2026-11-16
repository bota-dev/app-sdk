import type { NativeConnectedDevice } from './specs/NativeBotaDeviceSDK';

/** Backend-issued signed bytes and their captured response metadata. No token is exposed. */
export type CountryConfigurationDelivery = {
  protocolVersion: 1;
  bindingGeneration: number;
  countryAlpha2: string;
  countryRevision: string;
  expectedFirmwareVersion: string;
  document: { format: 'bota-country-config-v1'; encoding: 'base64url'; data: string };
};

/** Ordinary device observation correlated to this write, not a signed hardware attestation. */
export type CountryConfigurationResult = {
  result: 0;
  bindingGeneration: number;
  countryAlpha2: string;
  countryRevision: string;
};

/** Generated-JS extension. Unsupported native-only adapters fail before a device write. */
export interface CountryConfigurationAdapter {
  applyCountryConfiguration(device: NativeConnectedDevice, delivery: CountryConfigurationDelivery): Promise<CountryConfigurationResult>;
}
