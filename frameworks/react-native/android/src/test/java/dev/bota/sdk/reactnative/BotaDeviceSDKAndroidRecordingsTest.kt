package dev.bota.sdk.reactnative

import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.UploadOwnershipEvent
import dev.bota.sdk.UploadOwnershipResult
import dev.bota.sdk.model.AudioCodec
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.WireValue
import java.nio.file.Path
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidRecordingsTest {
    @Test
    fun recordingListAndSyncKeepTransferBytesInNativeFile() = runTest {
        val connected = ConnectedDevice(
            id = "selected",
            serialNumber = "EVFXXW67KP",
            deviceType = DeviceType.BotaPin,
            firmwareVersion = "1.0.11",
            isProvisioned = true,
            connectionState = ConnectionState.Connected,
            mtu = 247,
        )
        val recording = DeviceRecording(
            uuid = "recording-1",
            startedAt = Instant.ofEpochMilli(1_788_200_000_000),
            durationMs = 12_000u,
            fileSizeBytes = 48_000u,
            codec = WireValue.Known(AudioCodec.Opus16k),
            isEncrypted = true,
        )
        val client = TestAndroidRecordingClient(recording)
        val recordings = BotaDeviceSDKAndroidRecordings(client)
        val progress = mutableListOf<RecordingTransferProgress>()

        assertEquals(listOf(recording), recordings.listRecordings(connected))
        assertEquals(
            "/tmp/bota-recordings/recording-1.ogg",
            recordings.syncRecording(connected, recording, progress::add),
        )
        assertEquals(
            listOf(RecordingTransferProgress(24_000u, 48_000u)),
            progress,
        )
        recordings.cancelAll()
        assertTrue(client.cancelled)
    }

    @Test
    fun uploadOwnershipReturnsNativeFallbackDecisionAndProgress() = runTest {
        val connected = connectedDevice()
        val client = TestAndroidRecordingClient(recording())
        val recordings = BotaDeviceSDKAndroidRecordings(client)
        val progress = mutableListOf<RecordingTransferProgress>()

        assertEquals(
            UploadOwnershipResult.BluetoothFallback(
                "recording-1",
                "upload-1",
                "destination-1",
            ),
            recordings.observeUploadOwnership(
                connected,
                "recording-1",
                "upload-1",
                "destination-1",
                progress::add,
            ),
        )
        assertEquals(
            listOf(RecordingTransferProgress(32_000u, 48_000u)),
            progress,
        )
    }

    private fun connectedDevice(): ConnectedDevice = ConnectedDevice(
        id = "selected",
        serialNumber = "EVFXXW67KP",
        deviceType = DeviceType.BotaPin,
        firmwareVersion = "1.0.11",
        isProvisioned = true,
        connectionState = ConnectionState.Connected,
        mtu = 247,
    )

    private fun recording(): DeviceRecording = DeviceRecording(
        uuid = "recording-1",
        startedAt = Instant.ofEpochMilli(1_788_200_000_000),
        durationMs = 12_000u,
        fileSizeBytes = 48_000u,
        codec = WireValue.Known(AudioCodec.Opus16k),
        isEncrypted = true,
    )

    private class TestAndroidRecordingClient(
        private val recording: DeviceRecording,
    ) : BotaDeviceSDKAndroidRecordingClient {
        var cancelled = false

        override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
            listOf(recording)

        override fun syncRecording(
            device: ConnectedDevice,
            recording: DeviceRecording,
        ): Flow<RecordingSyncEvent> = flowOf(
            RecordingSyncEvent.Progress(RecordingTransferProgress(24_000u, 48_000u)),
            RecordingSyncEvent.Completed(Path.of("/tmp/bota-recordings/recording-1.ogg")),
        )

        override fun observeUploadOwnership(
            device: ConnectedDevice,
            recordingUuid: String,
            uploadId: String,
            destinationId: String,
        ): Flow<UploadOwnershipEvent> = flowOf(
            UploadOwnershipEvent.Progress(RecordingTransferProgress(32_000u, 48_000u)),
            UploadOwnershipEvent.Result(
                UploadOwnershipResult.BluetoothFallback(
                    recordingUuid,
                    uploadId,
                    destinationId,
                ),
            ),
        )

        override suspend fun cancelCurrentOperation() {
            cancelled = true
        }
    }
}
