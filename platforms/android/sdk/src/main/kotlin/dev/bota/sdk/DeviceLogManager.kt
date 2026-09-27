package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.cancelled
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.facadePublicError
import dev.bota.sdk.internal.requiredBoolean
import dev.bota.sdk.internal.requiredText
import dev.bota.sdk.internal.workflowError
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceDiagnosticsBatch
import dev.bota.sdk.model.DeviceLogLine
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

public class DeviceLogManager internal constructor(
    private val diagnosticTimeoutMilliseconds: Long = 30_000,
) {
    private data class Active(val id: UUID, val runtime: DeviceRuntime, val job: Job, var cleanupFailure: Throwable? = null)
    private class CleanupFailure(val underlying: Throwable) : RuntimeException(underlying)
    private val lock = Any()
    private var runtime: DeviceRuntime? = null
    private var active: Active? = null

    internal fun attach(runtime: DeviceRuntime) {
        synchronized(lock) {
            if (this.runtime != null && this.runtime !== runtime) active?.job?.cancel()
            this.runtime = runtime
        }
    }

    internal suspend fun detach() {
        val operation = synchronized(lock) { runtime = null; active }
        operation?.job?.cancelAndJoin()
        synchronized(lock) { if (active === operation) active = null }
    }

    public fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine> = flow {
        val command = CoreCommand.readDeviceLogs(device.serialNumber)
        owned(device, command.cancellationId) { configured ->
            try {
                configured.engine.run(command, configured.capabilities).collect { notification ->
                    when (notification.kind) {
                        CoreNotificationKind.DeviceLog -> emit(
                            DeviceLogLine(
                                notification.requiredText(46, BotaOperation.ReadDeviceLogs),
                                notification.requiredBoolean(51, BotaOperation.ReadDeviceLogs),
                            ),
                        )
                        CoreNotificationKind.Failed -> throw notification.workflowError()
                        CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.ReadDeviceLogs)
                        else -> Unit
                    }
                }
                currentCoroutineContext().ensureActive()
            } catch (error: CancellationException) {
                try { withContext(NonCancellable) { configured.engine.cancel(command.cancellationId) } }
                catch (cleanup: Throwable) { throw CleanupFailure(cleanup) }
                throw error
            }
        }
    }

    public suspend fun readDiagnosticEvents(device: ConnectedDevice): DeviceDiagnosticsBatch = owned(device) { configured ->
        try {
            withTimeout(diagnosticTimeoutMilliseconds) { readDiagnostics(device, configured) }
        } catch (_: TimeoutCancellationException) {
            throw failure(BotaErrorCode.Timeout, "device diagnostics timed out")
        }
    }

    public suspend fun acknowledgeDiagnosticEvents(device: ConnectedDevice, acceptedEventIds: List<String>): Unit =
        owned(device) { configured ->
            val generation = configured.connection.generation(device)
            // Rust validates every ID before the first device mutation.
            val commands = acceptedEventIds.map { configured.createDiagnosticCommand(it) }
            for (command in commands) {
                currentCoroutineContext().ensureActive()
                configured.connection.require(device, generation)
                configured.directWrite(device.id, Service, Control, command)
                configured.connection.require(device, generation)
            }
        }

    public suspend fun stop() {
        val operation = synchronized(lock) { active }
        operation?.job?.cancelAndJoin()
        synchronized(lock) { operation?.cleanupFailure }?.let { throw it.facadePublicError(BotaOperation.ReadDeviceLogs) }
    }

    private suspend fun readDiagnostics(device: ConnectedDevice, configured: DeviceRuntime): DeviceDiagnosticsBatch {
        val generation = configured.connection.generation(device)
        configured.decodeDiagnosticEvents(byteArrayOf())
        try {
            val command = configured.createDiagnosticCommand(null)
            try {
                val source = configured.directSubscribe(device.id, Service, Data)
                currentCoroutineContext().ensureActive()
                configured.connection.require(device, generation)
                val batch = coroutineScope {
                    // Register the collector before LIST, including for an unbuffered native flow.
                    val result = async(start = CoroutineStart.UNDISPATCHED) {
                        source.mapNotNull {
                            configured.connection.require(device, generation)
                            configured.decodeDiagnosticEvents(it)
                        }.firstOrNull() ?: throw failure(
                            BotaErrorCode.UnexpectedEvent, "device diagnostics ended without a complete batch",
                        )
                    }
                    configured.directWrite(device.id, Service, Control, command)
                    result.await()
                }
                configured.connection.require(device, generation)
                return batch
            } finally {
                if (configured.connection.ownsGeneration(generation)) {
                    try { withContext(NonCancellable) { configured.directUnsubscribe(device.id, Service, Data) } }
                    catch (error: Throwable) { throw CleanupFailure(error) }
                }
            }
        } finally {
            configured.decodeDiagnosticEvents(byteArrayOf())
        }
    }

    private suspend fun <T> owned(
        device: ConnectedDevice,
        id: UUID = UUID.randomUUID(),
        body: suspend (DeviceRuntime) -> T,
    ): T = coroutineScope {
        val job = currentCoroutineContext().job
        val operation = synchronized(lock) {
            val configured = runtime ?: throw failure(BotaErrorCode.FeatureUnavailable, "configure must be called first")
            if (active != null) throw failure(BotaErrorCode.OperationInProgress, "device logs or diagnostics are already active")
            configured.operations.begin(id, BotaOperation.ReadDeviceLogs)
            Active(id, configured, job).also { active = it }
        }
        try {
            currentCoroutineContext().ensureActive()
            operation.runtime.authorize(BotaOperation.ReadDeviceLogs)
            operation.runtime.connection.require(device)
            body(operation.runtime)
        } catch (error: CleanupFailure) {
            synchronized(lock) { operation.cleanupFailure = error.underlying }
            throw error.underlying.facadePublicError(BotaOperation.ReadDeviceLogs)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            throw error.facadePublicError(BotaOperation.ReadDeviceLogs)
        } finally {
            synchronized(lock) {
                if (operation.cleanupFailure == null) {
                    operation.runtime.operations.end(id)
                    if (active === operation) active = null
                }
            }
        }
    }

    private companion object {
        val Service: UUID = UUID.fromString("b07a0007-0000-1000-8000-00805f9b34fb")
        val Control: UUID = UUID.fromString("b07a0007-0001-1000-8000-00805f9b34fb")
        val Data: UUID = UUID.fromString("b07a0007-0002-1000-8000-00805f9b34fb")

        fun failure(code: BotaErrorCode, detail: String) = BotaSDKError.Core(
            code, BotaOperation.ReadDeviceLogs, retryable = false, protocolStatus = null, detail = detail,
        )
    }
}
