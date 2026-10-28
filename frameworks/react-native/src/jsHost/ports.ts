import { Buffer } from 'buffer';
import type { BotaJsHostPorts } from './contracts';
import { BotaJsHostError } from './executor';

/** Installed OS ports must implement this contract before an OTA runtime can use them. */
export const BOTA_JS_HOST_PORT_API_VERSION = 1 as const;

/** Shape preflight only; it never invokes a supplied port or acquires an OS resource. */
export function validateJsHostPorts(ports: BotaJsHostPorts): void {
  const supplied = object(ports);
  if (!supplied || supplied.apiVersion !== BOTA_JS_HOST_PORT_API_VERSION) {
    throw new BotaJsHostError('host_contract_unsupported', 'Configure');
  }
  const persistence = requiredObject(supplied.persistence, 'persistence');
  if (typeof persistence.namespace !== 'string' || !persistence.namespace.trim() ||
      Buffer.byteLength(persistence.namespace, 'utf8') > 4096) {
    throw new BotaJsHostError('invalid_scope', 'Configure');
  }
  if (typeof supplied.platform !== 'string' || !supplied.platform.trim()) {
    throw new BotaJsHostError('host_contract_unsupported', 'Configure');
  }
  const ble = requiredObject(supplied.ble, 'ble');
  requiredMethods(ble, 'ble', ['scan', 'connect', 'discoverServices', 'disconnect', 'read', 'write', 'subscribe']);
  optionalMethods(ble, 'ble', ['getMtu', 'hasService', 'observeDisconnect', 'writeOpaque', 'readBluetoothState', 'observeBluetoothState']);
  requiredMethods(persistence, 'persistence', ['load', 'save', 'remove']);
  requiredMethod(supplied, 'randomBytes', 'randomBytes');
  optionalMethods(supplied, '', ['checkScope']);

  if (supplied.signal !== undefined) {
    const signal = requiredObject(supplied.signal, 'signal');
    if (typeof signal.aborted !== 'boolean') missing('signal.aborted');
    requiredMethods(signal, 'signal', ['addEventListener', 'removeEventListener']);
  }
  if (supplied.files !== undefined) {
    const files = requiredObject(supplied.files, 'files');
    requiredMethods(files, 'files', ['open', 'metadata', 'append', 'truncate', 'read', 'finalize', 'remove']);
    optionalMethods(files, 'files', ['create', 'flush']);
  }
  if (supplied.network !== undefined) {
    const network = requiredObject(supplied.network, 'network');
    requiredMethods(network, 'network', ['download', 'upload']);
    optionalMethods(network, 'network', ['registerDownload', 'unregister']);
  }
  if (supplied.lifecycle !== undefined) {
    const lifecycle = requiredObject(supplied.lifecycle, 'lifecycle');
    requiredMethods(lifecycle, 'lifecycle', ['current', 'observe']);
    if (typeof lifecycle.backgroundExecution !== 'boolean') missing('lifecycle.backgroundExecution');
  }
}

type Properties = Record<string, unknown>;
function object(value: unknown): Properties | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Properties : null;
}
function requiredObject(value: unknown, path: string): Properties {
  const result = object(value);
  if (!result) missing(path);
  return result;
}
function requiredMethods(value: Properties, prefix: string, methods: readonly string[]): void {
  for (const method of methods) requiredMethod(value, method, `${prefix}.${method}`);
}
function optionalMethods(value: Properties, prefix: string, methods: readonly string[]): void {
  for (const method of methods) {
    if (value[method] !== undefined) requiredMethod(value, method, prefix ? `${prefix}.${method}` : method);
  }
}
function requiredMethod(value: Properties, name: string, path: string): void {
  if (typeof value[name] !== 'function') missing(path);
}
function missing(path: string): never {
  throw new BotaJsHostError(`missing_primitive:${path}`, 'Configure');
}
