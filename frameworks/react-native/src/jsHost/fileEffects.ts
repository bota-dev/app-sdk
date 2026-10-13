import type {
  JsEffectContext, JsEffectHandler, JsFilePort, JsHostContext, JsValue, OpaqueHostHandle,
} from './contracts';
import { BotaJsHostError } from './executor';

interface SinkState {
  handle: OpaqueHostHandle;
  durableUnits: string;
  localPath?: string;
}

/** File mechanics only. The shared core chooses offsets, checkpoints, ACK and cleanup. */
export class JsFileEffects {
  private readonly files: JsFilePort;
  private readonly namespace: string;
  private readonly sinks = new Map<string, SinkState>();
  private readonly firmware = new Map<string, OpaqueHostHandle>();
  private readonly acquireWritable?: (handle: OpaqueHostHandle) => () => void;

  constructor(files: JsFilePort, namespace: string, acquireWritable?: (handle: OpaqueHostHandle) => () => void) {
    if (!namespace.trim()) throw new BotaJsHostError('invalid_scope', 'FileEffects');
    this.files = files;
    this.namespace = namespace;
    this.acquireWritable = acquireWritable;
  }

  registerFirmware(downloadId: string, handle: OpaqueHostHandle): void {
    uint64(downloadId);
    this.validateHandle(handle, 'firmware');
    if (this.firmware.has(downloadId)) throw new BotaJsHostError('duplicate_firmware_blob', 'UpdateFirmware');
    this.firmware.set(downloadId, Object.freeze({ ...handle }));
  }

  /** Drop the operation registration; retained recovery bytes are not deleted. */
  releaseFirmware(downloadId: string): void {
    uint64(downloadId);
    this.firmware.delete(downloadId);
  }

  recordingSink: JsEffectHandler = async (effect, context): Promise<JsValue> => {
    const [kind, fields] = effectFields(effect);
    const id = text(fields.sink_id);
    const state = await this.openSink(id, context);
    switch (kind) {
      case 'Truncate': {
        const completed = uint64(fields.completed_units);
        await this.writable(state.handle, () => this.files.truncate(state.handle, completed, context));
        state.durableUnits = completed;
        return 'RecordingSinkTruncated';
      }
      case 'Append': {
        const payload = hostPayload(fields.opaque_payload ?? fields.payload, this.namespace);
        const offset = state.durableUnits;
        const length = payload instanceof Uint8Array ? payload.length.toString() : uint64(payload.byteLength);
        const expected = (BigInt(offset) + BigInt(length)).toString();
        uint64(expected);
        const result = await this.writable(state.handle, () => this.files.append(state.handle, offset, payload, context));
        const durable = uint64(result.durableUnits);
        if (durable !== expected) throw new BotaJsHostError('durable_file_mismatch', context.operation);
        state.durableUnits = durable;
        return { RecordingSinkAppendCompleted: { durable_units: durable } };
      }
      case 'Finalize': {
        const checksum = fields.expected_crc32;
        if (checksum !== null && (typeof checksum !== 'number' || !Number.isInteger(checksum) || checksum < 0 || checksum > 0xffffffff)) {
          throw new BotaJsHostError('invalid_core_effect', context.operation);
        }
        try {
          const result = await this.writable(state.handle, () => this.files.finalize(state.handle, checksum as number | null, context));
          const durable = uint64(result.durableUnits);
          if (durable !== state.durableUnits) throw new BotaJsHostError('durable_file_mismatch', context.operation);
          state.localPath = result.localPath;
          return { RecordingSinkFinalized: { durable_units: durable } };
        } catch (error) {
          if (hasCode(error, 'integrity_failed')) return 'RecordingSinkIntegrityFailed';
          throw error;
        }
      }
      case 'Discard':
        await this.writable(state.handle, () => this.files.remove(state.handle, context));
        this.sinks.delete(id);
        return null;
      default: throw new BotaJsHostError(`missing_primitive:RecordingSink.${kind}`, context.operation);
    }
  };

  private async writable<T>(handle: OpaqueHostHandle, body: () => Promise<T>): Promise<T> {
    const release = this.acquireWritable?.(handle);
    try { return await body(); } finally { release?.(); }
  }

  firmwareBlob: JsEffectHandler = async (effect, context) => {
    const [kind, fields] = effectFields(effect);
    if (kind !== 'ReadChunk') throw new BotaJsHostError(`missing_primitive:FirmwareBlob.${kind}`, context.operation);
    const id = uint64(fields.download_id);
    const offset = uint64(fields.offset);
    const maximum = fields.max_length;
    if (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum < 1 || maximum > 65535) {
      throw new BotaJsHostError('invalid_firmware_read_bound', context.operation);
    }
    let handle = this.firmware.get(id);
    if (!handle) {
      handle = await this.files.open(`firmware/${id}`, 'firmware', context);
      this.validateHandle(handle, 'firmware');
      this.firmware.set(id, handle);
    }
    const metadata = await this.files.metadata(handle, context);
    const size = uint64(metadata.durableUnits);
    if (BigInt(offset) > BigInt(size)) throw new BotaJsHostError('invalid_firmware_read_bound', context.operation);
    const value = await this.files.read(handle, offset, maximum, context);
    if (!(value instanceof Uint8Array)) throw new BotaJsHostError('missing_primitive:opaque_firmware_chunk', context.operation);
    if (value.length > maximum || BigInt(offset) + BigInt(value.length) > BigInt(size)) {
      throw new BotaJsHostError('invalid_firmware_read_bound', context.operation);
    }
    return { FirmwareChunkRead: { download_id: id, offset, bytes: Array.from(value) } };
  };

  async result(sinkId: string, context: JsHostContext): Promise<{
    handle: OpaqueHostHandle; durableUnits: string; localPath?: string;
  }> {
    const state = await this.openSink(sinkId, context);
    return { ...state };
  }

  peek(sinkId: string): { handle: OpaqueHostHandle; durableUnits: string; localPath?: string } | null {
    const state = this.sinks.get(sinkId);
    return state ? { ...state } : null;
  }

  /** Called after the exact completed queue file has been removed. */
  forgetPath(localPath: string): void {
    for (const [id, state] of this.sinks) if (state.localPath === localPath) this.sinks.delete(id);
  }

  findByPath(localPath: string): { handle: OpaqueHostHandle; durableUnits: string; localPath?: string } | null {
    const state = [...this.sinks.values()].find(value => value.localPath === localPath);
    return state ? { ...state } : null;
  }

  /** Reopens only a validated original queue/sink identity, never an arbitrary path. */
  async reopen(sinkId: string, context: JsHostContext): Promise<{
    handle: OpaqueHostHandle; durableUnits: string; localPath?: string;
  }> {
    return { ...await this.openSink(sinkId, context) };
  }

  private async openSink(id: string, context: JsHostContext): Promise<SinkState> {
    if (!id || id.length > 128 || /\s/.test(id)) throw new BotaJsHostError('invalid_sink_identity', context.operation);
    const known = this.sinks.get(id);
    if (known) return known;
    const handle = await this.files.open(`recording/${id}`, 'file', context);
    this.validateHandle(handle, 'file');
    const metadata = await this.files.metadata(handle, context);
    const state = { handle: Object.freeze({ ...handle }), durableUnits: uint64(metadata.durableUnits), localPath: metadata.localPath };
    this.sinks.set(id, state);
    return state;
  }

  private validateHandle(handle: OpaqueHostHandle, kind: OpaqueHostHandle['kind']): void {
    if (!handle || handle.scope !== this.namespace || handle.kind !== kind || !handle.id) {
      throw new BotaJsHostError('foreign_file_handle', 'FileEffects');
    }
  }
}

function effectFields(value: JsValue): [string, { readonly [key: string]: JsValue }] {
  const effect = object(value);
  const keys = Object.keys(effect);
  if (keys.length !== 1) throw new BotaJsHostError('invalid_core_effect', 'FileEffects');
  return [keys[0]!, object(effect[keys[0]!]!)];
}
function object(value: JsValue): { readonly [key: string]: JsValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotaJsHostError('invalid_core_effect', 'FileEffects');
  return value as { readonly [key: string]: JsValue };
}
function text(value: JsValue | undefined): string {
  if (typeof value !== 'string') throw new BotaJsHostError('invalid_core_effect', 'FileEffects');
  return value;
}
function uint64(value: JsValue | undefined): string {
  const result = text(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(result) || BigInt(result) > 18446744073709551615n) {
    throw new BotaJsHostError('invalid_core_integer', 'FileEffects');
  }
  return result;
}
function hostPayload(value: JsValue | undefined, namespace: string): Uint8Array | OpaqueHostHandle {
  if (Array.isArray(value)) {
    if (value.length > 65536 || value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new BotaJsHostError('invalid_core_bytes', 'RecordingSink');
    }
    return Uint8Array.from(value as number[]);
  }
  const handle = object(value!) as unknown as OpaqueHostHandle;
  if (handle.kind !== 'protected_packet' || !handle.id || handle.scope !== namespace) {
    throw new BotaJsHostError('foreign_protected_handle', 'RecordingSink');
  }
  if (handle.byteLength === undefined) throw new BotaJsHostError('missing_primitive:opaque_payload_length', 'RecordingSink');
  uint64(handle.byteLength);
  return Object.freeze({ ...handle });
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
