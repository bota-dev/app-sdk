package dev.bota.sdk.reactnative

import dev.bota.sdk.EncryptedUploadV2Capabilities
import dev.bota.sdk.EncryptedUploadV2CapabilitySnapshot
import dev.bota.sdk.EncryptedUploadV2Checkpoint
import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2ProfileProvider
import dev.bota.sdk.EncryptedUploadV2ProviderContext
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
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
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidRecordingsTest {
    @Test
    fun encryptedUploadV2UsesOneShotNativeMaterialAndSafeBridgeValues() = runTest {
        val recordingUuid = "00112233-4455-6677-8899-aabbccddeeff"
        val uploadSessionId = UUID.fromString("10213243-5465-7687-98a9-bacbdcedfe0f")
        val recording = EncryptedUploadV2Recording(
            recordingUuid,
            4u,
            4_096u,
            ByteArray(32) { 0x5a },
        )
        val context = EncryptedUploadV2ProviderContext(
            recording,
            EncryptedUploadV2CapabilitySnapshot(
                byteArrayOf(
                    0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00,
                    0x00, 0x04, 0x00, 0x04, 0x00, 0x10, 0x00, 0x08,
                    0x00, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
                ),
                ByteArray(32) { 0x6b },
                EncryptedUploadV2Capabilities(0x7fu, 1_024u, 1_024u, 4_096u, 8u, 256u, 16u),
            ),
            EncryptedUploadV2Checkpoint(
                uploadSessionId,
                2u,
                3u,
                2_048u,
                ByteArray(32) { 0x7c },
                7u,
                72_623_859_790_382_856u,
                "20314253-6475-8697-a8b9-cadbecfd0e1f",
                8u,
                512u,
            ),
        )
        val material = EncryptedUploadV2Material(
            "native-material-1",
            recordingUuid,
            uploadSessionId,
            2u,
            EncryptedUploadV2SecurityPolicy.V2Required,
            ByteArray(32) { 0xa5.toByte() },
            { Request.Builder().url("https://native.invalid/stage").build() },
            { _, _ -> },
            { _ -> },
            { ByteArray(16) { 0x3c } },
        )
        val registrationId = BotaDeviceSDKEncryptedUploadV2Materials.register(material)
        val client = TestAndroidRecordingClient(recording(), context)
        val recordings = BotaDeviceSDKAndroidRecordings(client)
        val requests = mutableListOf<BotaEncryptedUploadV2ProfileRequest>()
        val progress = mutableListOf<BotaEncryptedUploadV2Progress>()

        recordings.syncEncryptedRecordingV2(
            connectedDevice(),
            recording,
            "operation-1",
            onProfileRequest = { request ->
                requests += request
                recordings.resolveEncryptedUploadV2Profile(
                    request.requestId,
                    "encrypted_upload_v2",
                    uploadSessionId.toString(),
                    2u,
                    "v2_required",
                    registrationId,
                )
            },
            onProgress = progress::add,
        )

        assertEquals(1, requests.size)
        assertEquals(recordingUuid, requests.single().recording.uuid)
        assertEquals("2048", requests.single().checkpoint?.nextCiphertextOffset)
        assertEquals("native-material-1", client.encryptedMaterialId)
        assertEquals(
            listOf("profile_requested", "transferring", "completed"),
            progress.map(BotaEncryptedUploadV2Progress::phase),
        )
        assertNull(BotaDeviceSDKEncryptedUploadV2Materials.remove(registrationId))
    }

    @Test
    fun encryptedUploadV2MapsStableNativeFailureProgress() = runTest {
        val failure = BotaSDKError.Core(
            BotaErrorCode.ProtocolRejected,
            BotaOperation.TransferRecording,
            true,
            0x22u,
            "device rejected the selected policy",
        )
        val client = TestAndroidRecordingClient(recording(), encryptedUploadV2Error = failure)
        val recordings = BotaDeviceSDKAndroidRecordings(client)
        val progress = mutableListOf<BotaEncryptedUploadV2Progress>()

        val actual = runCatching {
            recordings.syncEncryptedRecordingV2(
                connectedDevice(),
                EncryptedUploadV2Recording(
                    "00112233-4455-6677-8899-aabbccddeeff",
                    4u,
                    4_096u,
                    ByteArray(32) { 0x5a },
                ),
                "operation-1",
                onProfileRequest = {},
                onProgress = progress::add,
            )
        }.exceptionOrNull()

        assertEquals(failure, actual)
        assertEquals("failed", progress.last().phase)
        assertEquals("protocol_rejected", progress.last().errorCode)
        assertEquals(true, progress.last().retryable)
        assertEquals(0x22u.toUShort(), progress.last().protocolStatus)
    }

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
        private val encryptedUploadV2Context: EncryptedUploadV2ProviderContext? = null,
        private val encryptedUploadV2Error: BotaSDKError.Core? = null,
    ) : BotaDeviceSDKAndroidRecordingClient {
        var cancelled = false
        val sinkIds = mutableListOf<String>()
        var encryptedMaterialId: String? = null

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

        override suspend fun syncEncryptedRecordingV2(
            device: ConnectedDevice,
            recording: EncryptedUploadV2Recording,
            provider: EncryptedUploadV2ProfileProvider,
        ) {
            encryptedUploadV2Error?.let { throw it }
            val context = requireNotNull(encryptedUploadV2Context)
            encryptedMaterialId = provider.select(context).materialId
        }

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
