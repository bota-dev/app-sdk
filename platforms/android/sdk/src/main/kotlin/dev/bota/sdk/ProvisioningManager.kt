package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.awaitWorkflowCompletion
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.runCleanupAfter
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeprovisionResult
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.ProvisioningFailure
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

public class ProvisioningManager internal constructor() {
    private data class Active(val cancellationId: UUID, val materialId: String)

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
            runCatching { configured.engine.cancel(operation.cancellationId) }
            configured.operations.end(operation.cancellationId)
            configured.unregisterMaterial(operation.materialId)
        }
    }

    public suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) {
        val configured = configuredRuntime()
        configured.connection.require(device)
        val materialId = UUID.randomUUID().toString()
        val command = CoreCommand.provision(device.serialNumber, materialId)
        configured.operations.begin(command.cancellationId, BotaOperation.Provision)
        synchronized(lock) { active = Active(command.cancellationId, materialId) }
        var failure: Throwable? = null
        try {
            configured.registerProvisioning(materialId, provider)
            awaitWorkflowCompletion(command, configured)
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            runCleanupAfter(
                failure,
                { configured.unregisterMaterial(materialId) },
                { finish(command.cancellationId) },
            )
        }
    }

    public suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    ) {
        val configured = configuredRuntime()
        configured.connection.require(device)
        val operationId = UUID.randomUUID()
        configured.operations.begin(operationId, BotaOperation.Encode)
        try {
            val encoded = configured.serializeConnectionSettings(settings.normalized(device.deviceType), device.deviceType)
            configured.directWrite(device.id, SecureUUIDs.ProvisioningService, SecureUUIDs.DeviceSettings, encoded)
        } finally {
            configured.operations.end(operationId)
        }
    }

    public suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings {
        val configured = configuredRuntime()
        configured.connection.require(device)
        val operationId = UUID.randomUUID()
        configured.operations.begin(operationId, BotaOperation.Decode)
        try {
            val encoded = configured.directRead(
                device.id,
                SecureUUIDs.ProvisioningService,
                SecureUUIDs.DeviceSettings,
            )
            return configured.parseConnectionSettings(encoded)
        } finally {
            configured.operations.end(operationId)
        }
    }

    public suspend fun deprovision(device: ConnectedDevice, grantBlob: String): DeprovisionResult {
        val configured = configuredRuntime()
        configured.connection.require(device)
        val grant = try {
            Base64.getDecoder().decode(grantBlob).takeIf { it.isNotEmpty() }
                ?: throw IllegalArgumentException("empty grant")
        } catch (_: IllegalArgumentException) {
            throw BotaSDKError.Core(
                BotaErrorCode.InvalidInput,
                BotaOperation.Validate,
                retryable = false,
                protocolStatus = null,
                detail = "deprovision grant is not valid base64 data",
            )
        }
        val operationId = UUID.randomUUID()
        configured.operations.begin(operationId, BotaOperation.Provision)
        try {
            configured.directWrite(
                device.id,
                SecureUUIDs.ControlService,
                SecureUUIDs.DeviceCommand,
                grant,
            )
            val notifications = configured.directSubscribe(
                device.id,
                SecureUUIDs.ProvisioningService,
                SecureUUIDs.ProvisioningResult,
            )
            val encoded = configured.encodeDeviceCommand(DeprovisionCommand)
            try {
                configured.directWrite(device.id, SecureUUIDs.ControlService, SecureUUIDs.DeviceCommand, encoded)
                return withTimeout(DeprovisionTimeoutMilliseconds) {
                    deprovisionResult(notifications.first().firstOrNull()?.toUByte())
                }
            } finally {
                runCatching {
                    configured.directUnsubscribe(
                        device.id,
                        SecureUUIDs.ProvisioningService,
                        SecureUUIDs.ProvisioningResult,
                    )
                }
            }
        } finally {
            configured.operations.end(operationId)
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

    private companion object {
        const val DeprovisionCommand: UByte = 1u
        const val DeprovisionTimeoutMilliseconds: Long = 30_000

        fun deprovisionResult(status: UByte?): DeprovisionResult = when (status?.toInt()) {
            0 -> DeprovisionResult(true)
            1 -> DeprovisionResult(false, ProvisioningFailure.InvalidToken)
            2 -> DeprovisionResult(false, ProvisioningFailure.StorageError)
            3 -> DeprovisionResult(false, ProvisioningFailure.ChunkError)
            4 -> DeprovisionResult(false, ProvisioningFailure.AlreadyPaired)
            else -> DeprovisionResult(false, ProvisioningFailure.Unknown)
        }
    }
}
