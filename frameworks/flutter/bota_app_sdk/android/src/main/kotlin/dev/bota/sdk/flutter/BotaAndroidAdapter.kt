package dev.bota.sdk.flutter

import android.content.Context
import dev.bota.sdk.BotaConfiguration
import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.FirmwareImage
import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.RecordingTransferMetadata
import dev.bota.sdk.UploadOwnershipEvent
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeprovisionResult
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.FactoryResetPersistenceResult
import dev.bota.sdk.model.FirmwareUpdateProgress
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingState
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiStatusInfo
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request

internal interface BotaFlutterBridge {
    suspend fun onEvent(event: BotaEventMessage)
    fun requestMaterial(
        request: BotaMaterialRequestMessage,
        callback: (Result<BotaMaterialResponseMessage>) -> Unit,
    )
    fun requestFirmware(
        request: BotaFirmwareRequestMessage,
        callback: (Result<BotaFirmwareSourceMessage>) -> Unit,
    )
    fun persistFactoryResetResult(
        request: BotaFactoryResetResultRequestMessage,
        callback: (Result<BotaFactoryResetResultAcknowledgementMessage>) -> Unit,
    )
}

internal class PigeonBotaFlutterBridge(
    private val api: BotaFlutterApi,
) : BotaFlutterBridge {
    override suspend fun onEvent(event: BotaEventMessage) = api.onEvent(event)

    override fun requestMaterial(
        request: BotaMaterialRequestMessage,
        callback: (Result<BotaMaterialResponseMessage>) -> Unit,
    ) = api.requestMaterial(request, callback)

    override fun requestFirmware(
        request: BotaFirmwareRequestMessage,
        callback: (Result<BotaFirmwareSourceMessage>) -> Unit,
    ) = api.requestFirmware(request, callback)

    override fun persistFactoryResetResult(
        request: BotaFactoryResetResultRequestMessage,
        callback: (Result<BotaFactoryResetResultAcknowledgementMessage>) -> Unit,
    ) = api.persistFactoryResetResult(request, callback)
}

internal interface BotaAndroidClient : NativeLeaseClient {
    suspend fun connect(device: DiscoveredDevice, serialNumber: String?): ConnectedDevice
    suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice
    suspend fun disconnect()
    suspend fun readDeviceStatus(): DeviceStatus
    suspend fun nextClientPresence(deviceId: String): dev.bota.sdk.SDKClientContext?
    suspend fun cancelDeviceOperation()
    suspend fun startRecording(device: ConnectedDevice, grantBlob: String)
    suspend fun stopRecording(device: ConnectedDevice, grantBlob: String)
    suspend fun readRecordingState(device: ConnectedDevice): RecordingState
    suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    )
    suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings
    suspend fun writeConnectionSettings(settings: DeviceConnectionSettings, device: ConnectedDevice)
    suspend fun deprovision(device: ConnectedDevice, grantBlob: String): DeprovisionResult
    suspend fun cancelProvisioningOperation()
    suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ): FactoryResetCompletion
    suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ): FactoryResetCompletion?
    suspend fun resumeUnjournaledFactoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ): FactoryResetCompletion
    suspend fun cancelFactoryResetOperation()
    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording>
    fun takeTransferMetadata(sinkId: String): RecordingTransferMetadata?
    suspend fun confirmRecording(device: ConnectedDevice, recordingId: String)
    suspend fun cancelRecordingOperation()
    suspend fun cancelOtaOperation()
    suspend fun stopLogs()
    suspend fun configureWifi(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult
    suspend fun disconnectWifi(device: ConnectedDevice): WiFiConfigResult
    suspend fun readWifiStatus(device: ConnectedDevice): WiFiStatusInfo
    suspend fun scanWifi(device: ConnectedDevice): DeviceWiFiScanResult
    suspend fun cancelWifiOperation()
    suspend fun scanFlow(timeoutMilliseconds: ULong, allowDuplicates: Boolean): Flow<DiscoveredDevice>
    fun connectionFlow(): Flow<ConnectedDevice?>
    fun deviceStatusFlow(): Flow<DeviceStatus>
    fun recordingStateFlow(device: ConnectedDevice): Flow<RecordingState>
    fun recordingSyncFlow(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
        confirmOnCompletion: Boolean,
    ): Flow<RecordingSyncEvent>
    fun uploadOwnershipFlow(
        device: ConnectedDevice,
        recordingId: String,
        uploadId: String,
        destinationId: String,
    ): Flow<UploadOwnershipEvent>
    fun firmwareFlow(device: ConnectedDevice, image: FirmwareImage): Flow<FirmwareUpdateProgress>
    fun logFlow(device: ConnectedDevice): Flow<DeviceLogLine>
    fun wifiStatusFlow(device: ConnectedDevice): Flow<WiFiStatusInfo>
}

internal object BotaAndroidNativeClient : BotaAndroidClient {
    private val client = BotaDeviceClient.shared
    private var applicationContext: Context? = null

    fun bind(context: Context) {
        val appContext = requireNotNull(context.applicationContext) {
            "Bota Flutter SDK requires an application context"
        }
        synchronized(this) {
            val existing = applicationContext
            require(existing == null || existing.packageName == appContext.packageName) {
                "Bota Flutter SDK cannot share a native client across applications"
            }
            applicationContext = appContext
        }
    }

    override suspend fun configure(namespace: String) {
        val context = synchronized(this) { applicationContext }
            ?: error("Bota Flutter SDK has no application context")
        client.configure(BotaConfiguration(context, storageDirectory = File(context.filesDir, namespace)))
    }

    override suspend fun destroy() = client.destroy()
    override suspend fun connect(device: DiscoveredDevice, serialNumber: String?): ConnectedDevice =
        serialNumber?.let { client.devices.connect(it, device) } ?: client.devices.connect(device)
    override suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint) =
        client.devices.reconnect(serialNumber, hint)
    override suspend fun disconnect() = client.devices.disconnect()
    override suspend fun readDeviceStatus() = client.devices.readStatus()
    override suspend fun nextClientPresence(deviceId: String) = client.clientPresence.nextReport(deviceId)
    override suspend fun cancelDeviceOperation() = client.devices.cancelCurrentOperation()
    override suspend fun startRecording(device: ConnectedDevice, grantBlob: String) =
        validateRecordingControl(client.controls.requestStartRecording(device, grantBlob))
    override suspend fun stopRecording(device: ConnectedDevice, grantBlob: String) =
        validateRecordingControl(client.controls.requestStopRecording(device, grantBlob))
    override suspend fun readRecordingState(device: ConnectedDevice) = client.controls.readRecordingState(device)
    override suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) = client.provisioning.provision(device, provider)
    override suspend fun readConnectionSettings(device: ConnectedDevice) =
        client.provisioning.readConnectionSettings(device)
    override suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    ) = client.provisioning.writeConnectionSettings(settings, device)
    override suspend fun deprovision(device: ConnectedDevice, grantBlob: String) =
        client.provisioning.deprovision(device, grantBlob)
    override suspend fun cancelProvisioningOperation() = client.provisioning.cancelCurrentOperation()
    override suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ) = client.factoryReset.factoryReset(device, commandId, bindingGeneration, persistResult, provider)
    override suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ) = client.factoryReset.resumePendingFactoryReset(device, currentBindingGeneration, persistResult)
    override suspend fun resumeUnjournaledFactoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ) = client.factoryReset.resumeUnjournaledFactoryReset(
        device,
        commandId,
        bindingGeneration,
        persistResult,
    )
    override suspend fun cancelFactoryResetOperation() = client.factoryReset.cancelCurrentOperation()
    override suspend fun listRecordings(device: ConnectedDevice) = client.recordings.listRecordings(device)
    override fun takeTransferMetadata(sinkId: String) = client.recordings.transferMetadata(sinkId)
    override suspend fun confirmRecording(device: ConnectedDevice, recordingId: String) =
        client.recordings.confirmRecording(device, recordingId)
    override suspend fun cancelRecordingOperation() = client.recordings.cancelCurrentOperation()
    override suspend fun cancelOtaOperation() = client.ota.cancelCurrentOperation()
    override suspend fun stopLogs() = client.logs.stop()
    override suspend fun configureWifi(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ) = client.wifi.configure(device, ssid, password, grantBlob)
    override suspend fun disconnectWifi(device: ConnectedDevice) = client.wifi.disconnect(device)
    override suspend fun readWifiStatus(device: ConnectedDevice) = client.wifi.readStatus(device)
    override suspend fun scanWifi(device: ConnectedDevice) = client.wifi.scanNetworks(device)
    override suspend fun cancelWifiOperation() = client.wifi.cancelCurrentOperation()
    override suspend fun scanFlow(timeoutMilliseconds: ULong, allowDuplicates: Boolean) =
        client.devices.startScan(timeoutMilliseconds, allowDuplicates)
    override fun connectionFlow() = client.devices.connectionUpdates()
    override fun deviceStatusFlow() = client.devices.statusUpdates()
    override fun recordingStateFlow(device: ConnectedDevice) = client.controls.recordingStateUpdates(device)
    override fun recordingSyncFlow(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
        confirmOnCompletion: Boolean,
    ) = client.recordings.syncRecording(device, recording, sinkId, confirmOnCompletion)
    override fun uploadOwnershipFlow(
        device: ConnectedDevice,
        recordingId: String,
        uploadId: String,
        destinationId: String,
    ) = client.recordings.observeUploadOwnership(device, recordingId, uploadId, destinationId)
    override fun firmwareFlow(device: ConnectedDevice, image: FirmwareImage) =
        client.ota.updateFirmware(device, image)
    override fun logFlow(device: ConnectedDevice) = client.logs.streamLogs(device)
    override fun wifiStatusFlow(device: ConnectedDevice) = client.wifi.statusUpdates(device)

    private fun validateRecordingControl(result: RecordingControlResult) {
        if (!result.success) {
            throw dev.bota.sdk.BotaSDKError.Core(
                code = dev.bota.sdk.BotaErrorCode.ProtocolRejected,
                operation = dev.bota.sdk.BotaOperation.Validate,
                retryable = false,
                protocolStatus = null,
                detail = result.error?.wireValue ?: "recording command was rejected",
            )
        }
    }
}

internal class BotaAndroidAdapter(
    private val engineId: String,
    private val client: BotaAndroidClient,
    private val leaseCoordinator: NativeLeaseCoordinator,
    private val flutterApi: BotaFlutterBridge,
    dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val beforeSubscriptionInstall: suspend () -> Unit = {},
) : BotaHostApi {
    private enum class SubscriptionOwner(val category: NativeOperationCategory?) {
        DEVICE_OPERATION(NativeOperationCategory.DEVICE),
        CONNECTION(null),
        DEVICE_STATUS(null),
        RECORDING_STATE(null),
        RECORDING_OPERATION(NativeOperationCategory.RECORDING),
        OTA(NativeOperationCategory.OTA),
        LOGS(NativeOperationCategory.LOGS),
        WIFI(NativeOperationCategory.WIFI),
    }

    private data class InFlightOperation(val category: NativeOperationCategory, val task: Deferred<Any?>)
    private data class PreparedSubscription(
        val owner: SubscriptionOwner,
        val flow: Flow<BotaEventPayloadMessage>,
    )
    private data class StartingSubscription(
        val owner: SubscriptionOwner,
        val task: Deferred<PreparedSubscription>,
    )
    private data class Subscription(val owner: SubscriptionOwner, val task: Job)
    private data class PendingCallback(
        val category: NativeOperationCategory,
        val reject: () -> Unit,
    )

    private val stateLock = Any()
    private val scopeJob = SupervisorJob()
    private val scope = CoroutineScope(scopeJob + dispatcher)
    private val discoveredDevices = mutableMapOf<String, DiscoveredDevice>()
    private val connectedDevices = mutableMapOf<String, ConnectedDevice>()
    private val activeIdentifiers = mutableSetOf<String>()
    private val consumedIdentifiers = mutableSetOf<String>()
    private val startingSubscriptions = mutableMapOf<String, StartingSubscription>()
    private val subscriptions = mutableMapOf<String, Subscription>()
    private val inFlightOperations = mutableMapOf<String, InFlightOperation>()
    private val pendingCallbacks = mutableMapOf<String, PendingCallback>()
    private var configuration: BotaConfigurationMessage? = null
    private var detached = false
    private var destroying = false
    private var callbackRegistrationClosed = false
    private var releaseTask: Deferred<Unit>? = null

    internal val activeSubscriptionCount: Int
        get() = synchronized(stateLock) { startingSubscriptions.size + subscriptions.size }

    override suspend fun configure(operationId: String, configuration: BotaConfigurationMessage) {
        try {
            beginIdentifier(operationId, requiresConfiguration = false)
            try {
                requireAttached()
                val namespace = configuration.applicationSupportNamespace
                if (namespace.isEmpty() || namespace == "." || namespace == ".." ||
                    namespace.contains('/') || namespace.contains('\\')
                ) {
                    throw bridgeError("invalid_configuration", "namespace must be one path component")
                }
                val lease = NativeLeaseConfiguration(
                    namespace,
                    configuration.hasProvisioningMaterialCallback,
                    configuration.hasFactoryResetGrantCallback,
                    configuration.hasFactoryResetResultCallback,
                    configuration.hasFirmwareCallback,
                )
                leaseCoordinator.acquire(engineId, lease)
                requireAttached()
                synchronized(stateLock) { this.configuration = configuration }
            } finally {
                finishIdentifier(operationId)
            }
        } catch (error: Throwable) {
            throw BotaAndroidMapper.flutterError(mapLeaseError(error))
        }
    }

    override suspend fun destroy(operationId: String) {
        try {
            beginIdentifier(operationId, requiresConfiguration = true)
            synchronized(stateLock) {
                destroying = true
                callbackRegistrationClosed = true
            }
            releaseEngine()
            synchronized(stateLock) {
                detached = true
                destroying = false
            }
            finishIdentifier(operationId)
        } catch (error: Throwable) {
            throw BotaAndroidMapper.flutterError(mapLeaseError(error))
        }
    }

    override suspend fun connect(
        operationId: String,
        device: BotaDiscoveredDeviceMessage,
        serialNumber: String?,
    ): BotaConnectedDeviceMessage = perform(operationId, NativeOperationCategory.DEVICE) {
        val native = synchronized(stateLock) { discoveredDevices[device.id] }
            ?: throw bridgeError("device_not_found", "device was not discovered by this engine")
        val connected = client.connect(native, serialNumber)
        requireAttached()
        store(connected)
        BotaAndroidMapper.connectedDevice(connected)
    }

    override suspend fun reconnect(
        operationId: String,
        serialNumber: String,
        hint: BotaReconnectHintMessage,
    ): BotaConnectedDeviceMessage = perform(operationId, NativeOperationCategory.DEVICE) {
        val connected = client.reconnect(
            serialNumber,
            DeviceReconnectHint(
                storedPeripheralId = hint.storedPeripheralId,
                advertisedAddress = hint.advertisedAddress,
                storedName = hint.storedName,
                scanTimeoutMilliseconds = BotaAndroidMapper.unsignedLong(hint.scanTimeoutMillis),
                connectionTimeoutMilliseconds = BotaAndroidMapper.unsignedLong(hint.connectionTimeoutMillis),
            ),
        )
        requireAttached()
        store(connected)
        BotaAndroidMapper.connectedDevice(connected)
    }

    override suspend fun disconnect(operationId: String) =
        perform<Unit>(operationId, NativeOperationCategory.DEVICE) {
            client.disconnect()
            requireAttached()
            synchronized(stateLock) { connectedDevices.clear() }
        }

    override suspend fun readDeviceStatus(operationId: String): BotaDeviceStatusMessage =
        perform(operationId, NativeOperationCategory.DEVICE) {
            BotaAndroidMapper.deviceStatus(client.readDeviceStatus())
        }

    override suspend fun nextClientPresence(operationId: String, deviceId: String): BotaClientContextMessage? =
        perform(operationId, NativeOperationCategory.DEVICE) {
            client.nextClientPresence(deviceId)?.let { report ->
                BotaClientContextMessage(report.schemaVersion.toLong(), report.sessionId, report.sequence,
                    report.platform, report.sdkPackage, report.sdkVersion)
            }
        }

    override suspend fun cancelDeviceOperation(operationId: String) = cancel(
        operationId,
        NativeOperationCategory.DEVICE,
        client::cancelDeviceOperation,
    )

    override suspend fun startRecording(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        grantBlob: String,
    ) = perform<Unit>(operationId, NativeOperationCategory.RECORDING) {
        requireText(grantBlob, "recording grant is required")
        client.startRecording(device(device), grantBlob)
    }

    override suspend fun stopRecording(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        grantBlob: String,
    ) = perform<Unit>(operationId, NativeOperationCategory.RECORDING) {
        requireText(grantBlob, "recording grant is required")
        client.stopRecording(device(device), grantBlob)
    }

    override suspend fun readRecordingState(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): BotaRecordingStateMessage = perform(operationId, NativeOperationCategory.RECORDING) {
        BotaAndroidMapper.recordingState(client.readRecordingState(device(device)))
    }

    override suspend fun provision(operationId: String, device: BotaDeviceReferenceMessage) =
        perform<Unit>(operationId, NativeOperationCategory.PROVISIONING) {
            requireCallback { it.hasProvisioningMaterialCallback }
            client.provision(device(device), ::provisioningMaterial)
        }

    override suspend fun readConnectionSettings(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): BotaConnectionSettingsMessage = perform(operationId, NativeOperationCategory.PROVISIONING) {
        BotaAndroidMapper.connectionSettings(client.readConnectionSettings(device(device)))
    }

    override suspend fun writeConnectionSettings(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        settings: BotaConnectionSettingsMessage,
    ) = perform<Unit>(operationId, NativeOperationCategory.PROVISIONING) {
        client.writeConnectionSettings(BotaAndroidMapper.connectionSettings(settings), device(device))
    }

    override suspend fun deprovision(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        grantBlob: String,
    ): BotaDeprovisionResultMessage = perform(operationId, NativeOperationCategory.PROVISIONING) {
        requireText(grantBlob, "deprovision grant is required")
        BotaAndroidMapper.deprovisionResult(client.deprovision(device(device), grantBlob))
    }

    override suspend fun cancelProvisioningOperation(operationId: String) = cancel(
        operationId,
        NativeOperationCategory.PROVISIONING,
        client::cancelProvisioningOperation,
    )

    override suspend fun factoryReset(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        command: BotaFactoryResetCommandMessage,
    ): BotaFactoryResetCompletionMessage = perform(operationId, NativeOperationCategory.FACTORY_RESET) {
        requireCallback { it.hasFactoryResetGrantCallback }
        requireCallback { it.hasFactoryResetResultCallback }
        BotaAndroidMapper.factoryResetCompletion(
            client.factoryReset(
                device(device),
                command.commandId,
                BotaAndroidMapper.unsignedLong(command.bindingGeneration),
                ::persistReset,
                ::factoryResetGrant,
            ),
        )
    }

    override suspend fun resumePendingFactoryReset(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        currentBindingGeneration: Long,
    ): BotaFactoryResetCompletionMessage? = perform(
        operationId,
        NativeOperationCategory.FACTORY_RESET,
    ) {
        requireCallback { it.hasFactoryResetResultCallback }
        client.resumePendingFactoryReset(
            device(device),
            BotaAndroidMapper.unsignedLong(currentBindingGeneration),
            ::persistReset,
        )?.let(BotaAndroidMapper::factoryResetCompletion)
    }

    override suspend fun resumeUnjournaledFactoryReset(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        command: BotaFactoryResetCommandMessage,
    ): BotaFactoryResetCompletionMessage = perform(operationId, NativeOperationCategory.FACTORY_RESET) {
        requireCallback { it.hasFactoryResetResultCallback }
        BotaAndroidMapper.factoryResetCompletion(
            client.resumeUnjournaledFactoryReset(
                device(device),
                command.commandId,
                BotaAndroidMapper.unsignedLong(command.bindingGeneration),
                ::persistReset,
            ),
        )
    }

    override suspend fun cancelFactoryResetOperation(operationId: String) = cancel(
        operationId,
        NativeOperationCategory.FACTORY_RESET,
        client::cancelFactoryResetOperation,
    )

    override suspend fun listRecordings(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): List<BotaDeviceRecordingMessage> = perform(operationId, NativeOperationCategory.RECORDING) {
        client.listRecordings(device(device)).map(BotaAndroidMapper::recording)
    }

    override suspend fun takeTransferMetadata(
        operationId: String,
        sinkId: String,
    ): BotaRecordingTransferMetadataMessage? = perform(operationId, NativeOperationCategory.RECORDING) {
        client.takeTransferMetadata(sinkId)?.let(BotaAndroidMapper::transferMetadata)
    }

    override suspend fun confirmRecording(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        recordingId: String,
    ) = perform<Unit>(operationId, NativeOperationCategory.RECORDING) {
        client.confirmRecording(device(device), recordingId)
    }

    override suspend fun cancelRecordingOperation(operationId: String) = cancel(
        operationId,
        NativeOperationCategory.RECORDING,
        client::cancelRecordingOperation,
    )

    override suspend fun cancelOtaOperation(operationId: String) =
        cancel(operationId, NativeOperationCategory.OTA, client::cancelOtaOperation)

    override suspend fun stopLogs(operationId: String) =
        cancel(operationId, NativeOperationCategory.LOGS, client::stopLogs)

    override suspend fun configureWifi(
        operationId: String,
        device: BotaDeviceReferenceMessage,
        credentials: BotaWifiCredentialsMessage,
        grantBlob: String,
    ): BotaWifiConfigResultMessage = perform(operationId, NativeOperationCategory.WIFI) {
        requireText(grantBlob, "WiFi grant is required")
        BotaAndroidMapper.wifiConfigResult(
            client.configureWifi(device(device), credentials.ssid, credentials.password, grantBlob),
        )
    }

    override suspend fun disconnectWifi(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): BotaWifiConfigResultMessage = perform(operationId, NativeOperationCategory.WIFI) {
        BotaAndroidMapper.wifiConfigResult(client.disconnectWifi(device(device)))
    }

    override suspend fun readWifiStatus(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): BotaWifiStatusMessage = perform(operationId, NativeOperationCategory.WIFI) {
        BotaAndroidMapper.wifiStatus(client.readWifiStatus(device(device)))
    }

    override suspend fun scanWifi(
        operationId: String,
        device: BotaDeviceReferenceMessage,
    ): BotaWifiScanResultMessage = perform(operationId, NativeOperationCategory.WIFI) {
        BotaAndroidMapper.wifiScan(client.scanWifi(device(device)))
    }

    override suspend fun cancelWifiOperation(operationId: String) =
        cancel(operationId, NativeOperationCategory.WIFI, client::cancelWifiOperation)

    override suspend fun startSubscription(
        subscriptionId: String,
        request: BotaSubscriptionRequestMessage,
    ) {
        try {
            reserveSubscription(subscriptionId)
            val owner = subscriptionOwner(request)
            val task = scope.async(start = CoroutineStart.LAZY) {
                val category = owner.category
                if (category != null) leaseCoordinator.beginOperation(engineId, category, subscriptionId)
                try {
                    ensureActive()
                    prepareSubscription(owner, request)
                } catch (error: Throwable) {
                    if (category != null) {
                        leaseCoordinator.finishOperation(engineId, category, subscriptionId)
                    }
                    throw error
                }
            }
            synchronized(stateLock) {
                startingSubscriptions[subscriptionId] = StartingSubscription(owner, task)
            }
            task.start()
            val prepared = task.await()
            beforeSubscriptionInstall()
            currentCoroutineContext().ensureActive()
            requireAttached()
            val removed = synchronized(stateLock) { startingSubscriptions.remove(subscriptionId) }
            if (removed == null) throw bridgeError("engine_detached", "engine is detached")
            installSubscription(subscriptionId, prepared)
        } catch (error: Throwable) {
            synchronized(stateLock) { startingSubscriptions.remove(subscriptionId) }
            finishIdentifier(subscriptionId)
            throw BotaAndroidMapper.flutterError(
                if (isDetached()) bridgeError("engine_detached", "engine is detached") else mapLeaseError(error),
            )
        }
    }

    override suspend fun cancelSubscription(subscriptionId: String) {
        try {
            validateId(subscriptionId)
            val starting = synchronized(stateLock) { startingSubscriptions[subscriptionId] }
            if (starting != null) {
                starting.task.cancel()
                val prepared = runCatching { starting.task.await() }.getOrNull()
                synchronized(stateLock) { startingSubscriptions.remove(subscriptionId) }
                finishIdentifier(subscriptionId)
                if (prepared != null) stopOwnedSubscription(subscriptionId, starting.owner, null)
                return
            }
            val subscription = synchronized(stateLock) { subscriptions.remove(subscriptionId) }
                ?: throw bridgeError("subscription_not_found", "subscription is not active")
            finishIdentifier(subscriptionId)
            subscription.task.cancel()
            stopOwnedSubscription(subscriptionId, subscription.owner, subscription.task)
        } catch (error: Throwable) {
            throw BotaAndroidMapper.flutterError(mapLeaseError(error))
        }
    }

    suspend fun detach() {
        val existing = synchronized(stateLock) {
            if (detached) releaseTask else {
                detached = true
                callbackRegistrationClosed = true
                null
            }
        }
        if (existing != null) {
            existing.await()
            return
        }
        releaseEngine()
    }

    private suspend fun <T> perform(
        operationId: String,
        category: NativeOperationCategory,
        body: suspend () -> T,
    ): T {
        var beganIdentifier = false
        val task: Deferred<T>
        try {
            beginIdentifier(operationId, requiresConfiguration = true)
            beganIdentifier = true
            task = scope.async(start = CoroutineStart.LAZY) {
                var ownsNative = false
                try {
                    leaseCoordinator.beginOperation(engineId, category, operationId)
                    ownsNative = true
                    ensureActive()
                    requireAttached()
                    body()
                } finally {
                    if (ownsNative) leaseCoordinator.finishOperation(engineId, category, operationId)
                }
            }
            synchronized(stateLock) { inFlightOperations[operationId] = InFlightOperation(category, task) }
            task.start()
            return task.await()
        } catch (error: Throwable) {
            val mapped = if (isDetached()) {
                bridgeError("engine_detached", "engine is detached")
            } else {
                mapLeaseError(error)
            }
            throw BotaAndroidMapper.flutterError(mapped)
        } finally {
            synchronized(stateLock) { inFlightOperations.remove(operationId) }
            if (beganIdentifier) finishIdentifier(operationId)
        }
    }

    private suspend fun cancel(
        operationId: String,
        category: NativeOperationCategory,
        nativeCancel: suspend () -> Unit,
    ) {
        var beganIdentifier = false
        try {
            beginIdentifier(operationId, requiresConfiguration = true)
            beganIdentifier = true
            val owned = synchronized(stateLock) {
                inFlightOperations.entries.firstOrNull { it.value.category == category }
            }
            leaseCoordinator.cancelOperation(engineId, category) {
                owned?.value?.task?.cancel()
                var cancellationError: Throwable? = null
                try {
                    nativeCancel()
                } catch (error: Throwable) {
                    cancellationError = error
                }
                owned?.value?.task?.let { runCatching { it.await() } }
                cancellationError?.let { throw it }
            }
            requireAttached()
        } catch (error: Throwable) {
            throw BotaAndroidMapper.flutterError(mapLeaseError(error))
        } finally {
            if (beganIdentifier) finishIdentifier(operationId)
        }
    }

    private suspend fun prepareSubscription(
        owner: SubscriptionOwner,
        request: BotaSubscriptionRequestMessage,
    ): PreparedSubscription {
        val flow: Flow<BotaEventPayloadMessage> = when (request) {
            is BotaScanSubscriptionMessage -> client.scanFlow(
                BotaAndroidMapper.unsignedLong(request.timeoutMillis),
                request.allowDuplicates,
            ).map { value ->
                synchronized(stateLock) { discoveredDevices[value.id] = value }
                BotaDiscoveredDeviceEventMessage(BotaAndroidMapper.discoveredDevice(value))
            }
            is BotaConnectionSubscriptionMessage -> client.connectionFlow().map { value ->
                synchronized(stateLock) {
                    if (value == null) connectedDevices.clear() else connectedDevices[value.id] = value
                }
                BotaConnectionEventMessage(value?.let(BotaAndroidMapper::connectedDevice))
            }
            is BotaDeviceStatusSubscriptionMessage -> client.deviceStatusFlow().map {
                BotaDeviceStatusEventMessage(BotaAndroidMapper.deviceStatus(it))
            }
            is BotaRecordingStateSubscriptionMessage -> client.recordingStateFlow(device(request.device)).map {
                BotaRecordingStateEventMessage(BotaAndroidMapper.recordingState(it))
            }
            is BotaRecordingSyncSubscriptionMessage -> client.recordingSyncFlow(
                device(request.device),
                BotaAndroidMapper.recording(request.recording),
                request.sinkId,
                request.confirmOnCompletion,
            ).map {
                when (it) {
                    is RecordingSyncEvent.Progress ->
                        BotaRecordingSyncProgressEventMessage(BotaAndroidMapper.recordingProgress(it.progress))
                    is RecordingSyncEvent.Completed ->
                        BotaRecordingSyncCompletedEventMessage(it.path.toString())
                }
            }
            is BotaUploadOwnershipSubscriptionMessage -> client.uploadOwnershipFlow(
                device(request.device),
                request.recordingId,
                request.uploadId,
                request.destinationId,
            ).map {
                when (it) {
                    is UploadOwnershipEvent.Progress ->
                        BotaUploadOwnershipProgressEventMessage(BotaAndroidMapper.recordingProgress(it.progress))
                    is UploadOwnershipEvent.Result ->
                        BotaUploadOwnershipResolvedEventMessage(BotaAndroidMapper.uploadOwnership(it.result))
                }
            }
            is BotaFirmwareUpdateSubscriptionMessage -> {
                requireCallback { it.hasFirmwareCallback }
                client.firmwareFlow(device(request.device), firmwareImage(request.image)).map {
                    BotaFirmwareProgressEventMessage(BotaAndroidMapper.firmwareProgress(it))
                }
            }
            is BotaLogSubscriptionMessage -> client.logFlow(device(request.device)).map {
                BotaDeviceLogEventMessage(BotaAndroidMapper.logLine(it))
            }
            is BotaWifiStatusSubscriptionMessage -> client.wifiStatusFlow(device(request.device)).map {
                BotaWifiStatusEventMessage(BotaAndroidMapper.wifiStatus(it))
            }
        }
        return PreparedSubscription(owner, flow)
    }

    private fun installSubscription(subscriptionId: String, prepared: PreparedSubscription) {
        requireAttached()
        val task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                prepared.flow.collect { payload -> emit(subscriptionId, payload) }
                completeSubscription(subscriptionId)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                failSubscription(subscriptionId, error)
            }
        }
        synchronized(stateLock) { subscriptions[subscriptionId] = Subscription(prepared.owner, task) }
        task.start()
    }

    private suspend fun stopOwnedSubscription(
        subscriptionId: String,
        owner: SubscriptionOwner,
        collector: Job?,
    ) {
        val category = owner.category
        if (category == null) {
            collector?.join()
            return
        }
        leaseCoordinator.cancelOperation(engineId, category) {
            var stopError: Throwable? = null
            try {
                stop(owner)
            } catch (error: Throwable) {
                stopError = error
            }
            collector?.join()
            stopError?.let { throw it }
        }
        leaseCoordinator.finishOperation(engineId, category, subscriptionId)
    }

    private suspend fun completeSubscription(subscriptionId: String) {
        val subscription = synchronized(stateLock) { subscriptions.remove(subscriptionId) } ?: return
        finishIdentifier(subscriptionId)
        runCatching { stopOwnedSubscription(subscriptionId, subscription.owner, null) }
        if (!isDetached()) emit(subscriptionId, BotaSubscriptionCompleteEventMessage())
    }

    private suspend fun failSubscription(subscriptionId: String, error: Throwable) {
        val active = synchronized(stateLock) { subscriptions.containsKey(subscriptionId) }
        if (!active) return
        emit(subscriptionId, BotaSubscriptionErrorEventMessage(BotaAndroidMapper.error(error)))
        completeSubscription(subscriptionId)
    }

    private suspend fun emit(subscriptionId: String, payload: BotaEventPayloadMessage) {
        if (isDetached()) return
        runCatching { flutterApi.onEvent(BotaEventMessage(subscriptionId, payload)) }
    }

    private suspend fun releaseEngine() {
        val task = synchronized(stateLock) {
            releaseTask ?: scope.async(start = CoroutineStart.LAZY) { cleanUpEngine() }.also {
                releaseTask = it
                it.start()
            }
        }
        task.await()
        scopeJob.cancel()
    }

    private suspend fun cleanUpEngine() {
        val rejectedCategories = rejectPendingCallbacks()
        val operations = synchronized(stateLock) { inFlightOperations.toMap() }
        val starting = synchronized(stateLock) { startingSubscriptions.toMap() }
        val active = synchronized(stateLock) {
            subscriptions.toMap().also { subscriptions.clear() }
        }
        starting.values.forEach { it.task.cancel() }
        val operationsByCategory = operations.values.associateBy { it.category }
        val startingByCategory = starting.values.mapNotNull { value ->
            value.owner.category?.let { it to value }
        }.toMap()
        val owned = leaseCoordinator.beginCancellingOperations(engineId) { category ->
            if (category in rejectedCategories) {
                operationsByCategory[category]?.task?.let {
                    it.cancel()
                    runCatching { it.await() }
                }
            }
            startingByCategory[category]?.task?.let {
                if (runCatching { it.await() }.isFailure) return@beginCancellingOperations
            }
            stop(category)
        }
        operations.values.forEach { it.task.cancel() }
        active.values.forEach { it.task.cancel() }
        leaseCoordinator.waitForOperationCancellations(engineId, owned)
        operations.values.forEach { runCatching { it.task.await() } }
        starting.values.forEach { runCatching { it.task.await() } }
        active.values.forEach { it.task.join() }
        leaseCoordinator.finishCancelledOperations(engineId, owned, operations.keys)
        synchronized(stateLock) {
            operations.keys.forEach(::finishIdentifierLocked)
            active.keys.forEach(::finishIdentifierLocked)
            starting.keys.forEach(::finishIdentifierLocked)
            inFlightOperations.clear()
            startingSubscriptions.clear()
            connectedDevices.clear()
            discoveredDevices.clear()
            configuration = null
        }
        leaseCoordinator.release(engineId)
    }

    private suspend fun stop(owner: SubscriptionOwner) {
        when (owner) {
            SubscriptionOwner.DEVICE_OPERATION -> client.cancelDeviceOperation()
            SubscriptionOwner.RECORDING_OPERATION -> client.cancelRecordingOperation()
            SubscriptionOwner.OTA -> client.cancelOtaOperation()
            SubscriptionOwner.LOGS -> client.stopLogs()
            SubscriptionOwner.WIFI -> client.cancelWifiOperation()
            SubscriptionOwner.CONNECTION,
            SubscriptionOwner.DEVICE_STATUS,
            SubscriptionOwner.RECORDING_STATE,
            -> Unit
        }
    }

    private suspend fun stop(category: NativeOperationCategory) {
        when (category) {
            NativeOperationCategory.DEVICE -> client.cancelDeviceOperation()
            NativeOperationCategory.PROVISIONING -> client.cancelProvisioningOperation()
            NativeOperationCategory.FACTORY_RESET -> client.cancelFactoryResetOperation()
            NativeOperationCategory.RECORDING -> client.cancelRecordingOperation()
            NativeOperationCategory.OTA -> client.cancelOtaOperation()
            NativeOperationCategory.LOGS -> client.stopLogs()
            NativeOperationCategory.WIFI -> client.cancelWifiOperation()
        }
    }

    private fun subscriptionOwner(request: BotaSubscriptionRequestMessage): SubscriptionOwner = when (request) {
        is BotaScanSubscriptionMessage -> SubscriptionOwner.DEVICE_OPERATION
        is BotaConnectionSubscriptionMessage -> SubscriptionOwner.CONNECTION
        is BotaDeviceStatusSubscriptionMessage -> SubscriptionOwner.DEVICE_STATUS
        is BotaRecordingStateSubscriptionMessage -> SubscriptionOwner.RECORDING_STATE
        is BotaRecordingSyncSubscriptionMessage,
        is BotaUploadOwnershipSubscriptionMessage,
        -> SubscriptionOwner.RECORDING_OPERATION
        is BotaFirmwareUpdateSubscriptionMessage -> SubscriptionOwner.OTA
        is BotaLogSubscriptionMessage -> SubscriptionOwner.LOGS
        is BotaWifiStatusSubscriptionMessage -> SubscriptionOwner.WIFI
    }

    private fun beginIdentifier(id: String, requiresConfiguration: Boolean) {
        validateId(id)
        synchronized(stateLock) {
            if (id in activeIdentifiers || id in consumedIdentifiers) {
                throw bridgeError("duplicate_identifier", "operation or subscription ID was reused")
            }
            requireAttachedLocked()
            if (requiresConfiguration && configuration == null) {
                throw bridgeError("not_configured", "adapter is not configured")
            }
            activeIdentifiers += id
        }
    }

    private fun finishIdentifier(id: String) = synchronized(stateLock) { finishIdentifierLocked(id) }

    private fun finishIdentifierLocked(id: String) {
        if (activeIdentifiers.remove(id)) consumedIdentifiers += id
    }

    private fun reserveSubscription(id: String) = beginIdentifier(id, requiresConfiguration = true)

    private fun validateId(id: String) {
        if (!ID_PATTERN.matches(id)) {
            throw bridgeError(
                "invalid_operation_id",
                "ID must be 32 lowercase hexadecimal characters",
            )
        }
    }

    private fun store(device: ConnectedDevice) = synchronized(stateLock) {
        connectedDevices[device.id] = device
    }

    private fun device(reference: BotaDeviceReferenceMessage): ConnectedDevice =
        synchronized(stateLock) { connectedDevices[reference.id] }
            ?: throw bridgeError("device_not_found", "device is not registered with this engine")

    private fun requireAttached() = synchronized(stateLock) { requireAttachedLocked() }

    private fun requireAttachedLocked() {
        if (detached || destroying) throw bridgeError("engine_detached", "engine is detached")
    }

    private fun isDetached(): Boolean = synchronized(stateLock) { detached || destroying }

    private fun requireCallback(enabled: (BotaConfigurationMessage) -> Boolean) {
        val available = synchronized(stateLock) { configuration?.let(enabled) == true }
        if (!available) throw bridgeError("callback_unavailable", "application callback is unavailable")
    }

    private suspend fun provisioningMaterial(request: ProvisioningMaterialRequest): ProvisioningMaterial {
        val id = callbackId()
        val response = requestMaterial(
            BotaProvisioningMaterialRequestMessage(
                id,
                request.serialNumber,
                request.nonce,
                request.devicePublicKey,
            ),
            id,
            NativeOperationCategory.PROVISIONING,
        )
        if (response.requestId != id) throw callbackIdMismatch()
        if (response !is BotaProvisioningMaterialResponseMessage) throw callbackKindMismatch()
        return ProvisioningMaterial(
            response.apiEndpoint,
            response.deviceToken,
            BotaAndroidMapper.unsignedLong(response.mtu),
        )
    }

    private suspend fun factoryResetGrant(request: FactoryResetGrantRequest): ByteArray {
        val id = callbackId()
        val response = requestMaterial(
            BotaFactoryResetGrantRequestMessage(
                id,
                request.serialNumber,
                request.nonce,
                request.commandId,
                BotaAndroidMapper.signedLong(request.bindingGeneration),
            ),
            id,
            NativeOperationCategory.FACTORY_RESET,
        )
        if (response.requestId != id) throw callbackIdMismatch()
        if (response !is BotaFactoryResetGrantResponseMessage) throw callbackKindMismatch()
        return response.encodedGrant
    }

    private suspend fun firmwareImage(image: BotaFirmwareImageMessage): FirmwareImage {
        val id = callbackId()
        val response = requestFirmware(
            BotaFirmwareRequestMessage(id, image.sourceId, image.version, image.sizeBytes, image.crc32),
            id,
            NativeOperationCategory.OTA,
        )
        if (response.requestId != id) throw callbackIdMismatch()
        val request = try {
            Request.Builder().url(response.url).apply {
                response.headers.forEach { (name, value) -> header(name, value) }
            }.build()
        } catch (_: IllegalArgumentException) {
            throw bridgeError("invalid_callback_response", "firmware URL is invalid")
        }
        return FirmwareImage(
            image.version,
            BotaAndroidMapper.unsignedInt(image.sizeBytes),
            BotaAndroidMapper.unsignedInt(image.crc32),
            stableId(image.sourceId),
            request,
        )
    }

    private suspend fun persistReset(result: FactoryResetPersistenceResult) {
        val id = callbackId()
        val response = persistFactoryResetResult(
            BotaFactoryResetResultRequestMessage(
                id,
                result.commandId,
                BotaAndroidMapper.signedLong(result.bindingGeneration),
                result.localRecordingsDeleted.toLong(),
            ),
            id,
            NativeOperationCategory.FACTORY_RESET,
        )
        if (response.requestId != id) throw callbackIdMismatch()
    }

    private suspend fun requestMaterial(
        request: BotaMaterialRequestMessage,
        id: String,
        category: NativeOperationCategory,
    ): BotaMaterialResponseMessage = awaitCallback(id, category) { complete ->
        flutterApi.requestMaterial(request, complete)
    }

    private suspend fun requestFirmware(
        request: BotaFirmwareRequestMessage,
        id: String,
        category: NativeOperationCategory,
    ): BotaFirmwareSourceMessage = awaitCallback(id, category) { complete ->
        flutterApi.requestFirmware(request, complete)
    }

    private suspend fun persistFactoryResetResult(
        request: BotaFactoryResetResultRequestMessage,
        id: String,
        category: NativeOperationCategory,
    ): BotaFactoryResetResultAcknowledgementMessage = awaitCallback(id, category) { complete ->
        flutterApi.persistFactoryResetResult(request, complete)
    }

    private suspend fun <T> awaitCallback(
        id: String,
        category: NativeOperationCategory,
        start: ((Result<T>) -> Unit) -> Unit,
    ): T {
        val deferred = CompletableDeferred<T>()
        synchronized(stateLock) {
            if (callbackRegistrationClosed) throw bridgeError("engine_detached", "engine is detached")
            pendingCallbacks[id] = PendingCallback(category) {
                deferred.completeExceptionally(bridgeError("engine_detached", "engine is detached"))
            }
        }
        try {
            start { result ->
                result.fold(deferred::complete, deferred::completeExceptionally)
            }
            return deferred.await()
        } finally {
            synchronized(stateLock) { pendingCallbacks.remove(id) }
        }
    }

    private fun rejectPendingCallbacks(): Set<NativeOperationCategory> {
        val callbacks = synchronized(stateLock) {
            pendingCallbacks.values.toList().also { pendingCallbacks.clear() }
        }
        callbacks.forEach { it.reject() }
        return callbacks.mapTo(mutableSetOf()) { it.category }
    }

    private fun mapLeaseError(error: Throwable): Throwable = when (error) {
        is NativeLeaseException.ConfigurationConflict ->
            bridgeError("configuration_conflict", "native client is configured differently")
        is NativeLeaseException.AcquisitionCancelled ->
            bridgeError("engine_detached", "engine is detached")
        is NativeLeaseException.OperationInProgress ->
            bridgeError("operation_in_progress", "another engine owns this native operation")
        is NativeLeaseException.OperationNotOwned ->
            bridgeError("operation_not_owned", "native operation belongs to another engine")
        else -> error
    }

    private fun requireText(value: String, detail: String) {
        if (value.isEmpty()) throw bridgeError("invalid_request", detail)
    }

    private fun callbackId(): String = UUID.randomUUID().toString().replace("-", "").lowercase()
    private fun callbackIdMismatch() = bridgeError(
        "callback_id_mismatch",
        "callback response ID does not match its request",
    )
    private fun callbackKindMismatch() = bridgeError(
        "callback_kind_mismatch",
        "callback response kind is invalid",
    )
    private fun bridgeError(code: String, detail: String) = BotaBridgeException(code, detail = detail)

    private fun stableId(value: String): ULong = value.toByteArray().fold(FNV_OFFSET) { hash, byte ->
        (hash xor byte.toUByte().toULong()) * FNV_PRIME
    }

    private val BotaMaterialResponseMessage.requestId: String
        get() = when (this) {
            is BotaProvisioningMaterialResponseMessage -> requestId
            is BotaFactoryResetGrantResponseMessage -> requestId
        }

    private companion object {
        val ID_PATTERN = Regex("^[0-9a-f]{32}$")
        val FNV_OFFSET = 14_695_981_039_346_656_037uL
        val FNV_PRIME = 1_099_511_628_211uL
    }
}
