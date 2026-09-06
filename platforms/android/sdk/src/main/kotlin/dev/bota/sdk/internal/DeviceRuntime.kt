package dev.bota.sdk.internal

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.internal.bluetooth.BluetoothGattDriver
import dev.bota.sdk.internal.bluetooth.BluetoothGattHost
import dev.bota.sdk.internal.bluetooth.BluetoothPermissionChecker
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.internal.bluetooth.ConfirmedBluetoothDisconnect
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2SignedBlobWriter
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferControl
import dev.bota.sdk.internal.core.EncryptedUploadV2CapabilityReader
import dev.bota.sdk.internal.bluetooth.FrameworkAndroidBluetoothPlatform
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreEngineRuntime
import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.CoreWorkflowRunner
import dev.bota.sdk.internal.host.AndroidKeystoreSecureStorageHost
import dev.bota.sdk.internal.host.ApplicationMaterialHost
import dev.bota.sdk.internal.host.AtomicFileJournalStore
import dev.bota.sdk.internal.host.AtomicFilePersistenceHost
import dev.bota.sdk.internal.host.FileFirmwareBlobHost
import dev.bota.sdk.internal.host.FileRecordingSinkHost
import dev.bota.sdk.internal.host.HostEffectExecutor
import dev.bota.sdk.internal.host.EncryptedUploadV2CheckpointStore
import dev.bota.sdk.internal.host.EncryptedUploadV2MaterialRegistry
import dev.bota.sdk.internal.host.EncryptedUploadV2StagingUploader
import dev.bota.sdk.internal.host.EncryptedUploadV2TerminalOutcome
import dev.bota.sdk.internal.host.EncryptedUploadV2TransferHost
import dev.bota.sdk.internal.host.EncryptedUploadV2TransferHostServices
import dev.bota.sdk.internal.host.OkHttpNetworkHost
import dev.bota.sdk.internal.host.PersistedFactoryResetResult
import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingState
import dev.bota.sdk.model.TransferCommand
import dev.bota.sdk.model.StreamingChunkDestinationProvider
import dev.bota.sdk.model.StreamingFinalizeHandler
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiScanUpdate
import dev.bota.sdk.model.WiFiStatusInfo
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import dev.bota.sdk.EncryptedUploadV2CapabilitySnapshot
import dev.bota.sdk.EncryptedUploadV2Checkpoint
import dev.bota.sdk.EncryptedUploadV2Material
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request

internal class DeviceRuntime(
    val engine: CoreWorkflowRunner,
    val capabilities: CoreCapabilities,
    val authorize: (BotaOperation) -> Unit,
    val disconnect: suspend (String) -> Unit,
    val readStatus: suspend (String) -> ByteArray,
    val statusUpdates: suspend (String) -> Flow<ByteArray>,
    val stopStatusUpdates: suspend (String) -> Unit,
    val decodeStatus: (ByteArray) -> DeviceStatus,
    private val closeResources: () -> Unit,
    val connection: DeviceConnectionRegistry = DeviceConnectionRegistry(),
    val operations: DeviceOperationCoordinator = DeviceOperationCoordinator(),
    val directRead: suspend (String, UUID, UUID) -> ByteArray = { _, _, _ ->
        error("direct read unavailable")
    },
    val directWrite: suspend (String, UUID, UUID, ByteArray) -> Unit = { _, _, _, _ ->
        error("direct write unavailable")
    },
    val directSubscribe: suspend (String, UUID, UUID) -> Flow<ByteArray> = { _, _, _ ->
        error("direct subscription unavailable")
    },
    val directUnsubscribe: suspend (String, UUID, UUID) -> Unit = { _, _, _ -> },
    val delay: suspend (Long) -> Unit = { milliseconds -> kotlinx.coroutines.delay(milliseconds) },
    val parseRecordingState: (ByteArray) -> RecordingState = {
        error("recording-state decoder unavailable")
    },
    val parseRecordingControlResult: (ByteArray) -> RecordingControlResult = {
        error("recording-control-result decoder unavailable")
    },
    val createRecordingControlCommand: (dev.bota.sdk.RecordingControlCommand) -> ByteArray = {
        error("recording-control encoder unavailable")
    },
    val parseWiFiConfigResult: (ByteArray) -> WiFiConfigResult = {
        error("WiFi config-result decoder unavailable")
    },
    val parseWiFiStatusInfo: (ByteArray) -> WiFiStatusInfo = {
        error("WiFi status decoder unavailable")
    },
    val parseWiFiScanResult: (ByteArray) -> WiFiScanUpdate = {
        error("WiFi scan decoder unavailable")
    },
    val createWiFiGrantPacket: (String) -> ByteArray = {
        error("WiFi grant encoder unavailable")
    },
    val createWiFiCredentialPacket: (String, String) -> ByteArray = { _, _ ->
        error("WiFi credential encoder unavailable")
    },
    val createWiFiScanCommand: () -> ByteArray = {
        error("WiFi scan-command encoder unavailable")
    },
    val createProvisioningChunks: (ByteArray, Int) -> List<ByteArray> = { _, _ ->
        error("provisioning chunk encoder unavailable")
    },
    val createTimeSyncData: (ULong, Short) -> ByteArray = { _, _ ->
        error("time-sync encoder unavailable")
    },
    val parseConnectionSettings: (ByteArray) -> DeviceConnectionSettings = {
        error("connection-settings decoder unavailable")
    },
    val serializeConnectionSettings: (DeviceConnectionSettings, DeviceType) -> ByteArray = { _, _ ->
        error("connection-settings encoder unavailable")
    },
    val encodeDeviceCommand: (UByte) -> ByteArray = { error("device-command encoder unavailable") },
    val registerProvisioning: (
        String,
        suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) -> Unit = { _, _ -> },
    val registerFactoryReset: (String, suspend (String, ByteArray) -> ByteArray) -> Unit = { _, _ -> },
    val unregisterMaterial: (String) -> Unit = {},
    val registerFactoryResetGeneration: suspend (String, ULong) -> Unit = { _, _ -> },
    val unregisterFactoryResetGeneration: suspend (String) -> Unit = {},
    val registerFactoryResetResultPersister: suspend (
        String,
        suspend (PersistedFactoryResetResult) -> Unit,
    ) -> Unit = { _, _ -> },
    val unregisterFactoryResetResultPersister: suspend (String) -> Unit = {},
    val loadPendingFactoryReset: suspend () -> PersistedFactoryResetResult? = { null },
    val parseRecordingList: (ByteArray) -> List<DeviceRecording> = { error("recording-list decoder unavailable") },
    val createTransferCommand: (TransferCommand) -> ByteArray = { error("transfer-command encoder unavailable") },
    val registerRecordingSink: (String) -> Path = { error("recording sink unavailable") },
    val unregisterRecordingSink: (String) -> Unit = {},
    val registerStreamingSink: suspend (
        String,
        Int,
        ULong,
        StreamingChunkDestinationProvider,
        StreamingFinalizeHandler,
    ) -> Unit = { _, _, _, _, _ -> error("streaming sink unavailable") },
    val unregisterStreamingSink: suspend (String) -> Unit = {},
    val registerFirmwareDownload: (ULong, Request) -> Path = { _, _ -> error("firmware download unavailable") },
    val unregisterFirmwareDownload: (ULong) -> Unit = {},
    val readEncryptedUploadV2Capabilities: suspend (String) -> EncryptedUploadV2CapabilitySnapshot = {
        error("encrypted upload v2 capability reader unavailable")
    },
    val encryptedUploadV2Checkpoint: suspend (String, String, UInt) -> EncryptedUploadV2Checkpoint? = { _, _, _ -> null },
    val encryptedUploadV2MaximumWriteLength: (String) -> Int = { error("encrypted upload v2 MTU unavailable") },
    val registerEncryptedUploadV2Material: suspend (String, EncryptedUploadV2Material) -> Unit = { _, _ ->
        error("encrypted upload v2 material registry unavailable")
    },
    val terminateEncryptedUploadV2Material: suspend (String, EncryptedUploadV2TerminalOutcome) -> Unit = { _, _ -> },
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        closeResources()
    }

    internal companion object {
        fun create(
            context: Context,
            networkClient: OkHttpClient,
            storageDirectory: File?,
        ): DeviceRuntime {
            val root = storageDirectory ?: File(context.noBackupFilesDir, "bota-app-sdk")
            val closeActions = mutableListOf<() -> Unit>()
            try {
                val platform = FrameworkAndroidBluetoothPlatform(context)
                closeActions += platform::close
                val driver = BluetoothGattDriver(platform)
                closeActions[closeActions.lastIndex] = driver::close
                val permissions = BluetoothPermissionChecker(Build.VERSION.SDK_INT) { permission ->
                    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
                }
                val bluetooth = BluetoothGattHost(driver, permissions)
                val persistenceJournals = AtomicFileJournalStore(File(root, "state"))
                val persistence = AtomicFilePersistenceHost(persistenceJournals)
                val secureStorage = AndroidKeystoreSecureStorageHost(context, rootDirectory = File(root, "secrets"))
                val network = OkHttpNetworkHost(networkClient).also { closeActions += it::close }
                val material = ApplicationMaterialHost().also { closeActions += it::close }
                val recordingSink = FileRecordingSinkHost(networkClient = networkClient).also { closeActions += it::close }
                val firmwareBlob = FileFirmwareBlobHost().also { closeActions += it::close }
                val mapper = CoreModelMapper().also { closeActions += it::close }
                val connection = DeviceConnectionRegistry()
                val encryptedMaterial = EncryptedUploadV2MaterialRegistry()
                val encryptedCheckpoint = EncryptedUploadV2CheckpointStore(
                    AtomicFileJournalStore(File(root, "encrypted-upload-v2/checkpoints")),
                )
                val encryptedUploader = EncryptedUploadV2StagingUploader(networkClient).also { closeActions += it::close }
                val encryptedSignedWriter = EncryptedUploadV2SignedBlobWriter(driver, mapper)
                val encryptedControl = EncryptedUploadV2TransferControl(driver, mapper).also { closeActions += it::close }
                val disconnectResetMutex = Mutex()
                val writeIds = AtomicInteger(0)
                fun currentPeripheral(): String = connection.current()?.id
                    ?: error("encrypted upload v2 requires a current verified connection")
                val encryptedHost = EncryptedUploadV2TransferHost(
                    File(root, "encrypted-upload-v2/files").toPath(),
                    EncryptedUploadV2TransferHostServices(
                        materialRegistry = encryptedMaterial,
                        checkpointStore = encryptedCheckpoint,
                        openTransfer = { request, checkpoint ->
                            disconnectResetMutex.withLock {
                                encryptedControl.open(currentPeripheral(), request, checkpoint)
                            }
                        },
                        sendControl = encryptedControl::writeActiveFrame,
                        confirmTransfer = { transportSessionId, frame, writeSucceeded ->
                            disconnectResetMutex.withLock {
                                encryptedControl.confirm(transportSessionId, frame, writeSucceeded)
                            }
                        },
                        confirmationAttemptedOrClaimCancellation = { transportSessionId ->
                            disconnectResetMutex.withLock {
                                encryptedControl.confirmationAttemptedOrClaimCancellation(transportSessionId)
                            }
                        },
                        abortTransfer = encryptedControl::abort,
                        releaseTransfer = encryptedControl::release,
                        sendSignedDocument = { kind, id, value, maximum ->
                            disconnectResetMutex.withLock {
                                encryptedSignedWriter.send(currentPeripheral(), kind, id, value, maximum)
                            }
                        },
                        uploadCiphertext = encryptedUploader::upload,
                        cancelUploads = encryptedUploader::cancelAll,
                        nextWriteId = {
                            writeIds.updateAndGet { current -> if (current == Int.MAX_VALUE) 1 else current + 1 }.toUInt()
                        },
                        encodeAcknowledgement = { value ->
                            mapper.createEncryptedUploadV2WindowAcknowledgement(
                                value.transportSessionId, value.windowIndex, value.highestContiguousSequence,
                                value.nextCiphertextOffset, value.prefixSha256, value.checkpointRevision,
                                value.missingSequences,
                            )
                        },
                        encodeConfirm = mapper::createEncryptedUploadV2Confirm,
                    ),
                ).also { closeActions += it::close }
                suspend fun resetEncryptedUploadOwnership(disconnect: ConfirmedBluetoothDisconnect) = disconnectResetMutex.withLock {
                    if (!driver.isCurrentDisconnectedGeneration(disconnect)) return@withLock
                    encryptedControl.resetAfterConfirmedDisconnect(disconnect)
                    encryptedSignedWriter.resetAfterConfirmedDisconnect(disconnect)
                    encryptedHost.resetAfterConfirmedDisconnect()
                }
                val disconnectResetScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
                closeActions += { disconnectResetScope.cancel() }
                disconnectResetScope.launch {
                    driver.confirmedDisconnects().collect { resetEncryptedUploadOwnership(it) }
                }
                val encryptedCapabilityReader = EncryptedUploadV2CapabilityReader(
                    driver::read,
                    mapper::decodeEncryptedUploadV2Capabilities,
                )
                val host = HostEffectExecutor(
                    bluetooth = bluetooth,
                    persistence = persistence,
                    secureStorage = secureStorage,
                    network = network,
                    material = material,
                    recordingSink = recordingSink,
                    firmwareBlob = firmwareBlob,
                    encryptedUploadV2 = encryptedHost,
                )
                val engine = CoreEngineRuntime(NativeCoreBridge(), host).also { closeActions += it::close }
                val allCapabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer +
                    CoreCapabilities.Persistence + CoreCapabilities.SecureStorage +
                    CoreCapabilities.NetworkTransfer + CoreCapabilities.Progress +
                    CoreCapabilities.HostMaterial + CoreCapabilities.RecordingSink +
                    CoreCapabilities.FirmwareBlob

                fun authorize(operation: BotaOperation) {
                    when (operation) {
                        BotaOperation.Discover -> permissions.requireScan(operation)
                        else -> permissions.requireConnect(operation)
                    }
                }

                return DeviceRuntime(
                    engine = engine,
                    capabilities = allCapabilities,
                    authorize = ::authorize,
                    disconnect = { peripheralId ->
                        val disconnect = ConfirmedBluetoothDisconnect(
                            peripheralId, driver.connectionGeneration(peripheralId),
                        )
                        driver.disconnect(peripheralId)
                        resetEncryptedUploadOwnership(disconnect)
                    },
                    readStatus = { peripheralId ->
                        driver.read(peripheralId, BotaBluetoothUUIDs.ControlService, BotaBluetoothUUIDs.DeviceStatus)
                    },
                    statusUpdates = { peripheralId ->
                        driver.subscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.ControlService,
                            BotaBluetoothUUIDs.DeviceStatus,
                        ).map { it.value }
                    },
                    stopStatusUpdates = { peripheralId ->
                        driver.unsubscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.ControlService,
                            BotaBluetoothUUIDs.DeviceStatus,
                        )
                    },
                    decodeStatus = mapper::parseDeviceStatus,
                    closeResources = { closeAll(*closeActions.asReversed().toTypedArray()) },
                    connection = connection,
                    directRead = driver::read,
                    directWrite = { peripheralId, service, characteristic, value ->
                        driver.write(peripheralId, service, characteristic, value, withResponse = true)
                    },
                    directSubscribe = { peripheralId, service, characteristic ->
                        driver.subscribe(peripheralId, service, characteristic).map { it.value }
                    },
                    directUnsubscribe = { peripheralId, service, characteristic ->
                        driver.unsubscribe(peripheralId, service, characteristic)
                    },
                    parseRecordingState = mapper::parseRecordingState,
                    parseRecordingControlResult = mapper::parseRecordingControlResult,
                    createRecordingControlCommand = mapper::createRecordingControlCommand,
                    parseWiFiConfigResult = mapper::parseWiFiConfigResult,
                    parseWiFiStatusInfo = mapper::parseWiFiStatusInfo,
                    parseWiFiScanResult = mapper::parseWiFiScanResult,
                    createWiFiGrantPacket = mapper::createWiFiGrantPacket,
                    createWiFiCredentialPacket = mapper::createWiFiCredentialPacket,
                    createWiFiScanCommand = mapper::createWiFiScanCommand,
                    createProvisioningChunks = mapper::createProvisioningChunks,
                    createTimeSyncData = mapper::createTimeSyncData,
                    parseConnectionSettings = { mapper.parseConnectionSettings(it).settings },
                    serializeConnectionSettings = mapper::serializeConnectionSettings,
                    encodeDeviceCommand = mapper::encodeDeviceCommand,
                    registerProvisioning = { id, provider ->
                        material.registerProvisioning(id) { request ->
                            val resolved = provider(
                                ProvisioningMaterialRequest(
                                    request.serialNumber,
                                    request.nonce,
                                    request.devicePublicKey,
                                ),
                            )
                            dev.bota.sdk.internal.host.ProvisioningMaterial(
                                resolved.apiEndpoint,
                                resolved.deviceToken,
                                resolved.mtu,
                            )
                        }
                    },
                    registerFactoryReset = { id, provider ->
                        material.registerFactoryReset(id) { request -> provider(request.serialNumber, request.nonce) }
                    },
                    unregisterMaterial = material::unregister,
                    registerFactoryResetGeneration = persistence::registerFactoryReset,
                    unregisterFactoryResetGeneration = persistence::unregisterFactoryReset,
                    registerFactoryResetResultPersister = persistence::registerFactoryResetResultPersister,
                    unregisterFactoryResetResultPersister = persistence::unregisterFactoryResetResultPersister,
                    loadPendingFactoryReset = persistence::loadFactoryResetResult,
                    parseRecordingList = mapper::parseRecordingList,
                    createTransferCommand = mapper::createTransferCommand,
                    registerRecordingSink = { sinkId ->
                        val path = File(root, "recordings/$sinkId.recording").toPath()
                        recordingSink.registerPath(sinkId, path)
                        path
                    },
                    unregisterRecordingSink = recordingSink::unregister,
                    registerStreamingSink = recordingSink::registerStreaming,
                    unregisterStreamingSink = recordingSink::unregisterStreaming,
                    registerFirmwareDownload = { downloadId, request ->
                        val path = File(root, "firmware/$downloadId.firmware").toPath()
                        path.parent?.let(Files::createDirectories)
                        network.registerDownload(downloadId, request, path)
                        try {
                            firmwareBlob.registerPath(downloadId, path)
                        } catch (error: Throwable) {
                            network.unregister(downloadId)
                            throw error
                        }
                        path
                    },
                    unregisterFirmwareDownload = { downloadId ->
                        network.unregister(downloadId)
                        firmwareBlob.unregister(downloadId)
                    },
                    readEncryptedUploadV2Capabilities = encryptedCapabilityReader::readFresh,
                    encryptedUploadV2Checkpoint = encryptedHost::checkpoint,
                    encryptedUploadV2MaximumWriteLength = driver::maximumWriteLength,
                    registerEncryptedUploadV2Material = encryptedMaterial::register,
                    terminateEncryptedUploadV2Material = encryptedMaterial::terminate,
                )
            } catch (failure: Throwable) {
                runCatching { closeAll(*closeActions.asReversed().toTypedArray()) }
                    .exceptionOrNull()
                    ?.let(failure::addSuppressed)
                throw failure
            }
        }
    }
}

internal fun closeAll(vararg actions: () -> Unit) {
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
