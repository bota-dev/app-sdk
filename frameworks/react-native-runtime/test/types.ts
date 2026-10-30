import { createBotaReactNativeRuntime, createNativeLocalWifiPort, type BotaDeviceAdapter,
  type NativeLocalWifiTransport } from '@bota.dev/react-native-app-sdk-runtime';
import type { Spec as LocalWifiSpec } from '../lib/typescript/specs/NativeBotaLocalWifiTransport.js';

const adapter: BotaDeviceAdapter = {
  configure: async () => {},
  destroy: async () => {},
  getState: async () => 'ready',
};
const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: adapter });
void runtime.supports('readStatus');
void runtime.sdk.getState();

const wifi: LocalWifiSpec = {
  preflight: async () => {}, createLease: async () => 'lease',
  join: async () => {}, open: async () => '{}', read: async () => null,
  closeReader: async () => {}, closeLease: async () => {},
};
const installedTransport: NativeLocalWifiTransport = wifi;
void createNativeLocalWifiPort(installedTransport, { assertOwner: async () => {} });
