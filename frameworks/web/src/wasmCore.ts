import initWasm, {
  WebCoreBridge as GeneratedWebCoreBridge,
  decodeDeviceStatus as decodeGeneratedDeviceStatus,
  decodeEncryptedUploadV2Capabilities as decodeGeneratedCapabilities,
} from './generated/bota_device_sdk_core.js'

import type {
  CoreBridge,
  CoreEffect,
  CoreHostEvent,
  CoreWorkflowStatus,
} from './core.ts'
import { createCoreLoader } from './core.ts'
import { BotaSDKError, normalizeCoreError } from './errors.ts'
import type {
  DeviceState,
  DeviceStatus,
  EncryptedUploadV2Capabilities,
  ModemInfo,
} from './models.ts'

type UnknownRecord = Record<string, unknown>

export async function createWasmCore(moduleInput?: unknown): Promise<CoreBridge> {
  try {
    if (moduleInput === undefined) {
      await initWasm()
    } else {
      await initWasm({ module_or_path: moduleInput as WebAssembly.Module })
    }
    return new WasmCoreAdapter(new GeneratedWebCoreBridge())
  } catch (error) {
    throw normalizeCoreError(error, 'initialize')
  }
}

export const loadDefaultCore = createCoreLoader(() => createWasmCore())

class WasmCoreAdapter implements CoreBridge {
  private readonly generated: GeneratedWebCoreBridge

  constructor(generated: GeneratedWebCoreBridge) {
    this.generated = generated
  }

  startExactConnection(input: Parameters<CoreBridge['startExactConnection']>[0]): CoreEffect[] {
    try {
      const raw = this.generated.startExactConnection(
        input.expectedSerialNumber,
        input.peripheralId,
        input.name,
        input.cancellationId,
      )
      return normalizeEffects(raw)
    } catch (error) {
      throw normalizeCoreError(error, 'connect')
    }
  }

  dispatch(event: CoreHostEvent): CoreEffect[] {
    try {
      return normalizeEffects(this.generated.dispatch(rawHostEvent(event)))
    } catch (error) {
      throw normalizeCoreError(error, 'connect')
    }
  }

  status(): CoreWorkflowStatus {
    try {
      return normalizeStatus(this.generated.status())
    } catch (error) {
      throw normalizeCoreError(error, 'connect')
    }
  }

  decodeDeviceStatus(bytes: Uint8Array): DeviceStatus {
    try {
      return normalizeDeviceStatus(decodeGeneratedDeviceStatus(bytes))
    } catch (error) {
      throw normalizeCoreError(error, 'read_snapshot')
    }
  }

  decodeEncryptedUploadV2Capabilities(
    bytes: Uint8Array,
  ): EncryptedUploadV2Capabilities {
    try {
      return normalizeCapabilities(decodeGeneratedCapabilities(bytes))
    } catch (error) {
      throw normalizeCoreError(error, 'read_snapshot')
    }
  }
}

function normalizeEffects(value: unknown): CoreEffect[] {
  if (!Array.isArray(value)) throw internalBridgeError()
  return value.map(normalizeEffect)
}

function normalizeEffect(value: unknown): CoreEffect {
  const request = record(value)
  const requestId = bigint(request.request_id)
  const effect = record(request.effect)

  if ('Notify' in effect) {
    const notify = record(effect.Notify)
    if ('Started' in notify) return { requestId, kind: 'notify', notification: { kind: 'started' } }
    if ('Completed' in notify) return { requestId, kind: 'notify', notification: { kind: 'completed' } }
    if ('Failed' in notify) {
      const failed = record(notify.Failed)
      return {
        requestId,
        kind: 'notify',
        notification: { kind: 'failed', error: failed.error },
      }
    }
    if ('ConnectionEstablished' in notify) {
      const established = record(notify.ConnectionEstablished)
      const candidate = record(established.candidate)
      return {
        requestId,
        kind: 'notify',
        notification: {
          kind: 'connection_established',
          serialNumber: string(established.device),
          peripheralId: string(candidate.peripheral_id),
          name: optionalString(candidate.name),
        },
      }
    }
  }

  if ('Ble' in effect) {
    const ble = record(effect.Ble)
    if ('Connect' in ble) {
      return {
        requestId,
        kind: 'ble_connect',
        peripheralId: string(record(ble.Connect).peripheral_id),
      }
    }
    if ('DiscoverServices' in ble) {
      return {
        requestId,
        kind: 'ble_discover_services',
        peripheralId: string(record(ble.DiscoverServices).peripheral_id),
      }
    }
    if ('Disconnect' in ble) {
      return {
        requestId,
        kind: 'ble_disconnect',
        peripheralId: string(record(ble.Disconnect).peripheral_id),
      }
    }
    if ('Read' in ble) {
      const read = record(ble.Read)
      return {
        requestId,
        kind: 'ble_read',
        serviceUuid: string(read.service_uuid),
        characteristicUuid: string(read.characteristic_uuid),
      }
    }
  }

  if ('Timer' in effect) {
    const timer = record(effect.Timer)
    if ('Schedule' in timer) {
      const schedule = record(timer.Schedule)
      return {
        requestId,
        kind: 'timer_schedule',
        timerId: bigint(schedule.timer_id),
        delayMs: bigint(schedule.delay_ms),
      }
    }
    if ('Cancel' in timer) {
      return {
        requestId,
        kind: 'timer_cancel',
        timerId: bigint(record(timer.Cancel).timer_id),
      }
    }
  }

  if ('Persistence' in effect) {
    if (effect.Persistence === 'DeleteCheckpoint') {
      return { requestId, kind: 'persistence_delete_checkpoint' }
    }
    const persistence = record(effect.Persistence)
    if ('SaveCheckpoint' in persistence) {
      return { requestId, kind: 'persistence_save_checkpoint' }
    }
    if ('SaveConnectionIdentity' in persistence) {
      const save = record(persistence.SaveConnectionIdentity)
      const candidate = record(save.candidate)
      return {
        requestId,
        kind: 'persistence_save_connection_identity',
        serialNumber: string(save.device),
        peripheralId: string(candidate.peripheral_id),
      }
    }
  }

  throw internalBridgeError()
}

function rawHostEvent(event: CoreHostEvent): UnknownRecord {
  const request_id = event.requestId
  switch (event.kind) {
    case 'ble_connected':
      return { request_id, kind: { Ble: { Connected: { peripheral_id: event.peripheralId } } } }
    case 'ble_services_discovered':
      return { request_id, kind: { Ble: { ServicesDiscovered: { peripheral_id: event.peripheralId } } } }
    case 'ble_read_completed':
      return { request_id, kind: { Ble: { ReadCompleted: { value: [...event.value] } } } }
    case 'ble_disconnected':
      return {
        request_id,
        kind: {
          Ble: {
            Disconnected: {
              peripheral_id: event.peripheralId,
              reason_code: event.reasonCode ?? undefined,
            },
          },
        },
      }
    case 'ble_failed':
      return {
        request_id,
        kind: { Ble: { Failed: { platform_code: event.platformCode ?? undefined } } },
      }
    case 'timer_fired':
      return { request_id, kind: { TimerFired: { timer_id: event.timerId } } }
    case 'checkpoint_saved':
      return { request_id, kind: 'CheckpointSaved' }
    case 'connection_identity_saved':
      return { request_id, kind: 'ConnectionIdentitySaved' }
  }
}

function normalizeStatus(value: unknown): CoreWorkflowStatus {
  if (value === 'Idle') return { kind: 'idle' }
  const status = record(value)
  if ('Idle' in status) return { kind: 'idle' }
  if ('Running' in status) return { kind: 'running' }
  if ('Completed' in status) return { kind: 'completed' }
  if ('Cancelled' in status) return { kind: 'cancelled' }
  if ('Failed' in status) return { kind: 'failed', error: record(status.Failed).error }
  throw internalBridgeError()
}

function normalizeDeviceStatus(value: unknown): DeviceStatus {
  const status = record(value)
  const flags = record(status.flags)
  return {
    batteryPercent: number(status.battery_percent),
    batteryMillivolts: optionalNumber(status.battery_mv),
    storageTotalMb: number(status.storage_total_mb),
    storageUsedMb: number(status.storage_used_mb),
    ...normalizeDeviceState(status.state),
    pendingRecordings: number(status.pending_recordings),
    lastTimeSyncTimestamp: number(status.last_time_sync_timestamp),
    flags: {
      charging: boolean(flags.charging),
      lowBattery: boolean(flags.low_battery),
      storageFull: boolean(flags.storage_full),
      wifiConnected: boolean(flags.wifi_connected),
      lteConnected: boolean(flags.lte_connected),
      syncActive: boolean(flags.sync_active),
    },
    lteStatusRaw: number(status.lte_status_raw),
    lteSignalQuality: optionalNumber(status.lte_signal_quality),
    wifiStatusRaw: optionalNumber(status.wifi_status_raw),
    modemInfo: normalizeModemInfo(status.modem_info),
  }
}

function normalizeDeviceState(value: unknown): { state: DeviceState; stateRaw?: number } {
  if (typeof value === 'string') {
    const known: Record<string, DeviceState> = {
      Idle: 'idle',
      Recording: 'recording',
      Syncing: 'syncing',
      Uploading: 'uploading',
      Charging: 'charging',
      LowBattery: 'low_battery',
      StorageFull: 'storage_full',
      Error: 'error',
    }
    return { state: known[value] ?? 'unknown' }
  }
  const unknown = record(value)
  return { state: 'unknown', stateRaw: number(unknown.Unknown) }
}

function normalizeModemInfo(value: unknown): ModemInfo | null {
  if (value === undefined || value === null) return null
  const modem = record(value)
  return {
    imei: optionalString(modem.imei),
    iccid: optionalString(modem.iccid),
    operator: optionalString(modem.operator),
    rat: optionalString(modem.rat),
    band: optionalString(modem.band),
    apn: optionalString(modem.apn),
    simStatus: optionalString(modem.sim_status),
    csq: optionalNumber(modem.csq),
    ipAddress: optionalString(modem.ip_address),
    voltageMillivolts: optionalNumber(modem.voltage_mv),
    firmware: optionalString(modem.firmware),
    roaming: optionalBoolean(modem.roaming),
  }
}

function normalizeCapabilities(value: unknown): EncryptedUploadV2Capabilities {
  const capabilities = record(value)
  return {
    flags: number(capabilities.flags),
    maximumSignedBlobBytes: number(capabilities.maximum_signed_blob_bytes),
    maximumManifestBytes: number(capabilities.maximum_manifest_bytes),
    maximumDataPayloadBytes: number(capabilities.maximum_data_payload_bytes),
    maximumWindowPackets: number(capabilities.maximum_window_packets),
    durableCheckpointIntervalBlocks: number(capabilities.durable_checkpoint_interval_blocks),
    maximumMissingSequences: number(capabilities.maximum_missing_sequences),
  }
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw internalBridgeError()
  return value as UnknownRecord
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw internalBridgeError()
  return value
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value)
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw internalBridgeError()
  return value
}

function optionalNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : number(value)
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw internalBridgeError()
  return value
}

function optionalBoolean(value: unknown): boolean | null {
  return value === undefined || value === null ? null : boolean(value)
}

function bigint(value: unknown): bigint {
  if (typeof value !== 'bigint') throw internalBridgeError()
  return value
}

function internalBridgeError(): BotaSDKError {
  return new BotaSDKError('internal_error', 'unknown')
}
