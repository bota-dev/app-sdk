package dev.bota.sdk

import dev.bota.sdk.internal.StreamingOperationState
import dev.bota.sdk.internal.cancelled
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.facadePublicError
import dev.bota.sdk.internal.requiredUnsigned
import dev.bota.sdk.internal.runCleanupAfter
import dev.bota.sdk.internal.workflowError
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request

public data class FirmwareImage(
    public val version: String,
    public val sizeBytes: UInt,
    public val crc32: UInt,
    public val downloadId: ULong,
    public val request: Request,
)

public class OTAManager internal constructor() {
    private val state = StreamingOperationState("firmware update")

    internal fun attach(runtime: dev.bota.sdk.internal.DeviceRuntime) = state.attach(runtime)
    internal suspend fun detach() = state.detach()

    public fun updateFirmware(device: ConnectedDevice, image: FirmwareImage): Flow<FirmwareUpdateProgress> =
        callbackFlow {
            val runtime = state.configuredRuntime()
            runtime.connection.require(device)
            val command = CoreCommand.updateFirmware(
                serialNumber = device.serialNumber,
                version = image.version,
                sizeBytes = image.sizeBytes,
                crc32 = image.crc32,
                downloadId = image.downloadId,
            )
            state.begin(
                runtime,
                command.cancellationId,
                BotaOperation.UpdateFirmware,
                cleanup = { runtime.unregisterFirmwareDownload(image.downloadId) },
            )
            try {
                runtime.registerFirmwareDownload(image.downloadId, image.request)
            } catch (error: Throwable) {
                val publicError = error.facadePublicError(BotaOperation.UpdateFirmware)
                runCleanupAfter(publicError, { state.finish(command.cancellationId) })
                throw publicError
            }
            val managerScope = state.callbackScope()
            val task = launch(start = CoroutineStart.LAZY) {
                var failure: Throwable? = null
                var wasCancelled = false
                try {
                    runtime.engine.run(command, runtime.capabilities).collect { notification ->
                        when (notification.kind) {
                            CoreNotificationKind.FirmwareProgress -> send(notification.firmwareProgress())
                            CoreNotificationKind.Failed -> throw notification.workflowError()
                            CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.UpdateFirmware)
                            else -> Unit
                        }
                    }
                } catch (error: CancellationException) {
                    wasCancelled = true
                    throw error
                } catch (error: Throwable) {
                    failure = error.facadePublicError(BotaOperation.UpdateFirmware)
                } finally {
                    withContext(NonCancellable) {
                        val cleanupFailure = runCatching {
                            if (wasCancelled) state.cancel(command.cancellationId, cancelTask = false)
                            else state.finish(command.cancellationId)
                        }.exceptionOrNull()?.facadePublicError(BotaOperation.UpdateFirmware)
                        val primary = failure
                        if (primary == null) failure = cleanupFailure else cleanupFailure?.let(primary::addSuppressed)
                        failure?.let(::close) ?: close()
                    }
                }
            }
            if (!state.setTask(command.cancellationId, task)) {
                task.cancel()
                runtime.unregisterFirmwareDownload(image.downloadId)
                close(cancelled(BotaOperation.UpdateFirmware))
            } else {
                task.start()
            }
            awaitClose {
                task.cancel()
                managerScope.launch { state.cancel(command.cancellationId, cancelTask = false) }
            }
        }

    public suspend fun cancelCurrentOperation(): Unit = state.cancelCurrentOperation()
}

private fun dev.bota.sdk.internal.core.CoreNotification.firmwareProgress(): FirmwareUpdateProgress {
    val rawPhase = requiredUnsigned(45, BotaOperation.UpdateFirmware)
    val phase = when (rawPhase) {
        1uL -> FirmwareUpdatePhase.Downloading
        2uL -> FirmwareUpdatePhase.AwaitingDevice
        3uL -> FirmwareUpdatePhase.Transferring
        4uL -> FirmwareUpdatePhase.Verifying
        5uL -> FirmwareUpdatePhase.Rebooting
        6uL -> FirmwareUpdatePhase.Reconnecting
        7uL -> FirmwareUpdatePhase.Complete
        else -> throw BotaSDKError.Core(
            BotaErrorCode.UnknownPacket,
            BotaOperation.UpdateFirmware,
            retryable = false,
            protocolStatus = null,
            detail = "unknown firmware phase $rawPhase",
        )
    }
    return FirmwareUpdateProgress(
        phase,
        completedBytes = requiredUnsigned(36, BotaOperation.UpdateFirmware),
        totalBytes = requiredUnsigned(15, BotaOperation.UpdateFirmware),
    )
}
