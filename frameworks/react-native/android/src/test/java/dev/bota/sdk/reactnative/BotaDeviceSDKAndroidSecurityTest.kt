package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.DeviceApiEnvironment
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeprovisionResult
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.FactoryResetPersistenceResult
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import dev.bota.sdk.model.RecordingControlError
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingInitiator
import dev.bota.sdk.model.RecordingState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidSecurityTest {
    @Test
    fun deviceControlsDelegateTypedValuesToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client)

        assertTrue(security.isProvisioned(connected))
        assertEquals("public-key", security.readPublicKey(connected))
        assertEquals("nonce", security.readAuthNonce(connected))
        security.setApiEndpoint(DeviceApiEnvironment.Gamma, connected)
        security.deliverCertificate("cert", "key", connected)
        security.deliverBackendPublicKey(byteArrayOf(1, 2, 3), connected)
        security.writeGrant("AQID", connected)
        security.syncTime(connected)

        assertEquals(DeviceApiEnvironment.Gamma, client.environment)
        assertEquals("cert", client.certificate)
        assertEquals("key", client.privateKey)
        assertArrayEquals(byteArrayOf(1, 2, 3), client.backendPublicKey)
        assertEquals("AQID", client.grantBlob)
        assertTrue(client.timeSynced)
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun recordingControlsAndStateStreamDelegateToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client, backgroundScope)
        val update = CompletableDeferred<RecordingState>()

        assertEquals(
            RecordingControlResult(success = true),
            security.requestStartRecording(connected, "c3RhcnQ="),
        )
        assertEquals(
            RecordingControlResult(success = false, error = RecordingControlError.NotRecording),
            security.requestStopRecording(connected, "c3RvcA=="),
        )
        assertEquals(
            RecordingState(true, "recording-1", RecordingInitiator.Remote),
            security.readRecordingState(connected),
        )

        security.startRecordingStateUpdates(connected) { update.complete(it) }
        runCurrent()
        assertEquals(
            RecordingState(false, initiatedBy = RecordingInitiator.Local),
            update.await(),
        )
        security.stopRecordingStateUpdates()
        security.stopRecordingStateUpdates()
        client.recordingStateTerminated.await()

        assertEquals("c3RhcnQ=", client.startRecordingGrant)
        assertEquals("c3RvcA==", client.stopRecordingGrant)
        assertEquals(1, client.recordingStateTerminationCount)
    }

    @Test
    fun provisioningMaterialRoundTripAndDeprovisionDelegateToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = false,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client)
        val requests = CompletableDeferred<BotaDeviceSDKAndroidProvisioningRequest>()

        val operation = async {
            security.provision(connected) { requests.complete(it) }
        }
        val request = requests.await()
        assertEquals(connected.serialNumber, request.serialNumber)
        assertEquals("00112233", request.nonce)
        assertEquals("aabbccdd", request.devicePublicKey)

        security.resolveProvisioningMaterial(
            requestId = request.requestId,
            apiEndpoint = "https://api.bota.dev",
            deviceToken = "dtok_example",
            mtu = 247u,
        )
        operation.await()
        val deprovision = security.deprovision(connected, "AQID")

        assertArrayEquals("https://api.bota.dev".encodeToByteArray(), client.material?.apiEndpoint)
        assertArrayEquals("dtok_example".encodeToByteArray(), client.material?.deviceToken)
        assertEquals(247uL, client.material?.mtu)
        assertEquals(listOf(connected.serialNumber), client.deprovisionedSerials)
        assertEquals("AQID", client.deprovisionGrant)
        assertEquals(DeprovisionResult(success = true), deprovision)
    }

    @Test
    fun factoryResetGrantRoundTripAndExactGenerationResumeDelegateToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client)
        val requests = CompletableDeferred<BotaDeviceSDKAndroidFactoryResetRequest>()

        val operation = async {
            security.factoryReset(
                connected,
                commandId = "reset-command-1",
                bindingGeneration = 9u,
                onGrantRequest = { requests.complete(it) },
                onPersistenceRequest = null,
            )
        }
        val request = requests.await()
        assertEquals(connected.serialNumber, request.serialNumber)
        assertEquals("44556677", request.nonce)
        assertEquals("reset-command-1", request.commandId)
        assertEquals(9uL, request.bindingGeneration)

        security.resolveFactoryResetGrant(request.requestId, "Z3JhbnQ=")
        assertEquals(
            FactoryResetCompletion("reset-command-1", 9u),
            operation.await(),
        )
        assertEquals(
            FactoryResetCompletion("reset-command-1", 9u),
            security.resumePendingFactoryReset(connected, 9u, null),
        )
        assertArrayEquals("grant".encodeToByteArray(), client.factoryResetGrant)
        assertEquals(listOf(9uL), client.resumedBindingGenerations)
    }

    @Test
    fun factoryResetWaitsForApplicationPersistenceResolution() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client)
        val grantRequests = CompletableDeferred<BotaDeviceSDKAndroidFactoryResetRequest>()
        val persistenceRequests = CompletableDeferred<
            BotaDeviceSDKAndroidFactoryResetPersistenceRequest
        >()

        val operation = async {
            security.factoryReset(
                connected,
                commandId = "reset-command-1",
                bindingGeneration = 9u,
                onGrantRequest = { grantRequests.complete(it) },
                onPersistenceRequest = { persistenceRequests.complete(it) },
            )
        }
        val grantRequest = grantRequests.await()
        security.resolveFactoryResetGrant(grantRequest.requestId, "Z3JhbnQ=")
        val persistenceRequest = persistenceRequests.await()
        assertEquals(7u.toUShort(), persistenceRequest.localRecordingsDeleted)
        assertEquals(0, client.factoryResetPersistenceCompletions)

        security.resolveFactoryResetResultPersistence(persistenceRequest.requestId)
        operation.await()

        assertEquals(1, client.factoryResetPersistenceCompletions)
    }

    @Test
    fun connectionSettingsDelegateToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaNote,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = TestAndroidSecurityClient()
        val security = BotaDeviceSDKAndroidSecurity(client)
        val settings = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(true, true),
            heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(true, true),
            uploadNetworkPreference = listOf(
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Ble,
                DeviceConnectionSettings.ConnectionType.Cellular,
            ),
            powerManagement = DeviceConnectionSettings.PowerManagement(0, -1),
            streamingEnabled = false,
            streamingFlushIntervalSeconds = 30,
        )

        security.writeConnectionSettings(settings, connected)

        assertEquals(settings, client.connectionSettings)
    }

    @Test
    fun connectionSettingsReadDelegatesToAndroidFacade() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaNote,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val expected = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
            uploadNetworkPreference = listOf(
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Ble,
            ),
        )
        val client = TestAndroidSecurityClient().apply { connectionSettingsReadResult = expected }
        val security = BotaDeviceSDKAndroidSecurity(client)

        val settings = security.readConnectionSettings(connected)

        assertEquals(expected, settings)
    }

    @Test
    fun factoryResetRejectsMalformedGrantAndCancelsPendingRequestsOnDestroy() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        supervisorScope {
            val malformedClient = TestAndroidSecurityClient()
            val malformedSecurity = BotaDeviceSDKAndroidSecurity(malformedClient)
            val malformedRequests = CompletableDeferred<BotaDeviceSDKAndroidFactoryResetRequest>()
            val malformedOperation = async {
                malformedSecurity.factoryReset(
                    connected,
                    commandId = "reset-command-1",
                    bindingGeneration = 9u,
                    onGrantRequest = { malformedRequests.complete(it) },
                    onPersistenceRequest = null,
                )
            }
            val malformedRequest = malformedRequests.await()

            malformedSecurity.resolveFactoryResetGrant(malformedRequest.requestId, "not-encoded")
            assertEquals(
                "factory reset grant is not valid encoded data",
                runCatching { malformedOperation.await() }.exceptionOrNull()?.message,
            )

            val cancelledClient = TestAndroidSecurityClient()
            val cancelledSecurity = BotaDeviceSDKAndroidSecurity(cancelledClient)
            val cancelledRequests = CompletableDeferred<BotaDeviceSDKAndroidFactoryResetRequest>()
            val cancelledOperation = async {
                cancelledSecurity.factoryReset(
                    connected,
                    commandId = "reset-command-2",
                    bindingGeneration = 10u,
                    onGrantRequest = { cancelledRequests.complete(it) },
                    onPersistenceRequest = null,
                )
            }
            cancelledRequests.await()
            cancelledSecurity.cancelAll()

            assertTrue(runCatching { cancelledOperation.await() }.isFailure)
            assertTrue(cancelledClient.factoryResetCancelled)
        }
    }

    private class TestAndroidSecurityClient : BotaDeviceSDKAndroidSecurityClient {
        var material: ProvisioningMaterial? = null
        val deprovisionedSerials = mutableListOf<String>()
        var deprovisionGrant: String? = null
        var factoryResetGrant: ByteArray? = null
        var factoryResetCancelled = false
        var factoryResetPersistenceCompletions = 0
        val resumedBindingGenerations = mutableListOf<ULong>()
        var connectionSettings: DeviceConnectionSettings? = null
        var connectionSettingsReadResult = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
            uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
        )
        var environment: DeviceApiEnvironment? = null
        var certificate: String? = null
        var privateKey: String? = null
        var backendPublicKey: ByteArray? = null
        var grantBlob: String? = null
        var timeSynced = false
        var startRecordingGrant: String? = null
        var stopRecordingGrant: String? = null
        val recordingStateTerminated = CompletableDeferred<Unit>()
        var recordingStateTerminationCount = 0

        override suspend fun isProvisioned(device: ConnectedDevice): Boolean = true
        override suspend fun readPublicKey(device: ConnectedDevice): String? = "public-key"
        override suspend fun readAuthNonce(device: ConnectedDevice): String? = "nonce"
        override suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice) {
            this.environment = environment
        }
        override suspend fun deliverCertificate(
            certificatePem: String,
            privateKeyPem: String,
            device: ConnectedDevice,
        ) {
            certificate = certificatePem
            privateKey = privateKeyPem
        }
        override suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice) {
            backendPublicKey = publicKey
        }
        override suspend fun writeGrant(grantBlob: String, device: ConnectedDevice) {
            this.grantBlob = grantBlob
        }
        override suspend fun syncTime(device: ConnectedDevice) { timeSynced = true }
        override suspend fun requestStartRecording(
            device: ConnectedDevice,
            grantBlob: String,
        ): RecordingControlResult {
            startRecordingGrant = grantBlob
            return RecordingControlResult(success = true)
        }
        override suspend fun requestStopRecording(
            device: ConnectedDevice,
            grantBlob: String,
        ): RecordingControlResult {
            stopRecordingGrant = grantBlob
            return RecordingControlResult(success = false, error = RecordingControlError.NotRecording)
        }
        override suspend fun readRecordingState(device: ConnectedDevice): RecordingState =
            RecordingState(true, "recording-1", RecordingInitiator.Remote)
        override fun recordingStateUpdates(device: ConnectedDevice): Flow<RecordingState> = flow {
            try {
                emit(RecordingState(false, initiatedBy = RecordingInitiator.Local))
                awaitCancellation()
            } finally {
                recordingStateTerminationCount += 1
                recordingStateTerminated.complete(Unit)
            }
        }

        override suspend fun provision(
            device: ConnectedDevice,
            provider: suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial,
        ) {
            material = provider(
                ProvisioningMaterialRequest(
                    serialNumber = device.serialNumber,
                    nonce = byteArrayOf(0x00, 0x11, 0x22, 0x33),
                    devicePublicKey = byteArrayOf(0xAA.toByte(), 0xBB.toByte(), 0xCC.toByte(), 0xDD.toByte()),
                ),
            )
        }

        override suspend fun deprovision(
            device: ConnectedDevice,
            grantBlob: String,
        ): DeprovisionResult {
            deprovisionedSerials += device.serialNumber
            deprovisionGrant = grantBlob
            return DeprovisionResult(success = true)
        }

        override suspend fun writeConnectionSettings(
            settings: DeviceConnectionSettings,
            device: ConnectedDevice,
        ) {
            connectionSettings = settings
        }

        override suspend fun readConnectionSettings(device: ConnectedDevice): DeviceConnectionSettings =
            connectionSettingsReadResult

        override suspend fun cancelCurrentOperation() = Unit

        override suspend fun factoryReset(
            device: ConnectedDevice,
            commandId: String,
            bindingGeneration: ULong,
            persistResult: (suspend (FactoryResetPersistenceResult) -> Unit)?,
            provider: suspend (FactoryResetGrantRequest) -> ByteArray,
        ): FactoryResetCompletion {
            factoryResetGrant = provider(
                FactoryResetGrantRequest(
                    serialNumber = device.serialNumber,
                    nonce = byteArrayOf(0x44, 0x55, 0x66, 0x77),
                    commandId = commandId,
                    bindingGeneration = bindingGeneration,
                ),
            )
            persistResult?.invoke(FactoryResetPersistenceResult(7u))
            if (persistResult != null) factoryResetPersistenceCompletions += 1
            return FactoryResetCompletion(commandId, bindingGeneration)
        }

        override suspend fun resumePendingFactoryReset(
            device: ConnectedDevice,
            currentBindingGeneration: ULong,
            persistResult: (suspend (FactoryResetPersistenceResult) -> Unit)?,
        ): FactoryResetCompletion? {
            resumedBindingGenerations += currentBindingGeneration
            return FactoryResetCompletion("reset-command-1", currentBindingGeneration)
        }

        override suspend fun cancelFactoryReset() {
            factoryResetCancelled = true
        }
    }
}
