package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.RecordingTransferMetadata
import dev.bota.sdk.UploadOwnershipEvent
import dev.bota.sdk.UploadOwnershipResult
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
        sinkId: String,
    ): Flow<RecordingSyncEvent>

    fun transferMetadata(sinkId: String): RecordingTransferMetadata?

    suspend fun confirmRecording(device: ConnectedDevice, recordingUuid: String)

    fun observeUploadOwnership(
        device: ConnectedDevice,
        recordingUuid: String,
        uploadId: String,
        destinationId: String,
    ): Flow<UploadOwnershipEvent>

    suspend fun cancelCurrentOperation()
}

internal fun BotaDeviceSDKAndroidRecordings.BotaRecordingFile.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("localPath", localPath)
        putBoolean("e2eEncrypted", isE2EEncrypted)
        contentSha256Hex?.let { putString("contentSha256", it) }
    }

internal class BotaDeviceSDKSharedAndroidRecordingClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidRecordingClient {
    override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.recordings.listRecordings(device)

    override fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
    ): Flow<RecordingSyncEvent> = client.recordings.syncRecording(
        device,
        recording,
        sinkId,
        confirmOnCompletion = false,
    )

    override fun transferMetadata(sinkId: String): RecordingTransferMetadata? =
        client.recordings.transferMetadata(sinkId)

    override suspend fun confirmRecording(device: ConnectedDevice, recordingUuid: String) {
        client.recordings.confirmRecording(device, recordingUuid)
    }

    override fun observeUploadOwnership(
        device: ConnectedDevice,
        recordingUuid: String,
        uploadId: String,
        destinationId: String,
    ): Flow<UploadOwnershipEvent> = client.recordings.observeUploadOwnership(
        device,
        recordingUuid,
        uploadId,
        destinationId,
    )

    override suspend fun cancelCurrentOperation() {
        client.recordings.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidRecordings(
    private val client: BotaDeviceSDKAndroidRecordingClient =
        BotaDeviceSDKSharedAndroidRecordingClient(),
) {
    internal data class BotaRecordingFile(
        val localPath: String,
        val isE2EEncrypted: Boolean,
        val contentSha256Hex: String?,
    )

    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.listRecordings(device)

    suspend fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
        onProgress: (RecordingTransferProgress) -> Unit,
    ): BotaRecordingFile {
        var path: String? = null
        client.syncRecording(device, recording, sinkId).collect { event ->
            when (event) {
                is RecordingSyncEvent.Progress -> onProgress(event.progress)
                is RecordingSyncEvent.Completed -> path = event.path.toString()
            }
        }
        val localPath = path ?: error("recording transfer completed without a native file")
        val metadata = client.transferMetadata(sinkId)
        return BotaRecordingFile(
            localPath,
            metadata?.isE2EEncrypted ?: false,
            metadata?.contentSha256Hex,
        )
    }

    suspend fun observeUploadOwnership(
        device: ConnectedDevice,
        recordingUuid: String,
        uploadId: String,
        destinationId: String,
        onProgress: (RecordingTransferProgress) -> Unit,
    ): UploadOwnershipResult {
        var result: UploadOwnershipResult? = null
        client.observeUploadOwnership(device, recordingUuid, uploadId, destinationId).collect { event ->
            when (event) {
                is UploadOwnershipEvent.Progress -> onProgress(event.progress)
                is UploadOwnershipEvent.Result -> result = event.result
            }
        }
        return result ?: error("upload ownership completed without a result")
    }

    suspend fun confirmRecording(device: ConnectedDevice, recordingUuid: String) {
        client.confirmRecording(device, recordingUuid)
    }

    suspend fun cancelAll() {
        runCatching { client.cancelCurrentOperation() }
    }
}
