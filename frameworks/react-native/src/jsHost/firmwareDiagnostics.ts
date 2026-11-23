import type { BotaJsHostPorts, JsHostContext } from './contracts';

/** Observability only: no paths, scope identities, URLs, payloads or arbitrary exception text. */
export interface JsFirmwareDiagnostic {
  stage: 'effect' | 'workflow' | 'checkpoint_load' | 'checkpoint_save' | 'checkpoint_remove' |
    'blob_metadata' | 'blob_read';
  phase: 'completed' | 'failed';
  attemptId?: string;
  requestId?: string;
  effectFamily?: string;
  effectKind?: string;
  downloadId?: string;
  fileId?: string;
  fileSize?: string;
  offset?: string;
  requestedBytes?: number;
  returnedBytes?: number;
  checkpointFound?: boolean;
  checkpointPhase?: string;
  completedUnits?: string;
  firmwareVersion?: string;
  errorName?: string;
  errorCode?: string;
  platformCode?: string;
  causeName?: string;
  causeCode?: string;
  failureReason?: 'invalid_chunk' | 'blob_read' | 'checkpoint' | 'start_rejected' | 'other';
  protocolStatus?: number;
}

const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'BotaJsHostError', 'CodedError',
  'IOException', 'FileNotFoundException', 'NoSuchFileException', 'SecurityException', 'EOFException',
  'IllegalStateException', 'IllegalArgumentException', 'FileSystemException', 'AccessDeniedException']);
const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBADF', 'EOF', 'ERR_UNEXPECTED',
  'ERR_FILESYSTEM', 'ERR_FILESYSTEM_READ', 'ERR_FILESYSTEM_WRITE', 'invalid_input', 'invalid_scope',
  'cancelled', 'integrity_failed', 'invalid_firmware_read_bound', 'foreign_file_handle',
  'persistence_failed', 'protocol_rejected', 'download_failed', 'operation_cancelled', 'scope_changed']);
const phases = new Set(['Preparing', 'Downloading', 'Transferring', 'Verifying', 'Reconnecting', 'Completed']);
export function firmwareEffectKind(value: unknown): string | undefined {
  try {
    const kind = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)[0] : undefined;
    return kind && ['ReadChunk', 'LoadCheckpoint', 'SaveCheckpoint', 'DeleteCheckpoint'].includes(kind) ? kind : undefined;
  } catch { return undefined; }
}
export function diagnosticDecimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n ? value : undefined;
}
function property(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
function errorCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  if (codes.has(value) || /^-?(0|[1-9][0-9]{0,18})$/.test(value)) return value;
  return 'unknown';
}

export function checkpointDiagnostic(value: unknown): Pick<JsFirmwareDiagnostic,
  'checkpointFound' | 'checkpointPhase' | 'completedUnits' | 'firmwareVersion'> {
  const phase = property(value, 'phase'), version = property(value, 'firmware_version');
  return { checkpointFound: value !== null && value !== undefined,
    checkpointPhase: typeof phase === 'string' && phases.has(phase) ? phase : undefined,
    completedUnits: diagnosticDecimal(property(value, 'completed_units')),
    firmwareVersion: typeof version === 'string' && /^\d{1,5}(\.\d{1,5}){1,3}$/.test(version) ? version : undefined };
}

/** Called before host exceptions are reduced to the core's numeric platform-code event. */
export function reportFirmwareDiagnostic(ports: Pick<BotaJsHostPorts, 'onFirmwareDiagnostic'>,
  context: JsHostContext, data: JsFirmwareDiagnostic, error?: unknown): void {
  try {
    if (!['UpdateFirmware', 'RegisterFirmware'].includes(context.operation) || !ports.onFirmwareDiagnostic) return;
    const cause = property(error, 'cause');
    const name = property(error, 'name'), causeName = property(cause, 'name');
    const cancellation = /^[0-9a-f]{2,64}$/.test(context.cancellationId) ? context.cancellationId : undefined;
    const generation = diagnosticDecimal(context.generation);
    const event = Object.freeze({ ...data,
      attemptId: generation && cancellation ? `${generation}:${cancellation}` : undefined,
      requestId: diagnosticDecimal(context.requestId),
      ...(error === undefined ? {} : {
        errorName: typeof name === 'string' && names.has(name) ? name : 'unknown',
        errorCode: errorCode(property(error, 'code')),
        platformCode: errorCode(property(error, 'platformCode')),
        causeName: cause === undefined ? undefined : typeof causeName === 'string' && names.has(causeName) ? causeName : 'unknown',
        causeCode: errorCode(property(cause, 'code')),
      }),
    });
    void Promise.resolve(ports.onFirmwareDiagnostic(event)).catch(() => {});
  } catch { /* Diagnostics never replace an IO result, start new work or interrupt cleanup. */ }
}
