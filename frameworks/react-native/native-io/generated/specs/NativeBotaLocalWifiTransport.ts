import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** Generic foreground OS effects; never runs the native Bota workflow engine.
 * Material stays ephemeral and ciphertext reads are bounded to 64 KiB. */
export interface Spec extends TurboModule {
  preflight(): Promise<void>;
  createLease(): Promise<string>;
  join(handle: string, inputJSON: string): Promise<void>;
  open(handle: string, inputJSON: string): Promise<string>;
  read(handle: string, maximumLength: number): Promise<string | null>;
  closeReader(handle: string): Promise<void>;
  closeLease(handle: string): Promise<void>;
}
export default TurboModuleRegistry.get<Spec>('BotaLocalWifiTransport');
