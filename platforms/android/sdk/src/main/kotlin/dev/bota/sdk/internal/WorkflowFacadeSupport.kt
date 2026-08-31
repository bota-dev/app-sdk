package dev.bota.sdk.internal

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.jni.NativeCoreException
import kotlinx.coroutines.CancellationException

internal suspend fun awaitWorkflowCompletion(command: CoreCommand, runtime: DeviceRuntime) {
    var completed = false
    try {
        runtime.engine.run(command, runtime.capabilities).collect { notification ->
            when (notification.kind) {
                CoreNotificationKind.Completed -> completed = true
                CoreNotificationKind.Cancelled -> throw BotaSDKError.Core(
                    BotaErrorCode.Cancelled,
                    operation(command.kind),
                    retryable = true,
                    protocolStatus = null,
                    detail = "device workflow was cancelled",
                )
                CoreNotificationKind.Failed -> throw notification.workflowError()
                else -> Unit
            }
        }
    } catch (error: BotaSDKError) {
        throw error
    } catch (error: NativeCoreException) {
        throw error.toPublicError()
    }
    if (!completed) throw BotaSDKError.Core(
        BotaErrorCode.Internal,
        operation(command.kind),
        retryable = true,
        protocolStatus = null,
        detail = "device workflow ended without terminal completion",
    )
}

internal suspend fun runCleanupActions(vararg actions: suspend () -> Unit) {
    var firstFailure: Throwable? = null
    actions.forEach { action ->
        try {
            action()
        } catch (failure: Throwable) {
            val first = firstFailure
            if (first == null) firstFailure = failure else first.addSuppressed(failure)
        }
    }
    firstFailure?.let { throw it }
}

internal suspend fun runCleanupAfter(primaryFailure: Throwable?, vararg actions: suspend () -> Unit) {
    try {
        runCleanupActions(*actions)
    } catch (cleanupFailure: Throwable) {
        if (primaryFailure == null) throw cleanupFailure
        primaryFailure.addSuppressed(cleanupFailure)
    }
}

internal fun CoreNotification.requiredText(id: Int, operation: BotaOperation): String =
    packet.texts(id).firstOrNull() ?: throw malformedNotification(id, operation)

internal fun CoreNotification.requiredUnsigned(id: Int, operation: BotaOperation): ULong =
    packet.unsigneds(id).firstOrNull() ?: throw malformedNotification(id, operation)

internal fun CoreNotification.requiredBoolean(id: Int, operation: BotaOperation): Boolean =
    packet.booleans(id).firstOrNull() ?: throw malformedNotification(id, operation)

internal fun Throwable.facadePublicError(operation: BotaOperation): Throwable = when (this) {
    is BotaSDKError -> this
    is CancellationException -> this
    is NativeCoreException -> toPublicError()
    else -> BotaSDKError.Core(
        BotaErrorCode.Internal,
        operation,
        retryable = true,
        protocolStatus = null,
        detail = message ?: "native workflow facade failed",
    )
}

internal fun cancelled(operation: BotaOperation): BotaSDKError.Core = BotaSDKError.Core(
    BotaErrorCode.Cancelled,
    operation,
    retryable = true,
    protocolStatus = null,
    detail = "device workflow was cancelled",
)

private fun malformedNotification(id: Int, operation: BotaOperation): BotaSDKError.Core = BotaSDKError.Core(
    BotaErrorCode.UnexpectedEvent,
    operation,
    retryable = false,
    protocolStatus = null,
    detail = "workflow notification is missing field $id",
)

private fun operation(commandKind: Int): BotaOperation = when (commandKind) {
    0x0104 -> BotaOperation.Provision
    0x0109, 0x010a -> BotaOperation.FactoryReset
    else -> BotaOperation.Unknown(commandKind.toUInt())
}
