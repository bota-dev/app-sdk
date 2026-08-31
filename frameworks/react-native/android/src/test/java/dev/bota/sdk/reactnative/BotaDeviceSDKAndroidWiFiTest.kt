package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiConnectionStatus
import dev.bota.sdk.model.WiFiScanNetwork
import dev.bota.sdk.model.WiFiStatusInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class BotaDeviceSDKAndroidWiFiTest {
    @Test
    fun configurationAndScanDelegateToNativeWiFiFacade() = runTest {
        val client = TestAndroidWiFiClient()
        val wifi = BotaDeviceSDKAndroidWiFi(client, CoroutineScope(coroutineContext))
        val device = wifiTestDevice()

        val configured = wifi.configure(device, "Bota", "secret", "grant.test")
        val scan = wifi.scanNetworks(device)

        assertEquals(WiFiConfigResult.Success, configured)
        assertEquals("Bota", scan.currentSsid)
        assertEquals(ConfigurationInput("Bota", "secret", "grant.test"), client.configurationInput)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun statusStreamOwnsExactlyOneNativeSubscription() = runTest {
        val client = TestAndroidWiFiClient()
        val wifi = BotaDeviceSDKAndroidWiFi(client, CoroutineScope(coroutineContext))
        val values = mutableListOf<WiFiStatusInfo>()

        wifi.startStatusUpdates(wifiTestDevice(), onStatus = values::add)
        runCurrent()
        wifi.stopStatusUpdates()
        wifi.stopStatusUpdates()

        assertEquals(listOf(WiFiStatusInfo(WiFiConnectionStatus.Connected, 87u, "Bota")), values)
        assertEquals(1, client.subscriptionTerminations)
    }
}

private data class ConfigurationInput(val ssid: String, val password: String, val grantBlob: String)

private class TestAndroidWiFiClient : BotaDeviceSDKAndroidWiFiClient {
    var configurationInput: ConfigurationInput? = null
    var subscriptionTerminations = 0

    override suspend fun configure(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult {
        configurationInput = ConfigurationInput(ssid, password, grantBlob)
        return WiFiConfigResult.Success
    }

    override suspend fun disconnect(device: ConnectedDevice): WiFiConfigResult = WiFiConfigResult.Success

    override suspend fun readStatus(device: ConnectedDevice): WiFiStatusInfo =
        WiFiStatusInfo(WiFiConnectionStatus.Connected, 87u, "Bota")

    override fun statusUpdates(device: ConnectedDevice): Flow<WiFiStatusInfo> = flow {
        try {
            emit(WiFiStatusInfo(WiFiConnectionStatus.Connected, 87u, "Bota"))
            awaitCancellation()
        } finally {
            subscriptionTerminations += 1
        }
    }

    override suspend fun scanNetworks(device: ConnectedDevice): DeviceWiFiScanResult =
        DeviceWiFiScanResult(
            listOf(WiFiScanNetwork("Bota", 100u, isCurrent = true, isOpen = false)),
            "Bota",
        )

    override suspend fun cancelCurrentOperation() = Unit
}

private fun wifiTestDevice(): ConnectedDevice = ConnectedDevice(
    id = "selected",
    serialNumber = "EVFXXW67KP",
    deviceType = DeviceType.BotaNote,
    firmwareVersion = "1.0.17",
    isProvisioned = true,
    connectionState = ConnectionState.Connected,
    mtu = 247,
)
