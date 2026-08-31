import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NativeConfiguration = {
  applicationSupportDirectory?: string;
  logLevel: string;
};

export type NativeCapabilities = {
  backgroundReconnect: boolean;
  backgroundScan: boolean;
  bluetooth: boolean;
  nativeFileTransfer: boolean;
  platform: string;
};

export interface Spec extends TurboModule {
  configure: (configuration: NativeConfiguration) => Promise<void>;
  destroy: () => Promise<void>;
  getCapabilities: () => Promise<NativeCapabilities>;
  getState: () => Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('BotaDeviceSDK');
