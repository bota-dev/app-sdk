import type { CoreOperation } from './core.ts'

export type BotaSDKErrorCode =
  | 'unsupported_browser'
  | 'invalid_input'
  | 'picker_cancelled'
  | 'bluetooth_unavailable'
  | 'permission_denied'
  | 'operation_in_progress'
  | 'connection_failed'
  | 'identity_mismatch'
  | 'device_disconnected'
  | 'protocol_error'
  | 'cancelled'
  | 'internal_error'
  | 'unsupported_capability'
  | 'picker_required'
  | 'storage_unavailable'
  | 'storage_quota_exceeded'
  | 'authorization_expired'
  | 'resume_rejected'
  | 'integrity_failed'
  | 'upload_failed'
  | 'firmware_rejected'

export type BotaOperation =
  | 'initialize'
  | 'connect'
  | 'reconnect'
  | 'disconnect'
  | 'read_snapshot'
  | 'provision'
  | 'deprovision'
  | 'settings'
  | 'wifi'
  | 'recording_control'
  | 'transfer_recording'
  | 'upload'
  | 'update_firmware'
  | 'read_device_logs'
  | 'unknown'

const MESSAGES: Record<BotaSDKErrorCode, string> = {
  unsupported_browser: 'Bluetooth is not supported by this browser.',
  invalid_input: 'The operation contains invalid input.',
  picker_cancelled: 'Device selection was cancelled.',
  bluetooth_unavailable: 'Bluetooth is unavailable.',
  permission_denied: 'Bluetooth permission was denied.',
  operation_in_progress: 'Another device operation is already in progress.',
  connection_failed: 'The device connection failed.',
  identity_mismatch: 'The selected device does not match this device record.',
  device_disconnected: 'The device is disconnected.',
  protocol_error: 'The device returned invalid protocol data.',
  cancelled: 'The operation was cancelled.',
  internal_error: 'The SDK could not complete the operation.',
  unsupported_capability: 'This browser or device does not support the operation.',
  picker_required: 'Select the device again to continue.',
  storage_unavailable: 'Durable browser storage is unavailable.',
  storage_quota_exceeded: 'Durable browser storage quota was exceeded.',
  authorization_expired: 'The operation authorization has expired.',
  resume_rejected: 'The saved operation cannot be resumed.',
  integrity_failed: 'The operation failed an integrity check.',
  upload_failed: 'The upload could not be completed.',
  firmware_rejected: 'The device rejected the firmware update.',
}

export class BotaSDKError extends Error {
  readonly code: BotaSDKErrorCode
  readonly operation: BotaOperation
  readonly retryable: boolean
  readonly protocolStatus: number | null

  constructor(
    code: BotaSDKErrorCode,
    operation: BotaOperation,
    options: {
      retryable?: boolean
      protocolStatus?: number | null
      cause?: unknown
    } = {},
  ) {
    super(MESSAGES[code], { cause: options.cause })
    this.name = 'BotaSDKError'
    this.code = code
    this.operation = operation
    this.retryable = options.retryable ?? false
    this.protocolStatus = options.protocolStatus ?? null
  }
}

interface StructuredCoreError {
  code?: unknown
  operation?: unknown
  retryable?: unknown
  protocol_status?: unknown
  protocolStatus?: unknown
}

export type CoreBridgeErrorCode =
  | 'invalid_input'
  | 'truncated_packet'
  | 'unknown_packet'
  | 'payload_too_large'
  | 'unsupported_capability'
  | 'unsupported_operation'
  | 'feature_unavailable'
  | 'operation_in_progress'
  | 'unexpected_event'
  | 'device_not_found'
  | 'identity_mismatch'
  | 'connection_failed'
  | 'persistence_failed'
  | 'not_connected'
  | 'timeout'
  | 'cancelled'
  | 'protocol_rejected'
  | 'integrity_failed'
  | 'upload_ownership_unknown'
  | 'download_failed'
  | 'internal'

export class CoreBridgeError extends Error {
  readonly code: CoreBridgeErrorCode
  readonly operation: CoreOperation
  readonly retryable: boolean
  readonly protocolStatus: number | null

  constructor(
    code: CoreBridgeErrorCode,
    operation: CoreOperation,
    retryable: boolean,
    protocolStatus: number | null,
  ) {
    super('The core workflow could not complete the operation.')
    this.name = 'CoreBridgeError'
    this.code = code
    this.operation = operation
    this.retryable = retryable
    this.protocolStatus = protocolStatus
  }
}

const PRIVATE_CORE_CODES: Record<string, CoreBridgeErrorCode> = {
  InvalidInput: 'invalid_input',
  invalid_input: 'invalid_input',
  TruncatedPacket: 'truncated_packet',
  truncated_packet: 'truncated_packet',
  UnknownPacket: 'unknown_packet',
  unknown_packet: 'unknown_packet',
  PayloadTooLarge: 'payload_too_large',
  payload_too_large: 'payload_too_large',
  UnsupportedCapability: 'unsupported_capability',
  unsupported_capability: 'unsupported_capability',
  UnsupportedOperation: 'unsupported_operation',
  unsupported_operation: 'unsupported_operation',
  FeatureUnavailable: 'feature_unavailable',
  feature_unavailable: 'feature_unavailable',
  OperationInProgress: 'operation_in_progress',
  operation_in_progress: 'operation_in_progress',
  UnexpectedEvent: 'unexpected_event',
  unexpected_event: 'unexpected_event',
  DeviceNotFound: 'device_not_found',
  device_not_found: 'device_not_found',
  IdentityMismatch: 'identity_mismatch',
  identity_mismatch: 'identity_mismatch',
  ConnectionFailed: 'connection_failed',
  connection_failed: 'connection_failed',
  PersistenceFailed: 'persistence_failed',
  persistence_failed: 'persistence_failed',
  NotConnected: 'not_connected',
  not_connected: 'not_connected',
  Timeout: 'timeout',
  timeout: 'timeout',
  Cancelled: 'cancelled',
  cancelled: 'cancelled',
  ProtocolRejected: 'protocol_rejected',
  protocol_rejected: 'protocol_rejected',
  IntegrityFailed: 'integrity_failed',
  integrity_failed: 'integrity_failed',
  UploadOwnershipUnknown: 'upload_ownership_unknown',
  upload_ownership_unknown: 'upload_ownership_unknown',
  DownloadFailed: 'download_failed',
  download_failed: 'download_failed',
  Internal: 'internal',
  internal: 'internal',
}

const PRIVATE_CORE_OPERATIONS: Record<string, CoreOperation> = {
  Validate: 'validate',
  validate: 'validate',
  Decode: 'decode',
  decode: 'decode',
  Encode: 'encode',
  encode: 'encode',
  Discover: 'discover',
  discover: 'discover',
  Connect: 'connect',
  connect: 'connect',
  Reconnect: 'reconnect',
  reconnect: 'reconnect',
  Provision: 'provision',
  provision: 'provision',
  TransferRecording: 'transfer_recording',
  transfer_recording: 'transfer_recording',
  Upload: 'upload',
  upload: 'upload',
  UpdateFirmware: 'update_firmware',
  update_firmware: 'update_firmware',
  ReadDeviceLogs: 'read_device_logs',
  read_device_logs: 'read_device_logs',
  FactoryReset: 'factory_reset',
  factory_reset: 'factory_reset',
  Unknown: 'unknown',
  unknown: 'unknown',
}

export function normalizePrivateCoreError(
  error: unknown,
  fallbackOperation: CoreOperation,
): CoreBridgeError | BotaSDKError {
  if (error instanceof CoreBridgeError || error instanceof BotaSDKError) {
    return error
  }

  if (typeof error === 'object' && error !== null) {
    const structured = error as StructuredCoreError
    if (typeof structured.code === 'string') {
      const operation = typeof structured.operation === 'string'
        ? (PRIVATE_CORE_OPERATIONS[structured.operation] ?? fallbackOperation)
        : fallbackOperation
      return new CoreBridgeError(
        PRIVATE_CORE_CODES[structured.code] ?? 'internal',
        operation,
        structured.retryable === true,
        typeof structured.protocol_status === 'number'
          ? structured.protocol_status
          : null,
      )
    }
  }

  return new CoreBridgeError('internal', fallbackOperation, false, null)
}

const CORE_CODES: Record<string, BotaSDKErrorCode> = {
  InvalidInput: 'invalid_input',
  invalid_input: 'invalid_input',
  OperationInProgress: 'operation_in_progress',
  operation_in_progress: 'operation_in_progress',
  UnsupportedCapability: 'unsupported_capability',
  unsupported_capability: 'unsupported_capability',
  UnsupportedOperation: 'unsupported_capability',
  unsupported_operation: 'unsupported_capability',
  FeatureUnavailable: 'unsupported_capability',
  feature_unavailable: 'unsupported_capability',
  UnexpectedEvent: 'protocol_error',
  unexpected_event: 'protocol_error',
  DeviceNotFound: 'connection_failed',
  device_not_found: 'connection_failed',
  IdentityMismatch: 'identity_mismatch',
  identity_mismatch: 'identity_mismatch',
  ConnectionFailed: 'connection_failed',
  connection_failed: 'connection_failed',
  NotConnected: 'device_disconnected',
  not_connected: 'device_disconnected',
  TruncatedPacket: 'protocol_error',
  truncated_packet: 'protocol_error',
  UnknownPacket: 'protocol_error',
  unknown_packet: 'protocol_error',
  ProtocolRejected: 'protocol_error',
  protocol_rejected: 'protocol_error',
  PayloadTooLarge: 'protocol_error',
  payload_too_large: 'protocol_error',
  PersistenceFailed: 'storage_unavailable',
  persistence_failed: 'storage_unavailable',
  Timeout: 'connection_failed',
  timeout: 'connection_failed',
  IntegrityFailed: 'integrity_failed',
  integrity_failed: 'integrity_failed',
  UploadOwnershipUnknown: 'upload_failed',
  upload_ownership_unknown: 'upload_failed',
  DownloadFailed: 'upload_failed',
  download_failed: 'upload_failed',
  Cancelled: 'cancelled',
  cancelled: 'cancelled',
}

const CORE_OPERATIONS: Record<string, BotaOperation> = {
  Connect: 'connect',
  connect: 'connect',
  Reconnect: 'reconnect',
  reconnect: 'reconnect',
  Provision: 'provision',
  provision: 'provision',
  TransferRecording: 'transfer_recording',
  transfer_recording: 'transfer_recording',
  Upload: 'upload',
  upload: 'upload',
  UpdateFirmware: 'update_firmware',
  update_firmware: 'update_firmware',
  ReadDeviceLogs: 'read_device_logs',
  read_device_logs: 'read_device_logs',
  Decode: 'read_snapshot',
  decode: 'read_snapshot',
  Validate: 'unknown',
  validate: 'unknown',
}

export function normalizeCoreError(
  error: unknown,
  fallbackOperation: BotaOperation,
): BotaSDKError {
  if (error instanceof BotaSDKError) return error

  if (typeof error === 'object' && error !== null) {
    const structured = error as StructuredCoreError
    if (typeof structured.code === 'string') {
      const operation =
        typeof structured.operation === 'string'
          ? (CORE_OPERATIONS[structured.operation] ?? fallbackOperation)
          : fallbackOperation
      const code = operation === 'update_firmware'
        && (structured.code === 'ProtocolRejected'
          || structured.code === 'protocol_rejected')
        ? 'firmware_rejected'
        : (CORE_CODES[structured.code] ?? 'internal_error')
      return new BotaSDKError(code, operation, {
        retryable: structured.retryable === true,
        protocolStatus:
          typeof structured.protocol_status === 'number'
            ? structured.protocol_status
            : typeof structured.protocolStatus === 'number'
              ? structured.protocolStatus
            : null,
        cause: error,
      })
    }
  }

  return new BotaSDKError('internal_error', fallbackOperation, { cause: error })
}
