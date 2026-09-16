import type {
  DeviceStatus,
  EncryptedUploadV2Capabilities,
} from './models.ts'
import { normalizeCoreError } from './errors.ts'

export interface CoreConnectionInput {
  expectedSerialNumber: string
  peripheralId: string
  name: string | null
  cancellationId: Uint8Array
}

export interface CoreEffect {
  requestId: bigint
  kind: string
  payload: Readonly<Record<string, unknown>>
}

export interface CoreHostEvent {
  requestId: bigint
  kind: string
  payload: Readonly<Record<string, unknown>>
}

export type CoreWorkflowStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown }

export interface CoreBridge {
  startExactConnection(input: CoreConnectionInput): CoreEffect[]
  dispatch(event: CoreHostEvent): CoreEffect[]
  status(): CoreWorkflowStatus
  decodeDeviceStatus(bytes: Uint8Array): DeviceStatus
  decodeEncryptedUploadV2Capabilities(
    bytes: Uint8Array,
  ): EncryptedUploadV2Capabilities
}

export type CoreLoader = () => Promise<CoreBridge>

export function createCoreLoader(importer: CoreLoader): CoreLoader {
  let pending: Promise<CoreBridge> | null = null

  return async () => {
    if (!pending) {
      pending = importer().catch((error: unknown) => {
        pending = null
        throw normalizeCoreError(error, 'initialize')
      })
    }
    return pending
  }
}
