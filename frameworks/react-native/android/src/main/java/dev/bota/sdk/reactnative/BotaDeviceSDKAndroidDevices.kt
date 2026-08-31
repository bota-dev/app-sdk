package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DiscoveredDevice
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

internal interface BotaDeviceSDKAndroidDeviceClient {
    suspend fun startScan(timeoutMilliseconds: ULong, allowDuplicates: Boolean): Flow<DiscoveredDevice>

    suspend fun cancelCurrentOperation()

    suspend fun connect(device: DiscoveredDevice): ConnectedDevice

    suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice

    suspend fun disconnect()
}

internal class BotaDeviceSDKSharedAndroidDeviceClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidDeviceClient {
    override suspend fun startScan(
        timeoutMilliseconds: ULong,
        allowDuplicates: Boolean,
    ): Flow<DiscoveredDevice> = client.devices.startScan(timeoutMilliseconds, allowDuplicates)

    override suspend fun cancelCurrentOperation() {
        client.devices.cancelCurrentOperation()
    }

    override suspend fun connect(device: DiscoveredDevice): ConnectedDevice = client.devices.connect(device)

    override suspend fun reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint,
    ): ConnectedDevice = client.devices.reconnect(serialNumber, hint)

    override suspend fun disconnect() {
        client.devices.disconnect()
    }
}

internal class BotaDeviceSDKAndroidDevices(
    private val client: BotaDeviceSDKAndroidDeviceClient,
    private val scope: CoroutineScope,
) {
    private val operations = Mutex()
    private val scanLock = Any()
    private var activeScan: Job? = null

    suspend fun startScan(
        timeoutMilliseconds: ULong,
        allowDuplicates: Boolean,
        onError: (Throwable) -> Unit = {},
        onDevice: (DiscoveredDevice) -> Unit,
    ) = operations.withLock {
        stopScanOwned()
        val stream = client.startScan(timeoutMilliseconds, allowDuplicates)
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                stream.collect(onDevice)
            } catch (_: CancellationException) {
                // Explicit stop is not a scan failure.
            } catch (error: Throwable) {
                onError(error)
            } finally {
                synchronized(scanLock) {
                    if (activeScan === task) activeScan = null
                }
            }
        }
        synchronized(scanLock) { activeScan = task }
        task.start()
    }

    suspend fun stopScan() = operations.withLock {
        stopScanOwned()
    }

    suspend fun connect(device: DiscoveredDevice): ConnectedDevice = operations.withLock {
        stopScanOwned()
        client.connect(device)
    }

    suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice = operations.withLock {
        stopScanOwned()
        client.reconnect(serialNumber, hint)
    }

    suspend fun disconnect() = operations.withLock {
        stopScanOwned()
        client.disconnect()
    }

    private suspend fun stopScanOwned() {
        val scan = synchronized(scanLock) {
            activeScan.also { activeScan = null }
        } ?: return
        scan.cancelAndJoin()
        runCatching { client.cancelCurrentOperation() }
    }
}
