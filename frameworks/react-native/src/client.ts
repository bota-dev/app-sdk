import type {
  NativeCapabilities,
  NativeConfiguration,
  Spec,
} from './specs/NativeBotaDeviceSDK';

export type BotaLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export type BotaDeviceSDKConfiguration = {
  applicationSupportDirectory?: string;
  logLevel?: BotaLogLevel;
};

export type BotaDeviceSDKState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'error';

export type BotaDeviceSDKCapabilities = NativeCapabilities;

export class BotaNativeModuleError extends Error {
  readonly code = 'native_module_unavailable';

  constructor() {
    super(
      'BotaDeviceSDK native module is unavailable. Rebuild the native application after installing the SDK.'
    );
    this.name = 'BotaNativeModuleError';
  }
}

export type BotaDeviceSDKClient = {
  configure(configuration?: BotaDeviceSDKConfiguration): Promise<void>;
  destroy(): Promise<void>;
  getCapabilities(): Promise<BotaDeviceSDKCapabilities>;
  getState(): Promise<BotaDeviceSDKState>;
};

export const createBotaDeviceSDK = (nativeModule: Spec | null): BotaDeviceSDKClient => {
  const requireNativeModule = (): Spec => {
    if (!nativeModule) throw new BotaNativeModuleError();
    return nativeModule;
  };

  return {
    async configure(configuration = {}) {
      const nativeConfiguration: NativeConfiguration = {
        logLevel: configuration.logLevel ?? 'warn',
        ...(configuration.applicationSupportDirectory
          ? {
              applicationSupportDirectory:
                configuration.applicationSupportDirectory,
            }
          : {}),
      };
      await requireNativeModule().configure(nativeConfiguration);
    },

    async destroy() {
      await requireNativeModule().destroy();
    },

    async getCapabilities() {
      return requireNativeModule().getCapabilities();
    },

    async getState() {
      return (await requireNativeModule().getState()) as BotaDeviceSDKState;
    },
  };
};
