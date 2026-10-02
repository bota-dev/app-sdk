import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/** Preparation/result JSON contains only bounded identity metadata. Signed
 * documents and recording bytes stay in the native backend adapter. */
export interface Spec extends TurboModule {
  readonly onCredentialsRequested: EventEmitter<{
    requestId: string;
    operationId: string;
  }>;
  prepare: (inputJSON: string) => Promise<string>;
  cancel: (operationId: string) => Promise<void>;
  complete: (operationId: string) => Promise<void>;
  resolveCredentials: (requestId: string, token: string) => Promise<void>;
  rejectCredentials: (requestId: string) => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('BotaUploadV2Backend');
