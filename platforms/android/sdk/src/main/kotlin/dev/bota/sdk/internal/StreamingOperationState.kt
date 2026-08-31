package dev.bota.sdk.internal

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

internal class StreamingOperationState(private val label: String) {
    private data class Active(
        val id: UUID,
        val runtime: DeviceRuntime,
        val cleanup: suspend () -> Unit,
        var task: Job? = null,
    )

    private val lock = Any()
    private var runtime: DeviceRuntime? = null
    private var active: Active? = null
    private var callbackScope: CoroutineScope? = null

    fun attach(runtime: DeviceRuntime) {
        synchronized(lock) {
            this.runtime = runtime
            callbackScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        }
    }

    suspend fun detach() {
        val snapshot = synchronized(lock) {
            val value = active to callbackScope
            active = null
            runtime = null
            callbackScope = null
            value
        }
        val operation = snapshot.first
        operation?.task?.cancel()
        try {
            if (operation != null) {
                runCleanupActions(
                    { runCatching { operation.runtime.engine.cancel(operation.id) } },
                    operation.cleanup,
                    { operation.runtime.operations.end(operation.id) },
                )
            }
        } finally {
            snapshot.second?.cancel()
        }
    }

    fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: throw BotaSDKError.Core(
        BotaErrorCode.FeatureUnavailable,
        BotaOperation.Validate,
        retryable = false,
        protocolStatus = null,
        detail = "BotaDeviceClient.configure() must be called first",
    )

    fun callbackScope(): CoroutineScope = synchronized(lock) { callbackScope } ?: throw BotaSDKError.Core(
        BotaErrorCode.FeatureUnavailable,
        BotaOperation.Validate,
        retryable = false,
        protocolStatus = null,
        detail = "BotaDeviceClient.configure() must be called first",
    )

    fun begin(
        configured: DeviceRuntime,
        id: UUID,
        operation: BotaOperation,
        cleanup: suspend () -> Unit = {},
    ) {
        configured.operations.begin(id, operation)
        try {
            synchronized(lock) {
                if (runtime !== configured) throw BotaSDKError.Core(
                    BotaErrorCode.Cancelled,
                    operation,
                    retryable = true,
                    protocolStatus = null,
                    detail = "$label runtime was replaced",
                )
                if (active != null) throw BotaSDKError.Core(
                    BotaErrorCode.OperationInProgress,
                    operation,
                    retryable = false,
                    protocolStatus = null,
                    detail = "another $label operation is already active",
                )
                active = Active(id, configured, cleanup)
            }
        } catch (error: Throwable) {
            configured.operations.end(id)
            throw error
        }
    }

    fun setTask(id: UUID, task: Job): Boolean = synchronized(lock) {
        active?.takeIf { it.id == id }?.let {
            it.task = task
            true
        } ?: false
    }

    suspend fun finish(id: UUID) {
        val operation = remove(id) ?: return
        runCleanupActions(operation.cleanup, { operation.runtime.operations.end(id) })
    }

    suspend fun cancel(id: UUID, cancelTask: Boolean, ignoreEngineFailure: Boolean = true) {
        val operation = remove(id) ?: return
        if (cancelTask) operation.task?.cancel()
        val cancelEngine: suspend () -> Unit = if (ignoreEngineFailure) {
            { runCatching { operation.runtime.engine.cancel(id) } }
        } else {
            { operation.runtime.engine.cancel(id) }
        }
        runCleanupActions(
            cancelEngine,
            operation.cleanup,
            { operation.runtime.operations.end(id) },
        )
    }

    suspend fun cancelCurrentOperation() {
        val id = synchronized(lock) { active?.id } ?: return
        cancel(id, cancelTask = true, ignoreEngineFailure = false)
    }

    private fun remove(id: UUID): Active? = synchronized(lock) {
        active?.takeIf { it.id == id }?.also { active = null }
    }
}
