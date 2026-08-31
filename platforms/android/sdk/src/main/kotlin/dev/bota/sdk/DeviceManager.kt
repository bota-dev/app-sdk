package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.toPublicError
import dev.bota.sdk.internal.workflowError
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DiscoveredDevice
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

public enum class DeviceCapability {
    Bluetooth,
    Persistence,
    SecureStorage,
    NetworkTransfer,
    RecordingSink,
    FirmwareBlob,
}

public class DeviceCapabilities internal constructor(
    private val values: Set<DeviceCapability>,
) {
    public operator fun contains(capability: DeviceCapability): Boolean = capability in values
    public fun asSet(): Set<DeviceCapability> = values.toSet()
}

public data class DeviceReconnectHint(
    public val storedPeripheralId: String? = null,
    public val advertisedAddress: String? = null,
    public val storedName: String? = null,
    public val scanTimeoutMilliseconds: ULong = 10_000u,
    public val connectionTimeoutMilliseconds: ULong = 10_000u,
)

public class DeviceManager internal constructor() {
    private data class RuntimeLease(val runtime: DeviceRuntime, val generation: Long)
    private data class ActiveOperation(
        val cancellationId: UUID,
        val lease: RuntimeLease,
        var task: Job? = null,
    )
    private data class StatusObserver(
        val runtime: DeviceRuntime,
        val peripheralId: String,
        val channel: SendChannel<DeviceStatus>,
        val task: Job,
    )

    private val lock = Any()
    private var callbackScope: CoroutineScope? = null
    private var runtime: DeviceRuntime? = null
    private var runtimeGeneration: Long = 0
    private var activeOperation: ActiveOperation? = null
    private var connectedDevice: ConnectedDevice? = null
    private val connectionObservers = mutableMapOf<UUID, SendChannel<ConnectedDevice?>>()
    private val statusObservers = mutableMapOf<UUID, StatusObserver>()

    internal fun attach(runtime: DeviceRuntime) {
        synchronized(lock) {
            runtimeGeneration += 1
            this.runtime = runtime
            callbackScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        }
    }

    internal suspend fun detach() {
        val snapshot = synchronized(lock) {
            val value = DetachSnapshot(
                runtime = runtime,
                active = activeOperation,
                connected = connectedDevice,
                status = statusObservers.values.toList(),
                connection = connectionObservers.values.toList(),
                callbackScope = callbackScope,
            )
            runtimeGeneration += 1
            runtime = null
            activeOperation = null
            connectedDevice = null
            statusObservers.clear()
            connectionObservers.clear()
            callbackScope = null
            value
        }
        snapshot.active?.task?.cancel()
        snapshot.active?.let {
            runCatching { it.lease.runtime.engine.cancel(it.cancellationId) }
            it.lease.runtime.operations.end(it.cancellationId)
        }
        snapshot.status.forEach { observer ->
            observer.task.cancel()
            observer.channel.close()
        }
        stopStatusTransports(snapshot.status)
        snapshot.connected?.let { device -> runCatching { snapshot.runtime?.disconnect?.invoke(device.id) } }
        snapshot.runtime?.connection?.clear()
        snapshot.connection.forEach { it.close() }
        snapshot.callbackScope?.cancel()
    }

    public fun capabilities(): DeviceCapabilities = DeviceCapabilities(configuredRuntime().capabilities.publicValues())

    public suspend fun startScan(
        timeoutMilliseconds: ULong = 10_000u,
        allowDuplicates: Boolean = false,
    ): Flow<DiscoveredDevice> = callbackFlow {
        val lease = configuredLease()
        lease.runtime.authorize(BotaOperation.Discover)
        val managerScope = configuredCallbackScope()
        val operation = beginOperation(BotaOperation.Discover, lease = lease)
        val command = CoreCommand.discoverDevices(
            timeoutMilliseconds = timeoutMilliseconds,
            allowDuplicates = allowDuplicates,
            cancellationId = operation.cancellationId,
        )
        val task = launch(start = CoroutineStart.LAZY) {
            var cancelled = false
            try {
                lease.runtime.engine.run(command, lease.runtime.capabilities).collect { notification ->
                    when (notification.kind) {
                        CoreNotificationKind.DeviceDiscovered -> send(notification.discoveredDevice())
                        CoreNotificationKind.Failed -> throw notification.workflowError()
                        CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.Discover)
                        else -> Unit
                    }
                }
                close()
            } catch (error: CancellationException) {
                cancelled = true
                close()
                throw error
            } catch (error: Throwable) {
                close(error.toPublicError())
            } finally {
                withContext(NonCancellable) {
                    if (cancelled) cancelIfActive(operation.cancellationId)
                    else finishOperation(operation.cancellationId)
                }
            }
        }
        synchronized(lock) {
            activeOperation?.takeIf { it.cancellationId == operation.cancellationId }?.task = task
        }
        task.start()
        awaitClose {
            task.cancel()
            managerScope.launch { cancelIfActive(operation.cancellationId) }
        }
    }

    public suspend fun connect(serialNumber: String, device: DiscoveredDevice): ConnectedDevice {
        requireSerial(serialNumber, BotaOperation.Connect)
        return runConnection(
            command = CoreCommand.connect(
                serialNumber = serialNumber,
                peripheralId = device.id,
                name = device.name,
                advertisedAddress = device.macAddress,
                rssi = device.rssi,
            ),
            expectedSerial = serialNumber,
            source = device,
            operation = BotaOperation.Connect,
        )
    }

    public suspend fun connect(device: DiscoveredDevice): ConnectedDevice = runConnection(
        command = CoreCommand.connectSelected(
            peripheralId = device.id,
            name = device.name,
            advertisedAddress = device.macAddress,
            rssi = device.rssi,
        ),
        expectedSerial = null,
        source = device,
        operation = BotaOperation.Connect,
    )

    public suspend fun reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint = DeviceReconnectHint(),
    ): ConnectedDevice {
        requireSerial(serialNumber, BotaOperation.Reconnect)
        return runConnection(
            command = CoreCommand.reconnect(
                serialNumber = serialNumber,
                storedPeripheralId = hint.storedPeripheralId,
                advertisedAddress = hint.advertisedAddress,
                storedName = hint.storedName,
                scanTimeoutMilliseconds = hint.scanTimeoutMilliseconds,
                connectionTimeoutMilliseconds = hint.connectionTimeoutMilliseconds,
            ),
            expectedSerial = serialNumber,
            source = null,
            operation = BotaOperation.Reconnect,
        )
    }

    public suspend fun disconnect() {
        val configured = configuredRuntime()
        val device = synchronized(lock) { connectedDevice } ?: return
        configured.authorize(BotaOperation.Connect)
        stopAllStatusObservers()
        configured.disconnect(device.id)
        synchronized(lock) { if (connectedDevice?.id == device.id) connectedDevice = null }
        configured.connection.clear()
        publishConnection()
    }

    public suspend fun cancelCurrentOperation() {
        val operation = synchronized(lock) {
            activeOperation.also { activeOperation = null }
        } ?: return
        operation.task?.cancel()
        try {
            operation.lease.runtime.engine.cancel(operation.cancellationId)
        } finally {
            operation.lease.runtime.operations.end(operation.cancellationId)
        }
    }

    public fun connectionUpdates(): Flow<ConnectedDevice?> {
        configuredRuntime()
        return callbackFlow {
            val id = UUID.randomUUID()
            val initial = synchronized(lock) {
                connectionObservers[id] = channel
                connectedDevice
            }
            send(initial)
            awaitClose { synchronized(lock) { connectionObservers.remove(id) } }
        }
    }

    public suspend fun readStatus(): DeviceStatus {
        val configured = configuredRuntime()
        val device = requireConnected()
        configured.authorize(BotaOperation.ReadStatus)
        return try {
            configured.decodeStatus(configured.readStatus(device.id))
        } catch (error: Throwable) {
            throw error.toStatusError()
        }
    }

    public fun statusUpdates(): Flow<DeviceStatus> {
        val configured = configuredRuntime()
        val device = requireConnected()
        configured.authorize(BotaOperation.ReadStatus)
        val managerScope = configuredCallbackScope()
        return callbackFlow {
            val id = UUID.randomUUID()
            val task = launch(start = CoroutineStart.LAZY) {
                try {
                    configured.statusUpdates(device.id).collect { send(configured.decodeStatus(it)) }
                    close()
                } catch (error: CancellationException) {
                    close()
                    throw error
                } catch (error: Throwable) {
                    close(error.toStatusError())
                } finally {
                    withContext(NonCancellable) {
                        stopStatusObserver(id, cancelTask = false, closeChannel = false)
                    }
                }
            }
            synchronized(lock) {
                statusObservers[id] = StatusObserver(configured, device.id, channel, task)
            }
            task.start()
            awaitClose {
                task.cancel()
                managerScope.launch { stopStatusObserver(id, cancelTask = true, closeChannel = true) }
            }
        }
    }

    private suspend fun runConnection(
        command: CoreCommand,
        expectedSerial: String?,
        source: DiscoveredDevice?,
        operation: BotaOperation,
    ): ConnectedDevice {
        val lease = configuredLease()
        lease.runtime.authorize(operation)
        val active = beginOperation(operation, command.cancellationId, lease)
        var established: ConnectedDevice? = null
        try {
            source?.let { disconnectDifferentDevice(it.id) }
            lease.runtime.engine.run(command, lease.runtime.capabilities).collect { notification ->
                when (notification.kind) {
                    CoreNotificationKind.ConnectionEstablished -> {
                        val candidate = notification.connectedDevice(source)
                        if (expectedSerial != null && candidate.serialNumber != expectedSerial) {
                            throw identityMismatch(expectedSerial, operation)
                        }
                        established = candidate
                    }
                    CoreNotificationKind.Failed -> throw notification.workflowError()
                    CoreNotificationKind.Cancelled -> throw cancelled(operation)
                    else -> Unit
                }
            }
        } catch (error: CancellationException) {
            withContext(NonCancellable) { cancelIfActive(command.cancellationId) }
            throw error
        } catch (error: Throwable) {
            finishOperation(command.cancellationId)
            throw error.toPublicError()
        }
        val connected = established ?: run {
            finishOperation(command.cancellationId)
            throw coreError(
                BotaErrorCode.ConnectionFailed,
                operation,
                retryable = true,
                "connection completed without verified identity",
            )
        }
        val accepted = synchronized(lock) {
            if (runtime !== active.lease.runtime || runtimeGeneration != active.lease.generation) {
                false
            } else {
                connectedDevice = connected
                true
            }
        }
        if (!accepted) {
            runCatching { active.lease.runtime.disconnect(connected.id) }
            finishOperation(command.cancellationId)
            throw cancelled(operation)
        }
        active.lease.runtime.connection.set(connected)
        publishConnection()
        finishOperation(command.cancellationId)
        return connected
    }

    private fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: throw coreError(
        BotaErrorCode.FeatureUnavailable,
        BotaOperation.Validate,
        retryable = false,
        "BotaDeviceClient.configure() must be called first",
    )

    private fun configuredLease(): RuntimeLease = synchronized(lock) {
        runtime?.let { RuntimeLease(it, runtimeGeneration) }
    } ?: throw coreError(
        BotaErrorCode.FeatureUnavailable,
        BotaOperation.Validate,
        retryable = false,
        "BotaDeviceClient.configure() must be called first",
    )

    private fun beginOperation(
        operation: BotaOperation,
        cancellationId: UUID = UUID.randomUUID(),
        lease: RuntimeLease = configuredLease(),
    ): ActiveOperation {
        lease.runtime.operations.begin(cancellationId, operation)
        try {
            synchronized(lock) {
                if (runtime !== lease.runtime || runtimeGeneration != lease.generation) throw cancelled(operation)
                if (activeOperation != null) throw coreError(
                    BotaErrorCode.OperationInProgress,
                    operation,
                    retryable = false,
                    "another device workflow is already active",
                )
                return ActiveOperation(cancellationId, lease).also { activeOperation = it }
            }
        } catch (error: Throwable) {
            lease.runtime.operations.end(cancellationId)
            throw error
        }
    }

    private fun finishOperation(cancellationId: UUID) {
        val operation = synchronized(lock) {
            activeOperation?.takeIf { it.cancellationId == cancellationId }?.also { activeOperation = null }
        } ?: return
        operation.lease.runtime.operations.end(cancellationId)
    }

    private suspend fun cancelIfActive(cancellationId: UUID) {
        val operation = synchronized(lock) {
            if (activeOperation?.cancellationId != cancellationId) return
            activeOperation.also { activeOperation = null }
        } ?: return
        try {
            runCatching { operation.lease.runtime.engine.cancel(cancellationId) }
        } finally {
            operation.lease.runtime.operations.end(cancellationId)
        }
    }

    private suspend fun disconnectDifferentDevice(nextId: String) {
        val configured = configuredRuntime()
        val current = synchronized(lock) { connectedDevice } ?: return
        if (current.id == nextId) return
        configured.authorize(BotaOperation.Connect)
        stopAllStatusObservers()
        configured.disconnect(current.id)
        synchronized(lock) { if (connectedDevice?.id == current.id) connectedDevice = null }
        configured.connection.clear()
        publishConnection()
    }

    private fun requireConnected(): ConnectedDevice = synchronized(lock) { connectedDevice } ?: throw coreError(
        BotaErrorCode.NotConnected,
        BotaOperation.ReadStatus,
        retryable = true,
        "a verified device connection is required",
    )

    private fun publishConnection() {
        val (device, observers) = synchronized(lock) { connectedDevice to connectionObservers.values.toList() }
        observers.forEach { it.trySend(device) }
    }

    private suspend fun stopStatusObserver(id: UUID, cancelTask: Boolean, closeChannel: Boolean) {
        val (observer, isLast) = synchronized(lock) {
            val removed = statusObservers.remove(id) ?: return
            removed to statusObservers.values.none {
                it.runtime === removed.runtime && it.peripheralId == removed.peripheralId
            }
        }
        if (cancelTask) observer.task.cancel()
        if (closeChannel) observer.channel.close()
        if (isLast) runCatching { observer.runtime.stopStatusUpdates(observer.peripheralId) }
    }

    private suspend fun stopAllStatusObservers() {
        val observers = synchronized(lock) { statusObservers.values.toList().also { statusObservers.clear() } }
        observers.forEach {
            it.task.cancel()
            it.channel.close()
        }
        stopStatusTransports(observers)
    }

    private suspend fun stopStatusTransports(observers: List<StatusObserver>) {
        val transports = mutableListOf<StatusObserver>()
        observers.forEach { observer ->
            if (transports.none { it.runtime === observer.runtime && it.peripheralId == observer.peripheralId }) {
                transports += observer
            }
        }
        transports.forEach {
            runCatching { it.runtime.stopStatusUpdates(it.peripheralId) }
        }
    }

    private fun configuredCallbackScope(): CoroutineScope = synchronized(lock) { callbackScope }
        ?: throw coreError(
            BotaErrorCode.FeatureUnavailable,
            BotaOperation.Validate,
            retryable = false,
            "BotaDeviceClient.configure() must be called first",
        )

    private data class DetachSnapshot(
        val runtime: DeviceRuntime?,
        val active: ActiveOperation?,
        val connected: ConnectedDevice?,
        val status: List<StatusObserver>,
        val connection: List<SendChannel<ConnectedDevice?>>,
        val callbackScope: CoroutineScope?,
    )
}

private fun CoreNotification.discoveredDevice(): DiscoveredDevice = DiscoveredDevice(
    id = requiredText(4),
    name = packet.texts(5).firstOrNull(),
    macAddress = packet.texts(6).firstOrNull(),
    rssi = packet.signed(7)?.toInt() ?: missingField(7),
)

private fun CoreNotification.connectedDevice(source: DiscoveredDevice?): ConnectedDevice = ConnectedDevice(
    id = requiredText(4),
    serialNumber = requiredText(3),
    deviceType = source?.deviceType ?: DeviceType.Unknown(0u),
    firmwareVersion = source?.firmwareVersion ?: "",
    isProvisioned = false,
    connectionState = ConnectionState.Connected,
    mtu = packet.unsigneds(57).firstOrNull()?.toInt() ?: 0,
)

private fun CoreNotification.requiredText(id: Int): String = packet.texts(id).firstOrNull() ?: missingField(id)

private fun missingField(id: Int): Nothing = throw coreError(
    BotaErrorCode.UnexpectedEvent,
    BotaOperation.Decode,
    retryable = false,
    "workflow notification is missing field $id",
)

private fun requireSerial(value: String, operation: BotaOperation) {
    if (value.isBlank()) throw coreError(
        BotaErrorCode.InvalidInput,
        operation,
        retryable = false,
        "serial number is required",
    )
}

private fun identityMismatch(serialNumber: String, operation: BotaOperation): BotaSDKError.Core = coreError(
    BotaErrorCode.IdentityMismatch,
    operation,
    retryable = false,
    "connected device did not verify serial number $serialNumber",
)

private fun cancelled(operation: BotaOperation): BotaSDKError.Core = coreError(
    BotaErrorCode.Cancelled,
    operation,
    retryable = true,
    "device workflow was cancelled",
)

private fun coreError(
    code: BotaErrorCode,
    operation: BotaOperation,
    retryable: Boolean,
    detail: String,
): BotaSDKError.Core = BotaSDKError.Core(code, operation, retryable, null, detail)

private fun Throwable.toPublicError(): Throwable = when (this) {
    is BotaSDKError -> this
    is NativeCoreException -> toPublicError()
    else -> this
}

private fun Throwable.toStatusError(): Throwable = when (this) {
    is BotaSDKError -> this
    is CancellationException -> this
    is NativeCoreException -> toPublicError()
    else -> coreError(
        BotaErrorCode.Internal,
        BotaOperation.ReadStatus,
        retryable = true,
        message ?: "device status transport failed",
    )
}

private fun CoreCapabilities.publicValues(): Set<DeviceCapability> = buildSet {
    if (bits and CoreCapabilities.Bluetooth.bits != 0uL) add(DeviceCapability.Bluetooth)
    if (bits and CoreCapabilities.Persistence.bits != 0uL) add(DeviceCapability.Persistence)
    if (bits and CoreCapabilities.SecureStorage.bits != 0uL) add(DeviceCapability.SecureStorage)
    if (bits and CoreCapabilities.NetworkTransfer.bits != 0uL) add(DeviceCapability.NetworkTransfer)
    if (bits and CoreCapabilities.RecordingSink.bits != 0uL) add(DeviceCapability.RecordingSink)
    if (bits and CoreCapabilities.FirmwareBlob.bits != 0uL) add(DeviceCapability.FirmwareBlob)
}
