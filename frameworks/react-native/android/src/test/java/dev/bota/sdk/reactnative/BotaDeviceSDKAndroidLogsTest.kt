package dev.bota.sdk.reactnative

import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceType
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

        override fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine> = flow {
            emit(DeviceLogLine("boot pass", isBacklog = true))
            awaitCancellation()
        }

        override suspend fun stop() {
            stopped = true
        }
    }
}
