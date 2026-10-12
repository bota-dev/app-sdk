import { createBotaReactNativeRuntime, type BotaDeviceAdapter } from '@bota.dev/react-native-app-sdk-runtime';

const adapter: BotaDeviceAdapter = {
  configure: async () => {},
  destroy: async () => {},
  getState: async () => 'ready',
};
const runtime = createBotaReactNativeRuntime({ apiVersion: 1, device: adapter });
void runtime.supports('readStatus');
void runtime.sdk.getState();
