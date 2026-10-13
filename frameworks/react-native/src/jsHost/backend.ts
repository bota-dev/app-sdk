import { Buffer } from 'buffer';
import type { BotaUploadBackendAdapter } from '../runtimeAdapter';
import { BotaJsHostError } from './executor';

export interface JsBackendHttpRequest {
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  redirect: 'error';
  credentials: 'omit';
  signal: AbortSignal;
}
export interface JsBackendHttpResponse {
  status: number;
  /** Final response URL must be the exact supplied HTTPS target. */
  url: string;
  redirected?: boolean;
  headers?: { get(name: string): string | null };
  body?: { getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
    releaseLock?(): void;
  } } | null;
  text(): Promise<string>;
}
export type JsBackendFetch = (url: string, request: JsBackendHttpRequest) => Promise<JsBackendHttpResponse>;
export interface JsUploadBackendOptions {
  /** Must refuse redirects before forwarding credentials; RN's default XHR fetch does not. */
  fetch?: JsBackendFetch;
  /** Permanently invalidated on logout, account/project/binding or environment change. */
  signal?: AbortSignal;
  /** Host rechecks its captured scope at every request/result boundary. */
  checkScope?: () => void;
}
export type JsReadOnlyUploadBackend = BotaUploadBackendAdapter & {
  dispose(): Promise<void>;
  /** Internal fresh-credential broker for operation-scoped JS backend effects. */
  requestCredentials(operationId: string, signal?: AbortSignal): Promise<string>;
};

interface StatusOwner {
  id: string;
  generation: number;
  controller: AbortController;
  work: Promise<string>;
}
interface CredentialOwner {
  operationId: string;
  signal?: AbortSignal;
  resolve(token: string): void;
  reject(error: unknown): void;
  release(): void;
}

const MAX_BYTES = 16384;
const STRING_FIELDS = ['profile', 'recording_id', 'session_id', 'writer_epoch', 'revision', 'state'];
const NUMBER_FIELDS = ['recording_generation', 'received_count', 'contiguous_sequence'];
const STATUS_FIELDS = new Set([...STRING_FIELDS, ...NUMBER_FIELDS, 'expected_count', 'authorization_expired']);

/** HTTP/scalar boundary only. The unchanged public facade owns full status/owner validation. */
export function createJsUploadBackend(options: JsUploadBackendOptions = {}): JsReadOnlyUploadBackend {
  const http = options.fetch;
  if (typeof http !== 'function') throw failure('missing_primitive:http');
  const scopeSignal = options.signal;
  const scopeCheck = options.checkScope;
  const statuses = new Map<string, StatusOwner>();
  const credentials = new Map<string, CredentialOwner>();
  const listeners = new Set<(event: { requestId: string; operationId: string }) => void | Promise<void>>();
  let generation = 0;
  let sequence = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const check = () => {
    if (disposed || scopeSignal?.aborted) throw failure('operation_cancelled');
    try { scopeCheck?.(); } catch { throw failure('scope_changed'); }
  };
  const invalidate = () => {
    disposed = true;
    for (const owner of statuses.values()) owner.controller.abort();
    for (const owner of [...credentials.values()]) owner.reject(failure('operation_cancelled'));
  };
  scopeSignal?.addEventListener('abort', invalidate, { once: true });
  if (scopeSignal?.aborted) invalidate();

  return {
    async readProtectedStreamingStatus(requestId, inputJSON) {
      check();
      if (!requestId || requestId.length > 256 || /\s/.test(requestId) || statuses.has(requestId)) {
        throw failure('invalid_status_request');
      }
      const request = decodeRequest(inputJSON);
      const controller = new AbortController();
      const owner: StatusOwner = { id: requestId, generation: ++generation, controller, work: Promise.resolve('') };
      statuses.set(requestId, owner);
      const exact = () => {
        check();
        if (controller.signal.aborted || statuses.get(requestId) !== owner) throw failure('operation_cancelled');
      };
      const deadline = setTimeout(() => controller.abort(), 45000);
      owner.work = (async () => {
        try {
          exact();
          const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${request.token}` };
          if (request.organizationId) headers['X-Organization-Id'] = request.organizationId;
          const response = await http(request.url, { method: 'GET', headers, redirect: 'error', credentials: 'omit', signal: controller.signal });
          exact();
          if (response.status !== 200 || response.redirected || response.url !== request.url) throw failure('status_request_failed');
          const body = await boundedBody(response, controller.signal);
          exact();
          return scalarStatus(body);
        } catch {
          if (disposed || scopeSignal?.aborted || controller.signal.aborted) throw failure('operation_cancelled');
          throw failure('status_request_failed');
        } finally {
          clearTimeout(deadline);
          if (statuses.get(requestId) === owner) statuses.delete(requestId);
        }
      })();
      // Observe ignored HTTP cancellation while retaining its request ID until actual settlement.
      void owner.work.catch(() => {});
      return abortable(owner.work, controller.signal);
    },

    async cancelProtectedStreamingStatus(requestId) {
      const owner = statuses.get(requestId);
      if (!owner) return;
      owner.controller.abort();
      await owner.work.catch(() => {});
    },

    // Portable consumers use remove(); native EventSubscription internals are not loaded.
    onCredentialsRequested: ((listener: (event: { requestId: string; operationId: string }) => void | Promise<void>) => {
      listeners.add(listener);
      return { remove() { listeners.delete(listener); } };
    }) as NonNullable<BotaUploadBackendAdapter['onCredentialsRequested']>,

    async resolveCredentials(requestId, token) {
      const owner = credentials.get(requestId);
      if (!owner) return;
      try {
        check();
        if (owner.signal?.aborted || !validToken(token)) throw failure('invalid_credentials');
        owner.resolve(token);
      } catch { owner.reject(failure('credentials_rejected')); }
    },

    async rejectCredentials(requestId) { credentials.get(requestId)?.reject(failure('credentials_rejected')); },

    requestCredentials(operationId, signal) {
      try {
        check();
        if (!operationId || operationId.length > 256 || /\s/.test(operationId) || signal?.aborted || !listeners.size) {
          throw failure('credentials_unavailable');
        }
      } catch (error) { return Promise.reject(error); }
      const requestId = `js-credentials:${generation}:${++sequence}`;
      return new Promise<string>((resolve, reject) => {
        const release = () => { credentials.delete(requestId); signal?.removeEventListener('abort', abort); };
        const owner: CredentialOwner = {
          operationId, signal, release,
          resolve(token) { release(); resolve(token); },
          reject(error) { release(); reject(error); },
        };
        const abort = () => owner.reject(failure('operation_cancelled'));
        credentials.set(requestId, owner);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          for (const listener of listeners) {
            void Promise.resolve(listener({ requestId, operationId })).catch(() => owner.reject(failure('credentials_rejected')));
          }
        } catch { owner.reject(failure('credentials_rejected')); }
      });
    },

    dispose() {
      if (disposal) return disposal;
      invalidate();
      scopeSignal?.removeEventListener('abort', invalidate);
      listeners.clear();
      disposal = Promise.allSettled([...statuses.values()].map(owner => owner.work)).then(() => undefined);
      return disposal;
    },
  };
}

function decodeRequest(inputJSON: string): { url: string; token: string; organizationId: string } {
  if (typeof inputJSON !== 'string' || Buffer.byteLength(inputJSON, 'utf8') > 32768) throw failure('invalid_status_request');
  let value: unknown;
  try { value = JSON.parse(inputJSON); } catch { throw failure('invalid_status_request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_status_request');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 3 || typeof request.url !== 'string' ||
      typeof request.token !== 'string' || typeof request.organizationId !== 'string' || !validToken(request.token) ||
      (request.organizationId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(request.organizationId))) throw failure('invalid_status_request');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9_-]+)+\/recordings\/rec_[A-Za-z0-9_-]+\/streaming-status\?session_id=[0-9a-f-]{36}$/.test(request.url)) {
    throw failure('invalid_status_request');
  }
  let url: URL;
  try { url = new URL(request.url); } catch { throw failure('invalid_status_request'); }
  if (url.href !== request.url || url.username || url.password || url.hash) throw failure('invalid_status_request');
  return { url: request.url, token: request.token, organizationId: request.organizationId };
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,16384}$/.test(value);
}

async function boundedBody(response: JsBackendHttpResponse, signal: AbortSignal): Promise<string> {
  const header = response.headers?.get('content-length');
  if (header !== undefined && header !== null && (!/^(0|[1-9][0-9]*)$/.test(header) || BigInt(header) > BigInt(MAX_BYTES))) {
    throw failure('invalid_status_response');
  }
  if (!response.body) {
    const body = await response.text();
    if (signal.aborted || Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw failure('invalid_status_response');
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw failure('operation_cancelled');
      const part = await reader.read();
      if (signal.aborted) throw failure('operation_cancelled');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > MAX_BYTES - size) throw failure('invalid_status_response');
      chunks.push(part.value); size += part.value.byteLength;
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

/** Same scalar transport filter as native; canonical semantics remain in the public facade. */
function scalarStatus(body: string): string {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw failure('invalid_status_response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_status_response');
  const status = value as Record<string, unknown>;
  if (Object.keys(status).length !== STATUS_FIELDS.size || Object.keys(status).some(key => !STATUS_FIELDS.has(key)) ||
      STRING_FIELDS.some(key => typeof status[key] !== 'string' || Buffer.byteLength(status[key] as string, 'utf8') > 160) ||
      NUMBER_FIELDS.some(key => typeof status[key] !== 'number' || !Number.isFinite(status[key])) ||
      (status.expected_count !== null && (typeof status.expected_count !== 'number' || !Number.isFinite(status.expected_count))) ||
      typeof status.authorization_expired !== 'boolean') throw failure('invalid_status_response');
  return JSON.stringify(status);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure('operation_cancelled')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function failure(code: string): BotaJsHostError { return new BotaJsHostError(code, 'ProtectedStreamingStatus'); }
