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
import dev.bota.sdk.model.StreamingChunkDestinationProvider
import dev.bota.sdk.model.StreamingChunkRequest
import dev.bota.sdk.model.StreamingFinalizeHandler
import dev.bota.sdk.model.StreamingFinalizeMetadata
import dev.bota.sdk.model.StreamingRecordingEvent
import dev.bota.sdk.model.WireValue
import java.nio.file.Path
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flow
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
            BotaDeviceSDKAndroidRecordings.BotaRecordingFile(
                "/tmp/bota-recordings/recording-1.ogg",
                true,
                "5a".repeat(32),
            ),
            recordings.syncRecording(connected, recording, "sink-1", progress::add),
        )
        assertEquals(listOf("sink-1"), client.sinkIds)
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

    @Test
    fun streamingResolvesOneShotRequestsAndMapsProgress() = runTest {
        val client = TestAndroidRecordingClient(recording())
        val recordings = BotaDeviceSDKAndroidRecordings(client)
        val states = mutableListOf<String>()
        var sequence: Double? = null
        var finalizedChunks: Double? = null

        val total = recordings.streamRecording(
            device = connectedDevice(),
            recordingUuid = "recording-1",
            sessionId = UUID.randomUUID().toString(),
            chunkSizeBytes = 64 * 1_024,
            flushIntervalMilliseconds = 1_000u,
            onProgress = { states += it.state },
            onDestinationRequest = {
                sequence = it.sequence.toDouble()
                recordings.resolveStreamingDestination(
                    it.requestId,
                    "https://example.test/chunk/1",
                    "PUT",
                    "audio/ogg",
                    null,
                )
            },
            onFinalizeRequest = {
                finalizedChunks = it.totalChunks.toDouble()
                recordings.resolveStreamingFinalize(it.requestId)
            },
        )

        assertEquals(96uL, total)
        assertEquals(1.0, sequence)
        assertEquals(2.0, finalizedChunks)
        assertEquals(listOf("streaming", "paused", "streaming", "completing"), states)
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
        val sinkIds = mutableListOf<String>()

        override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
            listOf(recording)

        override fun syncRecording(
            device: ConnectedDevice,
            recording: DeviceRecording,
            sinkId: String,
        ): Flow<RecordingSyncEvent> = flowOf(
            RecordingSyncEvent.Progress(RecordingTransferProgress(24_000u, 48_000u)),
            RecordingSyncEvent.Completed(Path.of("/tmp/bota-recordings/recording-1.ogg")),
        ).also { sinkIds += sinkId }

        override fun transferMetadata(sinkId: String): dev.bota.sdk.RecordingTransferMetadata =
            dev.bota.sdk.RecordingTransferMetadata(true, "5a".repeat(32))

        override suspend fun confirmRecording(device: ConnectedDevice, recordingUuid: String) = Unit

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

        override fun streamRecording(
            device: ConnectedDevice,
            recordingUuid: String,
            sinkId: String,
            chunkSizeBytes: Int,
            flushIntervalMilliseconds: ULong,
            destinationProvider: StreamingChunkDestinationProvider,
            finalize: StreamingFinalizeHandler,
        ): Flow<StreamingRecordingEvent> = flow {
            destinationProvider.destination(StreamingChunkRequest(1u, false))
            finalize.finalize(StreamingFinalizeMetadata(2u, 500u, 96u, false))
            emit(StreamingRecordingEvent.Paused(32u))
            emit(StreamingRecordingEvent.Resumed)
            emit(StreamingRecordingEvent.Completed(96u, 2u, false))
        }

        override suspend fun cancelCurrentOperation() {
            cancelled = true
        }
    }
}
