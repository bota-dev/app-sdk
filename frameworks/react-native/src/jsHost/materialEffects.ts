import { Buffer } from 'buffer';
import type { NativeProvisioningMaterial } from '../specs/NativeBotaDeviceSDK';
import type { JsEffectContext, JsEffectHandler, JsHostContext, JsValue, RawJsCoreFactory } from './contracts';
import { BotaJsHostError } from './executor';

export interface JsMaterialEffectsOptions {
  core: Pick<RawJsCoreFactory, 'codec'>;
  emit(event: string, value: unknown): void;
  /** Checks the active executor owner and captured physical connection/scope. */
  checkOwner(context: JsHostContext, serialNumber: string): void;
}
type Registration = { kind: 'provisioning'; serialNumber: string } |
  { kind: 'factory_reset'; serialNumber: string; commandId: string; bindingGeneration: number };
interface Pending {
  context: JsEffectContext;
  registration: Registration;
  resolve(value: JsValue): void;
  reject(error: unknown): void;
  release(): void;
}

/** Application material broker only. Shared Rust validates and sequences device writes. */
export class JsMaterialEffects {
  private readonly options: JsMaterialEffectsOptions;
  private readonly registrations = new Map<string, Registration>();
  private readonly requests = new Map<string, Pending>();
  private readonly persistenceRequests = new Map<string, {
    context: JsHostContext; serialNumber: string; resolve(): void; reject(error: unknown): void;
  }>();

  constructor(options: JsMaterialEffectsOptions) { this.options = options; }

  registerProvisioning(operationId: string, input: { serialNumber: string }): void {
    this.register(operationId, { kind: 'provisioning', serialNumber: input.serialNumber });
  }

  registerFactoryReset(operationId: string, input: {
    serialNumber: string; commandId: string; bindingGeneration: number;
  }): void {
    if (!Number.isInteger(input.bindingGeneration) || input.bindingGeneration < 1 || input.bindingGeneration > 0xffffffff ||
        !input.commandId || input.commandId.length > 128 || /\s/.test(input.commandId)) {
      throw new BotaJsHostError('invalid_factory_reset_identity', 'FactoryReset');
    }
    this.register(operationId, { kind: 'factory_reset', ...input });
  }

  release(operationId: string): void {
    this.registrations.delete(operationId);
    for (const request of [...this.requests.values()]) {
      if (request.context.operationId === operationId) request.reject(new BotaJsHostError('operation_cancelled', request.context.operation));
    }
  }

  handler: JsEffectHandler = async (effect, context): Promise<JsValue> => {
    const entries = Object.entries(object(effect));
    if (entries.length !== 1) throw new BotaJsHostError('invalid_core_effect', context.operation);
    const [kind, value] = entries[0]!;
    const fields = object(value);
    const registration = this.registrations.get(context.operationId);
    const expectedKind = kind === 'PrepareProvisioning' ? 'provisioning' : kind === 'PrepareFactoryResetGrant' ? 'factory_reset' : null;
    if (!registration || registration.kind !== expectedKind || fields.device !== registration.serialNumber) {
      throw new BotaJsHostError('material_identity_mismatch', context.operation);
    }
    this.check(context, registration);
    const requestId = `material:${context.operationId}:${context.generation}:${context.requestId}`;
    if (this.requests.has(requestId)) throw new BotaJsHostError('duplicate_material_request', context.operation);
    return new Promise<JsValue>((resolve, reject) => {
      const release = () => { this.requests.delete(requestId); context.signal.removeEventListener('abort', abort); };
      const request: Pending = {
        context, registration, release,
        resolve(result) { release(); resolve(result); },
        reject(error) { release(); reject(error); },
      };
      const abort = () => request.reject(new BotaJsHostError('operation_cancelled', context.operation));
      this.requests.set(requestId, request);
      context.signal.addEventListener('abort', abort, { once: true });
      context.addCleanup(async () => { request.reject(new BotaJsHostError('operation_cancelled', context.operation)); });
      try {
        this.check(context, registration);
        const nonce = byteArray(fields.nonce, 16);
        const common = { requestId, serialNumber: registration.serialNumber, nonce: Buffer.from(nonce).toString('hex') };
        if (registration.kind === 'provisioning') {
          const publicKey = byteArray(fields.device_public_key, 64);
          this.options.emit('onProvisioningMaterialRequested', { ...common, devicePublicKey: Buffer.from(publicKey).toString('hex') });
        } else {
          this.options.emit('onFactoryResetGrantRequested', { ...common, commandId: registration.commandId,
            bindingGeneration: registration.bindingGeneration });
        }
      } catch (error) { request.reject(error); }
    });
  };

  async resolveProvisioningMaterial(requestId: string, input: NativeProvisioningMaterial): Promise<void> {
    const request = this.require(requestId, 'provisioning');
    try {
      this.check(request.context, request.registration);
      if (!input || typeof input.apiEndpoint !== 'string' || input.deviceToken !== '' || typeof input.credentialEnvelope !== 'string' ||
          !Number.isInteger(input.mtu) || input.mtu < 23 || input.mtu > 517 ||
          Buffer.byteLength(input.apiEndpoint, 'utf8') > 4096) {
        throw new BotaJsHostError('invalid_provisioning_material', request.context.operation);
      }
      const encoded = input.credentialEnvelope;
      if (!/^[A-Za-z0-9_-]{307,1024}$/.test(encoded)) {
        throw new BotaJsHostError('invalid_provisioning_material', request.context.operation);
      }
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded || bytes.length < 230 || bytes.length > 768) {
        throw new BotaJsHostError('invalid_provisioning_material', request.context.operation);
      }
      const envelope = Array.from(bytes);
      request.resolve({ ProvisioningMaterialPrepared: { material: {
        api_endpoint: Array.from(Buffer.from(input.apiEndpoint, 'utf8')),
        device_token: [], credential_envelope: envelope, mtu: input.mtu,
      } } });
    } catch (error) { request.reject(error); throw error; }
  }

  async resolveFactoryResetGrant(requestId: string, grantBlob: string): Promise<void> {
    const request = this.require(requestId, 'factory_reset');
    try {
      this.check(request.context, request.registration);
      const registration = request.registration as Extract<Registration, { kind: 'factory_reset' }>;
      const grant = this.options.core.codec('validateFactoryResetGrant', { grantBlob, bindingGeneration: String(registration.bindingGeneration) });
      request.resolve({ FactoryResetGrantPrepared: { grant: byteArray(grant) } });
    } catch (error) { request.reject(error); throw error; }
  }

  async rejectApplicationMaterial(requestId: string, _message?: string): Promise<void> {
    const request = this.requests.get(requestId);
    request?.reject(new BotaJsHostError('application_material_rejected', request.context.operation));
    const persistence = this.persistenceRequests.get(requestId);
    persistence?.reject(new BotaJsHostError('application_persistence_rejected', persistence.context.operation));
  }

  /** The SDK journal has already settled. The app acknowledgement must precede the device receipt. */
  requestFactoryResetPersistence(serialNumber: string, localRecordingsDeleted: number,
    context: JsHostContext): Promise<void> {
    this.options.checkOwner(context, serialNumber);
    const requestId = `reset-persistence:${context.operationId}:${context.generation}:${context.requestId}`;
    if (this.persistenceRequests.has(requestId)) throw new BotaJsHostError('duplicate_material_request', context.operation);
    return new Promise<void>((resolve, reject) => {
      const release = () => {
        this.persistenceRequests.delete(requestId);
        context.signal.removeEventListener('abort', abort);
      };
      const request = { context, serialNumber,
        resolve() { release(); resolve(); }, reject(error: unknown) { release(); reject(error); } };
      const abort = () => request.reject(new BotaJsHostError('operation_cancelled', context.operation));
      this.persistenceRequests.set(requestId, request);
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        this.options.checkOwner(context, serialNumber);
        this.options.emit('onFactoryResetResultPersistenceRequested', { requestId, localRecordingsDeleted });
      } catch (error) { request.reject(error); }
    });
  }

  async resolveFactoryResetResultPersistence(requestId: string): Promise<void> {
    const request = this.persistenceRequests.get(requestId);
    if (!request) throw new BotaJsHostError('stale_material_request', 'FactoryReset');
    try { this.options.checkOwner(request.context, request.serialNumber); request.resolve(); }
    catch (error) { request.reject(error); throw error; }
  }

  private register(operationId: string, value: Registration): void {
    if (!operationId || operationId.length > 256 || this.registrations.has(operationId) || !value.serialNumber) {
      throw new BotaJsHostError('invalid_material_registration', 'HostMaterial');
    }
    this.registrations.set(operationId, Object.freeze({ ...value }));
  }

  private require(requestId: string, kind: Registration['kind']): Pending {
    const request = this.requests.get(requestId);
    if (!request || request.registration.kind !== kind) throw new BotaJsHostError('stale_material_request', 'HostMaterial');
    return request;
  }

  private check(context: JsHostContext, registration: Registration): void {
    if (context.signal.aborted || this.registrations.get(context.operationId) !== registration) {
      throw new BotaJsHostError('operation_cancelled', context.operation);
    }
    this.options.checkOwner(context, registration.serialNumber);
  }
}

function object(value: JsValue): { readonly [key: string]: JsValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotaJsHostError('invalid_core_effect', 'HostMaterial');
  return value as { readonly [key: string]: JsValue };
}
function byteArray(value: JsValue | undefined, length?: number): number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length) || value.length > 65536 ||
      value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new BotaJsHostError('invalid_core_bytes', 'HostMaterial');
  }
  return [...value] as number[];
}
