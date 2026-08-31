import NativeBotaDeviceSDK from './specs/NativeBotaDeviceSDK';
import { createBotaDeviceSDK } from './client';

export {
  BotaNativeModuleError,
  createBotaDeviceSDK,
} from './client';
export type {
  BotaDeviceSDKCapabilities,
  BotaDeviceSDKClient,
  BotaDeviceSDKConfiguration,
  BotaDeviceSDKState,
  BotaLogLevel,
} from './client';

export const BotaDeviceSDK = createBotaDeviceSDK(NativeBotaDeviceSDK);
