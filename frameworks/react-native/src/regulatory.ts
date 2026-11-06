import type { NativeConnectedDevice } from './specs/NativeBotaDeviceSDK';
export type RegulatoryCapabilities = { supported: boolean; protocolVersion: number };
export type RegulatoryDelivery = {
  format: 'bota-regulatory-signed-v1';
  encoding: 'base64url';
  data: string;
  nonce: string;
};
/** Unverified transport evidence. The App must submit it to the backend verifier. */
export type RegulatoryReceipt = {
  result: number;
  acknowledgement: string;
  countryAlpha2: string;
  configId: string;
  revision: string;
  bindingGeneration: string;
};
/** Additive generated-JS capability; native-only adapters fail before any write. */
export interface RegulatoryAdapter {
  readRegulatoryCapabilities(device: NativeConnectedDevice): Promise<RegulatoryCapabilities>;
  readRegulatoryStatus(device: NativeConnectedDevice): Promise<{ ready: boolean }>;
  readRegulatoryChallenge(device: NativeConnectedDevice): Promise<string>;
  applyRegulatoryConfiguration(device: NativeConnectedDevice, document: RegulatoryDelivery): Promise<RegulatoryReceipt>;
}
