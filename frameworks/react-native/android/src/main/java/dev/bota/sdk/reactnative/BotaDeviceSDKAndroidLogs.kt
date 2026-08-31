package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceLogLine
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

internal interface BotaDeviceSDKAndroidLogClient {
    fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine>

    suspend fun stop()
}

internal class BotaDeviceSDKSharedAndroidLogClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidLogClient {
    override fun streamLogs(device: ConnectedDevice): Flow<DeviceLogLine> =
        client.logs.streamLogs(device)

    override suspend fun stop() {
        client.logs.stop()
    }
}

internal class BotaDeviceSDKAndroidLogs(
    private val client: BotaDeviceSDKAndroidLogClient,
    private val scope: CoroutineScope,
) {
    private val operations = Mutex()
    private val streamLock = Any()
    private var activeStream: Job? = null

    suspend fun start(
        device: ConnectedDevice,
        onError: (Throwable) -> Unit = {},
        onLine: (DeviceLogLine) -> Unit,
    ) = operations.withLock {
        stopOwned()
        val stream = client.streamLogs(device)
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                stream.collect(onLine)
            } catch (_: CancellationException) {
                // Explicit stop is not a log-stream failure.
            } catch (error: Throwable) {
                onError(error)
            } finally {
                synchronized(streamLock) {
                    if (activeStream === task) activeStream = null
                }
            }
        }
        synchronized(streamLock) { activeStream = task }
        task.start()
    }

    suspend fun stop() = operations.withLock {
        stopOwned()
    }

    suspend fun cancelAll() {
        runCatching { stop() }
    }

    private suspend fun stopOwned() {
        val stream = synchronized(streamLock) {
            activeStream.also { activeStream = null }
        } ?: return
        stream.cancelAndJoin()
        client.stop()
    }
}
