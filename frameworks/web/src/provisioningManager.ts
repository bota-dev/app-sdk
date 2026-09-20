import type {
  CoreBridge,
  CoreConnectionSettings,
  CoreDeviceModel,
  CoreEffectEnvelope,
  CoreHostEvent,
} from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  type BotaOperation,
  type BotaSDKErrorCode,
} from './errors.ts'
import {
  BOTA_CONTROL_SERVICE,
  BOTA_PROVISIONING_SERVICE,
  DEVICE_COMMAND_CHARACTERISTIC,
  DEVICE_INFORMATION_SERVICE,
  DEVICE_SETTINGS_CHARACTERISTIC,
  MODEL_NUMBER_CHARACTERISTIC,
  PROVISIONING_RESULT_CHARACTERISTIC,
  SERIAL_NUMBER_CHARACTERISTIC,
  canonicalGattUuid,
} from './gatt.ts'
import type {
  DeprovisionRequest,
  DeprovisionResult,
  DeviceConnectionSettings,
  ProvisionRequest,
} from './models.ts'
import type {
  ProvisioningMaterial,
  ProvisioningPrepareContext,
  ProvisioningProvider,
} from './providers.ts'
import {
  BrowserStorageError,
  type BrowserSdkStorage,
  type ProvisioningJournal,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserSubscription,
} from './transport.ts'
import {
  BrowserWorkflowRuntime,
  createBrowserPersistenceHost,
  type WorkflowEffectContext,
  type WorkflowEffectHost,
} from './workflowRuntime.ts'

const DEFAULT_DEPROVISION_TIMEOUT_MS = 30_000

interface ProvisioningManagerOptions {
  core: CoreBridge
  transport: BrowserBluetoothTransport
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
  storage?: BrowserSdkStorage | null
  provider?: ProvisioningProvider | null
  now?: () => number
  deprovisionTimeoutMs?: number | undefined
}

interface ActiveProvision {
  controller: AbortController
  operationId: string | null
  physicalCompleted: boolean
  settled: Promise<void>
  settle(): void
}

type Settled<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }

export class ProvisioningManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private readonly storage: BrowserSdkStorage | null
  private readonly provider: ProvisioningProvider | null
  private readonly now: () => number
  private readonly deprovisionTimeoutMs: number
  private activeProvision: ActiveProvision | null = null
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(options: ProvisioningManagerOptions) {
    this.core = options.core
    this.transport = options.transport
    this.runtime = options.runtime
    this.devices = options.devices
    this.storage = options.storage ?? null
    this.provider = options.provider ?? null
    this.now = options.now ?? Date.now
    this.deprovisionTimeoutMs =
      options.deprovisionTimeoutMs ?? DEFAULT_DEPROVISION_TIMEOUT_MS
  }

  async provision(request: ProvisionRequest): Promise<void> {
    this.validateProvisionRequest(request)
    if (!this.provider) {
      throw new BotaSDKError('unsupported_capability', 'provision')
    }
    if (!this.storage) {
      throw new BotaSDKError('storage_unavailable', 'provision')
    }
    if (this.activeProvision) {
      throw new BotaSDKError('operation_in_progress', 'provision')
    }

    let settle!: () => void
    const active: ActiveProvision = {
      controller: new AbortController(),
      operationId: null,
      physicalCompleted: false,
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settle: () => settle(),
    }
    this.activeProvision = active

    const cancel = () => {
      active.controller.abort()
      if (active.operationId) void this.runtime.cancel(active.operationId)
    }
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()

    try {
      await this.runProvision(request.attemptId, active)
    } finally {
      request.signal?.removeEventListener('abort', cancel)
      if (this.activeProvision === active) this.activeProvision = null
      active.settle()
    }
  }

  async deprovision(request: DeprovisionRequest): Promise<DeprovisionResult> {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'deprovision')
    if (!(request.grant instanceof Uint8Array) || request.grant.byteLength === 0) {
      throw new BotaSDKError('invalid_input', 'deprovision')
    }
    if (request.signal?.aborted) {
      throw new BotaSDKError('cancelled', 'deprovision')
    }

    try {
      return await this.runtime.runExclusive('deprovision', async (runtimeSignal) =>
        await withCombinedSignal(
          runtimeSignal,
          request.signal,
          async (signal) => await this.performDeprovision(request.grant, signal),
        )
      )
    } catch (error) {
      const normalized = managerError(error, 'deprovision')
      if (normalized.code === 'identity_mismatch') await this.disconnectMismatch()
      throw normalized
    }
  }

  async readConnectionSettings(): Promise<DeviceConnectionSettings> {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'settings')
    try {
      return await this.runtime.runExclusive('settings', async (signal) => {
        const { device } = await this.verifyConnectedDevice(signal, true, 'settings')
        const encoded = await this.gattStep(
          this.transport.read(
            device,
            BOTA_PROVISIONING_SERVICE,
            DEVICE_SETTINGS_CHARACTERISTIC,
          ),
          signal,
          'settings',
        )
        return publicSettings(this.core.decodeConnectionSettings(encoded))
      })
    } catch (error) {
      const normalized = managerError(error, 'settings')
      if (normalized.code === 'identity_mismatch') await this.disconnectMismatch()
      throw normalized
    }
  }

  async writeConnectionSettings(
    settings: DeviceConnectionSettings,
  ): Promise<void> {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'settings')
    try {
      await this.runtime.runExclusive('settings', async (signal) => {
        const { device, model } = await this.verifyConnectedDevice(
          signal,
          true,
          'settings',
        )
        if (!model) throw new BotaSDKError('protocol_error', 'settings')
        let encoded: Uint8Array | null = null
        try {
          encoded = this.core.encodeConnectionSettings(
            coreSettings(settings),
            model,
          )
          await this.gattStep(
            this.transport.write(
              device,
              BOTA_PROVISIONING_SERVICE,
              DEVICE_SETTINGS_CHARACTERISTIC,
              encoded,
              true,
            ),
            signal,
            'settings',
          )
        } finally {
          encoded?.fill(0)
        }
      })
    } catch (error) {
      const normalized = managerError(error, 'settings')
      if (normalized.code === 'identity_mismatch') await this.disconnectMismatch()
      throw normalized
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = (async () => {
      const active = this.activeProvision
      if (!active) return
      active.controller.abort()
      if (active.operationId) await this.runtime.cancel(active.operationId)
      await active.settled
    })()
    return this.destroyPromise
  }

  private async runProvision(
    attemptId: string,
    active: ActiveProvision,
  ): Promise<void> {
    const storage = this.storage
    const provider = this.provider
    if (!storage || !provider) {
      throw new BotaSDKError('unsupported_capability', 'provision')
    }

    const connected = this.requireConnected('provision')
    let journal: ProvisioningJournal | null
    let journals: ProvisioningJournal[]
    try {
      [journal, journals] = await Promise.all([
        storage.loadProvisioningJournal(attemptId),
        storage.listProvisioningJournals(),
      ])
    } catch (error) {
      throw managerError(error, 'provision')
    }

    if (journal) {
      if (journal.serialNumber !== connected.serialNumber) {
        throw new BotaSDKError('identity_mismatch', 'provision')
      }
      if (journal.phase === 'backend_confirmed') return
      if (journal.phase === 'prepared') {
        await this.requireProvisioningReconciliation(journal)
        return
      }
      if (journal.phase !== 'device_applied') {
        throw new BotaSDKError('resume_rejected', 'provision')
      }
      await this.confirmProvisioning(journal, active.controller.signal)
      return
    }

    const unresolved = journals.find((candidate) =>
      candidate.serialNumber === connected.serialNumber
      && candidate.attemptId !== attemptId
      && (candidate.phase === 'prepared' || candidate.phase === 'device_applied')
    )
    if (unresolved) {
      await this.requireProvisioningReconciliation(unresolved)
      return
    }
    this.throwIfProvisionCancelled(active)

    const cancellationId = randomBytes(16)
    const operationId = `provision:${bytesHex(cancellationId)}`
    const materialId = `web-${bytesHex(randomBytes(16))}`
    active.operationId = operationId
    const host = new ProvisioningMaterialHost({
      provider,
      storage,
      transport: this.transport,
      runtime: this.runtime,
      attemptId,
      materialId,
      serialNumber: connected.serialNumber,
      now: this.now,
    })

    try {
      await this.runtime.run(
        operationId,
        cancellationId,
        () => this.core.startProvisioning({
          serialNumber: connected.serialNumber,
          materialId,
          cancellationId: cancellationId.slice(),
        }),
        {
          persistence: createBrowserPersistenceHost(storage),
          hostMaterial: host,
        },
        undefined,
        async () => {
          active.physicalCompleted = true
          const prepared = host.preparedJournal
          if (!prepared) throw new BotaSDKError('internal_error', 'provision')
          const deviceApplied = nextProvisioningJournal(
            prepared,
            'device_applied',
            this.now,
          )
          await storage.saveProvisioningJournal(deviceApplied)
          await this.confirmProvisioningWhileOwned(deviceApplied)
        },
      )
    } catch (error) {
      const normalized = managerError(error, 'provision')
      if (!active.physicalCompleted && host.prepareStarted) {
        try {
          await host.abort(normalized.code)
          const prepared = host.preparedJournal
          if (prepared) {
            await storage.saveProvisioningJournal(
              nextProvisioningJournal(prepared, 'aborted', this.now),
            )
          }
        } catch {
          throw new BotaSDKError('internal_error', 'provision', {
            retryable: true,
          })
        }
      }
      if (normalized.code === 'identity_mismatch') {
        await this.disconnectMismatch()
      }
      throw normalized
    } finally {
      active.operationId = null
      cancellationId.fill(0)
    }
  }

  private async confirmProvisioning(
    journal: ProvisioningJournal,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.runtime.runExclusive('provision', async (runtimeSignal) =>
        await withCombinedSignal(runtimeSignal, signal, async (combined) => {
          throwIfAborted(combined, 'provision')
          await this.confirmProvisioningWhileOwned(journal)
          throwIfAborted(combined, 'provision')
        })
      )
    } catch (error) {
      const normalized = managerError(error, 'provision')
      if (normalized.code === 'cancelled'
        || normalized.code === 'operation_in_progress'
        || normalized.code === 'storage_unavailable'
        || normalized.code === 'storage_quota_exceeded'
        || normalized.code === 'resume_rejected'
        || normalized.code === 'reconciliation_required') {
        throw normalized
      }
      throw new BotaSDKError('internal_error', 'provision', { retryable: true })
    }
  }

  private async confirmProvisioningWhileOwned(
    journal: ProvisioningJournal,
  ): Promise<void> {
    const provider = this.provider
    const storage = this.storage
    if (!provider || !storage) {
      throw new BotaSDKError('unsupported_capability', 'provision')
    }

    const confirmed = await settled(provider.confirm({
      attemptId: journal.attemptId,
      serialNumber: journal.serialNumber,
    }))
    if (confirmed.kind === 'failed') {
      throw new BotaSDKError('internal_error', 'provision', { retryable: true })
    }
    try {
      await storage.saveProvisioningJournal(
        nextProvisioningJournal(journal, 'backend_confirmed', this.now),
      )
    } catch (error) {
      throw managerError(error, 'provision')
    }
  }

  private async requireProvisioningReconciliation(
    journal: ProvisioningJournal,
  ): Promise<never> {
    return await this.runtime.runExclusive('provision', async (signal) => {
      const connected = this.requireConnected('provision')
      if (journal.serialNumber !== connected.serialNumber) {
        throw new BotaSDKError('identity_mismatch', 'provision')
      }
      await this.verifyConnectedDevice(signal, false, 'provision')
      throw new BotaSDKError('reconciliation_required', 'provision', {
        retryable: true,
      })
    })
  }

  private async performDeprovision(
    callerGrant: Uint8Array,
    signal: AbortSignal,
  ): Promise<DeprovisionResult> {
    const { device } = await this.verifyConnectedDevice(signal, false, 'deprovision')
    const grant = callerGrant.slice()
    let command: Uint8Array | null = null
    let subscription: BrowserSubscription | null = null
    let resultWindowOpen = false
    let resolveResult!: (value: Uint8Array) => void
    const result = new Promise<Uint8Array>((resolve) => {
      resolveResult = resolve
    })
    let resultReceived = false

    try {
      await this.gattStep(
        this.transport.write(
          device,
          BOTA_CONTROL_SERVICE,
          DEVICE_COMMAND_CHARACTERISTIC,
          grant,
          true,
        ),
        signal,
        'deprovision',
      )

      const subscribe = await settled(
        this.transport.subscribe(
          device,
          BOTA_PROVISIONING_SERVICE,
          PROVISIONING_RESULT_CHARACTERISTIC,
          (notification) => {
            if (
              !resultWindowOpen
              || resultReceived
              || canonicalGattUuid(notification.characteristicUuid)
                !== canonicalGattUuid(PROVISIONING_RESULT_CHARACTERISTIC)
            ) return
            resultReceived = true
            resolveResult(notification.value.slice())
          },
        ),
      )
      if (subscribe.kind === 'failed') throw subscribe.error
      subscription = subscribe.value
      throwIfAborted(signal, 'deprovision')

      command = this.core.encodeDeprovisionCommand()
      await this.gattStep(
        this.transport.write(
          device,
          BOTA_CONTROL_SERVICE,
          DEVICE_COMMAND_CHARACTERISTIC,
          command,
          true,
        ),
        signal,
        'deprovision',
      )
      resultWindowOpen = true

      const encodedResult = await resultWithDeadline(
        result,
        signal,
        this.deprovisionTimeoutMs,
      )
      return deprovisionResult(this.core.decodeDeprovisionResult(encodedResult))
    } finally {
      resultWindowOpen = false
      resultReceived = true
      grant.fill(0)
      command?.fill(0)
      if (subscription) await subscription.remove().catch(() => undefined)
    }
  }

  private async verifyConnectedDevice(
    signal: AbortSignal,
    includeModel: boolean,
    operation: BotaOperation,
  ): Promise<{
    device: BrowserDeviceHandle
    model: CoreDeviceModel | null
  }> {
    const connected = this.requireConnected(operation)
    const device = this.runtime.connectedDeviceHandle
    if (!device || device.id !== connected.id) {
      throw new BotaSDKError('device_disconnected', operation)
    }

    const serialBytes = await this.gattStep(
      this.transport.read(
        device,
        DEVICE_INFORMATION_SERVICE,
        SERIAL_NUMBER_CHARACTERISTIC,
      ),
      signal,
      operation,
    )
    if (decodeRequiredText(serialBytes, operation) !== connected.serialNumber) {
      throw new BotaSDKError('identity_mismatch', operation)
    }
    if (!includeModel) return { device, model: null }

    const modelBytes = await this.gattStep(
      this.transport.read(
        device,
        DEVICE_INFORMATION_SERVICE,
        MODEL_NUMBER_CHARACTERISTIC,
      ),
      signal,
      operation,
    )
    const model = deviceModel(decodeRequiredText(modelBytes, operation))
    if (!model) throw new BotaSDKError('protocol_error', operation)
    return { device, model }
  }

  private requireConnected(operation: BotaOperation) {
    const connected = this.devices.connectedDevice
    if (!connected || this.runtime.connectedDeviceHandle?.id !== connected.id) {
      throw new BotaSDKError('device_disconnected', operation)
    }
    return connected
  }

  private async gattStep<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    operation: BotaOperation,
  ): Promise<T> {
    const outcome = await settled(promise)
    if (outcome.kind === 'failed') throw outcome.error
    throwIfAborted(signal, operation)
    return outcome.value
  }

  private validateProvisionRequest(request: ProvisionRequest): void {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'provision')
    if (typeof request.attemptId !== 'string' || request.attemptId.length === 0) {
      throw new BotaSDKError('invalid_input', 'provision')
    }
    if (request.signal?.aborted) {
      throw new BotaSDKError('cancelled', 'provision')
    }
  }

  private throwIfProvisionCancelled(active: ActiveProvision): void {
    if (this.destroyed || active.controller.signal.aborted) {
      throw new BotaSDKError('cancelled', 'provision')
    }
  }

  private async disconnectMismatch(): Promise<void> {
    await this.devices.disconnect().catch(() => undefined)
  }
}

class ProvisioningMaterialHost implements WorkflowEffectHost {
  readonly attemptId: string
  readonly materialId: string
  readonly serialNumber: string
  private readonly provider: ProvisioningProvider
  private readonly storage: BrowserSdkStorage
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly now: () => number
  private cancelled = false
  private currentContext: ProvisioningPrepareContext | null = null
  private currentMaterial: ProvisioningMaterial | null = null
  private durableSettlement: Promise<void> | null = null
  private abortPromise: Promise<void> | null = null
  private didStartPrepare = false
  private journal: ProvisioningJournal | null = null

  constructor(options: {
    provider: ProvisioningProvider
    storage: BrowserSdkStorage
    transport: BrowserBluetoothTransport
    runtime: BrowserWorkflowRuntime
    attemptId: string
    materialId: string
    serialNumber: string
    now: () => number
  }) {
    this.provider = options.provider
    this.storage = options.storage
    this.transport = options.transport
    this.runtime = options.runtime
    this.attemptId = options.attemptId
    this.materialId = options.materialId
    this.serialNumber = options.serialNumber
    this.now = options.now
  }

  get prepareStarted(): boolean {
    return this.didStartPrepare
  }

  get preparedJournal(): ProvisioningJournal | null {
    return this.journal ? { ...this.journal } : null
  }

  async execute(
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent | readonly CoreHostEvent[] | null> {
    if (envelope.effect.kind !== 'host_material_prepare_provisioning') {
      throw new BotaSDKError('internal_error', 'provision')
    }
    const effect = envelope.effect
    const providerContext: ProvisioningPrepareContext = {
      attemptId: this.attemptId,
      materialId: effect.materialId,
      serialNumber: this.serialNumber,
      nonce: effect.nonce.slice(),
      devicePublicKey: effect.devicePublicKey.slice(),
    }
    effect.nonce.fill(0)
    effect.devicePublicKey.fill(0)
    this.currentContext = providerContext

    try {
      if (effect.materialId !== this.materialId) {
        throw new BotaSDKError('internal_error', 'provision')
      }
      const device = this.runtime.connectedDeviceHandle
      if (!device) throw new BotaSDKError('device_disconnected', 'provision')
      const serialBytes = await this.transport.read(
        device,
        DEVICE_INFORMATION_SERVICE,
        SERIAL_NUMBER_CHARACTERISTIC,
      )
      this.throwIfCancelled(context.signal)
      const freshSerial = decodeRequiredText(serialBytes, 'provision')
      if (
        freshSerial !== this.serialNumber
        || effect.serialNumber !== this.serialNumber
      ) {
        throw new BotaSDKError('identity_mismatch', 'provision')
      }
      providerContext.serialNumber = freshSerial

      this.didStartPrepare = true
      const prepared = await settled(this.provider.prepare(providerContext))
      if (prepared.kind === 'failed') {
        return {
          requestId: envelope.requestId,
          kind: 'host_material_failed',
          platformCode: null,
        }
      }
      const material = prepared.value
      this.currentMaterial = material
      this.throwIfCancelled(context.signal)
      if (!validMaterial(material, this.materialId)) {
        return {
          requestId: envelope.requestId,
          kind: 'host_material_failed',
          platformCode: null,
        }
      }

      const journal: ProvisioningJournal = {
        schemaVersion: 1,
        attemptId: this.attemptId,
        materialId: this.materialId,
        serialNumber: freshSerial,
        phase: 'prepared',
        updatedAtEpochMs: this.now(),
      }
      const save = this.storage.saveProvisioningJournal(journal).then(() => {
        this.journal = journal
      })
      this.durableSettlement = save.then(
        () => undefined,
        () => undefined,
      )
      await save
      this.throwIfCancelled(context.signal)
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'provisioning_material_prepared',
        apiEndpoint: material.apiEndpoint,
        deviceToken: material.deviceToken,
        mtu: material.mtu,
      })
      return null
    } finally {
      scrubContext(providerContext)
      if (this.currentContext === providerContext) this.currentContext = null
      if (this.currentMaterial) scrubMaterial(this.currentMaterial)
      this.currentMaterial = null
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.currentContext) scrubContext(this.currentContext)
    if (this.currentMaterial) scrubMaterial(this.currentMaterial)
    await this.durableSettlement
  }

  abort(reason: BotaSDKErrorCode): Promise<void> {
    if (!this.abortPromise) {
      this.abortPromise = this.provider.abort({
        attemptId: this.attemptId,
        serialNumber: this.serialNumber,
        reason,
      })
    }
    return this.abortPromise
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (this.cancelled || signal.aborted) {
      throw new BotaSDKError('cancelled', 'provision')
    }
  }
}

function nextProvisioningJournal(
  previous: ProvisioningJournal,
  phase: ProvisioningJournal['phase'],
  now: () => number,
): ProvisioningJournal {
  return {
    schemaVersion: 1,
    attemptId: previous.attemptId,
    materialId: previous.materialId,
    serialNumber: previous.serialNumber,
    phase,
    updatedAtEpochMs: Math.max(previous.updatedAtEpochMs, now()),
  }
}

function validMaterial(
  material: ProvisioningMaterial,
  expectedMaterialId: string,
): boolean {
  return typeof material.materialId === 'string'
    && material.materialId === expectedMaterialId
    && material.apiEndpoint instanceof Uint8Array
    && material.apiEndpoint.byteLength > 0
    && material.deviceToken instanceof Uint8Array
    && material.deviceToken.byteLength > 0
    && Number.isSafeInteger(material.mtu)
    && material.mtu > 0
}

function scrubContext(context: ProvisioningPrepareContext): void {
  context.nonce.fill(0)
  context.devicePublicKey.fill(0)
}

function scrubMaterial(material: ProvisioningMaterial): void {
  material.apiEndpoint.fill(0)
  material.deviceToken.fill(0)
}

function coreSettings(settings: DeviceConnectionSettings): CoreConnectionSettings {
  return {
    enabledConnections: { ...settings.enabledConnections },
    heartbeatEnabledConnections: { ...settings.heartbeatEnabledConnections },
    uploadNetworkPreference: [...settings.uploadNetworkPreference],
    powerManagement: { ...settings.powerManagement },
    streamingEnabled: settings.streamingEnabled,
    streamingFlushIntervalSeconds: settings.streamingFlushIntervalSeconds,
  }
}

function publicSettings(settings: CoreConnectionSettings): DeviceConnectionSettings {
  return {
    enabledConnections: { ...settings.enabledConnections },
    heartbeatEnabledConnections: { ...settings.heartbeatEnabledConnections },
    uploadNetworkPreference: settings.uploadNetworkPreference.filter(
      (connection): connection is 'wifi' | 'ble' | 'cellular' =>
        connection === 'wifi' || connection === 'ble' || connection === 'cellular',
    ),
    powerManagement: { ...settings.powerManagement },
    streamingEnabled: settings.streamingEnabled,
    streamingFlushIntervalSeconds: settings.streamingFlushIntervalSeconds,
  }
}

function deprovisionResult(result: {
  success: boolean
  error?: string
  errorRaw?: number
}): DeprovisionResult {
  if (result.success) return { success: true }
  const error = result.error === 'invalid_token'
    || result.error === 'storage_error'
    || result.error === 'chunk_error'
    || result.error === 'already_paired'
    ? result.error
    : 'unknown'
  return {
    success: false,
    error,
    ...(typeof result.errorRaw === 'number'
      ? { errorRaw: result.errorRaw }
      : {}),
  }
}

function deviceModel(value: string): CoreDeviceModel | null {
  switch (value.trim().toLowerCase().replace(/[ -]+/g, '_')) {
    case 'bota_note':
    case 'note':
      return 'note'
    case 'pin':
      return 'pin'
    case 'bota_pin':
    case 'bota_pin_4g':
    case 'bota_pin_pro':
    case 'pin_4g':
    case 'pin_pro':
      return 'pin_4g'
    default:
      return null
  }
}

function decodeRequiredText(value: Uint8Array, operation: BotaOperation): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true })
      .decode(value)
      .replace(/^[\0\s]+|[\0\s]+$/g, '')
    if (!decoded) throw new Error('empty')
    return decoded
  } catch {
    throw new BotaSDKError('protocol_error', operation)
  }
}

async function resultWithDeadline(
  result: Promise<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (signal.aborted) throw new BotaSDKError('cancelled', 'deprovision')
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancel!: () => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new BotaSDKError('cancelled', 'deprovision'))
  })
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BotaSDKError('connection_failed', 'deprovision', {
        retryable: true,
      }))
    }, timeoutMs)
  })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([result, cancellation, timeout])
  } finally {
    signal.removeEventListener('abort', cancel)
    if (timer) clearTimeout(timer)
  }
}

async function withCombinedSignal<T>(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  primary.addEventListener('abort', abort, { once: true })
  secondary?.addEventListener('abort', abort, { once: true })
  if (primary.aborted || secondary?.aborted) controller.abort()
  try {
    return await body(controller.signal)
  } finally {
    primary.removeEventListener('abort', abort)
    secondary?.removeEventListener('abort', abort)
  }
}

function throwIfAborted(signal: AbortSignal, operation: BotaOperation): void {
  if (signal.aborted) throw new BotaSDKError('cancelled', operation)
}

async function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return await promise.then<Settled<T>, Settled<T>>(
    (value) => ({ kind: 'completed', value }),
    (error: unknown) => ({ kind: 'failed', error }),
  )
}

function managerError(error: unknown, operation: BotaOperation): BotaSDKError {
  if (error instanceof BotaSDKError) {
    return new BotaSDKError(error.code, operation, {
      retryable: error.retryable,
      protocolStatus: error.protocolStatus,
    })
  }
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, operation)
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, operation)
  }
  const normalized = normalizeCoreError(error, operation)
  return new BotaSDKError(normalized.code, operation, {
    retryable: normalized.retryable,
    protocolStatus: normalized.protocolStatus,
  })
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length)
  globalThis.crypto.getRandomValues(value)
  return value
}

function bytesHex(value: Uint8Array): string {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
