package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.awaitWorkflowCompletion
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.runCleanupActions
import dev.bota.sdk.internal.runCleanupAfter
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.FactoryResetPersistenceResult
import java.util.UUID

public class FactoryResetManager internal constructor() {
    private data class Active(
        val cancellationId: UUID,
        val commandId: String,
        val grantId: String?,
    )

    private val lock = Any()
    private var runtime: DeviceRuntime? = null
    private var active: Active? = null

    internal fun attach(runtime: DeviceRuntime) {
        synchronized(lock) { this.runtime = runtime }
    }

    internal suspend fun detach() {
        val snapshot = synchronized(lock) {
            (runtime to active).also {
                runtime = null
                active = null
            }
        }
        val configured = snapshot.first ?: return
        snapshot.second?.let { operation ->
            runCleanupActions(
                { runCatching { configured.engine.cancel(operation.cancellationId) } },
                { operation.grantId?.let(configured.unregisterMaterial) },
                { configured.unregisterFactoryResetResultPersister(operation.commandId) },
                { configured.unregisterFactoryResetGeneration(operation.commandId) },
                { configured.operations.end(operation.cancellationId) },
            )
        }
    }

    public suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: (suspend (FactoryResetPersistenceResult) -> Unit)? = null,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ): FactoryResetCompletion {
        requireIdentifier(commandId, "command ID")
        val configured = configuredRuntime()
        configured.connection.require(device)
        val grantId = UUID.randomUUID().toString()
        val command = CoreCommand.factoryReset(device.serialNumber, commandId, grantId)
        configured.operations.begin(command.cancellationId, BotaOperation.FactoryReset)
        synchronized(lock) { active = Active(command.cancellationId, commandId, grantId) }
        var failure: Throwable? = null
        try {
            configured.registerFactoryResetGeneration(commandId, bindingGeneration)
            persistResult?.let { persister ->
                configured.registerFactoryResetResultPersister(commandId) { result ->
                    persister(result.toPublicPersistenceResult())
                }
            }
            configured.registerFactoryReset(grantId) { serialNumber, nonce ->
                provider(FactoryResetGrantRequest(serialNumber, nonce, commandId, bindingGeneration))
            }
            awaitWorkflowCompletion(command, configured)
            return FactoryResetCompletion(commandId, bindingGeneration)
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            runCleanupAfter(
                failure,
                { configured.unregisterMaterial(grantId) },
                { configured.unregisterFactoryResetResultPersister(commandId) },
                { configured.unregisterFactoryResetGeneration(commandId) },
                { finish(command.cancellationId) },
            )
        }
    }

    public suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
        persistResult: (suspend (FactoryResetPersistenceResult) -> Unit)? = null,
    ): FactoryResetCompletion? {
        val configured = configuredRuntime()
        configured.connection.require(device)
        val saved = configured.loadPendingFactoryReset() ?: return null
        if (saved.bindingGeneration != currentBindingGeneration) throw BotaSDKError.Core(
            BotaErrorCode.IdentityMismatch,
            BotaOperation.FactoryReset,
            retryable = false,
            protocolStatus = null,
            detail = "pending factory reset belongs to a different binding generation",
        )
        if (saved.resultCode > UByte.MAX_VALUE.toULong() ||
            saved.deletedRecordingCount > UShort.MAX_VALUE.toULong()
        ) {
            throw BotaSDKError.Core(
                BotaErrorCode.PersistenceFailed,
                BotaOperation.FactoryReset,
                retryable = false,
                protocolStatus = null,
                detail = "pending factory-reset result is out of range",
            )
        }
        val command = CoreCommand.resumeFactoryReset(
            device.serialNumber,
            saved.commandId,
            saved.resultCode.toUByte(),
            saved.deletedRecordingCount.toUShort(),
        )
        configured.operations.begin(command.cancellationId, BotaOperation.FactoryReset)
        synchronized(lock) { active = Active(command.cancellationId, saved.commandId, null) }
        configured.registerFactoryResetGeneration(saved.commandId, currentBindingGeneration)
        persistResult?.let { persister ->
            configured.registerFactoryResetResultPersister(saved.commandId) { result ->
                persister(result.toPublicPersistenceResult())
            }
        }
        try {
            awaitWorkflowCompletion(command, configured)
            return FactoryResetCompletion(saved.commandId, currentBindingGeneration)
        } finally {
            runCleanupActions(
                { configured.unregisterFactoryResetResultPersister(saved.commandId) },
                { configured.unregisterFactoryResetGeneration(saved.commandId) },
                { finish(command.cancellationId) },
            )
        }
    }

    /**
     * Resumes a firmware-held reset result when this installation has no native
     * journal. No grant or reset opcode is sent.
     */
    public suspend fun resumeUnjournaledFactoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ): FactoryResetCompletion {
        requireIdentifier(commandId, "command ID")
        val configured = configuredRuntime()
        configured.connection.require(device)
        val command = CoreCommand.resumeUnjournaledFactoryReset(device.serialNumber, commandId)
        configured.operations.begin(command.cancellationId, BotaOperation.FactoryReset)
        synchronized(lock) { active = Active(command.cancellationId, commandId, null) }
        configured.registerFactoryResetGeneration(commandId, bindingGeneration)
        configured.registerFactoryResetResultPersister(commandId) { result ->
            persistResult(result.toPublicPersistenceResult())
        }
        try {
            awaitWorkflowCompletion(command, configured)
            return FactoryResetCompletion(commandId, bindingGeneration)
        } finally {
            runCleanupActions(
                { configured.unregisterFactoryResetResultPersister(commandId) },
                { configured.unregisterFactoryResetGeneration(commandId) },
                { finish(command.cancellationId) },
            )
        }
    }

    public suspend fun cancelCurrentOperation() {
        val configured = configuredRuntime()
        val operation = synchronized(lock) { active } ?: return
        configured.engine.cancel(operation.cancellationId)
    }

    private fun finish(cancellationId: UUID) {
        val configured = synchronized(lock) {
            if (active?.cancellationId != cancellationId) return
            active = null
            runtime
        }
        configured?.operations?.end(cancellationId)
    }

    private fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: unavailable()
}

private fun dev.bota.sdk.internal.host.PersistedFactoryResetResult.toPublicPersistenceResult():
    FactoryResetPersistenceResult {
    if (resultCode != 0uL || deletedRecordingCount > UShort.MAX_VALUE.toULong()) {
        throw BotaSDKError.Core(
            BotaErrorCode.PersistenceFailed,
            BotaOperation.FactoryReset,
            retryable = false,
            protocolStatus = null,
            detail = "factory-reset persistence result is out of range",
        )
    }
    return FactoryResetPersistenceResult(deletedRecordingCount.toUShort())
}

internal object SecureUUIDs {
    val ControlService: UUID = UUID.fromString("b07a0002-0000-1000-8000-00805f9b34fb")
    val DeviceCommand: UUID = UUID.fromString("b07a0002-0005-1000-8000-00805f9b34fb")
    val ProvisioningService: UUID = UUID.fromString("b07a0003-0000-1000-8000-00805f9b34fb")
    val ProvisioningResult: UUID = UUID.fromString("b07a0003-0002-1000-8000-00805f9b34fb")
    val DeviceSettings: UUID = UUID.fromString("b07a0003-0006-1000-8000-00805f9b34fb")
}

private fun requireIdentifier(value: String, label: String) {
    if (value.isBlank()) throw BotaSDKError.Core(
        BotaErrorCode.InvalidInput,
        BotaOperation.Validate,
        retryable = false,
        protocolStatus = null,
        detail = "$label is required",
    )
}

internal fun unavailable(): Nothing = throw BotaSDKError.Core(
    BotaErrorCode.FeatureUnavailable,
    BotaOperation.Validate,
    retryable = false,
    protocolStatus = null,
    detail = "BotaDeviceClient.configure() must be called first",
)
