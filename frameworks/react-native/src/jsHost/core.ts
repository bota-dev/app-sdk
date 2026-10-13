import { Buffer } from 'buffer';
import type { JsValue, RawCoreRequest, RawCoreResponse, RawJsCoreFactory } from './contracts';
import { instantiateGeneratedCore } from './generated/core';
import type { GeneratedCoreExports } from './generated/core';

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Actual Rust implementation compiled to JS. No WebAssembly runtime or native binding. */
export function createGeneratedJsCore(): RawJsCoreFactory & { dispose(): void } {
  const exports = instantiateGeneratedCore();
  if (exports.bota_js_abi_version() !== 1) throw new Error('Incompatible generated core ABI');
  const codecEngine = exports.bota_js_engine_new();
  if (!codecEngine) throw new Error('Cannot allocate generated core codec state');
  const engines = new Set<number>();
  let disposed = false;
  return {
    createEngine() {
      if (disposed) throw new Error('Generated core disposed');
      let handle = exports.bota_js_engine_new();
      if (!handle) throw new Error('Cannot allocate generated core workflow state');
      engines.add(handle);
      return {
        request(input: RawCoreRequest): RawCoreResponse {
          if (!handle || disposed) throw new Error('Generated core engine disposed');
          return rpc(exports, handle, input as unknown as JsValue) as unknown as RawCoreResponse;
        },
        dispose() {
          if (handle) {
            if (!disposed) exports.bota_js_engine_free(handle);
            engines.delete(handle); handle = 0;
          }
        },
      };
    },
    codec(name, input) {
      if (disposed) throw new Error('Generated core disposed');
      const response = rpc(exports, codecEngine, { version: 1, action: 'codec', codec: name, input }) as
        { ok: boolean; result?: JsValue; error?: { code: string; operation: string; retryable: boolean; detail?: string } };
      if (!response.ok) {
        const error = new Error(response.error?.detail ?? response.error?.code ?? 'Generated codec rejected input');
        Object.assign(error, response.error, { protocolStatus: (response.error as { protocol_status?: number } | undefined)?.protocol_status });
        throw error;
      }
      return response.result ?? null;
    },
    dispose() {
      if (disposed) return;
      for (const handle of engines) exports.bota_js_engine_free(handle);
      engines.clear();
      exports.bota_js_engine_free(codecEngine);
      disposed = true;
    },
  };
}

function rpc(exports: GeneratedCoreExports, engine: number, input: JsValue): JsValue {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8');
  if (encoded.byteLength > MAX_MESSAGE_BYTES) throw new Error('Core message exceeds bound');
  const request = exports.bota_js_buffer_alloc(encoded.byteLength);
  if (!request) throw new Error('Cannot allocate core message');
  let response = 0;
  try {
    writeBuffer(exports, request, encoded);
    response = exports.bota_js_rpc(engine, request);
    if (!response) throw new Error('Core message failed');
    const length = exports.bota_js_buffer_len(response) >>> 0;
    const pointer = exports.bota_js_buffer_ptr(response) >>> 0;
    const memory = exports.memory.buffer;
    if (!length || length > MAX_MESSAGE_BYTES || pointer > memory.byteLength - length) {
      throw new Error('Core returned an invalid buffer');
    }
    return JSON.parse(Buffer.from(new Uint8Array(memory, pointer, length)).toString('utf8')) as JsValue;
  } finally {
    if (response) exports.bota_js_buffer_free(response);
    exports.bota_js_buffer_free(request);
    encoded.fill(0);
  }
}

function writeBuffer(exports: GeneratedCoreExports, handle: number, bytes: Uint8Array): void {
  const length = exports.bota_js_buffer_len(handle) >>> 0;
  const pointer = exports.bota_js_buffer_ptr(handle) >>> 0;
  const memory = exports.memory.buffer;
  if (length !== bytes.byteLength || pointer > memory.byteLength - length) throw new Error('Invalid core allocation');
  new Uint8Array(memory, pointer, length).set(bytes);
}
