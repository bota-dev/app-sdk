package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.PairingState
import java.util.Base64
import java.util.TimeZone
import java.util.UUID

public enum class DeviceApiEnvironment { Development, Gamma, Production }

public class DeviceControlManager internal constructor() {
    private val lock = Any()
    private var runtime: DeviceRuntime? = null

    internal fun attach(runtime: DeviceRuntime) { synchronized(lock) { this.runtime = runtime } }
    internal fun detach() { synchronized(lock) { runtime = null } }

    public suspend fun isProvisioned(device: ConnectedDevice): Boolean =
        readPairingState(device) == PairingState.Paired

    public suspend fun readPairingState(device: ConnectedDevice): PairingState =
        performOperation(device, BotaOperation.Decode) { configured ->
            val value = configured.directRead(
                device.id,
                BotaBluetoothUUIDs.ProvisioningService,
                BotaBluetoothUUIDs.PairingState,
            ).firstOrNull()?.toUByte() ?: 0u
            pairingState(value)
        }

    public suspend fun readPublicKey(device: ConnectedDevice): String? =
        performOperation(device, BotaOperation.Decode) { configured ->
            runCatching {
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.DevicePublicKey,
                )
            }.getOrNull()?.takeIf { it.size == 64 }?.hexString()
        }

    public suspend fun readAuthNonce(device: ConnectedDevice): String? =
        performOperation(device, BotaOperation.Decode) { configured ->
            runCatching {
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.AuthNonce,
                )
            }.getOrNull()?.takeIf { it.size == 16 }?.hexString()
        }

    public suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice) {
        write(
            byteArrayOf(endpointCode(environment)),
            BotaBluetoothUUIDs.ProvisioningService,
            BotaBluetoothUUIDs.ApiEndpoint,
            device,
        )
    }

    public suspend fun deliverCertificate(
        certificatePem: String,
        privateKeyPem: String,
        device: ConnectedDevice,
    ) {
        performOperation(device, BotaOperation.Encode) { configured ->
            val payload = "${certificatePem.trim()}\n${privateKeyPem.trim()}\n".encodeToByteArray()
            configured.createProvisioningChunks(payload, device.mtu).forEach { chunk ->
                configured.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.DeviceCertificate,
                    chunk,
                )
            }
        }
    }

    public suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice) {
        if (publicKey.size != 32) throw invalidControl("backend public key must be 32 bytes")
        write(
            publicKey,
            BotaBluetoothUUIDs.AuthService,
            BotaBluetoothUUIDs.BackendPublicKey,
            device,
        )
    }

    public suspend fun writeGrant(grantBlob: String, device: ConnectedDevice) {
        val grant = runCatching { Base64.getDecoder().decode(grantBlob) }
            .getOrElse { throw invalidControl("grant blob is not valid base64 data") }
        if (grant.isEmpty()) throw invalidControl("grant blob is not valid base64 data")
        write(grant, BotaBluetoothUUIDs.ControlService, BotaBluetoothUUIDs.DeviceCommand, device)
    }

    public suspend fun syncTime(
        epochMilliseconds: Long = System.currentTimeMillis(),
        timezoneOffsetMinutes: Int? = null,
        device: ConnectedDevice,
    ) {
        if (epochMilliseconds < 0) throw invalidControl("time sync timestamp is before 1970")
        val offset = timezoneOffsetMinutes ?: TimeZone.getDefault().getOffset(epochMilliseconds) / 60_000
        if (offset !in Short.MIN_VALUE..Short.MAX_VALUE) {
            throw invalidControl("time sync timezone offset is out of range")
        }
        performOperation(device, BotaOperation.Encode) { configured ->
            configured.directWrite(
                device.id,
                BotaBluetoothUUIDs.ControlService,
                BotaBluetoothUUIDs.TimeSync,
                configured.createTimeSyncData(epochMilliseconds.toULong(), offset.toShort()),
            )
        }
    }

    private suspend fun write(
        data: ByteArray,
        service: UUID,
        characteristic: UUID,
        device: ConnectedDevice,
    ) {
        performOperation(device, BotaOperation.Encode) { configured ->
            configured.directWrite(device.id, service, characteristic, data)
        }
    }

    private suspend fun <T> performOperation(
        device: ConnectedDevice,
        operation: BotaOperation,
        body: suspend (DeviceRuntime) -> T,
    ): T {
        val configured = configuredRuntime()
        configured.connection.require(device)
        configured.authorize(operation)
        val id = UUID.randomUUID()
        configured.operations.begin(id, operation)
        return try {
            body(configured)
        } finally {
            configured.operations.end(id)
        }
    }

    private fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: unavailable()

    private fun pairingState(value: UByte): PairingState = when (value.toInt()) {
        0 -> PairingState.Unpaired
        1 -> PairingState.Pairing
        2 -> PairingState.Paired
        3 -> PairingState.Error
        else -> PairingState.Unknown(value)
    }

    private fun endpointCode(environment: DeviceApiEnvironment): Byte = when (environment) {
        DeviceApiEnvironment.Development -> 0
        DeviceApiEnvironment.Production -> 1
        DeviceApiEnvironment.Gamma -> 2
    }
}

private fun ByteArray.hexString(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

private fun invalidControl(detail: String): BotaSDKError.Core = BotaSDKError.Core(
    code = BotaErrorCode.InvalidInput,
    operation = BotaOperation.Validate,
    retryable = false,
    protocolStatus = null,
    detail = detail,
)
