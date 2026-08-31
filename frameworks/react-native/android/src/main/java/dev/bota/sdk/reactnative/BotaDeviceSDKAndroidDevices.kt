package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceStatus
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

    suspend fun readStatus(): DeviceStatus

    suspend fun statusUpdates(): Flow<DeviceStatus>
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

    override suspend fun readStatus(): DeviceStatus = client.devices.readStatus()

    override suspend fun statusUpdates(): Flow<DeviceStatus> = client.devices.statusUpdates()
}

internal class BotaDeviceSDKAndroidDevices(
    private val client: BotaDeviceSDKAndroidDeviceClient,
    private val scope: CoroutineScope,
) {
    private val operations = Mutex()
    private val scanLock = Any()
    private val statusLock = Any()
    private var activeScan: Job? = null
    private var activeStatusUpdates: Job? = null

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
        stopStatusUpdatesOwned()
        client.connect(device)
    }

    suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice = operations.withLock {
        stopScanOwned()
        stopStatusUpdatesOwned()
        client.reconnect(serialNumber, hint)
    }

    suspend fun disconnect() = operations.withLock {
        stopScanOwned()
        stopStatusUpdatesOwned()
        client.disconnect()
    }

    suspend fun readStatus(): DeviceStatus = operations.withLock {
        client.readStatus()
    }

    suspend fun startStatusUpdates(
        onError: (Throwable) -> Unit = {},
        onStatus: (DeviceStatus) -> Unit,
    ) = operations.withLock {
        stopStatusUpdatesOwned()
        val stream = client.statusUpdates()
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                stream.collect(onStatus)
            } catch (_: CancellationException) {
                // Explicit stop is not a status subscription failure.
            } catch (error: Throwable) {
                onError(error)
            } finally {
                synchronized(statusLock) {
                    if (activeStatusUpdates === task) activeStatusUpdates = null
                }
            }
        }
        synchronized(statusLock) { activeStatusUpdates = task }
        task.start()
    }

    suspend fun stopStatusUpdates() = operations.withLock {
        stopStatusUpdatesOwned()
    }

    suspend fun stopAll() = operations.withLock {
        stopScanOwned()
        stopStatusUpdatesOwned()
    }

    private suspend fun stopScanOwned() {
        val scan = synchronized(scanLock) {
            activeScan.also { activeScan = null }
        } ?: return
        scan.cancelAndJoin()
        runCatching { client.cancelCurrentOperation() }
    }

    private suspend fun stopStatusUpdatesOwned() {
        val updates = synchronized(statusLock) {
            activeStatusUpdates.also { activeStatusUpdates = null }
        } ?: return
        updates.cancelAndJoin()
    }
}
