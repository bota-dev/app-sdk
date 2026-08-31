package dev.bota.sdk

import dev.bota.sdk.internal.StreamingOperationState
import dev.bota.sdk.internal.cancelled
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.facadePublicError
import dev.bota.sdk.internal.requiredBoolean
import dev.bota.sdk.internal.requiredText
import dev.bota.sdk.internal.workflowError
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceLogLine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

public class DeviceLogManager internal constructor() {
    private val state = StreamingOperationState("device log")

    internal fun attach(runtime: dev.bota.sdk.internal.DeviceRuntime) = state.attach(runtime)
    internal suspend fun detach() = state.detach()

    public fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine> = callbackFlow {
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val command = CoreCommand.readDeviceLogs(device.serialNumber)
        state.begin(runtime, command.cancellationId, BotaOperation.ReadDeviceLogs)
        val managerScope = state.callbackScope()
        val task = launch(start = CoroutineStart.LAZY) {
            var failure: Throwable? = null
            var wasCancelled = false
            try {
                runtime.engine.run(command, runtime.capabilities).collect { notification ->
                    when (notification.kind) {
                        CoreNotificationKind.DeviceLog -> send(
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
            } catch (error: CancellationException) {
                wasCancelled = true
                throw error
            } catch (error: Throwable) {
                failure = error.facadePublicError(BotaOperation.ReadDeviceLogs)
            } finally {
                withContext(NonCancellable) {
                    val cleanupFailure = runCatching {
                        if (wasCancelled) state.cancel(command.cancellationId, cancelTask = false)
                        else state.finish(command.cancellationId)
                    }.exceptionOrNull()?.facadePublicError(BotaOperation.ReadDeviceLogs)
                    val primary = failure
                    if (primary == null) failure = cleanupFailure else cleanupFailure?.let(primary::addSuppressed)
                    failure?.let(::close) ?: close()
                }
            }
        }
        if (!state.setTask(command.cancellationId, task)) {
            task.cancel()
            close(cancelled(BotaOperation.ReadDeviceLogs))
        } else {
            task.start()
        }
        awaitClose {
            task.cancel()
            managerScope.launch { state.cancel(command.cancellationId, cancelTask = false) }
        }
    }

    public suspend fun stop(): Unit = state.cancelCurrentOperation()
}
