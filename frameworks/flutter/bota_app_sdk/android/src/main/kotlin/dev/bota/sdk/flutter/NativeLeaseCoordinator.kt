package dev.bota.sdk.flutter

import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface NativeLeaseClient {
    suspend fun configure(namespace: String)
    suspend fun destroy()
}

internal data class NativeLeaseConfiguration(
    val applicationSupportNamespace: String,
    val hasProvisioningMaterialCallback: Boolean,
    val hasFactoryResetGrantCallback: Boolean,
    val hasFactoryResetResultCallback: Boolean,
    val hasFirmwareCallback: Boolean,
)

internal enum class NativeOperationCategory {
    DEVICE,
    PROVISIONING,
    FACTORY_RESET,
    RECORDING,
    OTA,
    LOGS,
    WIFI,
}

internal sealed class NativeLeaseException(message: String) : IllegalStateException(message) {
    class ConfigurationConflict : NativeLeaseException("native client is configured differently")
    class AcquisitionCancelled : NativeLeaseException("native lease acquisition was cancelled")
    class OperationInProgress : NativeLeaseException("another engine owns this native operation")
    class OperationNotOwned : NativeLeaseException("native operation belongs to another engine")
}

internal data class NativeOwnedOperation(
    val category: NativeOperationCategory,
    val operationId: String,
)

internal class NativeLeaseCoordinator(
    private val client: NativeLeaseClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    private val beforeOperationAcquisition: suspend () -> Unit = {},
) {
    private data class ConfigurationAttempt(
        val id: UUID,
        val configuration: NativeLeaseConfiguration,
        val task: Deferred<Result<Unit>>,
    )

    private data class DestroyAttempt(
        val id: UUID,
        val task: Deferred<Unit>,
    )

    private enum class CancellationStatus { IN_PROGRESS, SUCCEEDED, FAILED }

    private data class OperationCancellation(
        val id: UUID,
        val task: Deferred<Result<Unit>>,
        var status: CancellationStatus,
    )

    private data class OperationOwner(
        val engineId: String,
        val operationId: String,
        var cancellation: OperationCancellation? = null,
        var operationTerminated: Boolean = false,
        var retainAfterCancellation: Boolean = false,
    )

    private val lock = Mutex()
    private val leases = mutableMapOf<String, NativeLeaseConfiguration>()
    private val pendingLeases = mutableMapOf<String, NativeLeaseConfiguration>()
    private val operations = mutableMapOf<NativeOperationCategory, OperationOwner>()
    private var activeConfiguration: NativeLeaseConfiguration? = null
    private var configuring: ConfigurationAttempt? = null
    private var destroying: DestroyAttempt? = null

    suspend fun acquire(engineId: String, configuration: NativeLeaseConfiguration) {
        var destroyToWait: DestroyAttempt? = null
        var configurationAttempt: ConfigurationAttempt? = null
        lock.withLock {
            leases[engineId]?.let {
                if (it != configuration) throw NativeLeaseException.ConfigurationConflict()
                return
            }
            pendingLeases[engineId]?.let {
                if (it != configuration) throw NativeLeaseException.ConfigurationConflict()
            } ?: run {
                requireCompatible(configuration)
                pendingLeases[engineId] = configuration
            }
            destroyToWait = destroying
            if (destroyToWait == null) {
                activeConfiguration?.let {
                    if (it != configuration) {
                        pendingLeases.remove(engineId)
                        throw NativeLeaseException.ConfigurationConflict()
                    }
                } ?: run {
                    configurationAttempt = configurationAttempt(configuration)
                }
            }
        }

        destroyToWait?.task?.await()
        if (destroyToWait != null) {
            lock.withLock {
                if (destroying?.id == destroyToWait.id) destroying = null
                if (!pendingLeases.containsKey(engineId)) {
                    throw NativeLeaseException.AcquisitionCancelled()
                }
                activeConfiguration?.let {
                    if (it != configuration) {
                        pendingLeases.remove(engineId)
                        throw NativeLeaseException.ConfigurationConflict()
                    }
                } ?: run {
                    configurationAttempt = configurationAttempt(configuration)
                }
            }
        }

        configurationAttempt?.let { attempt ->
            val outcome = attempt.task.await()
            outcome.exceptionOrNull()?.let { error ->
                lock.withLock {
                    if (configuring?.id == attempt.id) configuring = null
                    pendingLeases.remove(engineId)
                }
                throw error
            }
            lock.withLock {
                if (configuring?.id == attempt.id) {
                    activeConfiguration = attempt.configuration
                    configuring = null
                }
            }
        }

        var cancelled = false
        lock.withLock {
            leases[engineId]?.let {
                if (it != configuration) throw NativeLeaseException.ConfigurationConflict()
                return
            }
            if (pendingLeases.remove(engineId) == null) {
                cancelled = true
            } else {
                leases[engineId] = configuration
            }
        }
        if (cancelled) {
            destroyIfUnused()
            throw NativeLeaseException.AcquisitionCancelled()
        }
    }

    suspend fun release(engineId: String) {
        val shouldDestroy = lock.withLock {
            val removed = leases.remove(engineId) != null || pendingLeases.remove(engineId) != null
            removed && leases.isEmpty() && pendingLeases.isEmpty() && configuring == null
        }
        if (shouldDestroy) destroyIfUnused()
    }

    suspend fun beginOperation(
        engineId: String,
        category: NativeOperationCategory,
        operationId: String,
    ) {
        beforeOperationAcquisition()
        lock.withLock {
            if (operations[category] != null) throw NativeLeaseException.OperationInProgress()
            operations[category] = OperationOwner(engineId, operationId)
        }
    }

    suspend fun finishOperation(
        engineId: String,
        category: NativeOperationCategory,
        operationId: String,
    ) {
        lock.withLock {
            val owner = operations[category] ?: return
            if (owner.engineId != engineId || owner.operationId != operationId) return
            owner.operationTerminated = true
            val cancellation = owner.cancellation
            if (!owner.retainAfterCancellation &&
                (cancellation == null || cancellation.status != CancellationStatus.IN_PROGRESS)
            ) {
                operations.remove(category)
            }
        }
    }

    suspend fun cancelOperation(
        engineId: String,
        category: NativeOperationCategory,
        cancellation: suspend () -> Unit,
    ) {
        val ownerAndCancellation = lock.withLock {
            val owner = operations[category] ?: return
            if (owner.engineId != engineId) throw NativeLeaseException.OperationNotOwned()
            if (owner.cancellation != null) throw NativeLeaseException.OperationInProgress()
            val operationCancellation = OperationCancellation(
                id = UUID.randomUUID(),
                task = scope.async { runCatching { cancellation() } },
                status = CancellationStatus.IN_PROGRESS,
            )
            owner.cancellation = operationCancellation
            owner to operationCancellation
        }
        val (owner, operationCancellation) = ownerAndCancellation
        val outcome = operationCancellation.task.await()
        settleCancellation(owner, category, operationCancellation.id, outcome)
        outcome.getOrThrow()
    }

    suspend fun beginCancellingOperations(
        engineId: String,
        cancellation: suspend (NativeOperationCategory) -> Unit,
    ): List<NativeOwnedOperation> = lock.withLock {
        val owned = NativeOperationCategory.entries.mapNotNull { category ->
            operations[category]?.takeIf { it.engineId == engineId }?.let {
                NativeOwnedOperation(category, it.operationId)
            }
        }
        owned.forEach { operation ->
            val owner = operations[operation.category] ?: return@forEach
            owner.retainAfterCancellation = true
            if (owner.cancellation == null) {
                owner.cancellation = OperationCancellation(
                    id = UUID.randomUUID(),
                    task = scope.async { runCatching { cancellation(operation.category) } },
                    status = CancellationStatus.IN_PROGRESS,
                )
            }
        }
        owned
    }

    suspend fun waitForOperationCancellations(
        engineId: String,
        owned: List<NativeOwnedOperation>,
    ) {
        owned.forEach { operation ->
            val cancellation = lock.withLock {
                operations[operation.category]
                    ?.takeIf { it.engineId == engineId && it.operationId == operation.operationId }
                    ?.cancellation
            } ?: return@forEach
            val outcome = cancellation.task.await()
            val owner = lock.withLock { operations[operation.category] } ?: return@forEach
            settleCancellation(owner, operation.category, cancellation.id, outcome)
        }
    }

    suspend fun finishCancelledOperations(
        engineId: String,
        owned: List<NativeOwnedOperation>,
        terminalOperationIds: Set<String>,
    ) {
        lock.withLock {
            owned.forEach { operation ->
                val owner = operations[operation.category]
                    ?.takeIf {
                        it.engineId == engineId &&
                            it.operationId == operation.operationId &&
                            it.retainAfterCancellation
                    } ?: return@forEach
                if (operation.operationId in terminalOperationIds) owner.operationTerminated = true
                owner.retainAfterCancellation = false
                val cancellationSucceeded = owner.cancellation?.status == CancellationStatus.SUCCEEDED
                if (cancellationSucceeded || owner.operationTerminated) {
                    operations.remove(operation.category)
                }
            }
        }
    }

    private fun configurationAttempt(configuration: NativeLeaseConfiguration): ConfigurationAttempt {
        configuring?.let {
            if (it.configuration != configuration) throw NativeLeaseException.ConfigurationConflict()
            return it
        }
        return ConfigurationAttempt(
            id = UUID.randomUUID(),
            configuration = configuration,
            task = scope.async { runCatching { client.configure(configuration.applicationSupportNamespace) } },
        ).also { configuring = it }
    }

    private fun requireCompatible(configuration: NativeLeaseConfiguration) {
        val current = activeConfiguration
            ?: configuring?.configuration
            ?: leases.values.firstOrNull()
            ?: pendingLeases.values.firstOrNull()
        if (current != null && current != configuration) {
            throw NativeLeaseException.ConfigurationConflict()
        }
    }

    private suspend fun settleCancellation(
        expected: OperationOwner,
        category: NativeOperationCategory,
        cancellationId: UUID,
        outcome: Result<Unit>,
    ) {
        lock.withLock {
            val owner = operations[category] ?: return
            if (owner.engineId != expected.engineId || owner.operationId != expected.operationId) return
            val cancellation = owner.cancellation?.takeIf { it.id == cancellationId } ?: return
            cancellation.status = if (outcome.isSuccess) {
                CancellationStatus.SUCCEEDED
            } else {
                CancellationStatus.FAILED
            }
            if (!owner.retainAfterCancellation &&
                (cancellation.status == CancellationStatus.SUCCEEDED || owner.operationTerminated)
            ) {
                operations.remove(category)
            }
        }
    }

    private suspend fun destroyIfUnused() {
        val attempt = lock.withLock {
            if (leases.isNotEmpty() || pendingLeases.isNotEmpty()) return
            destroying?.let { return@withLock it }
            if (activeConfiguration == null) {
                if (configuring == null) operations.clear()
                return
            }
            activeConfiguration = null
            DestroyAttempt(UUID.randomUUID(), scope.async { client.destroy() }).also { destroying = it }
        }
        attempt.task.await()
        lock.withLock {
            if (destroying?.id == attempt.id) destroying = null
            operations.clear()
        }
    }

    internal companion object {
        val shared: NativeLeaseCoordinator by lazy { NativeLeaseCoordinator(BotaAndroidNativeClient) }
    }
}
