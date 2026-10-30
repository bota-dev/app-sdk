import type { JsLocalWifiPort } from './localWifi';
/** Primitive host contracts. Implementations supply OS effects, never Bota workflows. */
export type JsValue = null | boolean | number | string | readonly JsValue[] |
  { readonly [key: string]: JsValue };
export type Decimal = string;
export type CoreCapability = 'Ble' | 'Timer' | 'Persistence' | 'SecureStorage' |
  'NetworkTransfer' | 'Progress' | 'HostMaterial' | 'RecordingSink' | 'FirmwareBlob';

export interface RawCoreEffect {
  request_id: Decimal;
  operation: string;
  cancellation_id: readonly number[];
  effect: JsValue;
}
export interface RawCoreResult {
  effects: readonly RawCoreEffect[];
  status: JsValue;
}
export type RawCoreResponse = { ok: true; result: RawCoreResult } |
  { ok: false; error: { code: string; operation: string; retryable: boolean; protocol_status?: number; detail?: string } };
export interface RawCoreRequest {
  version: 1;
  action: 'start' | 'dispatch' | 'cancel' | 'status';
  generation?: Decimal;
  operation?: string;
  cancellation_id?: readonly number[];
  command?: JsValue;
  capabilities?: readonly CoreCapability[];
  event?: { request_id: Decimal; kind: JsValue };
}
export interface RawJsCoreEngine {
  request(input: RawCoreRequest): RawCoreResponse;
  dispose(): void;
}
export interface RawJsCoreFactory {
  createEngine(): RawJsCoreEngine;
  /** Calls the generated shared Rust codec; handwritten hosts do not encode wire packets. */
  codec(name: string, input: JsValue): JsValue;
}

export interface JsHostContext {
  readonly operationId: string;
  readonly operation: string;
  readonly requestId: Decimal;
  readonly cancellationId: string;
  readonly generation: Decimal;
  readonly signal: AbortSignal;
}
export interface JsHostSubscription { remove(): Promise<void> }
export interface GattAddress {
  serviceUuid: string;
  characteristicUuid: string;
  peripheralId?: string;
}
export interface JsHostCandidate {
  peripheral_id: string;
  name: string | null;
  advertised_address: string | null;
  rssi: number;
}
export interface JsAdvertisementMetadata {
  readonly deviceType?: 'bota_pin' | 'bota_pin_4g' | 'bota_note' | 'bota_pin_pro';
  readonly serialSuffix?: string;
}
/** Scoped OS handle. Private keys remain opaque; bounded transport bytes may be internal JS values. */
export interface OpaqueHostHandle {
  readonly id: string;
  readonly kind: 'file' | 'firmware' | 'material' | 'protected_packet';
  readonly scope: string;
  /** Exact append length when this reference names a protected packet/range. */
  readonly byteLength?: Decimal;
}
export type JsGattValue = Uint8Array | OpaqueHostHandle;
export interface JsBlePort {
  /** Metadata decoded directly from the most recent manufacturer advertisement. */
  advertisementMetadata?(peripheralId: string): JsAdvertisementMetadata | undefined;
  /** Actual OS radio/permission state; absence remains unknown. */
  readBluetoothState?(context: JsHostContext): Promise<string>;
  observeBluetoothState?(onState: (state: string) => void, context: JsHostContext,
    onError?: (error: unknown) => void): Promise<JsHostSubscription>;
  scan(allowDuplicates: boolean, onCandidate: (candidate: JsHostCandidate) => void,
    context: JsHostContext, onError?: (error: unknown) => void): Promise<JsHostSubscription>;
  connect(peripheralId: string, context: JsHostContext): Promise<void>;
  discoverServices(peripheralId: string, context: JsHostContext): Promise<void>;
  disconnect(peripheralId: string, context: JsHostContext): Promise<void>;
  getMtu?(peripheralId: string, context: JsHostContext): Promise<number>;
  observeDisconnect?(peripheralId: string, onDisconnect: (error?: string) => void,
    context: JsHostContext): Promise<JsHostSubscription>;
  read(address: GattAddress, context: JsHostContext): Promise<JsGattValue>;
  write(address: GattAddress, value: Uint8Array, withResponse: boolean,
    context: JsHostContext): Promise<void>;
  subscribe(address: GattAddress, onValue: (value: JsGattValue) => void,
    context: JsHostContext, onError?: (error: unknown) => void): Promise<JsHostSubscription>;
  /** Writes a host-held protected range; framing is a shared-code primitive. */
  writeOpaque?(address: GattAddress, handle: OpaqueHostHandle, offset: Decimal,
    maximumLength: number, withResponse: boolean, context: JsHostContext): Promise<void>;
}
export interface JsPersistencePort {
  /** Non-secret identity containing account/project/user/environment scope. */
  readonly namespace: string;
  load(key: string, context: JsHostContext): Promise<JsValue | null>;
  /** Resolve only after the complete replacement is durable and readable. */
  save(key: string, value: JsValue, context: JsHostContext): Promise<void>;
  remove(key: string, context: JsHostContext): Promise<void>;
}
export interface JsFilePort {
  flush?(handle: OpaqueHostHandle, context: JsHostContext): Promise<void>;
  create?(kind: 'file' | 'firmware', context: JsHostContext): Promise<OpaqueHostHandle>;
  /** Reopen the same scoped logical file after process loss; create only when absent. */
  open(logicalId: string, kind: 'file' | 'firmware', context: JsHostContext): Promise<OpaqueHostHandle>;
  metadata(handle: OpaqueHostHandle, context: JsHostContext): Promise<{
    durableUnits: Decimal; localPath?: string; crc32?: number; sha256?: string;
  }>;
  append(handle: OpaqueHostHandle, offset: Decimal, value: JsGattValue,
    context: JsHostContext): Promise<{ durableUnits: Decimal }>;
  truncate(handle: OpaqueHostHandle, size: Decimal, context: JsHostContext): Promise<void>;
  read(handle: OpaqueHostHandle, offset: Decimal, maximumLength: number,
    context: JsHostContext): Promise<JsGattValue>;
  finalize(handle: OpaqueHostHandle, expectedCrc32: number | null,
    context: JsHostContext): Promise<{ durableUnits: Decimal; localPath?: string }>;
  remove(handle: OpaqueHostHandle, context: JsHostContext): Promise<void>;
}
export interface JsNetworkPort {
  registerDownload?(registrationId: Decimal, url: string, destination: OpaqueHostHandle,
    context: JsHostContext): Promise<void>;
  unregister?(registrationId: Decimal, context: JsHostContext): Promise<void>;
  /** Registrations hold the exact request/headers/file; no Bota endpoint is inferred. */
  download(registrationId: Decimal,
    onProgress: (completed: Decimal, total: Decimal | null) => void,
    context: JsHostContext): Promise<{ crc32: number }>;
  upload(registrationId: Decimal, source: string,
    onProgress: (completed: Decimal, total: Decimal) => void,
    context: JsHostContext): Promise<void>;
}
export interface JsHostMaterialPort {
  prepare(kind: 'provisioning' | 'factory_reset', metadata: JsValue,
    context: JsHostContext): Promise<OpaqueHostHandle>;
  /** Only public size/generation/context evidence, never protected document bytes. */
  evidence(handle: OpaqueHostHandle, context: JsHostContext): Promise<JsValue>;
  release(handle: OpaqueHostHandle, context: JsHostContext): Promise<void>;
}
export interface JsLifecyclePort {
  current(): 'foreground' | 'background' | 'suspended';
  observe(listener: (state: 'foreground' | 'background' | 'suspended') => void): JsHostSubscription;
  /** True only if this installed host can start/settle JS tasks in the background. */
  backgroundExecution: boolean;
}
export interface BotaJsHostPorts {
  readonly apiVersion: 1;
  readonly platform: string;
  /** Permanently abort this captured scope on logout or account/project/binding change. */
  readonly signal?: AbortSignal;
  readonly checkScope?: () => void;
  readonly ble: JsBlePort;
  readonly persistence: JsPersistencePort;
  readonly randomBytes: (length: number) => Uint8Array | Promise<Uint8Array>;
  readonly files?: JsFilePort;
  readonly network?: JsNetworkPort;
  readonly localWifi?: JsLocalWifiPort;
  readonly material?: JsHostMaterialPort;
  readonly lifecycle?: JsLifecyclePort;
}

export interface JsWorkflowOptions {
  operation: string;
  operationId?: string;
  capabilities?: readonly CoreCapability[];
  signal?: AbortSignal;
  onNotification?: (notification: JsValue) => void;
  onProgress?: (completed: Decimal, total: Decimal) => void;
  /** Application/generation journal must settle before the core receives save acknowledgement. */
  beforeFactoryResetReceipt?: (result: JsValue, context: JsHostContext) => Promise<void>;
}
export interface JsWorkflowResult { notifications: readonly JsValue[] }

/** JS effect mechanics supplied alongside the generated core, never a native SDK workflow. */
export interface JsEffectContext extends JsHostContext {
  emit(kind: JsValue): Promise<void>;
  addCleanup(cleanup: () => Promise<void>): void;
}
export type JsEffectHandler = (effect: JsValue, context: JsEffectContext) => Promise<JsValue | null>;
