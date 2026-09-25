package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceDiagnosticEvent
import dev.bota.sdk.model.DeviceDiagnosticsBatch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidLogsTest {
    @Test
    fun diagnosticReadDoesNotAcknowledgeAndPreservesEventIDs() = runTest {
        val client = TestAndroidLogClient()
        val logs = BotaDeviceSDKAndroidLogs(client, CoroutineScope(coroutineContext))
        val device = ConnectedDevice(
            id = "selected", serialNumber = "EVFXXW67KP", deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11", isProvisioned = true,
            connectionState = ConnectionState.Connected, mtu = 247,
        )
        val batch = logs.readDiagnosticEvents(device)
        assertTrue(client.acceptedIDs.isEmpty())
        assertEquals("ffffffffffffffff", batch.events.single().eventId)
        assertEquals(UInt.MAX_VALUE, batch.events.single().uptimeMs)
        logs.acknowledgeDiagnosticEvents(device, listOf("ffffffffffffffff"))
        assertEquals(listOf("ffffffffffffffff"), client.acceptedIDs)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun logStreamEmitsSanitizedLinesAndOwnsStop() = runTest {
        val client = TestAndroidLogClient()
        val logs = BotaDeviceSDKAndroidLogs(client, CoroutineScope(coroutineContext))
        val lines = mutableListOf<DeviceLogLine>()

        logs.start(
            ConnectedDevice(
                id = "selected",
                serialNumber = "EVFXXW67KP",
                deviceType = DeviceType.BotaPin,
                firmwareVersion = "1.0.11",
                isProvisioned = true,
                connectionState = ConnectionState.Connected,
                mtu = 247,
            ),
            onLine = lines::add,
        )
        runCurrent()

        assertEquals(listOf(DeviceLogLine("boot pass", isBacklog = true)), lines)
        logs.stop()
        assertTrue(client.stopped)
    }

    private class TestAndroidLogClient : BotaDeviceSDKAndroidLogClient {
        var stopped = false
        val acceptedIDs = mutableListOf<String>()

        override suspend fun readDiagnosticEvents(device: ConnectedDevice) = DeviceDiagnosticsBatch(
            schemaVersion = 1,
            events = listOf(DeviceDiagnosticEvent(
                eventId = "ffffffffffffffff", eventType = "crash", reasonCode = "exception",
                uptimeMs = UInt.MAX_VALUE, signature = "0123456789abcdef", firmwareBuildId = "1.0.11",
                subsystem = "system", stateBeforeEvent = "idle",
            )),
        )

        override suspend fun acknowledgeDiagnosticEvents(device: ConnectedDevice, acceptedEventIds: List<String>) {
            acceptedIDs.addAll(acceptedEventIds)
        }

        override fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine> = flow {
            emit(DeviceLogLine("boot pass", isBacklog = true))
            awaitCancellation()
        }

        override suspend fun stop() {
            stopped = true
        }
    }
}
