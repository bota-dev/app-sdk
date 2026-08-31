package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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

    private class TestAndroidSecurityClient : BotaDeviceSDKAndroidSecurityClient {
        var material: ProvisioningMaterial? = null
        val deprovisionedSerials = mutableListOf<String>()

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

        override suspend fun cancelCurrentOperation() = Unit
    }
}
