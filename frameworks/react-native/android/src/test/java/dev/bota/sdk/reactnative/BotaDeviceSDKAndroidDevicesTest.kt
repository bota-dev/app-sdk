package dev.bota.sdk.reactnative

import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.PairingState
import dev.bota.sdk.model.WifiRadioStatus
import dev.bota.sdk.model.WireValue
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class BotaDeviceSDKAndroidDevicesTest {
    @Test
    fun unknownPairingStateUsesTheFrozenUnpairedFallback() {
        assertEquals("unpaired", PairingState.Unknown(0xFFu).toBridgeValue())
    }

    @Test
    fun scanAndConnectionsDelegateToTheAndroidFacade() = runTest {
        val selected = DiscoveredDevice(
            id = "selected",
            name = "Bota Pin",
            deviceType = DeviceType.BotaPin,
            rssi = -42,
            discoveredAt = Instant.ofEpochMilli(1_788_200_000_000),
        )
        val verified = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = false,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val client = FakeDeviceClient(selected, verified)
        val devices = BotaDeviceSDKAndroidDevices(client, backgroundScope)
        val received = CompletableDeferred<DiscoveredDevice>()

        devices.startScan(5_000u, allowDuplicates = true) { received.complete(it) }
        assertEquals("selected", received.await().id)
        val connected = devices.connect(selected)
        val reconnected = devices.reconnect(
            "EVFXXW67KP",
            DeviceReconnectHint(
                scanTimeoutMilliseconds = 7_000u,
                connectionTimeoutMilliseconds = 8_000u,
            ),
        )
        devices.disconnect()

        assertEquals(listOf(5_000uL to true), client.scanOptions)
        assertEquals(listOf("selected"), client.selectedIds)
        assertEquals(listOf("EVFXXW67KP"), client.reconnectSerials)
        assertEquals(1, client.cancelCount)
        assertEquals(1, client.disconnectCount)
        assertEquals("EVFXXW67KP", connected.serialNumber)
        assertEquals("EVFXXW67KP", reconnected.serialNumber)
    }

    @Test
    fun scanFailureIsReportedWithoutEscapingTheOwnedTask() = runTest {
        val selected = DiscoveredDevice(
            id = "selected",
            name = "Bota Pin",
            deviceType = DeviceType.BotaPin,
            rssi = -42,
            discoveredAt = Instant.ofEpochMilli(1_788_200_000_000),
        )
        val verified = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = false,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val failure = IllegalStateException("scan failed")
        val client = FakeDeviceClient(selected, verified, scanFailure = failure)
        val devices = BotaDeviceSDKAndroidDevices(client, backgroundScope)
        val reported = CompletableDeferred<Throwable>()

        devices.startScan(
            timeoutMilliseconds = 5_000u,
            allowDuplicates = false,
            onDevice = {},
            onError = { reported.complete(it) },
        )

        assertEquals(failure, reported.await())
    }

    @Test
    fun statusReadAndSubscriptionDelegateToTheAndroidFacade() = runTest {
        val selected = DiscoveredDevice(id = "selected", name = "Bota Pin", rssi = -42)
        val verified = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = false,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val expected = testDeviceStatus()
        val client = FakeDeviceClient(selected, verified, status = expected)
        val devices = BotaDeviceSDKAndroidDevices(client, backgroundScope)
        val received = CompletableDeferred<DeviceStatus>()

        assertEquals(expected, devices.readStatus())
        devices.startStatusUpdates { received.complete(it) }
        assertEquals(expected, received.await())
        devices.stopStatusUpdates()

        assertEquals(1, client.statusReadCount)
        assertEquals(1, client.statusCancelCount)
    }

    private class FakeDeviceClient(
        private val discovered: DiscoveredDevice,
        private val connected: ConnectedDevice,
        private val scanFailure: Throwable? = null,
        private val status: DeviceStatus = testDeviceStatus(),
    ) : BotaDeviceSDKAndroidDeviceClient {
        val scanOptions = mutableListOf<Pair<ULong, Boolean>>()
        val selectedIds = mutableListOf<String>()
        val reconnectSerials = mutableListOf<String>()
        var cancelCount = 0
        var disconnectCount = 0
        var statusReadCount = 0
        var statusCancelCount = 0

        override suspend fun startScan(
            timeoutMilliseconds: ULong,
            allowDuplicates: Boolean,
        ): Flow<DiscoveredDevice> = flow {
            scanOptions += timeoutMilliseconds to allowDuplicates
            scanFailure?.let { throw it }
            emit(discovered)
            awaitCancellation()
        }

        override suspend fun cancelCurrentOperation() {
            cancelCount += 1
        }

        override suspend fun connect(device: DiscoveredDevice): ConnectedDevice {
            selectedIds += device.id
            return connected
        }

        override suspend fun reconnect(serialNumber: String, hint: DeviceReconnectHint): ConnectedDevice {
            reconnectSerials += serialNumber
            return connected
        }

        override suspend fun disconnect() {
            disconnectCount += 1
        }

        override suspend fun readStatus(): DeviceStatus {
            statusReadCount += 1
            return status
        }

        override suspend fun statusUpdates(): Flow<DeviceStatus> = flow {
            try {
                emit(status)
                awaitCancellation()
            } finally {
                statusCancelCount += 1
            }
        }
    }
}

private fun testDeviceStatus(): DeviceStatus = DeviceStatus(
    batteryLevel = 72,
    batteryMv = 3_842,
    storageTotalMb = 8_192,
    storageUsedMb = 512,
    state = WireValue.Known(DeviceState.Idle),
    pendingRecordings = 2,
    lastTimeSyncAt = Instant.ofEpochSecond(1_788_200_000),
    signalStrength = 4,
    flags = DeviceFlags(
        charging = false,
        lowBattery = false,
        storageFull = false,
        wifiConnected = true,
        lteConnected = false,
        syncActive = false,
    ),
    timestamp = 1_788_200_000u,
    lteStatus = WireValue.Known(LteStatus.Off),
    lteSignalQuality = 99,
    wifiStatus = WireValue.Known(WifiRadioStatus.Connected),
)
