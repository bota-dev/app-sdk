import type {
  CoreBridge,
  CoreEffectEnvelope,
  CoreHostEvent,
  CoreNotification,
  CoreOperation,
  CoreWorkflowCheckpoint,
} from './core.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  type BotaOperation,
} from './errors.ts'
import {
  BrowserStorageError,
  type BrowserSdkStorage,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserSubscription,
} from './transport.ts'

export interface WorkflowResult {
  notifications: CoreNotification[]
}

export interface WorkflowEffectContext {
  operationId: string
  cancellationId: Uint8Array
  signal: AbortSignal
  dispatch(event: CoreHostEvent): Promise<void>
  addCleanup(cleanup: () => Promise<void>): void
}

export interface WorkflowEffectHost {
  execute(
    effect: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent | readonly CoreHostEvent[] | null>
  cancel(): Promise<void>
}

export interface WorkflowObserver {
  onNotification?(notification: CoreNotification): void
  onProgress?(completedUnits: bigint, totalUnits: bigint): void
}

export interface WorkflowEffectHosts {
  persistence: WorkflowEffectHost
  recordingSink?: WorkflowEffectHost
  network?: WorkflowEffectHost
  firmwareBlob?: WorkflowEffectHost
  hostMaterial?: WorkflowEffectHost
  encryptedUploadV2?: WorkflowEffectHost
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

type OwnerStepResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'cancelled' }

interface QueuedEffect {
  envelope: CoreEffectEnvelope
  generation: number
}

interface RequestOwner {
  generation: number
  cancellationId: Uint8Array
}

interface RuntimeSubscription {
  serviceUuid: string
  characteristicUuid: string
  subscription: BrowserSubscription
  remove(): Promise<void>
}

interface PendingGattSetup<T> {
  promise: Promise<T>
  settlement: Promise<void>
  cancel(): void
  transferOwnership(): void
}

type FirmwareProgressPhase = Extract<
  CoreNotification,
  { kind: 'firmware_progress' }
>['phase']

interface FirmwareProgressState {
  phase: FirmwareProgressPhase
  completedBytes: bigint
  totalBytes: bigint
}

interface WorkflowOwner {
  kind: 'workflow'
  operationId: string
  operation: BotaOperation
  cancellationId: Uint8Array
  abortController: AbortController
  cancellationAbortController: AbortController | null
  cancellationGeneration: number | null
  hosts: WorkflowEffectHosts
  observer: WorkflowObserver | undefined
  result: Deferred<WorkflowResult>
  notifications: CoreNotification[]
  queue: QueuedEffect[]
  requests: Map<bigint, RequestOwner>
  subscriptions: Map<bigint, RuntimeSubscription>
  timers: Map<bigint, ReturnType<typeof setTimeout>>
  cleanups: Array<() => Promise<void>>
  pendingGattSetups: Set<Promise<void>>
  generation: number
  pumping: boolean
  inlineEffects: QueuedEffect[] | null
  terminal: boolean
  cancelling: boolean
  cancelPromise: Promise<void> | null
  failure: { error: unknown } | null
  failurePromise: Promise<void> | null
  cleanupPromise: Promise<void> | null
  lastProgress: { completedUnits: bigint; totalUnits: bigint } | null
  lastFirmwareProgress: FirmwareProgressState | null
  authorizedScanExhausted: boolean
}

interface DirectOwner {
  kind: 'direct'
  operation: BotaOperation
  abortController: AbortController
  terminalError: BotaSDKError | null
  settled: Promise<void>
}

type MutationOwner = WorkflowOwner | DirectOwner

export class BrowserWorkflowRuntime {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly devices = new Map<string, BrowserDeviceHandle>()
  private activeOwner: MutationOwner | null = null
  private connectedDevice: BrowserDeviceHandle | null = null
  private destroyed = false
  private destroyPromise: Promise<void> | null = null
  private coreDispatchTail: Promise<void> = Promise.resolve()
  private nextConnectionAttempt = 0
  private readonly connectionAttempts = new Map<string, number>()
  private readonly pendingConnectionSettlements = new Map<
    string,
    Promise<void>
  >()

  constructor(core: CoreBridge, transport: BrowserBluetoothTransport) {
    this.core = core
    this.transport = transport
  }

  get connectedDeviceHandle(): BrowserDeviceHandle | null {
    return this.connectedDevice
  }

  registerDevice(device: BrowserDeviceHandle): void {
    this.devices.set(device.id, device)
  }

  registeredDevice(deviceId: string): BrowserDeviceHandle | null {
    return this.devices.get(deviceId) ?? null
  }

  async waitForPendingConnection(deviceId: string): Promise<void> {
    await this.pendingConnectionSettlements.get(deviceId)
  }

  unregisterDevice(deviceId: string): void {
    this.devices.delete(deviceId)
    if (this.connectedDevice?.id === deviceId) this.connectedDevice = null
  }

  markDeviceDisconnected(deviceId: string): void {
    if (this.connectedDevice?.id !== deviceId) return
    this.connectedDevice = null
    const owner = this.activeOwner
    if (!owner) return
    if (owner.kind === 'direct') {
      if (owner.operation === 'disconnect') return
      owner.terminalError ??= new BotaSDKError(
        'device_disconnected',
        owner.operation,
      )
      owner.abortController.abort()
      return
    }
    const generation = owner.generation
    void this.dispatchDeviceDisconnected(
      owner,
      deviceId,
      generation,
    ).catch((error: unknown) => {
      void this.failOwner(owner, error)
    })
  }

  run(
    operationId: string,
    cancellationId: Uint8Array,
    start: () => CoreEffectEnvelope[],
    hosts: WorkflowEffectHosts,
    observer?: WorkflowObserver,
  ): Promise<WorkflowResult> {
    const operation = operationFromId(operationId)
    if (this.destroyed) {
      return Promise.reject(new BotaSDKError('cancelled', operation))
    }
    if (this.activeOwner || this.pendingConnectionSettlements.size > 0) {
      return Promise.reject(new BotaSDKError('operation_in_progress', operation))
    }
    if (operationId.length === 0 || cancellationId.byteLength !== 16) {
      return Promise.reject(new BotaSDKError('invalid_input', operation))
    }

    const result = deferred<WorkflowResult>()
    const owner: WorkflowOwner = {
      kind: 'workflow',
      operationId,
      operation,
      cancellationId: cancellationId.slice(),
      abortController: new AbortController(),
      cancellationAbortController: null,
      cancellationGeneration: null,
      hosts,
      observer,
      result,
      notifications: [],
      queue: [],
      requests: new Map(),
      subscriptions: new Map(),
      timers: new Map(),
      cleanups: [],
      pendingGattSetups: new Set(),
      generation: 0,
      pumping: false,
      inlineEffects: null,
      terminal: false,
      cancelling: false,
      cancelPromise: null,
      failure: null,
      failurePromise: null,
      cleanupPromise: null,
      lastProgress: null,
      lastFirmwareProgress: null,
      authorizedScanExhausted: false,
    }
    this.activeOwner = owner

    try {
      this.enqueueEffects(owner, start(), owner.generation)
    } catch (error) {
      void this.failOwner(owner, error)
    }
    return result.promise
  }

  async cancel(operationId: string): Promise<void> {
    const owner = this.activeOwner
    if (
      !owner
      || owner.kind !== 'workflow'
      || owner.operationId !== operationId
      || owner.terminal
    ) {
      return
    }
    await this.enterCancellation(owner)
  }

  async runExclusive<T>(
    operation: BotaOperation,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.destroyed) throw new BotaSDKError('cancelled', operation)
    if (this.activeOwner || this.pendingConnectionSettlements.size > 0) {
      throw new BotaSDKError('operation_in_progress', operation)
    }

    const abortController = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const owner: DirectOwner = {
      kind: 'direct',
      operation,
      abortController,
      terminalError: null,
      settled,
    }
    this.activeOwner = owner

    try {
      const value = await body(abortController.signal)
      if (owner.terminalError) throw owner.terminalError
      if (abortController.signal.aborted || this.destroyed) {
        throw new BotaSDKError('cancelled', operation)
      }
      return value
    } catch (error) {
      const normalized = normalizeRuntimeError(error, operation)
      if (owner.terminalError) {
        throw normalized.code === 'cancelled'
          ? owner.terminalError
          : normalized
      }
      if (abortController.signal.aborted || this.destroyed) {
        throw new BotaSDKError('cancelled', operation)
      }
      throw normalized
    } finally {
      if (this.activeOwner === owner) this.activeOwner = null
      settle()
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = (async () => {
      const owner = this.activeOwner
      if (!owner) return
      if (owner.kind === 'workflow') {
        await this.cancel(owner.operationId)
        return
      }
      owner.abortController.abort()
      await owner.settled
    })()
    return this.destroyPromise
  }

  private enqueueEffects(
    owner: WorkflowOwner,
    effects: readonly CoreEffectEnvelope[],
    generation: number,
  ): void {
    if (owner.terminal || generation !== owner.generation) return
    const queue = owner.inlineEffects ?? owner.queue
    for (const effect of effects) {
      this.validateEnvelope(owner, effect, generation)
      queue.push({ envelope: effect, generation })
    }
    if (owner.inlineEffects === null) this.ensurePump(owner)
  }

  private async dispatchDeviceDisconnected(
    owner: WorkflowOwner,
    deviceId: string,
    generation: number,
  ): Promise<void> {
    if (
      owner.terminal
      || this.activeOwner !== owner
      || owner.generation !== generation
    ) return
    const requestId = owner.subscriptions.keys().next().value
      ?? owner.requests.keys().next().value
    if (requestId === undefined) {
      throw new BotaSDKError('device_disconnected', owner.operation)
    }
    const effects = await this.serializedCoreCall(() => {
      if (
        owner.terminal
        || this.activeOwner !== owner
        || owner.generation !== generation
      ) return []
      const status = this.core.status()
      if (
        status.kind === 'completed'
        || status.kind === 'cancelled'
        || status.kind === 'failed'
      ) return []
      return this.core.dispatch({
        requestId,
        kind: 'ble_disconnected',
        peripheralId: deviceId,
        reasonCode: null,
      })
    })
    if (
      owner.terminal
      || this.activeOwner !== owner
      || owner.generation !== generation
    ) return
    this.enqueueEffects(owner, effects, generation)
  }

  private validateEnvelope(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    generation: number,
  ): void {
    if (!equalBytes(envelope.cancellationId, owner.cancellationId)) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    const operation = publicOperation(envelope.operation)
    if (owner.operation === 'unknown') owner.operation = operation
    if (operation !== 'unknown' && owner.operation !== operation) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    if (owner.requests.has(envelope.requestId)) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    owner.requests.set(envelope.requestId, {
      generation,
      cancellationId: envelope.cancellationId.slice(),
    })
  }

  private ensurePump(owner: WorkflowOwner): void {
    if (owner.pumping || owner.terminal) return
    owner.pumping = true
    void this.pump(owner).catch(async (error: unknown) => {
      await this.failOwner(owner, error)
    }).finally(() => {
      owner.pumping = false
      if (owner.queue.length > 0 && !owner.terminal) this.ensurePump(owner)
    })
  }

  private async pump(owner: WorkflowOwner): Promise<void> {
    while (owner.queue.length > 0 && !owner.terminal) {
      const queued = owner.queue.shift()
      if (!queued || queued.generation !== owner.generation) continue
      await this.executeEffect(owner, queued)
    }
    if (!owner.terminal && owner.queue.length === 0) {
      await this.finishFromCoreStatus(owner)
    }
  }

  private async finishFromCoreStatus(owner: WorkflowOwner): Promise<void> {
    const status = this.core.status()
    switch (status.kind) {
      case 'completed':
        await this.finishSuccess(owner)
        return
      case 'cancelled':
        await this.finishCancelled(owner)
        return
      case 'failed':
        await this.finishFailure(
          owner,
          normalizeCoreError(status.error, owner.operation),
        )
        return
      case 'idle':
      case 'running':
        return
    }
  }

  private async executeEffect(
    owner: WorkflowOwner,
    queued: QueuedEffect,
  ): Promise<void> {
    const { envelope, generation } = queued
    const context = this.effectContext(owner, envelope, generation)
    const { effect } = envelope

    switch (effect.kind) {
      case 'notify':
        await this.handleNotification(owner, effect.notification)
        return
      case 'ble_start_scan':
        await this.startAuthorizedScan(owner, envelope, context, generation)
        return
      case 'ble_stop_scan':
        await context.dispatch({
          requestId: envelope.requestId,
          kind: 'ble_scan_stopped',
        })
        return
      case 'ble_connect':
        await this.connectDevice(owner, envelope, context, generation)
        return
      case 'ble_discover_services':
        await this.discoverServices(owner, envelope, context, generation)
        return
      case 'ble_disconnect':
        await this.disconnectDevice(envelope, context)
        return
      case 'ble_read':
        await this.readCharacteristic(owner, envelope, context, generation)
        return
      case 'ble_write':
        await this.writeCharacteristic(owner, envelope, context, generation)
        return
      case 'ble_subscribe':
        await this.subscribe(owner, envelope, context, generation)
        return
      case 'ble_unsubscribe':
        await this.unsubscribe(owner, effect.serviceUuid, effect.characteristicUuid)
        return
      case 'timer_schedule':
        await this.scheduleTimer(owner, envelope, context, generation)
        return
      case 'timer_cancel':
        this.cancelTimer(owner, effect.timerId)
        return
      case 'progress':
        this.reportProgress(owner, effect.completedUnits, effect.totalUnits)
        return
      case 'persistence_load_checkpoint':
      case 'persistence_save_checkpoint':
      case 'persistence_delete_checkpoint':
      case 'persistence_save_connection_identity':
        await this.executeHost(
          owner,
          owner.hosts.persistence,
          envelope,
          context,
          generation,
        )
        return
      case 'host_material_prepare_provisioning':
        await this.executeHost(
          owner,
          owner.hosts.hostMaterial,
          envelope,
          context,
          generation,
        )
        return
      case 'recording_sink_truncate':
      case 'recording_sink_append':
      case 'recording_sink_finalize':
      case 'recording_sink_discard':
        await this.executeHost(
          owner,
          owner.hosts.recordingSink,
          envelope,
          context,
          generation,
        )
        return
      case 'network_download':
        await this.executeHost(
          owner,
          owner.hosts.network,
          envelope,
          context,
          generation,
        )
        return
      case 'firmware_blob_read_chunk':
        await this.executeHost(
          owner,
          owner.hosts.firmwareBlob,
          envelope,
          context,
          generation,
        )
        return
      case 'encrypted_upload_v2_load_checkpoint':
      case 'encrypted_upload_v2_delete_checkpoint':
      case 'encrypted_upload_v2_truncate_sink':
      case 'encrypted_upload_v2_prepare_session':
      case 'encrypted_upload_v2_start_transfer':
      case 'encrypted_upload_v2_repair_window':
      case 'encrypted_upload_v2_save_checkpoint':
      case 'encrypted_upload_v2_acknowledge_window':
      case 'encrypted_upload_v2_stage_artifacts':
      case 'encrypted_upload_v2_await_completion_receipt':
      case 'encrypted_upload_v2_confirm_with_receipt':
      case 'encrypted_upload_v2_abort':
        await this.executeHost(
          owner,
          owner.hosts.encryptedUploadV2,
          envelope,
          context,
          generation,
        )
        return
    }

    const unhandledEffect: never = effect
    void unhandledEffect
    throw new BotaSDKError('internal_error', owner.operation)
  }

  private effectContext(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    generation: number,
  ): WorkflowEffectContext {
    const signal = this.ownerSignal(owner, generation)
    const context: WorkflowEffectContext = {
      operationId: owner.operationId,
      cancellationId: owner.cancellationId.slice(),
      signal,
      dispatch: async (event) => {
        await this.dispatchFromContext(owner, envelope, generation, context, event)
      },
      addCleanup: (cleanup) => {
        if (owner.terminal || generation !== owner.generation) {
          void cleanup().catch(() => undefined)
          return
        }
        owner.cleanups.push(cleanup)
      },
    }
    return context
  }

  private async dispatchFromContext(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    generation: number,
    context: WorkflowEffectContext,
    event: CoreHostEvent,
  ): Promise<void> {
    if (owner.terminal || generation !== owner.generation) return
    if (
      event.requestId !== envelope.requestId
      || !equalBytes(context.cancellationId, owner.cancellationId)
    ) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    const request = owner.requests.get(event.requestId)
    if (
      !request
      || request.generation !== generation
      || !equalBytes(request.cancellationId, owner.cancellationId)
    ) {
      throw new BotaSDKError('internal_error', owner.operation)
    }

    const effects = await this.serializedCoreCall(() => {
      if (owner.terminal || generation !== owner.generation) return []
      const status = this.core.status()
      if (
        status.kind === 'completed'
        || status.kind === 'cancelled'
        || status.kind === 'failed'
      ) {
        return []
      }
      return this.core.dispatch(event)
    })
    if (owner.terminal || generation !== owner.generation) return
    this.enqueueEffects(owner, effects, generation)
  }

  private async startAuthorizedScan(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (!this.transport.supportsAuthorizedDevices) {
      throw new BotaSDKError('picker_required', owner.operation)
    }
    const authorizedResult = await this.awaitOwnerStep(
      owner,
      generation,
      this.transport.getAuthorizedDevices(),
    )
    if (authorizedResult.kind === 'cancelled') return
    if (authorizedResult.kind === 'failed') throw authorizedResult.error
    const authorized = authorizedResult.value
    if (owner.terminal || generation !== owner.generation) return
    let forwarded = 0
    for (const device of authorized) {
      if (!this.devices.has(device.id)) continue
      this.devices.set(device.id, device)
      forwarded += 1
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_scan_result',
        candidate: {
          peripheralId: device.id,
          name: device.name,
          advertisedAddress: null,
          rssi: 0,
        },
      })
    }
    owner.authorizedScanExhausted = forwarded === 0
  }

  private async connectDevice(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_connect') return
    const device = this.devices.get(envelope.effect.peripheralId)
    if (!device) {
      await this.dispatchBleFailure(context, envelope.requestId, null)
      return
    }
    const attempt = ++this.nextConnectionAttempt
    this.connectionAttempts.set(device.id, attempt)
    const pendingConnection = this.transport.connect(device)
    const connection = await this.awaitOwnerStep(
      owner,
      generation,
      pendingConnection,
    )
    if (connection.kind === 'cancelled') {
      let settlement!: Promise<void>
      settlement = pendingConnection.then(
        async () => {
          if (
            this.connectionAttempts.get(device.id) === attempt
            && this.connectedDevice?.id !== device.id
          ) {
            await this.transport.disconnect(device).catch(() => undefined)
          }
        },
        () => undefined,
      ).finally(() => {
        if (this.connectionAttempts.get(device.id) === attempt) {
          this.connectionAttempts.delete(device.id)
        }
        if (this.pendingConnectionSettlements.get(device.id) === settlement) {
          this.pendingConnectionSettlements.delete(device.id)
        }
      })
      this.pendingConnectionSettlements.set(device.id, settlement)
      return
    }
    if (this.connectionAttempts.get(device.id) === attempt) {
      this.connectionAttempts.delete(device.id)
    }
    if (connection.kind === 'failed') {
      await this.dispatchBleFailure(
        context,
        envelope.requestId,
        connection.error,
      )
      return
    }
    if (
      owner.terminal
      || generation !== owner.generation
      || owner.abortController.signal.aborted
    ) {
      await this.transport.disconnect(device).catch(() => undefined)
      return
    }
    this.connectedDevice = device
    await context.dispatch({
      requestId: envelope.requestId,
      kind: 'ble_connected',
      peripheralId: device.id,
    })
  }

  private async discoverServices(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_discover_services') return
    const device = this.devices.get(envelope.effect.peripheralId)
    if (!device || this.connectedDevice?.id !== device.id) {
      await this.dispatchBleFailure(context, envelope.requestId, null)
      return
    }
    const discovery = await this.awaitOwnerStep(
      owner,
      generation,
      this.transport.discoverServices(device),
    )
    if (discovery.kind === 'cancelled') return
    if (discovery.kind === 'completed') {
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_services_discovered',
        peripheralId: device.id,
      })
    } else {
      await this.dispatchBleFailure(
        context,
        envelope.requestId,
        discovery.error,
      )
    }
  }

  private async disconnectDevice(
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_disconnect') return
    const device = this.devices.get(envelope.effect.peripheralId)
    try {
      if (device && this.connectedDevice?.id === device.id) {
        await this.transport.disconnect(device)
      }
      if (this.connectedDevice?.id === envelope.effect.peripheralId) {
        this.connectedDevice = null
      }
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_disconnected',
        peripheralId: envelope.effect.peripheralId,
        reasonCode: null,
      })
    } catch (error) {
      await this.dispatchBleFailure(context, envelope.requestId, error)
    }
  }

  private async readCharacteristic(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_read') return
    const device = this.connectedDevice
    if (!device) {
      await this.dispatchBleFailure(context, envelope.requestId, null)
      return
    }
    const read = await this.awaitOwnerStep(
      owner,
      generation,
      this.transport.read(
        device,
        envelope.effect.serviceUuid,
        envelope.effect.characteristicUuid,
      ),
    )
    if (read.kind === 'cancelled') return
    if (read.kind === 'completed') {
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_read_completed',
        value: read.value,
      })
    } else {
      await this.dispatchBleFailure(context, envelope.requestId, read.error)
    }
  }

  private async writeCharacteristic(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_write') return
    const device = this.connectedDevice
    if (!device) {
      await this.dispatchBleFailure(context, envelope.requestId, null)
      return
    }
    const write = await this.awaitOwnerStep(
      owner,
      generation,
      this.transport.write(
        device,
        envelope.effect.serviceUuid,
        envelope.effect.characteristicUuid,
        envelope.effect.payload,
        envelope.effect.withResponse,
      ),
    )
    if (write.kind === 'cancelled') return
    if (write.kind === 'completed') {
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_write_completed',
      })
    } else {
      await this.dispatchBleFailure(context, envelope.requestId, write.error)
    }
  }

  private async subscribe(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'ble_subscribe') return
    const device = this.connectedDevice
    if (!device) {
      await this.dispatchBleFailure(context, envelope.requestId, null)
      return
    }
    const characteristicUuid = envelope.effect.characteristicUuid
    const pendingSubscription = this.trackGattSetup(
      owner,
      generation,
      this.transport.subscribe(
        device,
        envelope.effect.serviceUuid,
        envelope.effect.characteristicUuid,
        (notification) => {
          void context.dispatch({
            requestId: envelope.requestId,
            kind: 'ble_notification',
            characteristicUuid,
            value: notification.value,
          }).catch((error: unknown) => {
            void this.failOwner(owner, error)
          })
        },
      ),
      async (subscription) => subscription.remove(),
    )
    const subscribed = await this.awaitOwnerStep(
      owner,
      generation,
      pendingSubscription.promise,
    )
    if (subscribed.kind === 'cancelled') return
    if (subscribed.kind === 'failed') {
      pendingSubscription.cancel()
      await this.dispatchBleFailure(
        context,
        envelope.requestId,
        subscribed.error,
      )
      return
    }
    const subscription = subscribed.value
    if (owner.terminal || generation !== owner.generation) {
      pendingSubscription.cancel()
      await pendingSubscription.settlement
      return
    }
    try {
      let removal: Promise<void> | null = null
      const runtimeSubscription: RuntimeSubscription = {
        serviceUuid: envelope.effect.serviceUuid,
        characteristicUuid: envelope.effect.characteristicUuid,
        subscription,
        remove: () => {
          removal ??= subscription.remove()
          return removal
        },
      }
      owner.subscriptions.set(envelope.requestId, runtimeSubscription)
      context.addCleanup(runtimeSubscription.remove)
      pendingSubscription.transferOwnership()
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'ble_subscribed',
        characteristicUuid: envelope.effect.characteristicUuid,
      })
    } catch (error) {
      await this.dispatchBleFailure(context, envelope.requestId, error)
    }
  }

  private async unsubscribe(
    owner: WorkflowOwner,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<void> {
    const matches = [...owner.subscriptions.entries()].filter(([, value]) =>
      value.serviceUuid === serviceUuid
      && value.characteristicUuid === characteristicUuid
    )
    for (const [requestId, value] of matches) {
      await value.remove()
      owner.subscriptions.delete(requestId)
    }
  }

  private async scheduleTimer(
    owner: WorkflowOwner,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (envelope.effect.kind !== 'timer_schedule') return
    const effect = envelope.effect
    const delayMs = Number(effect.delayMs)
    if (
      !Number.isSafeInteger(delayMs)
      || delayMs < 0
      || delayMs > 2_147_483_647
    ) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    this.cancelTimer(owner, effect.timerId)
    if (owner.authorizedScanExhausted) {
      owner.authorizedScanExhausted = false
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'timer_fired',
        timerId: effect.timerId,
      })
      return
    }
    const timer = setTimeout(() => {
      owner.timers.delete(effect.timerId)
      if (owner.terminal || generation !== owner.generation) return
      void context.dispatch({
        requestId: envelope.requestId,
        kind: 'timer_fired',
        timerId: effect.timerId,
      }).catch((error: unknown) => {
        void this.failOwner(owner, error)
      })
    }, delayMs)
    owner.timers.set(effect.timerId, timer)
    context.addCleanup(async () => {
      clearTimeout(timer)
      owner.timers.delete(effect.timerId)
    })
  }

  private cancelTimer(owner: WorkflowOwner, timerId: bigint): void {
    const timer = owner.timers.get(timerId)
    if (timer) clearTimeout(timer)
    owner.timers.delete(timerId)
  }

  private async executeHost(
    owner: WorkflowOwner,
    host: WorkflowEffectHost | undefined,
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
    generation: number,
  ): Promise<void> {
    if (!host) {
      throw new BotaSDKError('unsupported_capability', publicOperation(envelope.operation))
    }
    const executed = await this.awaitOwnerStep(
      owner,
      generation,
      host.execute(envelope, context),
    )
    if (executed.kind === 'cancelled') return
    if (executed.kind === 'failed') throw executed.error
    if (!executed.value) return
    const events = Array.isArray(executed.value)
      ? executed.value
      : [executed.value]
    for (const event of events) await context.dispatch(event)
  }

  private async awaitOwnerStep<T>(
    owner: WorkflowOwner,
    generation: number,
    promise: Promise<T>,
  ): Promise<OwnerStepResult<T>> {
    const signal = this.ownerSignal(owner, generation)
    const settled = promise.then<OwnerStepResult<T>, OwnerStepResult<T>>(
      (value) => ({ kind: 'completed', value }),
      (error: unknown) => ({ kind: 'failed', error }),
    )
    if (
      owner.terminal
      || generation !== owner.generation
      || signal.aborted
    ) {
      return { kind: 'cancelled' }
    }

    let resolveCancellation!: () => void
    const cancellation = new Promise<OwnerStepResult<T>>((resolve) => {
      resolveCancellation = () => resolve({ kind: 'cancelled' })
    })
    signal.addEventListener('abort', resolveCancellation, { once: true })
    const result = await Promise.race([settled, cancellation])
    signal.removeEventListener('abort', resolveCancellation)
    return result
  }

  private trackGattSetup<T>(
    owner: WorkflowOwner,
    generation: number,
    promise: Promise<T>,
    cleanup: (value: T) => Promise<void>,
  ): PendingGattSetup<T> {
    const signal = this.ownerSignal(owner, generation)
    let decisionMade = false
    let resolveDecision!: (decision: 'cancelled' | 'transferred') => void
    const decision = new Promise<'cancelled' | 'transferred'>((resolve) => {
      resolveDecision = resolve
    })
    const decide = (value: 'cancelled' | 'transferred'): void => {
      if (decisionMade) return
      decisionMade = true
      signal.removeEventListener('abort', onAbort)
      resolveDecision(value)
    }
    const onAbort = (): void => decide('cancelled')
    signal.addEventListener('abort', onAbort, {
      once: true,
    })
    if (signal.aborted) onAbort()

    let settlement!: Promise<void>
    settlement = promise.then(
      async (value) => {
        const setupDecision = await decision
        if (
          setupDecision === 'cancelled'
          || owner.terminal
          || generation !== owner.generation
        ) {
          await cleanup(value)
        }
      },
      () => undefined,
    ).finally(() => {
      signal.removeEventListener('abort', onAbort)
      owner.pendingGattSetups.delete(settlement)
    })
    owner.pendingGattSetups.add(settlement)

    return {
      promise,
      settlement,
      cancel: () => decide('cancelled'),
      transferOwnership: () => decide('transferred'),
    }
  }

  private async settlePendingGattSetups(owner: WorkflowOwner): Promise<void> {
    let failure: unknown = null
    while (owner.pendingGattSetups.size > 0) {
      const settlements = [...owner.pendingGattSetups]
      const results = await Promise.allSettled(settlements)
      for (const result of results) {
        if (failure === null && result.status === 'rejected') {
          failure = result.reason
        }
      }
    }
    if (failure !== null) throw failure
  }

  private ownerSignal(
    owner: WorkflowOwner,
    generation: number,
  ): AbortSignal {
    if (
      owner.cancellationGeneration === generation
      && owner.cancellationAbortController
    ) {
      return owner.cancellationAbortController.signal
    }
    return owner.abortController.signal
  }

  private async handleNotification(
    owner: WorkflowOwner,
    notification: CoreNotification,
  ): Promise<void> {
    owner.notifications.push(notification)
    try {
      owner.observer?.onNotification?.(notification)
    } catch {
      // Observer failures do not change device workflow state.
    }
    if (notification.kind === 'progress') {
      this.reportProgress(
        owner,
        notification.completedUnits,
        notification.totalUnits,
      )
    } else if (notification.kind === 'firmware_progress') {
      this.reportFirmwareProgress(
        owner,
        notification.phase,
        notification.completedBytes,
        notification.totalBytes,
      )
    }

    switch (notification.kind) {
      case 'completed':
        await this.finishSuccess(owner)
        return
      case 'cancelled':
        await this.finishCancelled(owner)
        return
      case 'failed': {
        const error = normalizeCoreError(notification.error, owner.operation)
        if (owner.cancelling) {
          owner.failure ??= { error }
          await this.finishFailure(owner, owner.failure.error)
        } else {
          await this.failOwner(owner, error)
        }
        return
      }
      default:
        return
    }
  }

  private reportProgress(
    owner: WorkflowOwner,
    completedUnits: bigint,
    totalUnits: bigint,
  ): void {
    if (
      completedUnits < 0n
      || totalUnits < 0n
      || completedUnits > totalUnits
      || (owner.lastProgress !== null
        && (completedUnits < owner.lastProgress.completedUnits
          || totalUnits !== owner.lastProgress.totalUnits))
    ) {
      throw new BotaSDKError('protocol_error', owner.operation)
    }
    owner.lastProgress = { completedUnits, totalUnits }
    try {
      owner.observer?.onProgress?.(completedUnits, totalUnits)
    } catch {
      // Observer failures do not change device workflow state.
    }
  }

  private reportFirmwareProgress(
    owner: WorkflowOwner,
    phase: FirmwareProgressPhase,
    completedBytes: bigint,
    totalBytes: bigint,
  ): void {
    const previous = owner.lastFirmwareProgress
    if (
      completedBytes < 0n
      || totalBytes < 0n
      || completedBytes > totalBytes
      || (previous !== null
        && (firmwarePhaseIndex(phase) < firmwarePhaseIndex(previous.phase)
          || totalBytes !== previous.totalBytes
          || (phase === previous.phase
            && completedBytes < previous.completedBytes)))
    ) {
      throw new BotaSDKError('protocol_error', owner.operation)
    }
    owner.lastFirmwareProgress = { phase, completedBytes, totalBytes }
    try {
      owner.observer?.onProgress?.(completedBytes, totalBytes)
    } catch {
      // Observer failures do not change device workflow state.
    }
  }

  private async dispatchBleFailure(
    context: WorkflowEffectContext,
    requestId: bigint,
    error: unknown,
  ): Promise<void> {
    await context.dispatch({
      requestId,
      kind: 'ble_failed',
      platformCode: platformCode(error),
    })
  }

  private async serializedCoreCall<T>(body: () => T): Promise<T> {
    const result = this.coreDispatchTail.then(body)
    this.coreDispatchTail = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  private enterCancellation(owner: WorkflowOwner): Promise<void> {
    if (owner.cancelPromise) return owner.cancelPromise
    const cancellation = deferred<void>()
    owner.cancelPromise = cancellation.promise
    const started = owner.failure
      ? this.cancelAfterFailure(owner, owner.failure.error)
      : this.cancelOwner(owner)
    void started.then(
      () => cancellation.resolve(undefined),
      cancellation.reject,
    )
    return cancellation.promise
  }

  private async cancelOwner(owner: WorkflowOwner): Promise<void> {
    if (owner.terminal) return
    this.beginCancellation(owner)

    let cleanupError: unknown = null
    try {
      await this.cleanupAndSettle(owner, true)
    } catch (error) {
      cleanupError = error
    }

    try {
      const effects = await this.serializedCoreCall(() =>
        this.core.cancel(owner.cancellationId.slice())
      )
      this.enqueueEffects(owner, effects, owner.generation)
    } catch (error) {
      await this.finishFailure(owner, cleanupError ?? error)
    }

    try {
      await owner.result.promise
    } catch (error) {
      if (
        cleanupError === null
        && error instanceof BotaSDKError
        && error.code === 'cancelled'
      ) {
        return
      }
      throw normalizeRuntimeError(cleanupError ?? error, owner.operation)
    }
  }

  private async finishSuccess(owner: WorkflowOwner): Promise<void> {
    if (owner.terminal) return
    if (owner.failure) {
      await this.finishFailure(owner, owner.failure.error)
      return
    }
    owner.terminal = true
    owner.queue.length = 0
    try {
      await this.cleanupAndSettle(owner, false)
      this.releaseOwner(owner)
      owner.result.resolve({ notifications: [...owner.notifications] })
    } catch (error) {
      this.releaseOwner(owner)
      owner.result.reject(normalizeRuntimeError(error, owner.operation))
    }
  }

  private async finishCancelled(owner: WorkflowOwner): Promise<void> {
    if (owner.terminal) return
    owner.terminal = true
    owner.queue.length = 0
    owner.cancellationAbortController?.abort()
    let cleanupError: unknown = null
    try {
      await this.cleanupAndSettle(owner, true)
    } catch (error) {
      cleanupError = error
    }
    this.releaseOwner(owner)
    if (owner.failure) {
      owner.result.reject(
        normalizeRuntimeError(owner.failure.error, owner.operation),
      )
    } else if (cleanupError !== null) {
      owner.result.reject(normalizeRuntimeError(cleanupError, owner.operation))
    } else {
      owner.result.reject(new BotaSDKError('cancelled', owner.operation))
    }
  }

  private failOwner(owner: WorkflowOwner, error: unknown): Promise<void> {
    if (owner.terminal) return Promise.resolve()
    if (owner.failurePromise) return owner.failurePromise
    owner.failure = { error }
    owner.failurePromise = owner.cancelling
      ? this.finishFailure(owner, error)
      : this.enterCancellation(owner)
    return owner.failurePromise
  }

  private async cancelAfterFailure(
    owner: WorkflowOwner,
    error: unknown,
  ): Promise<void> {
    this.beginCancellation(owner)
    await this.cleanupAndSettle(owner, true).catch(() => undefined)

    let effects: CoreEffectEnvelope[]
    try {
      effects = await this.serializedCoreCall(() =>
        this.core.cancel(owner.cancellationId.slice())
      )
    } catch {
      await this.finishFailure(owner, error)
      return
    }

    try {
      await this.executeCancellationEffects(owner, effects, owner.generation)
    } catch {
      // The originating operation error remains the public terminal failure.
    }
    if (!owner.terminal) await this.finishFailure(owner, error)
  }

  private async executeCancellationEffects(
    owner: WorkflowOwner,
    effects: readonly CoreEffectEnvelope[],
    generation: number,
  ): Promise<void> {
    if (owner.inlineEffects) {
      throw new BotaSDKError('internal_error', owner.operation)
    }
    const queue: QueuedEffect[] = []
    const failures: unknown[] = []
    owner.inlineEffects = queue
    try {
      this.enqueueEffects(owner, effects, generation)
      while (queue.length > 0 && !owner.terminal) {
        const queued = queue.shift()
        if (!queued || queued.generation !== owner.generation) continue
        try {
          await this.executeEffect(owner, queued)
        } catch (error) {
          failures.push(error)
        }
      }
    } finally {
      owner.inlineEffects = null
    }
    if (failures.length > 0) throw failures[0]
  }

  private async finishFailure(
    owner: WorkflowOwner,
    error: unknown,
  ): Promise<void> {
    if (owner.terminal) return
    owner.terminal = true
    owner.abortController.abort()
    owner.cancellationAbortController?.abort()
    owner.queue.length = 0
    await this.cleanupAndSettle(owner, true).catch(() => undefined)
    this.releaseOwner(owner)
    owner.result.reject(normalizeRuntimeError(error, owner.operation))
  }

  private beginCancellation(owner: WorkflowOwner): void {
    owner.cancelling = true
    owner.generation += 1
    owner.abortController.abort()
    owner.queue.length = 0
    owner.cancellationAbortController = new AbortController()
    owner.cancellationGeneration = owner.generation
  }

  private async cleanupAndSettle(
    owner: WorkflowOwner,
    cancelHosts: boolean,
  ): Promise<void> {
    let failure: unknown = null
    try {
      await this.cleanupOwner(owner, cancelHosts)
    } catch (error) {
      failure = error
    }
    try {
      await this.settlePendingGattSetups(owner)
    } catch (error) {
      if (failure === null) failure = error
    }
    if (failure !== null) throw failure
  }

  private cleanupOwner(
    owner: WorkflowOwner,
    cancelHosts: boolean,
  ): Promise<void> {
    if (owner.cleanupPromise) return owner.cleanupPromise
    owner.cleanupPromise = (async () => {
      const failures: unknown[] = []
      if (cancelHosts) {
        const hosts = uniqueHosts(owner.hosts)
        for (const host of hosts) {
          try {
            await host.cancel()
          } catch (error) {
            failures.push(error)
          }
        }
      }
      for (const cleanup of [...owner.cleanups].reverse()) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
      owner.cleanups.length = 0
      for (const timer of owner.timers.values()) clearTimeout(timer)
      owner.timers.clear()
      owner.subscriptions.clear()
      if (failures.length > 0) throw failures[0]
    })()
    return owner.cleanupPromise
  }

  private releaseOwner(owner: WorkflowOwner): void {
    if (this.activeOwner === owner) this.activeOwner = null
  }
}

export function createBrowserPersistenceHost(
  storage: BrowserSdkStorage | null,
  now: () => number = Date.now,
): WorkflowEffectHost {
  return {
    execute: async (envelope, context) => {
      switch (envelope.effect.kind) {
        case 'persistence_load_checkpoint': {
          const checkpoint = storage
            ? await storage.loadWorkflowCheckpoint(context.operationId)
            : null
          return {
            requestId: envelope.requestId,
            kind: 'checkpoint_loaded',
            checkpoint: checkpoint as CoreWorkflowCheckpoint | null,
          }
        }
        case 'persistence_save_checkpoint':
          if (storage) {
            await storage.saveWorkflowCheckpoint(
              context.operationId,
              envelope.effect.checkpoint,
            )
          }
          return { requestId: envelope.requestId, kind: 'checkpoint_saved' }
        case 'persistence_delete_checkpoint':
          if (storage) {
            await storage.deleteWorkflowCheckpoint(context.operationId)
          }
          return null
        case 'persistence_save_connection_identity':
          if (storage) {
            await storage.saveVerifiedDevice({
              schemaVersion: 1,
              serialNumber: envelope.effect.serialNumber,
              browserDeviceId: envelope.effect.candidate.peripheralId,
              name: envelope.effect.candidate.name,
              updatedAtEpochMs: now(),
            })
          }
          return {
            requestId: envelope.requestId,
            kind: 'connection_identity_saved',
          }
        default:
          throw new BotaSDKError(
            'internal_error',
            publicOperation(envelope.operation),
          )
      }
    },
    cancel: async () => undefined,
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function platformCode(error: unknown): number | null {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'number'
  ) {
    return error.code
  }
  return null
}

function uniqueHosts(hosts: WorkflowEffectHosts): WorkflowEffectHost[] {
  return [...new Set([
    hosts.persistence,
    hosts.recordingSink,
    hosts.network,
    hosts.firmwareBlob,
    hosts.hostMaterial,
    hosts.encryptedUploadV2,
  ].filter((host): host is WorkflowEffectHost => host !== undefined))]
}

function firmwarePhaseIndex(phase: FirmwareProgressPhase): number {
  switch (phase) {
    case 'downloading':
      return 0
    case 'awaiting_device':
      return 1
    case 'transferring':
      return 2
    case 'verifying':
      return 3
    case 'rebooting':
      return 4
    case 'reconnecting':
      return 5
    case 'complete':
      return 6
  }
}

function publicOperation(operation: CoreOperation): BotaOperation {
  switch (operation) {
    case 'connect':
      return 'connect'
    case 'reconnect':
      return 'reconnect'
    case 'provision':
      return 'provision'
    case 'transfer_recording':
      return 'transfer_recording'
    case 'upload':
      return 'upload'
    case 'update_firmware':
      return 'update_firmware'
    case 'read_device_logs':
      return 'read_device_logs'
    default:
      return 'unknown'
  }
}

function operationFromId(operationId: string): BotaOperation {
  const prefix = operationId.split(':', 1)[0]
  switch (prefix) {
    case 'connect':
      return 'connect'
    case 'reconnect':
      return 'reconnect'
    case 'provision':
      return 'provision'
    case 'transfer_recording':
      return 'transfer_recording'
    case 'upload':
      return 'upload'
    case 'update_firmware':
      return 'update_firmware'
    case 'read_device_logs':
      return 'read_device_logs'
    default:
      return 'unknown'
  }
}

function normalizeRuntimeError(
  error: unknown,
  operation: BotaOperation,
): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, operation, { cause: error })
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : error.code === 'picker_cancelled'
          ? 'picker_cancelled'
          : 'bluetooth_unavailable'
    return new BotaSDKError(code, operation, { cause: error })
  }
  return normalizeCoreError(error, operation)
}
