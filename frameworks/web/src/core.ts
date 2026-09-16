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

interface CoreRequest {
  requestId: bigint
}

export type CoreNotification =
  | { kind: 'started' }
  | {
      kind: 'connection_established'
      serialNumber: string
      peripheralId: string
      name: string | null
    }
  | { kind: 'completed' }
  | { kind: 'failed'; error: unknown }

export type CoreEffect =
  | (CoreRequest & { kind: 'notify'; notification: CoreNotification })
  | (CoreRequest & { kind: 'ble_connect'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_discover_services'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_disconnect'; peripheralId: string })
  | (CoreRequest & {
      kind: 'ble_read'
      serviceUuid: string
      characteristicUuid: string
    })
  | (CoreRequest & { kind: 'timer_schedule'; timerId: bigint; delayMs: bigint })
  | (CoreRequest & { kind: 'timer_cancel'; timerId: bigint })
  | (CoreRequest & { kind: 'persistence_save_checkpoint' })
  | (CoreRequest & {
      kind: 'persistence_save_connection_identity'
      serialNumber: string
      peripheralId: string
    })
  | (CoreRequest & { kind: 'persistence_delete_checkpoint' })

export type CoreHostEvent =
  | (CoreRequest & { kind: 'ble_connected'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_services_discovered'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_read_completed'; value: Uint8Array })
  | (CoreRequest & {
      kind: 'ble_disconnected'
      peripheralId: string
      reasonCode: number | null
    })
  | (CoreRequest & { kind: 'ble_failed'; platformCode: number | null })
  | (CoreRequest & { kind: 'timer_fired'; timerId: bigint })
  | (CoreRequest & { kind: 'checkpoint_saved' })
  | (CoreRequest & { kind: 'connection_identity_saved' })

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
