package dev.bota.sdk.flutter

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.FirmwareImage
import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.RecordingTransferMetadata
import dev.bota.sdk.UploadOwnershipEvent
import dev.bota.sdk.UploadOwnershipResult
import dev.bota.sdk.model.AudioCodec
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeprovisionResult
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.FactoryResetPersistenceResult
import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.PairingState
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.RecordingInitiator
import dev.bota.sdk.model.RecordingState
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiConnectionStatus
import dev.bota.sdk.model.WiFiScanNetwork
import dev.bota.sdk.model.WiFiStatusInfo
import dev.bota.sdk.model.WifiRadioStatus
import dev.bota.sdk.model.WireValue
import java.nio.file.Path
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BotaAndroidAdapterTest {
    @Test
    fun invalidOperationIdentifierFailsBeforeNativeState() = runTest {
        val client = FakeAndroidClient()
        val adapter = adapter(client)

        val error = assertSuspendFailsWith<FlutterError> {
            adapter.configure("NOT-AN-ID", configuration())
        }

        assertEquals("invalid_operation_id", error.code)
        assertTrue(client.invocations.isEmpty())
    }

    @Test
    fun allOneShotOperationsMapToNativeManagersAndCallbacks() = runTest {
        val client = FakeAndroidClient()
        val flutter = FakeFlutterApi()
        val adapter = adapter(client, flutter)
        adapter.configure(id(1), configuration())
        discover(adapter, id(32))

        assertEquals("BP-001", adapter.connect(id(2), discoveredMessage(), "BP-001").serialNumber)
        adapter.reconnect(id(3), "BP-001", reconnectHint())
        adapter.disconnect(id(4))
        adapter.connect(id(5), discoveredMessage(), "BP-001")
        adapter.readDeviceStatus(id(6))
        adapter.cancelDeviceOperation(id(7))
        adapter.startRecording(id(8), deviceReference(), "start-grant")
        adapter.stopRecording(id(9), deviceReference(), "stop-grant")
        adapter.readRecordingState(id(10), deviceReference())
        adapter.provision(id(11), deviceReference())
        adapter.readConnectionSettings(id(12), deviceReference())
        adapter.writeConnectionSettings(id(13), deviceReference(), settingsMessage())
        adapter.deprovision(id(14), deviceReference(), "deprovision-grant")
        adapter.cancelProvisioningOperation(id(15))
        adapter.factoryReset(id(16), deviceReference(), resetCommand())
        adapter.resumePendingFactoryReset(id(17), deviceReference(), 4)
        adapter.resumeUnjournaledFactoryReset(id(18), deviceReference(), resetCommand("command-2"))
        adapter.cancelFactoryResetOperation(id(19))
        adapter.listRecordings(id(20), deviceReference())
        adapter.takeTransferMetadata(id(21), "sink-1")
        adapter.confirmRecording(id(22), deviceReference(), "recording-1")
        adapter.cancelRecordingOperation(id(23))
        adapter.cancelOtaOperation(id(24))
        adapter.stopLogs(id(25))
        adapter.configureWifi(
            id(26),
            deviceReference(),
            BotaWifiCredentialsMessage("Bota", "secret"),
            "wifi-grant",
        )
        adapter.disconnectWifi(id(27), deviceReference())
        adapter.readWifiStatus(id(28), deviceReference())
        adapter.scanWifi(id(29), deviceReference())
        adapter.cancelWifiOperation(id(30))
        adapter.destroy(id(31))

        val expected = setOf(
            "configure", "scanFlow", "connect", "reconnect", "disconnect", "readDeviceStatus",
            "cancelDeviceOperation", "startRecording", "stopRecording", "readRecordingState",
            "provision", "readConnectionSettings", "writeConnectionSettings", "deprovision",
            "factoryReset", "resumePendingFactoryReset", "resumeUnjournaledFactoryReset",
            "listRecordings", "takeTransferMetadata", "confirmRecording", "configureWifi",
            "disconnectWifi", "readWifiStatus", "scanWifi", "destroy",
        )
        assertEquals(expected, client.invocations.toSet())
        assertEquals(1, client.invocations.count { it == "cancelDeviceOperation" })
        assertEquals(listOf("provisioning", "factoryReset"), flutter.materialKinds)
        assertEquals(
            listOf("command-1" to 4L, "durable-command" to 4L, "command-2" to 4L),
            flutter.persistedResets,
        )
        assertEquals("start-grant", client.startRecordingGrant)
        assertEquals("stop-grant", client.stopRecordingGrant)
        assertEquals("deprovision-grant", client.deprovisionGrant)
        assertEquals("wifi-grant", client.wifiGrant)
    }

    @Test
    fun allNativeStreamKindsEmitMappedEvents() = runTest {
        val client = FakeAndroidClient()
        val flutter = FakeFlutterApi()
        val adapter = adapter(client, flutter)
        adapter.configure(id(1), configuration())
        discover(adapter, id(40))
        adapter.connect(id(2), discoveredMessage(), "BP-001")
        flutter.events.clear()

        val requests = listOf<BotaSubscriptionRequestMessage>(
            BotaScanSubscriptionMessage(1_000, false),
            BotaConnectionSubscriptionMessage(),
            BotaDeviceStatusSubscriptionMessage(),
            BotaRecordingStateSubscriptionMessage(deviceReference()),
            BotaRecordingSyncSubscriptionMessage(deviceReference(), recordingMessage(), "sink-1", false),
            BotaUploadOwnershipSubscriptionMessage(
                deviceReference(),
                "recording-1",
                "upload-1",
                "destination-1",
            ),
            BotaFirmwareUpdateSubscriptionMessage(
                deviceReference(),
                BotaFirmwareImageMessage("firmware-source", "1.2.3", 512, 123),
            ),
            BotaLogSubscriptionMessage(deviceReference()),
            BotaWifiStatusSubscriptionMessage(deviceReference()),
        )
        requests.forEachIndexed { index, request ->
            adapter.startSubscription(id(50 + index), request)
            advanceUntilIdle()
        }

        val payloadNames = flutter.events.map { it.payload::class.simpleName }.toSet()
        assertTrue("BotaDiscoveredDeviceEventMessage" in payloadNames)
        assertTrue("BotaConnectionEventMessage" in payloadNames)
        assertTrue("BotaDeviceStatusEventMessage" in payloadNames)
        assertTrue("BotaRecordingStateEventMessage" in payloadNames)
        assertTrue("BotaRecordingSyncProgressEventMessage" in payloadNames)
        assertTrue("BotaRecordingSyncCompletedEventMessage" in payloadNames)
        assertTrue("BotaUploadOwnershipProgressEventMessage" in payloadNames)
        assertTrue("BotaUploadOwnershipResolvedEventMessage" in payloadNames)
        assertTrue("BotaFirmwareProgressEventMessage" in payloadNames)
        assertTrue("BotaDeviceLogEventMessage" in payloadNames)
        assertTrue("BotaWifiStatusEventMessage" in payloadNames)
        assertEquals(9, flutter.events.map { it.subscriptionId }.toSet().size)
        assertEquals(listOf("firmware"), flutter.callbackKinds)
        assertTrue(
            setOf(
                "scanFlow", "connectionFlow", "deviceStatusFlow", "recordingStateFlow",
                "recordingSyncFlow", "uploadOwnershipFlow", "firmwareFlow", "logFlow",
                "wifiStatusFlow",
            ).all(client.invocations::contains),
        )
        adapter.detach()
    }

    @Test
    fun perEngineRegistriesAndCrossKindIdentifierTombstonesAreEnforced() = runTest {
        val client = FakeAndroidClient()
        val coordinator = NativeLeaseCoordinator(client, this)
        val first = adapter(client, leases = coordinator, engineId = "first")
        val second = adapter(client, leases = coordinator, engineId = "second")
        first.configure(id(1), configuration())
        second.configure(id(2), configuration())
        discover(first, id(3))

        val invisible = assertSuspendFailsWith<FlutterError> {
            second.connect(id(4), discoveredMessage(), "BP-001")
        }
        assertEquals("device_not_found", invisible.code)
        val reused = assertSuspendFailsWith<FlutterError> {
            first.readDeviceStatus(id(1))
        }
        assertEquals("duplicate_identifier", reused.code)
        val crossKind = assertSuspendFailsWith<FlutterError> {
            first.startSubscription(id(1), BotaConnectionSubscriptionMessage())
        }
        assertEquals("duplicate_identifier", crossKind.code)
        first.detach()
        second.detach()
    }

    @Test
    fun API26IntegerAndUnknownEnumBoundsFailBeforeNativeState() = runTest {
        val client = FakeAndroidClient()
        val adapter = adapter(client)
        adapter.configure(id(1), configuration())

        val overflow = assertSuspendFailsWith<FlutterError> {
            adapter.reconnect(id(2), "serial", BotaReconnectHintMessage(null, null, null, -1, 1_000))
        }
        assertEquals("bota_sdk_error", overflow.code)
        assertEquals(0, client.invocations.count { it == "reconnect" })

        assertEquals("unknown", BotaAndroidMapper.deviceType(DeviceType.Unknown(247u)).name)
        assertEquals(
            DeviceType.Unknown(247u),
            BotaAndroidMapper.deviceType(BotaDeviceTypeMessage("future", 247)),
        )
        val rawOverflow = runCatching {
            BotaAndroidMapper.deviceType(BotaDeviceTypeMessage("future", 256))
        }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.InvalidInput, rawOverflow.code)
        val payloadOverflow = runCatching {
            BotaAndroidMapper.recordingProgress(
                RecordingTransferProgress(Long.MAX_VALUE.toULong() + 1u, ULong.MAX_VALUE),
            )
        }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.PayloadTooLarge, payloadOverflow.code)
        val settings = BotaAndroidMapper.connectionSettings(
            nativeSettings().copy(
                powerManagement = DeviceConnectionSettings.PowerManagement(0, -1),
            ),
        )
        assertEquals(0L, settings.powerManagement.wifiIdleTimeoutMillis)
        assertEquals(-1_000L, settings.powerManagement.cellularIdleTimeoutMillis)
        val invalidTimeout = runCatching {
            BotaAndroidMapper.connectionSettings(
                settingsMessage().copy(
                    powerManagement = BotaPowerManagementMessage(-500, 1_000),
                ),
            )
        }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.InvalidInput, invalidTimeout.code)
        adapter.detach()
    }

    @Test
    fun API35PermissionErrorUsesStableFlutterSurface() = runTest {
        val client = FakeAndroidClient().apply {
            readStatusError = BotaSDKError.AuthorizationRequired(
                setOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"),
                BotaOperation.Discover,
            )
        }
        val adapter = adapter(client)
        adapter.configure(id(1), configuration())

        val error = assertSuspendFailsWith<FlutterError> { adapter.readDeviceStatus(id(2)) }
        val details = error.details as BotaErrorMessage

        assertEquals("bota_sdk_error", error.code)
        assertEquals("featureUnavailable", details.code.name)
        assertEquals("discover", details.operation.name)
        assertEquals(
            "Required Bluetooth permissions are missing: " +
                "android.permission.BLUETOOTH_CONNECT, android.permission.BLUETOOTH_SCAN",
            details.detail,
        )
        adapter.detach()
    }

    @Test
    fun nativeUnknownErrorAndCallbackResponsesPreserveStableFields() = runTest {
        val client = FakeAndroidClient().apply {
            readStatusError = BotaSDKError.Core(
                BotaErrorCode.Unknown(900u),
                BotaOperation.Unknown(901u),
                retryable = true,
                protocolStatus = 17u,
                detail = "native detail",
            )
        }
        val adapter = adapter(client)
        adapter.configure(id(1), configuration())
        val error = assertSuspendFailsWith<FlutterError> { adapter.readDeviceStatus(id(2)) }
        val details = error.details as BotaErrorMessage
        assertEquals(900L, details.code.rawValue)
        assertEquals(901L, details.operation.rawValue)
        assertTrue(details.retryable)
        assertEquals(17L, details.protocolStatus)
        assertEquals("native detail", details.detail)
        adapter.detach()

        for ((index, mode) in listOf(
            FakeFlutterApi.Mode.WRONG_ID,
            FakeFlutterApi.Mode.WRONG_MATERIAL_KIND,
        ).withIndex()) {
            val flutter = FakeFlutterApi(mode)
            val candidate = adapter(FakeAndroidClient(), flutter, engineId = "callback-$index")
            candidate.configure(id(10 + index), configuration())
            discover(candidate, id(20 + index))
            candidate.connect(id(30 + index), discoveredMessage(), "BP-001")
            val callbackError = assertSuspendFailsWith<FlutterError> {
                candidate.provision(id(40 + index), deviceReference())
            }
            assertEquals(
                if (mode == FakeFlutterApi.Mode.WRONG_ID) {
                    "callback_id_mismatch"
                } else {
                    "callback_kind_mismatch"
                },
                callbackError.code,
            )
            candidate.detach()
        }
    }

    @Test
    fun detachDuringConfigureCannotRestoreLeaseOrConfiguration() = runTest {
        supervisorScope {
        val client = FakeAndroidClient(suspendConfigure = true)
        val adapter = adapter(client)
        val configure = async { adapter.configure(id(1), configuration()) }
        client.configureStarted.await()

        adapter.detach()
        client.resumeConfigure.complete(Unit)

        val error = assertSuspendFailsWith<FlutterError> { configure.await() }
        assertEquals("engine_detached", error.code)
        assertEquals(1, client.destroyCount)
        }
    }

    @Test
    fun detachRejectsPendingCallbackOnceAndAwaitsOwnedWork() = runTest {
        supervisorScope {
        val client = FakeAndroidClient()
        val flutter = FakeFlutterApi(FakeFlutterApi.Mode.SUSPENDED_MATERIAL)
        val adapter = adapter(client, flutter)
        adapter.configure(id(1), configuration())
        discover(adapter, id(2))
        adapter.connect(id(3), discoveredMessage(), "BP-001")
        val provision = async { adapter.provision(id(4), deviceReference()) }
        flutter.materialRequested.await()

        adapter.detach()
        val error = assertSuspendFailsWith<FlutterError> { provision.await() }
        flutter.resumeMaterial()

        assertEquals("engine_detached", error.code)
        assertEquals(1, client.destroyCount)
        assertEquals(0, adapter.activeSubscriptionCount)
        }
    }

    @Test
    fun publicCancellationAwaitsDirectReadUnwindBeforeReleasingOwnership() = runTest {
        supervisorScope {
        val client = FakeAndroidClient(suspendReadStatus = true)
        val coordinator = NativeLeaseCoordinator(client, this)
        val adapter = adapter(client, leases = coordinator)
        adapter.configure(id(1), configuration())
        val read = async { adapter.readDeviceStatus(id(2)) }
        client.readStatusStarted.await()

        val cancel = async { adapter.cancelDeviceOperation(id(3)) }
        client.readStatusCancellationObserved.await()
        assertFalse(cancel.isCompleted)
        assertSuspendFailsWith<NativeLeaseException.OperationInProgress> {
            coordinator.beginOperation("other", NativeOperationCategory.DEVICE, "other")
        }
        client.allowReadStatusUnwind.complete(Unit)
        cancel.await()
        assertSuspendFailsWith<FlutterError> { read.await() }
        coordinator.beginOperation("other", NativeOperationCategory.DEVICE, "other")
        coordinator.finishOperation("other", NativeOperationCategory.DEVICE, "other")
        adapter.detach()
        }
    }

    @Test
    fun anotherEngineCannotCancelOwnedNativeWork() = runTest {
        supervisorScope {
        val client = FakeAndroidClient(suspendReadStatus = true)
        val coordinator = NativeLeaseCoordinator(client, this)
        val first = adapter(client, leases = coordinator, engineId = "first")
        val second = adapter(client, leases = coordinator, engineId = "second")
        first.configure(id(1), configuration())
        second.configure(id(2), configuration())
        val read = async { first.readDeviceStatus(id(3)) }
        client.readStatusStarted.await()

        val error = assertSuspendFailsWith<FlutterError> { second.cancelDeviceOperation(id(4)) }
        assertEquals("operation_not_owned", error.code)
        assertEquals(0, client.deviceCancellationCount)

        val cancellation = async { first.cancelDeviceOperation(id(5)) }
        client.readStatusCancellationObserved.await()
        client.allowReadStatusUnwind.complete(Unit)
        cancellation.await()
        assertSuspendFailsWith<FlutterError> { read.await() }
        first.detach()
        second.detach()
        }
    }

    @Test
    fun subscriptionStartupIsTrackedBeforeCoordinatorAcquisition() = runTest {
        supervisorScope {
        val client = FakeAndroidClient()
        val acquisitionEntered = CompletableDeferred<Unit>()
        val releaseAcquisition = CompletableDeferred<Unit>()
        val coordinator = NativeLeaseCoordinator(client, this) {
            acquisitionEntered.complete(Unit)
            releaseAcquisition.await()
        }
        val adapter = adapter(client, leases = coordinator)
        adapter.configure(id(1), configuration())
        val start = async {
            adapter.startSubscription(id(2), BotaScanSubscriptionMessage(1_000, false))
        }
        acquisitionEntered.await()

        val cancel = async { adapter.cancelSubscription(id(2)) }
        cancel.await()
        releaseAcquisition.complete(Unit)
        assertSuspendFailsWith<FlutterError> { start.await() }

        assertEquals(0, client.invocations.count { it == "scanFlow" })
        assertEquals(0, adapter.activeSubscriptionCount)
        adapter.detach()
        }
    }

    @Test
    fun detachCancelsStartupTrackedBeforeCoordinatorAcquisition() = runTest {
        supervisorScope {
            val client = FakeAndroidClient()
            val acquisitionEntered = CompletableDeferred<Unit>()
            val releaseAcquisition = CompletableDeferred<Unit>()
            val coordinator = NativeLeaseCoordinator(client, this@runTest) {
                acquisitionEntered.complete(Unit)
                releaseAcquisition.await()
            }
            val adapter = adapter(client, leases = coordinator)
            adapter.configure(id(1), configuration())
            val start = async {
                adapter.startSubscription(id(2), BotaScanSubscriptionMessage(1_000, false))
            }
            acquisitionEntered.await()

            adapter.detach()
            releaseAcquisition.complete(Unit)
            val error = assertSuspendFailsWith<FlutterError> { start.await() }

            assertEquals("engine_detached", error.code)
            assertEquals(0, client.invocations.count { it == "scanFlow" })
            assertEquals(1, client.destroyCount)
        }
    }

    @Test
    fun returnedButUninstalledFlowWithFailedStopRemainsPoisoned() = runTest {
        supervisorScope {
            val client = FakeAndroidClient(failDeviceCancellation = true)
            val coordinator = NativeLeaseCoordinator(client, this@runTest)
            val installEntered = CompletableDeferred<Unit>()
            val allowInstall = CompletableDeferred<Unit>()
            val first = adapter(
                client,
                leases = coordinator,
                engineId = "first",
                beforeSubscriptionInstall = {
                    installEntered.complete(Unit)
                    allowInstall.await()
                },
            )
            val second = adapter(client, leases = coordinator, engineId = "second")
            first.configure(id(1), configuration())
            second.configure(id(2), configuration())
            val start = async {
                first.startSubscription(id(3), BotaScanSubscriptionMessage(1_000, false))
            }
            installEntered.await()

            val cancellation = assertSuspendFailsWith<FlutterError> {
                first.cancelSubscription(id(3))
            }
            assertEquals("bota_sdk_error", cancellation.code)
            val poisoned = assertSuspendFailsWith<FlutterError> {
                second.startSubscription(id(4), BotaScanSubscriptionMessage(1_000, false))
            }
            assertEquals("operation_in_progress", poisoned.code)

            allowInstall.complete(Unit)
            assertSuspendFailsWith<FlutterError> { start.await() }
            first.detach()
            second.detach()
            assertEquals(1, client.destroyCount)
        }
    }

    @Test
    fun failedStopKeepsCompletedFlowPoisonedUntilFinalSharedClientDestruction() = runTest {
        val client = FakeAndroidClient(failDeviceCancellation = true)
        val coordinator = NativeLeaseCoordinator(client, this)
        val first = adapter(client, leases = coordinator, engineId = "first")
        val second = adapter(client, leases = coordinator, engineId = "second")
        first.configure(id(1), configuration())
        second.configure(id(2), configuration())

        first.startSubscription(id(3), BotaScanSubscriptionMessage(1_000, false))
        advanceUntilIdle()
        assertEquals(0, first.activeSubscriptionCount)
        val poisoned = assertSuspendFailsWith<FlutterError> {
            second.startSubscription(id(4), BotaScanSubscriptionMessage(1_000, false))
        }
        assertEquals("operation_in_progress", poisoned.code)
        val crossEngine = assertSuspendFailsWith<FlutterError> {
            second.cancelDeviceOperation(id(5))
        }
        assertEquals("operation_not_owned", crossEngine.code)

        first.detach()
        assertEquals(0, client.destroyCount)
        second.detach()
        assertEquals(1, client.destroyCount)

        client.failDeviceCancellation = false
        val recovered = adapter(client, leases = coordinator, engineId = "recovered")
        recovered.configure(id(6), configuration())
        recovered.startSubscription(id(7), BotaScanSubscriptionMessage(1_000, false))
        advanceUntilIdle()
        recovered.detach()
        assertEquals(2, client.destroyCount)
    }

    private fun TestScope.adapter(
        client: FakeAndroidClient,
        flutter: FakeFlutterApi = FakeFlutterApi(),
        leases: NativeLeaseCoordinator = NativeLeaseCoordinator(client, this),
        engineId: String = "engine",
        beforeSubscriptionInstall: suspend () -> Unit = {},
    ): BotaAndroidAdapter = BotaAndroidAdapter(
        engineId,
        client,
        leases,
        flutter,
        UnconfinedTestDispatcher(testScheduler),
        beforeSubscriptionInstall,
    )

    private suspend fun TestScope.discover(adapter: BotaAndroidAdapter, subscriptionId: String) {
        adapter.startSubscription(subscriptionId, BotaScanSubscriptionMessage(1_000, false))
        advanceUntilIdle()
    }
}

private class FakeFlutterApi(
    private val mode: Mode = Mode.VALID,
) : BotaFlutterBridge {
    enum class Mode { VALID, WRONG_ID, WRONG_MATERIAL_KIND, SUSPENDED_MATERIAL }

    val events = mutableListOf<BotaEventMessage>()
    val materialKinds = mutableListOf<String>()
    val callbackKinds = mutableListOf<String>()
    val persistedResets = mutableListOf<Pair<String, Long>>()
    val materialRequested = CompletableDeferred<Unit>()
    private var suspendedMaterial: ((Result<BotaMaterialResponseMessage>) -> Unit)? = null

    override suspend fun onEvent(event: BotaEventMessage) {
        events += event
    }

    override fun requestMaterial(
        request: BotaMaterialRequestMessage,
        callback: (Result<BotaMaterialResponseMessage>) -> Unit,
    ) {
        when (request) {
            is BotaProvisioningMaterialRequestMessage -> {
                materialKinds += "provisioning"
                if (mode == Mode.SUSPENDED_MATERIAL) {
                    suspendedMaterial = callback
                    materialRequested.complete(Unit)
                    return
                }
                if (mode == Mode.WRONG_MATERIAL_KIND) {
                    callback(Result.success(BotaFactoryResetGrantResponseMessage(request.requestId, byteArrayOf(1))))
                    return
                }
                callback(
                    Result.success(
                        BotaProvisioningMaterialResponseMessage(
                            responseId(request.requestId),
                            "https://api.bota.dev".toByteArray(),
                            "token".toByteArray(),
                            247,
                        ),
                    ),
                )
            }
            is BotaFactoryResetGrantRequestMessage -> {
                materialKinds += "factoryReset"
                callback(
                    Result.success(
                        BotaFactoryResetGrantResponseMessage(
                            responseId(request.requestId),
                            byteArrayOf(1, 2, 3),
                        ),
                    ),
                )
            }
        }
    }

    override fun requestFirmware(
        request: BotaFirmwareRequestMessage,
        callback: (Result<BotaFirmwareSourceMessage>) -> Unit,
    ) {
        callbackKinds += "firmware"
        callback(
            Result.success(
                BotaFirmwareSourceMessage(
                    responseId(request.requestId),
                    "https://example.com/firmware.bin",
                    mapOf("Authorization" to "redacted"),
                ),
            ),
        )
    }

    override fun persistFactoryResetResult(
        request: BotaFactoryResetResultRequestMessage,
        callback: (Result<BotaFactoryResetResultAcknowledgementMessage>) -> Unit,
    ) {
        persistedResets += request.commandId to request.bindingGeneration
        callback(
            Result.success(
                BotaFactoryResetResultAcknowledgementMessage(responseId(request.requestId)),
            ),
        )
    }

    fun resumeMaterial() {
        suspendedMaterial?.invoke(
            Result.success(
                BotaProvisioningMaterialResponseMessage(
                    id(999),
                    "https://api.bota.dev".toByteArray(),
                    "token".toByteArray(),
                    247,
                ),
            ),
        )
        suspendedMaterial = null
    }

    private fun responseId(requestId: String): String = if (mode == Mode.WRONG_ID) id(999) else requestId
}

private class FakeAndroidClient(
    private val suspendConfigure: Boolean = false,
    private val suspendReadStatus: Boolean = false,
    failDeviceCancellation: Boolean = false,
) : BotaAndroidClient {
    override suspend fun nextClientPresence(deviceId: String): dev.bota.sdk.SDKClientContext? = null
    val invocations = mutableListOf<String>()
    val configureStarted = CompletableDeferred<Unit>()
    val resumeConfigure = CompletableDeferred<Unit>()
    val readStatusStarted = CompletableDeferred<Unit>()
    val readStatusCancellationObserved = CompletableDeferred<Unit>()
    val allowReadStatusUnwind = CompletableDeferred<Unit>()
    var destroyCount = 0
    var deviceCancellationCount = 0
    var startRecordingGrant: String? = null
    var stopRecordingGrant: String? = null
    var deprovisionGrant: String? = null
    var wifiGrant: String? = null
    var readStatusError: Throwable? = null
    var failDeviceCancellation = failDeviceCancellation

    override suspend fun configure(namespace: String) {
        invocations += "configure"
        configureStarted.complete(Unit)
        if (suspendConfigure) resumeConfigure.await()
    }

    override suspend fun destroy() {
        invocations += "destroy"
        destroyCount += 1
    }

    override suspend fun connect(device: DiscoveredDevice, serialNumber: String?): ConnectedDevice {
        invocations += "connect"
        return connected(serialNumber ?: "BP-001")
    }

    override suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice {
        invocations += "reconnect"
        return connected(serialNumber)
    }

    override suspend fun disconnect() {
        invocations += "disconnect"
    }

    override suspend fun readDeviceStatus(): DeviceStatus {
        invocations += "readDeviceStatus"
        readStatusStarted.complete(Unit)
        if (suspendReadStatus) {
            try {
                CompletableDeferred<Unit>().await()
            } catch (error: CancellationException) {
                readStatusCancellationObserved.complete(Unit)
                withContext(NonCancellable) { allowReadStatusUnwind.await() }
                throw error
            }
        }
        readStatusError?.let { throw it }
        return status()
    }

    override suspend fun cancelDeviceOperation() {
        invocations += "cancelDeviceOperation"
        deviceCancellationCount += 1
        if (failDeviceCancellation) error("stop failed")
    }

    override suspend fun startRecording(device: ConnectedDevice, grantBlob: String) {
        invocations += "startRecording"
        startRecordingGrant = grantBlob
    }

    override suspend fun stopRecording(device: ConnectedDevice, grantBlob: String) {
        invocations += "stopRecording"
        stopRecordingGrant = grantBlob
    }

    override suspend fun readRecordingState(device: ConnectedDevice): RecordingState {
        invocations += "readRecordingState"
        return RecordingState(true, "recording-1", RecordingInitiator.Remote)
    }

    override suspend fun provision(
        device: ConnectedDevice,
        provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
    ) {
        invocations += "provision"
        provider(ProvisioningMaterialRequest(device.serialNumber, byteArrayOf(1), byteArrayOf(2)))
    }

    override suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings {
        invocations += "readConnectionSettings"
        return nativeSettings()
    }

    override suspend fun writeConnectionSettings(
        settings: DeviceConnectionSettings,
        device: ConnectedDevice,
    ) {
        invocations += "writeConnectionSettings"
    }

    override suspend fun deprovision(device: ConnectedDevice, grantBlob: String): DeprovisionResult {
        invocations += "deprovision"
        deprovisionGrant = grantBlob
        return DeprovisionResult(true)
    }

    override suspend fun cancelProvisioningOperation() {
        invocations += "cancelProvisioningOperation"
    }

    override suspend fun factoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
        provider: suspend (FactoryResetGrantRequest) -> ByteArray,
    ): FactoryResetCompletion {
        invocations += "factoryReset"
        provider(FactoryResetGrantRequest(device.serialNumber, byteArrayOf(3), commandId, bindingGeneration))
        persistResult(FactoryResetPersistenceResult(commandId, bindingGeneration, 2u))
        return FactoryResetCompletion(commandId, bindingGeneration)
    }

    override suspend fun resumePendingFactoryReset(
        device: ConnectedDevice,
        currentBindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ): FactoryResetCompletion {
        invocations += "resumePendingFactoryReset"
        persistResult(FactoryResetPersistenceResult("durable-command", currentBindingGeneration, 2u))
        return FactoryResetCompletion("durable-command", currentBindingGeneration)
    }

    override suspend fun resumeUnjournaledFactoryReset(
        device: ConnectedDevice,
        commandId: String,
        bindingGeneration: ULong,
        persistResult: suspend (FactoryResetPersistenceResult) -> Unit,
    ): FactoryResetCompletion {
        invocations += "resumeUnjournaledFactoryReset"
        persistResult(FactoryResetPersistenceResult(commandId, bindingGeneration, 2u))
        return FactoryResetCompletion(commandId, bindingGeneration)
    }

    override suspend fun cancelFactoryResetOperation() {
        invocations += "cancelFactoryResetOperation"
    }

    override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> {
        invocations += "listRecordings"
        return listOf(recording())
    }

    override fun takeTransferMetadata(sinkId: String): RecordingTransferMetadata {
        invocations += "takeTransferMetadata"
        return RecordingTransferMetadata(true, "abc")
    }

    override suspend fun confirmRecording(device: ConnectedDevice, recordingId: String) {
        invocations += "confirmRecording"
    }

    override suspend fun cancelRecordingOperation() {
        invocations += "cancelRecordingOperation"
    }

    override suspend fun cancelOtaOperation() {
        invocations += "cancelOtaOperation"
    }

    override suspend fun stopLogs() {
        invocations += "stopLogs"
    }

    override suspend fun configureWifi(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult {
        invocations += "configureWifi"
        wifiGrant = grantBlob
        return WiFiConfigResult.Success
    }

    override suspend fun disconnectWifi(device: ConnectedDevice): WiFiConfigResult {
        invocations += "disconnectWifi"
        return WiFiConfigResult.Success
    }

    override suspend fun readWifiStatus(device: ConnectedDevice): WiFiStatusInfo {
        invocations += "readWifiStatus"
        return wifiStatus()
    }

    override suspend fun scanWifi(device: ConnectedDevice): DeviceWiFiScanResult {
        invocations += "scanWifi"
        return DeviceWiFiScanResult(listOf(WiFiScanNetwork("Bota", 80u, true, false)), "Bota")
    }

    override suspend fun cancelWifiOperation() {
        invocations += "cancelWifiOperation"
    }

    override suspend fun scanFlow(timeoutMilliseconds: ULong, allowDuplicates: Boolean): Flow<DiscoveredDevice> {
        invocations += "scanFlow"
        return flowOf(discovered())
    }

    override fun connectionFlow(): Flow<ConnectedDevice?> {
        invocations += "connectionFlow"
        return flowOf(connected())
    }

    override fun deviceStatusFlow(): Flow<DeviceStatus> {
        invocations += "deviceStatusFlow"
        return flowOf(status())
    }

    override fun recordingStateFlow(device: ConnectedDevice): Flow<RecordingState> {
        invocations += "recordingStateFlow"
        return flowOf(RecordingState(true, "recording-1", RecordingInitiator.Remote))
    }

    override fun recordingSyncFlow(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
        confirmOnCompletion: Boolean,
    ): Flow<RecordingSyncEvent> {
        invocations += "recordingSyncFlow"
        return flowOf(
            RecordingSyncEvent.Progress(RecordingTransferProgress(256u, 512u)),
            RecordingSyncEvent.Completed(Path.of("/tmp/recording.ogg")),
        )
    }

    override fun uploadOwnershipFlow(
        device: ConnectedDevice,
        recordingId: String,
        uploadId: String,
        destinationId: String,
    ): Flow<UploadOwnershipEvent> {
        invocations += "uploadOwnershipFlow"
        return flowOf(
            UploadOwnershipEvent.Progress(RecordingTransferProgress(512u, 512u)),
            UploadOwnershipEvent.Result(UploadOwnershipResult.DeviceUploadCompleted),
        )
    }

    override fun firmwareFlow(device: ConnectedDevice, image: FirmwareImage): Flow<FirmwareUpdateProgress> {
        invocations += "firmwareFlow"
        return flowOf(FirmwareUpdateProgress(FirmwareUpdatePhase.Complete, 512u, 512u))
    }

    override fun logFlow(device: ConnectedDevice): Flow<DeviceLogLine> {
        invocations += "logFlow"
        return flowOf(DeviceLogLine("ready", false))
    }

    override fun wifiStatusFlow(device: ConnectedDevice): Flow<WiFiStatusInfo> {
        invocations += "wifiStatusFlow"
        return flowOf(wifiStatus())
    }
}

private fun configuration(namespace: String = "adapter-tests") = BotaConfigurationMessage(
    namespace,
    hasProvisioningMaterialCallback = true,
    hasFactoryResetGrantCallback = true,
    hasFactoryResetResultCallback = true,
    hasFirmwareCallback = true,
)

private fun discoveredMessage() = BotaDiscoveredDeviceMessage(
    "peripheral-1",
    "Bota Pin",
    BotaDeviceTypeMessage("botaPin", null),
    "1.0.0",
    "AA:BB:CC:DD:EE:FF",
    BotaPairingStateMessage("paired", null),
    -42,
    1_700_000_000_000,
)

private fun reconnectHint() = BotaReconnectHintMessage(
    "peripheral-1",
    null,
    "Bota Pin",
    1_000,
    2_000,
)

private fun deviceReference() = BotaDeviceReferenceMessage("peripheral-1")
private fun resetCommand(commandId: String = "command-1") = BotaFactoryResetCommandMessage(commandId, 4)
private fun recordingMessage() = BotaDeviceRecordingMessage(
    "recording-1",
    1_700_000_000_000,
    2_000,
    512,
    BotaAudioCodecMessage("opus16k", null),
    true,
)

private fun settingsMessage() = BotaConnectionSettingsMessage(
    BotaEnabledConnectionsMessage(true, true),
    BotaEnabledConnectionsMessage(true, false),
    0,
    listOf(BotaConnectionTypeMessage("wifi", null)),
    BotaPowerManagementMessage(180_000, 120_000),
    true,
    60_000,
)

private fun connected(serialNumber: String = "BP-001") = ConnectedDevice(
    "peripheral-1",
    serialNumber,
    DeviceType.BotaPin,
    "1.0.0",
    isProvisioned = true,
    connectionState = ConnectionState.Connected,
    mtu = 247,
)

private fun discovered() = DiscoveredDevice(
    "peripheral-1",
    "Bota Pin",
    DeviceType.BotaPin,
    "1.0.0",
    "AA:BB:CC:DD:EE:FF",
    PairingState.Paired,
    -42,
    discoveredAt = Instant.ofEpochMilli(1_700_000_000_000),
)

private fun status() = DeviceStatus(
    batteryLevel = 80,
    storageTotalMb = 8_192,
    storageUsedMb = 256,
    state = WireValue.Known(DeviceState.Idle),
    pendingRecordings = 1,
    lastTimeSyncAt = Instant.ofEpochMilli(1_700_000_000_000),
    signalStrength = -50,
    flags = DeviceFlags(false, false, false, true, false, false),
    timestamp = 123u,
    lteStatus = WireValue.Unknown(99u),
    wifiStatus = WireValue.Known(WifiRadioStatus.Connected),
)

private fun nativeSettings() = DeviceConnectionSettings(
    enabledConnections = DeviceConnectionSettings.EnabledConnections(true, true),
    heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
    uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
    powerManagement = DeviceConnectionSettings.PowerManagement(180, 120),
    streamingEnabled = true,
    streamingFlushIntervalSeconds = 60,
)

private fun recording() = DeviceRecording(
    "recording-1",
    Instant.ofEpochMilli(1_700_000_000_000),
    2_000u,
    512u,
    WireValue.Known(AudioCodec.Opus16k),
    true,
)

private fun wifiStatus() = WiFiStatusInfo(WiFiConnectionStatus.Connected, 80u, "Bota")
private fun id(value: Int): String = value.toString(16).padStart(32, '0')
