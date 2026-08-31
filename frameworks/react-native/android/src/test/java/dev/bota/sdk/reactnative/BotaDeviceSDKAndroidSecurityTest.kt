package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidSecurityTest {
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
        security.deprovision(connected)

        assertArrayEquals("https://api.bota.dev".encodeToByteArray(), client.material?.apiEndpoint)
        assertArrayEquals("dtok_example".encodeToByteArray(), client.material?.deviceToken)
        assertEquals(247uL, client.material?.mtu)
        assertEquals(listOf(connected.serialNumber), client.deprovisionedSerials)
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
            ) { requests.complete(it) }
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
            security.resumePendingFactoryReset(connected, 9u),
        )
        assertArrayEquals("grant".encodeToByteArray(), client.factoryResetGrant)
        assertEquals(listOf(9uL), client.resumedBindingGenerations)
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
                ) { malformedRequests.complete(it) }
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
                ) { cancelledRequests.complete(it) }
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
        var factoryResetGrant: ByteArray? = null
        var factoryResetCancelled = false
        val resumedBindingGenerations = mutableListOf<ULong>()
        var connectionSettings: DeviceConnectionSettings? = null
        var connectionSettingsReadResult = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
            uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
        )

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

        override suspend fun deprovision(device: ConnectedDevice) {
            deprovisionedSerials += device.serialNumber
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
            return FactoryResetCompletion(commandId, bindingGeneration)
        }

        override suspend fun resumePendingFactoryReset(
            device: ConnectedDevice,
            currentBindingGeneration: ULong,
        ): FactoryResetCompletion? {
            resumedBindingGenerations += currentBindingGeneration
            return FactoryResetCompletion("reset-command-1", currentBindingGeneration)
        }

        override suspend fun cancelFactoryReset() {
            factoryResetCancelled = true
        }
    }
}
