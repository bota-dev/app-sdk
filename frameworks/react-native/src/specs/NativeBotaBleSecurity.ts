import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** Android OS pairing. Keys remain in the system Bluetooth stack. */
export interface Spec extends TurboModule {
  ensureBond(peripheralId: string, requestId: string, timeoutMs: number): Promise<void>;
  cancelBond(requestId: string): Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('BotaBleSecurity');
