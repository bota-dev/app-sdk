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

export type BotaOperation =
  | 'initialize'
  | 'connect'
  | 'disconnect'
  | 'read_snapshot'
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
}

const CORE_CODES: Record<string, BotaSDKErrorCode> = {
  InvalidInput: 'invalid_input',
  invalid_input: 'invalid_input',
  OperationInProgress: 'operation_in_progress',
  operation_in_progress: 'operation_in_progress',
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
  Cancelled: 'cancelled',
  cancelled: 'cancelled',
}

const CORE_OPERATIONS: Record<string, BotaOperation> = {
  Connect: 'connect',
  connect: 'connect',
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
      const code = CORE_CODES[structured.code] ?? 'internal_error'
      const operation =
        typeof structured.operation === 'string'
          ? (CORE_OPERATIONS[structured.operation] ?? fallbackOperation)
          : fallbackOperation
      return new BotaSDKError(code, operation, {
        retryable: structured.retryable === true,
        protocolStatus:
          typeof structured.protocol_status === 'number'
            ? structured.protocol_status
            : null,
        cause: error,
      })
    }
  }

  return new BotaSDKError('internal_error', fallbackOperation, { cause: error })
}
