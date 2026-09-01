package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.DeviceApiEnvironment
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingState
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal data class BotaDeviceSDKAndroidProvisioningRequest(
    val requestId: String,
    val serialNumber: String,
    val nonce: String,
    val devicePublicKey: String,
)

internal data class BotaDeviceSDKAndroidFactoryResetRequest(
    val requestId: String,
    val serialNumber: String,
    val nonce: String,
    val commandId: String,
    val bindingGeneration: ULong,
)

internal interface BotaDeviceSDKAndroidSecurityClient {
    suspend fun isProvisioned(device: ConnectedDevice): Boolean
    suspend fun readPublicKey(device: ConnectedDevice): String?
    suspend fun readAuthNonce(device: ConnectedDevice): String?
    suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice)
    suspend fun deliverCertificate(certificatePem: String, privateKeyPem: String, device: ConnectedDevice)
    suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice)
    suspend fun writeGrant(grantBlob: String, device: ConnectedDevice)
    suspend fun syncTime(device: ConnectedDevice)
    suspend fun requestStartRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult

    suspend fun requestStopRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult

    suspend fun readRecordingState(device: ConnectedDevice): RecordingState

    fun recordingStateUpdates(device: ConnectedDevice): Flow<RecordingState>
    suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    )

    suspend fun deprovision(device: ConnectedDevice)

    suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings

    suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    )

    suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ): FactoryResetCompletion

    suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
    ): FactoryResetCompletion?

    suspend fun cancelCurrentOperation()

    suspend fun cancelFactoryReset()
}

internal class BotaDeviceSDKSharedAndroidSecurityClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidSecurityClient {
    override suspend fun isProvisioned(device: ConnectedDevice): Boolean =
        client.controls.isProvisioned(device)

    override suspend fun readPublicKey(device: ConnectedDevice): String? =
        client.controls.readPublicKey(device)

    override suspend fun readAuthNonce(device: ConnectedDevice): String? =
        client.controls.readAuthNonce(device)

    override suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice) {
        client.controls.setApiEndpoint(environment, device)
    }

    override suspend fun deliverCertificate(
        certificatePem: String,
        privateKeyPem: String,
        device: ConnectedDevice,
    ) {
        client.controls.deliverCertificate(certificatePem, privateKeyPem, device)
    }

    override suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice) {
        client.controls.deliverBackendPublicKey(publicKey, device)
    }

    override suspend fun writeGrant(grantBlob: String, device: ConnectedDevice) {
        client.controls.writeGrant(grantBlob, device)
    }

    override suspend fun syncTime(device: ConnectedDevice) {
        client.controls.syncTime(device = device)
    }

    override suspend fun requestStartRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = client.controls.requestStartRecording(device, grantBlob)

    override suspend fun requestStopRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = client.controls.requestStopRecording(device, grantBlob)

    override suspend fun readRecordingState(device: ConnectedDevice): RecordingState =
        client.controls.readRecordingState(device)

    override fun recordingStateUpdates(device: ConnectedDevice): Flow<RecordingState> =
        client.controls.recordingStateUpdates(device)

    override suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) {
        client.provisioning.provision(device, provider)
    }

    override suspend fun deprovision(device: ConnectedDevice) {
        client.provisioning.deprovision(device)
    }

    override suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings =
        client.provisioning.readConnectionSettings(device)

    override suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    ) {
        client.provisioning.writeConnectionSettings(settings, device)
    }

    override suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ): FactoryResetCompletion = client.factoryReset.factoryReset(
        device,
        commandId,
        bindingGeneration,
        provider,
    )

    override suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
    ): FactoryResetCompletion? = client.factoryReset.resumePendingFactoryReset(
        device,
        currentBindingGeneration,
    )

    override suspend fun cancelCurrentOperation() {
        client.provisioning.cancelCurrentOperation()
    }

    override suspend fun cancelFactoryReset() {
        client.factoryReset.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidSecurity(
    private val client: BotaDeviceSDKAndroidSecurityClient = BotaDeviceSDKSharedAndroidSecurityClient(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Any()
    private val streamOperations = Mutex()
    private val streamLock = Any()
    private val provisioningRequests = mutableMapOf<String, CompletableDeferred<ProvisioningMaterial>>()
    private val factoryResetRequests = mutableMapOf<String, CompletableDeferred<ByteArray>>()
    private var recordingStateStream: Job? = null

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

    suspend fun isProvisioned(device: ConnectedDevice): Boolean = client.isProvisioned(device)
    suspend fun readPublicKey(device: ConnectedDevice): String? = client.readPublicKey(device)
    suspend fun readAuthNonce(device: ConnectedDevice): String? = client.readAuthNonce(device)
    suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice) =
        client.setApiEndpoint(environment, device)
    suspend fun deliverCertificate(certificatePem: String, privateKeyPem: String, device: ConnectedDevice) =
        client.deliverCertificate(certificatePem, privateKeyPem, device)
    suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice) =
        client.deliverBackendPublicKey(publicKey, device)
    suspend fun writeGrant(grantBlob: String, device: ConnectedDevice) = client.writeGrant(grantBlob, device)
    suspend fun syncTime(device: ConnectedDevice) = client.syncTime(device)
    suspend fun requestStartRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = client.requestStartRecording(device, grantBlob)
    suspend fun requestStopRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = client.requestStopRecording(device, grantBlob)
    suspend fun readRecordingState(device: ConnectedDevice): RecordingState =
        client.readRecordingState(device)

    suspend fun startRecordingStateUpdates(
        device: ConnectedDevice,
        onError: (Throwable) -> Unit = {},
        onState: (RecordingState) -> Unit,
    ) = streamOperations.withLock {
        stopOwnedRecordingStateStream()
        val updates = client.recordingStateUpdates(device)
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                updates.collect(onState)
            } catch (_: CancellationException) {
                // Explicit stop is not a recording-state stream failure.
            } catch (error: Throwable) {
                onError(error)
            } finally {
                synchronized(streamLock) {
                    if (recordingStateStream === task) recordingStateStream = null
                }
            }
        }
        synchronized(streamLock) { recordingStateStream = task }
        task.start()
    }

    suspend fun stopRecordingStateUpdates() = streamOperations.withLock {
        stopOwnedRecordingStateStream()
    }

    suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings =
        client.readConnectionSettings(device)

    suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    ) {
        client.writeConnectionSettings(settings, device)
    }

    suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        onGrantRequest: (BotaDeviceSDKAndroidFactoryResetRequest) -> Unit,
    ): FactoryResetCompletion = client.factoryReset(
        device,
        commandId,
        bindingGeneration,
    ) { request ->
        requestFactoryResetGrant(request, onGrantRequest)
    }

    suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
    ): FactoryResetCompletion? = client.resumePendingFactoryReset(
        device,
        currentBindingGeneration,
    )

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
        synchronized(lock) { provisioningRequests.remove(requestId) }
            ?.completeExceptionally(IllegalStateException(message))
            ?: synchronized(lock) { factoryResetRequests.remove(requestId) }
                ?.completeExceptionally(IllegalStateException(message))
            ?: error("application material request is no longer pending")
    }

    fun resolveFactoryResetGrant(requestId: String, grantBlob: String) {
        val pending = synchronized(lock) { factoryResetRequests.remove(requestId) }
            ?: error("application material request is no longer pending")
        val grant = runCatching { Base64.getDecoder().decode(grantBlob) }
            .getOrElse {
                pending.completeExceptionally(
                    IllegalArgumentException("factory reset grant is not valid encoded data"),
                )
                return
            }
        if (grant.isEmpty()) {
            pending.completeExceptionally(
                IllegalArgumentException("factory reset grant is not valid encoded data"),
            )
            return
        }
        pending.complete(grant)
    }

    suspend fun cancelAll() {
        runCatching { stopRecordingStateUpdates() }
        val pending = synchronized(lock) {
            provisioningRequests.values.toList().also { provisioningRequests.clear() }
        }
        pending.forEach { it.cancel() }
        val pendingResets = synchronized(lock) {
            factoryResetRequests.values.toList().also { factoryResetRequests.clear() }
        }
        pendingResets.forEach { it.cancel() }
        runCatching { client.cancelCurrentOperation() }
        runCatching { client.cancelFactoryReset() }
    }

    private suspend fun stopOwnedRecordingStateStream() {
        val stream = synchronized(streamLock) {
            recordingStateStream.also { recordingStateStream = null }
        } ?: return
        stream.cancelAndJoin()
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

    private suspend fun requestFactoryResetGrant(
        request: FactoryResetGrantRequest,
        onRequest: (BotaDeviceSDKAndroidFactoryResetRequest) -> Unit,
    ): ByteArray {
        val requestId = UUID.randomUUID().toString()
        val pending = CompletableDeferred<ByteArray>()
        synchronized(lock) { factoryResetRequests[requestId] = pending }
        return try {
            onRequest(
                BotaDeviceSDKAndroidFactoryResetRequest(
                    requestId = requestId,
                    serialNumber = request.serialNumber,
                    nonce = request.nonce.hexString(),
                    commandId = request.commandId,
                    bindingGeneration = request.bindingGeneration,
                ),
            )
            pending.await()
        } finally {
            synchronized(lock) { factoryResetRequests.remove(requestId, pending) }
        }
    }
}

private fun ByteArray.hexString(): String = joinToString("") { byte ->
    "%02x".format(byte.toInt() and 0xFF)
}
