import { createBotaReactNativeJsRuntime, type BotaJsHostPorts } from '@bota.dev/react-native-app-sdk-runtime';

declare const ports: BotaJsHostPorts;
const runtime = createBotaReactNativeJsRuntime(ports);
void runtime.client.configure({ environment: 'production' });
void runtime.client.destroy();
