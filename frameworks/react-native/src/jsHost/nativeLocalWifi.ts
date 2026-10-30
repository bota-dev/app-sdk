import { Buffer } from 'buffer';
import type { JsHostContext } from './contracts';
import type { JsLocalWifiPort, JsLocalWifiReader } from './localWifi';
import { BotaJsHostError } from './executor';

declare const performance: { now(): number };

/** Narrow OS module only: no BLE packets, upload policy or durable task state. */
export interface NativeLocalWifiTransport {
  preflight(): Promise<void>;
  createLease(): Promise<string>;
  join(handle: string, inputJSON: string): Promise<void>;
  open(handle: string, inputJSON: string): Promise<string>;
  read(handle: string, maximumLength: number): Promise<string | null>;
  closeReader(handle: string): Promise<void>;
  closeLease(handle: string): Promise<void>;
}
export interface NativeLocalWifiOptions {
  /** Verify the captured App/physical connection owner, including retirement.
   * Cryptographic device proof is enforced in the shared control protocol. */
  assertOwner(peripheralId: string, context: JsHostContext): Promise<void>;
}

/** Safe to import from /runtime without loading React Native or a native engine. */
export function createNativeLocalWifiPort(
  native: NativeLocalWifiTransport | null | undefined,
  options: NativeLocalWifiOptions,
): JsLocalWifiPort {
  let admission: { key: string; peripheralId: string } | undefined;
  const key = (c: JsHostContext) => JSON.stringify([c.operationId, c.generation, c.cancellationId]);
  const fail = (code: string, c: JsHostContext): never => { throw new BotaJsHostError(code, c.operation); };
  const check = (c: JsHostContext, owner?: string) => {
    if (c.signal.aborted) fail('cancelled', c);
    if (owner !== undefined && key(c) !== owner) fail('stale_host_owner', c);
  };
  const module = (c: JsHostContext): NativeLocalWifiTransport => {
    if (!native || typeof options?.assertOwner !== 'function' ||
        ['preflight', 'createLease', 'join', 'open', 'read', 'closeReader', 'closeLease']
          .some(name => typeof native[name as keyof NativeLocalWifiTransport] !== 'function')) {
      return fail('unsupported_capability', c);
    }
    return native;
  };
  return {
    async preflight(peripheralId, context) {
      check(context); admission = undefined;
      const os = module(context);
      await os.preflight(); check(context);
      await options.assertOwner(peripheralId, context); check(context);
      admission = { key: key(context), peripheralId };
    },
    async join(material, context) {
      check(context);
      const os = module(context), owner = key(context), captured = admission;
      if (!captured || captured.key !== owner) return fail('stale_host_owner', context);
      admission = undefined;
      const began = performance.now();
      if (!Number.isInteger(material.expiresInSeconds) || material.expiresInSeconds <= 0 || material.expiresInSeconds > 0xffffffff ||
          material.password.length !== 32 || material.tlsSpkiSha256.length !== 32 || material.downloadToken.length !== 32 ||
          Buffer.byteLength(material.ssid, 'utf8') < 1 || Buffer.byteLength(material.ssid, 'utf8') > 32 ||
          !material.password.every(b => b >= 32 && b <= 126) || material.ipv4.length !== 4 ||
          !material.ipv4.every(b => Number.isInteger(b) && b >= 0 && b <= 255) ||
          !Number.isInteger(material.port) || material.port < 1 || material.port > 65535) return fail('invalid_input', context);
      const ssid = material.ssid, password = Buffer.from(material.password).toString('ascii');
      const address = { ipv4: material.ipv4.join('.'), port: material.port,
        spkiHex: Buffer.from(material.tlsSpkiSha256).toString('hex'),
        bearer: Buffer.from(material.downloadToken).toString('base64url') };
      await os.preflight(); check(context);
      await options.assertOwner(captured.peripheralId, context); check(context);
      const handle = await os.createLease();
      let retired = false, closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        retired = true;
        if (!closing) closing = Promise.resolve().then(() => os.closeLease(handle)).catch(() => {
          closing = undefined; return fail('cleanup_incomplete', context);
        });
        return closing;
      };
      const execute = async <T>(c: JsHostContext, body: () => Promise<T>): Promise<T> => {
        check(c, owner);
        if (retired) return fail('stale_host_owner', c);
        let cancellation: Promise<void> | undefined;
        let cleanupFailed = false;
        const abort = () => { cancellation ??= close().catch(() => { cleanupFailed = true; }); };
        c.signal.addEventListener('abort', abort, { once: true });
        try {
          const value = await body(); check(c, owner);
          if (retired) return fail('stale_host_owner', c);
          return value;
        } catch (error) {
          await close(); throw error;
        } finally {
          c.signal.removeEventListener('abort', abort);
          await cancellation;
          if (cleanupFailed) fail('cleanup_incomplete', c);
        }
      };
      try {
        check(context, owner);
        const remainingMs = material.expiresInSeconds * 1000 - (performance.now() - began);
        if (remainingMs <= 0) fail('timeout', context);
        await execute(context, () => os.join(handle, JSON.stringify({ ssid, password, remainingMs })));
      } catch (error) { await close(); throw error; }
      let opened = false;
      return {
        async open(request, c) {
          check(c, owner);
          if (opened) return fail('stale_host_owner', c);
          opened = true;
          const response = await execute(c, async () => {
            const json = await os.open(handle, JSON.stringify({ ...address, ...request }));
            if (json.length > 32_768) return fail('invalid_input', c);
            let value: { status: number; headers: Record<string, string> };
            try { value = JSON.parse(json); } catch { return fail('invalid_input', c); }
            if (!value || !Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !value.headers ||
                typeof value.headers['content-length'] !== 'string' || typeof value.headers.etag !== 'string' ||
                [value.headers['content-range'], value.headers['content-encoding']].some(v => v !== undefined && typeof v !== 'string')) {
              return fail('invalid_input', c);
            }
            return { status: value.status, content_length: value.headers['content-length'], etag: value.headers.etag,
              content_range: value.headers['content-range'] ?? null, content_encoding: value.headers['content-encoding'] ?? null };
          });
          let readerClosed = false, readerClosing: Promise<void> | undefined;
          const reader: JsLocalWifiReader = {
            response,
            async read(maximumLength, ctx) {
              check(ctx, owner);
              if (readerClosed) return fail('stale_host_owner', ctx);
              if (!Number.isInteger(maximumLength) || maximumLength < 1 || maximumLength > 65_536) return fail('invalid_input', ctx);
              return execute(ctx, async () => {
                const encoded = await os.read(handle, maximumLength);
                if (readerClosed) return fail('stale_host_owner', ctx);
                if (encoded === null) return null;
                if (encoded.length > Math.ceil(maximumLength / 3) * 4) return fail('invalid_input', ctx);
                const bytes = Buffer.from(encoded, 'base64');
                if (bytes.length === 0 || bytes.length > maximumLength || bytes.toString('base64') !== encoded) return fail('invalid_input', ctx);
                return Uint8Array.from(bytes);
              });
            },
            close() {
              readerClosed = true;
              if (!readerClosing) readerClosing = Promise.resolve().then(() => os.closeReader(handle)).catch(() => {
                readerClosing = undefined; return fail('cleanup_incomplete', c);
              });
              return readerClosing;
            },
          };
          return reader;
        },
        close,
      };
    },
  };
}
