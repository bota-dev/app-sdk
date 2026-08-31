package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.RecordingTransferProgress
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect

internal interface BotaDeviceSDKAndroidRecordingClient {
    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording>

    fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
    ): Flow<RecordingSyncEvent>

    suspend fun cancelCurrentOperation()
}

internal class BotaDeviceSDKSharedAndroidRecordingClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidRecordingClient {
    override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.recordings.listRecordings(device)

    override fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
    ): Flow<RecordingSyncEvent> = client.recordings.syncRecording(device, recording)

    override suspend fun cancelCurrentOperation() {
        client.recordings.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidRecordings(
    private val client: BotaDeviceSDKAndroidRecordingClient =
        BotaDeviceSDKSharedAndroidRecordingClient(),
) {
    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.listRecordings(device)

    suspend fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        onProgress: (RecordingTransferProgress) -> Unit,
    ): String {
        var path: String? = null
        client.syncRecording(device, recording).collect { event ->
            when (event) {
                is RecordingSyncEvent.Progress -> onProgress(event.progress)
                is RecordingSyncEvent.Completed -> path = event.path.toString()
            }
        }
        return path ?: error("recording transfer completed without a native file")
    }

    suspend fun cancelAll() {
        runCatching { client.cancelCurrentOperation() }
    }
}
