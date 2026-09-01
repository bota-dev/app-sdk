package dev.bota.sdk

import dev.bota.sdk.internal.StreamingOperationState
import dev.bota.sdk.internal.cancelled
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.facadePublicError
import dev.bota.sdk.internal.requiredText
import dev.bota.sdk.internal.requiredUnsigned
import dev.bota.sdk.internal.runCleanupAfter
import dev.bota.sdk.internal.workflowError
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.TransferCommand
import dev.bota.sdk.model.StreamingChunkDestinationProvider
import dev.bota.sdk.model.StreamingFinalizeHandler
import dev.bota.sdk.model.StreamingRecordingEvent
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

public sealed interface RecordingSyncEvent {
    public data class Progress(public val progress: RecordingTransferProgress) : RecordingSyncEvent
    public data class Completed(public val path: Path) : RecordingSyncEvent
}

public data class RecordingTransferMetadata(
    public val isE2EEncrypted: Boolean,
    public val contentSha256Hex: String?,
)

public sealed interface UploadOwnershipResult {
    public data object DeviceUploadCompleted : UploadOwnershipResult
    public data class DeviceUploadPreserved(public val uploadId: String) : UploadOwnershipResult
    public data class BluetoothFallback(
        public val recordingUuid: String,
        public val uploadId: String,
        public val destinationId: String,
    ) : UploadOwnershipResult
}

public sealed interface UploadOwnershipEvent {
    public data class Progress(public val progress: RecordingTransferProgress) : UploadOwnershipEvent
    public data class Result(public val result: UploadOwnershipResult) : UploadOwnershipEvent
}

public class RecordingManager internal constructor() {
    private val state = StreamingOperationState("recording")
    private val transferMetadataBySinkId = ConcurrentHashMap<String, RecordingTransferMetadata>()

    internal fun attach(runtime: dev.bota.sdk.internal.DeviceRuntime) = state.attach(runtime)
    internal suspend fun detach() {
        transferMetadataBySinkId.clear()
        state.detach()
    }

    public suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> {
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val operationId = UUID.randomUUID()
        state.begin(
            runtime,
            operationId,
            BotaOperation.TransferRecording,
            cleanup = {
                runCatching {
                    runtime.directUnsubscribe(
                        device.id,
                        RecordingUUIDs.StorageService,
                        RecordingUUIDs.RecordingList,
                    )
                }
            },
        )
        var failure: Throwable? = null
        try {
            return coroutineScope {
                val task = async(start = CoroutineStart.LAZY) {
                    val notifications = runtime.directSubscribe(
                        device.id,
                        RecordingUUIDs.StorageService,
                        RecordingUUIDs.RecordingList,
                    )
                    val pending = async(start = CoroutineStart.UNDISPATCHED) { notifications.firstOrNull() }
                    val command = runtime.createTransferCommand(TransferCommand.List)
                    runtime.directWrite(
                        device.id,
                        RecordingUUIDs.StorageService,
                        RecordingUUIDs.TransferControl,
                        command,
                    )
                    runtime.parseRecordingList(pending.await() ?: byteArrayOf())
                }
                if (!state.setTask(operationId, task)) {
                    task.cancel()
                    throw cancelled(BotaOperation.TransferRecording)
                }
                task.start()
                task.await()
            }
        } catch (error: Throwable) {
            val publicError = error.facadePublicError(BotaOperation.TransferRecording)
            failure = publicError
            throw publicError
        } finally {
            runCleanupAfter(failure, { state.finish(operationId) })
        }
    }

    public fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String = UUID.randomUUID().toString(),
        confirmOnCompletion: Boolean = true,
    ): Flow<RecordingSyncEvent> = callbackFlow {
        transferMetadataBySinkId.remove(sinkId)
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val command = CoreCommand.transferRecording(
            serialNumber = device.serialNumber,
            recordingUuid = recording.uuid,
            sinkId = sinkId,
            totalUnits = recording.fileSizeBytes,
            confirmOnCompletion = confirmOnCompletion,
        )
        state.begin(
            runtime,
            command.cancellationId,
            BotaOperation.TransferRecording,
            cleanup = { runtime.unregisterRecordingSink(sinkId) },
        )
        val path = try {
            runtime.registerRecordingSink(sinkId)
        } catch (error: Throwable) {
            val publicError = error.facadePublicError(BotaOperation.TransferRecording)
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
                        CoreNotificationKind.Progress -> send(
                            RecordingSyncEvent.Progress(notification.transferProgress(BotaOperation.TransferRecording)),
                        )
                        CoreNotificationKind.Completed -> {
                            transferMetadataBySinkId[sinkId] = notification.transferMetadata()
                            send(RecordingSyncEvent.Completed(path))
                        }
                        CoreNotificationKind.Failed -> throw notification.workflowError()
                        CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.TransferRecording)
                        else -> Unit
                    }
                }
            } catch (error: CancellationException) {
                wasCancelled = true
                throw error
            } catch (error: Throwable) {
                failure = error.facadePublicError(BotaOperation.TransferRecording)
            } finally {
                withContext(NonCancellable) {
                    val cleanupFailure = runCatching {
                        if (wasCancelled) state.cancel(command.cancellationId, cancelTask = false)
                        else state.finish(command.cancellationId)
                    }.exceptionOrNull()?.facadePublicError(BotaOperation.TransferRecording)
                    val primary = failure
                    if (primary == null) failure = cleanupFailure else cleanupFailure?.let(primary::addSuppressed)
                    failure?.let(::close) ?: close()
                }
            }
        }
        if (!state.setTask(command.cancellationId, task)) {
            task.cancel()
            runtime.unregisterRecordingSink(sinkId)
            close(cancelled(BotaOperation.TransferRecording))
        } else {
            task.start()
        }
        awaitClose {
            task.cancel()
            managerScope.launch { state.cancel(command.cancellationId, cancelTask = false) }
        }
    }

    public fun transferMetadata(sinkId: String): RecordingTransferMetadata? =
        transferMetadataBySinkId.remove(sinkId)

    public fun streamRecording(
        device: ConnectedDevice,
        recordingUuid: String,
        sinkId: String = UUID.randomUUID().toString(),
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: ULong,
        destinationProvider: StreamingChunkDestinationProvider,
        finalize: StreamingFinalizeHandler,
    ): Flow<StreamingRecordingEvent> = callbackFlow {
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val command = CoreCommand.streamRecording(device.serialNumber, recordingUuid, sinkId)
        state.begin(
            runtime,
            command.cancellationId,
            BotaOperation.TransferRecording,
            cleanup = { runtime.unregisterStreamingSink(sinkId) },
        )
        try {
            runtime.registerStreamingSink(
                sinkId,
                chunkSizeBytes,
                flushIntervalMilliseconds,
                destinationProvider,
                finalize,
            )
        } catch (error: Throwable) {
            val publicError = error.facadePublicError(BotaOperation.TransferRecording)
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
                        CoreNotificationKind.StreamingPaused -> send(
                            StreamingRecordingEvent.Paused(
                                notification.requiredUnsigned(36, BotaOperation.TransferRecording),
                            ),
                        )
                        CoreNotificationKind.StreamingResumed -> send(StreamingRecordingEvent.Resumed)
                        CoreNotificationKind.StreamingCompleted -> send(
                            StreamingRecordingEvent.Completed(
                                notification.requiredUnsigned(15, BotaOperation.TransferRecording),
                                notification.requiredUnsigned(126, BotaOperation.TransferRecording).toUInt(),
                                notification.packet.booleans(90).firstOrNull() ?: false,
                            ),
                        )
                        CoreNotificationKind.Failed -> throw notification.workflowError()
                        CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.TransferRecording)
                        else -> Unit
                    }
                }
            } catch (error: CancellationException) {
                wasCancelled = true
                throw error
            } catch (error: Throwable) {
                failure = error.facadePublicError(BotaOperation.TransferRecording)
            } finally {
                withContext(NonCancellable) {
                    val cleanupFailure = runCatching {
                        if (wasCancelled) state.cancel(command.cancellationId, cancelTask = false)
                        else state.finish(command.cancellationId)
                    }.exceptionOrNull()?.facadePublicError(BotaOperation.TransferRecording)
                    val primary = failure
                    if (primary == null) failure = cleanupFailure else cleanupFailure?.let(primary::addSuppressed)
                    failure?.let(::close) ?: close()
                }
            }
        }
        if (!state.setTask(command.cancellationId, task)) {
            task.cancel()
            close(cancelled(BotaOperation.TransferRecording))
        } else {
            task.start()
        }
        awaitClose {
            task.cancel()
            managerScope.launch { state.cancel(command.cancellationId, cancelTask = false) }
        }
    }

    public fun observeUploadOwnership(
        device: ConnectedDevice,
        recordingUuid: String,
        uploadId: String,
        destinationId: String,
    ): Flow<UploadOwnershipEvent> = callbackFlow {
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val command = CoreCommand.uploadRecording(device.serialNumber, recordingUuid, uploadId, destinationId)
        state.begin(runtime, command.cancellationId, BotaOperation.Upload)
        val managerScope = state.callbackScope()
        val task = launch(start = CoroutineStart.LAZY) {
            var result: UploadOwnershipResult = UploadOwnershipResult.DeviceUploadCompleted
            var failure: Throwable? = null
            var wasCancelled = false
            try {
                runtime.engine.run(command, runtime.capabilities).collect { notification ->
                    when (notification.kind) {
                        CoreNotificationKind.Progress -> send(
                            UploadOwnershipEvent.Progress(notification.transferProgress(BotaOperation.Upload)),
                        )
                        CoreNotificationKind.DeviceUploadPreserved -> {
                            result = UploadOwnershipResult.DeviceUploadPreserved(
                                notification.requiredText(16, BotaOperation.Upload),
                            )
                        }
                        CoreNotificationKind.BleFallbackReady -> {
                            result = UploadOwnershipResult.BluetoothFallback(
                                notification.requiredText(13, BotaOperation.Upload),
                                notification.requiredText(16, BotaOperation.Upload),
                                notification.requiredText(17, BotaOperation.Upload),
                            )
                        }
                        CoreNotificationKind.Completed -> send(UploadOwnershipEvent.Result(result))
                        CoreNotificationKind.Failed -> throw notification.workflowError()
                        CoreNotificationKind.Cancelled -> throw cancelled(BotaOperation.Upload)
                        else -> Unit
                    }
                }
            } catch (error: CancellationException) {
                wasCancelled = true
                throw error
            } catch (error: Throwable) {
                failure = error.facadePublicError(BotaOperation.Upload)
            } finally {
                withContext(NonCancellable) {
                    val cleanupFailure = runCatching {
                        if (wasCancelled) state.cancel(command.cancellationId, cancelTask = false)
                        else state.finish(command.cancellationId)
                    }.exceptionOrNull()?.facadePublicError(BotaOperation.Upload)
                    val primary = failure
                    if (primary == null) failure = cleanupFailure else cleanupFailure?.let(primary::addSuppressed)
                    failure?.let(::close) ?: close()
                }
            }
        }
        if (!state.setTask(command.cancellationId, task)) {
            task.cancel()
            close(cancelled(BotaOperation.Upload))
        } else {
            task.start()
        }
        awaitClose {
            task.cancel()
            managerScope.launch { state.cancel(command.cancellationId, cancelTask = false) }
        }
    }

    public suspend fun confirmRecording(device: ConnectedDevice, recordingUuid: String) {
        val runtime = state.configuredRuntime()
        runtime.connection.require(device)
        val operationId = UUID.randomUUID()
        state.begin(runtime, operationId, BotaOperation.TransferRecording)
        var failure: Throwable? = null
        try {
            runtime.directWrite(
                device.id,
                RecordingUUIDs.StorageService,
                RecordingUUIDs.TransferControl,
                runtime.createTransferCommand(TransferCommand.Confirm(recordingUuid)),
            )
        } catch (error: Throwable) {
            val publicError = error.facadePublicError(BotaOperation.TransferRecording)
            failure = publicError
            throw publicError
        } finally {
            runCleanupAfter(failure, { state.finish(operationId) })
        }
    }

    public suspend fun cancelCurrentOperation(): Unit = state.cancelCurrentOperation()
}

private fun dev.bota.sdk.internal.core.CoreNotification.transferMetadata(): RecordingTransferMetadata =
    RecordingTransferMetadata(
        isE2EEncrypted = packet.booleans(90).firstOrNull() ?: false,
        contentSha256Hex = packet.bytes(123)?.joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        },
    )

private fun dev.bota.sdk.internal.core.CoreNotification.transferProgress(
    operation: BotaOperation,
): RecordingTransferProgress = RecordingTransferProgress(
    completedBytes = requiredUnsigned(36, operation),
    totalBytes = requiredUnsigned(15, operation),
)

private object RecordingUUIDs {
    val StorageService: UUID = UUID.fromString("b07a0004-0000-1000-8000-00805f9b34fb")
    val RecordingList: UUID = UUID.fromString("b07a0004-0001-1000-8000-00805f9b34fb")
    val TransferControl: UUID = UUID.fromString("b07a0004-0002-1000-8000-00805f9b34fb")
}
