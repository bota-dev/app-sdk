package dev.bota.sdk.internal

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.jni.NativeCoreException

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

private fun operation(commandKind: Int): BotaOperation = when (commandKind) {
    0x0104 -> BotaOperation.Provision
    0x0109, 0x010a -> BotaOperation.FactoryReset
    else -> BotaOperation.Unknown(commandKind.toUInt())
}
