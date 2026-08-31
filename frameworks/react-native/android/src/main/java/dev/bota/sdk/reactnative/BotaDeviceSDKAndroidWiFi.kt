package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiStatusInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface BotaDeviceSDKAndroidWiFiClient {
    suspend fun configure(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult

    suspend fun disconnect(device: ConnectedDevice): WiFiConfigResult

    suspend fun readStatus(device: ConnectedDevice): WiFiStatusInfo

    fun statusUpdates(device: ConnectedDevice): Flow<WiFiStatusInfo>

    suspend fun scanNetworks(device: ConnectedDevice): DeviceWiFiScanResult

    suspend fun cancelCurrentOperation()
}

internal class BotaDeviceSDKSharedAndroidWiFiClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidWiFiClient {
    override suspend fun configure(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult = client.wifi.configure(device, ssid, password, grantBlob)

    override suspend fun disconnect(device: ConnectedDevice): WiFiConfigResult =
        client.wifi.disconnect(device)

    override suspend fun readStatus(device: ConnectedDevice): WiFiStatusInfo =
        client.wifi.readStatus(device)

    override fun statusUpdates(device: ConnectedDevice): Flow<WiFiStatusInfo> =
        client.wifi.statusUpdates(device)

    override suspend fun scanNetworks(device: ConnectedDevice): DeviceWiFiScanResult =
        client.wifi.scanNetworks(device)

    override suspend fun cancelCurrentOperation() {
        client.wifi.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidWiFi(
    private val client: BotaDeviceSDKAndroidWiFiClient,
    private val scope: CoroutineScope,
) {
    private val operations = Mutex()
    private val streamLock = Any()
    private var statusStream: Job? = null

    suspend fun configure(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult = client.configure(device, ssid, password, grantBlob)

    suspend fun disconnect(device: ConnectedDevice): WiFiConfigResult = client.disconnect(device)

    suspend fun readStatus(device: ConnectedDevice): WiFiStatusInfo = client.readStatus(device)

    suspend fun scanNetworks(device: ConnectedDevice): DeviceWiFiScanResult =
        client.scanNetworks(device)

    suspend fun startStatusUpdates(
        device: ConnectedDevice,
        onError: (Throwable) -> Unit = {},
        onStatus: (WiFiStatusInfo) -> Unit,
    ) = operations.withLock {
        stopOwned()
        val updates = client.statusUpdates(device)
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                updates.collect(onStatus)
            } catch (_: CancellationException) {
                // Explicit stop is not a WiFi status-stream failure.
            } catch (error: Throwable) {
                onError(error)
            } finally {
                synchronized(streamLock) {
                    if (statusStream === task) statusStream = null
                }
            }
        }
        synchronized(streamLock) { statusStream = task }
        task.start()
    }

    suspend fun stopStatusUpdates() = operations.withLock {
        stopOwned()
    }

    suspend fun cancelAll() {
        runCatching { stopStatusUpdates() }
        runCatching { client.cancelCurrentOperation() }
    }

    private suspend fun stopOwned() {
        val stream = synchronized(streamLock) { statusStream.also { statusStream = null } } ?: return
        stream.cancelAndJoin()
    }
}
