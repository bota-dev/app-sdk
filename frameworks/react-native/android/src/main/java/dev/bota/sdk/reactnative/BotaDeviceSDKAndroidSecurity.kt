package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred

internal data class BotaDeviceSDKAndroidProvisioningRequest(
    val requestId: String,
    val serialNumber: String,
    val nonce: String,
    val devicePublicKey: String,
)

internal interface BotaDeviceSDKAndroidSecurityClient {
    suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    )

    suspend fun deprovision(device: ConnectedDevice)

    suspend fun cancelCurrentOperation()
}

internal class BotaDeviceSDKSharedAndroidSecurityClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidSecurityClient {
    override suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) {
        client.provisioning.provision(device, provider)
    }

    override suspend fun deprovision(device: ConnectedDevice) {
        client.provisioning.deprovision(device)
    }

    override suspend fun cancelCurrentOperation() {
        client.provisioning.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidSecurity(
    private val client: BotaDeviceSDKAndroidSecurityClient = BotaDeviceSDKSharedAndroidSecurityClient(),
) {
    private val lock = Any()
    private val provisioningRequests = mutableMapOf<String, CompletableDeferred<ProvisioningMaterial>>()

    suspend fun provision(
        device: ConnectedDevice,
        onMaterialRequest: (BotaDeviceSDKAndroidProvisioningRequest) -> Unit,
    ) {
        client.provision(device) { request ->
            requestProvisioningMaterial(request, onMaterialRequest)
        }
    }

    suspend fun deprovision(device: ConnectedDevice) {
        client.deprovision(device)
    }

    fun resolveProvisioningMaterial(
        requestId: String,
        apiEndpoint: String,
        deviceToken: String,
        mtu: ULong,
    ) {
        pendingRequest(requestId).complete(
            ProvisioningMaterial(
                apiEndpoint = apiEndpoint.encodeToByteArray(),
                deviceToken = deviceToken.encodeToByteArray(),
                mtu = mtu,
            ),
        )
    }

    fun rejectApplicationMaterial(requestId: String, message: String) {
        pendingRequest(requestId).completeExceptionally(IllegalStateException(message))
    }

    suspend fun cancelAll() {
        val pending = synchronized(lock) {
            provisioningRequests.values.toList().also { provisioningRequests.clear() }
        }
        pending.forEach { it.cancel() }
        runCatching { client.cancelCurrentOperation() }
    }

    private suspend fun requestProvisioningMaterial(
        request: ProvisioningMaterialRequest,
        onRequest: (BotaDeviceSDKAndroidProvisioningRequest) -> Unit,
    ): ProvisioningMaterial {
        val requestId = UUID.randomUUID().toString()
        val pending = CompletableDeferred<ProvisioningMaterial>()
        synchronized(lock) { provisioningRequests[requestId] = pending }
        return try {
            onRequest(
                BotaDeviceSDKAndroidProvisioningRequest(
                    requestId = requestId,
                    serialNumber = request.serialNumber,
                    nonce = request.nonce.hexString(),
                    devicePublicKey = request.devicePublicKey.hexString(),
                ),
            )
            pending.await()
        } finally {
            synchronized(lock) { provisioningRequests.remove(requestId, pending) }
        }
    }

    private fun pendingRequest(requestId: String): CompletableDeferred<ProvisioningMaterial> =
        synchronized(lock) { provisioningRequests.remove(requestId) }
            ?: error("application material request is no longer pending")
}

private fun ByteArray.hexString(): String = joinToString("") { byte ->
    "%02x".format(byte.toInt() and 0xFF)
}
