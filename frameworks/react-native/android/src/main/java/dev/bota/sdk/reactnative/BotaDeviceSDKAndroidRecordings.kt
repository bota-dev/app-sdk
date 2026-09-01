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
import dev.bota.sdk.model.StreamingChunkDestinationProvider
import dev.bota.sdk.model.StreamingChunkRequest
import dev.bota.sdk.model.StreamingFinalizeHandler
import dev.bota.sdk.model.StreamingFinalizeMetadata
import dev.bota.sdk.model.StreamingRecordingEvent
import dev.bota.sdk.model.StreamingUploadDestination
import dev.bota.sdk.model.StreamingUploadMethod
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
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

    fun streamRecording(
        device: ConnectedDevice,
        recordingUuid: String,
        sinkId: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: ULong,
        destinationProvider: StreamingChunkDestinationProvider,
        finalize: StreamingFinalizeHandler,
    ): Flow<StreamingRecordingEvent>

    suspend fun cancelCurrentOperation()
}

internal fun BotaDeviceSDKAndroidRecordings.BotaRecordingFile.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("localPath", localPath)
        putBoolean("e2eEncrypted", isE2EEncrypted)
        contentSha256Hex?.let { putString("contentSha256", it) }
    }

internal data class BotaStreamingProgress(
    val sessionId: String,
    val state: String,
    val bytesReceived: ULong,
    val chunksUploaded: UInt,
)

internal data class BotaStreamingDestinationRequest(
    val requestId: String,
    val sessionId: String,
    val sequence: UInt,
    val encrypted: Boolean,
)

internal data class BotaStreamingFinalizeRequest(
    val requestId: String,
    val sessionId: String,
    val totalChunks: UInt,
    val durationMilliseconds: ULong,
    val fileSizeBytes: ULong,
    val encrypted: Boolean,
)

internal fun BotaStreamingProgress.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("sessionId", sessionId)
    putString("state", state)
    putDouble("bytesReceived", bytesReceived.toDouble())
    putDouble("chunksUploaded", chunksUploaded.toDouble())
}

internal fun BotaStreamingDestinationRequest.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("requestId", requestId)
    putString("sessionId", sessionId)
    putDouble("sequence", sequence.toDouble())
    putBoolean("encrypted", encrypted)
}

internal fun BotaStreamingFinalizeRequest.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("requestId", requestId)
    putString("sessionId", sessionId)
    putDouble("totalChunks", totalChunks.toDouble())
    putDouble("durationMs", durationMilliseconds.toDouble())
    putDouble("fileSizeBytes", fileSizeBytes.toDouble())
    putBoolean("encrypted", encrypted)
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

    override fun streamRecording(
        device: ConnectedDevice,
        recordingUuid: String,
        sinkId: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: ULong,
        destinationProvider: StreamingChunkDestinationProvider,
        finalize: StreamingFinalizeHandler,
    ): Flow<StreamingRecordingEvent> = client.recordings.streamRecording(
        device,
        recordingUuid,
        sinkId,
        chunkSizeBytes,
        flushIntervalMilliseconds,
        destinationProvider,
        finalize,
    )

    override suspend fun cancelCurrentOperation() {
        client.recordings.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidRecordings(
    private val client: BotaDeviceSDKAndroidRecordingClient =
        BotaDeviceSDKSharedAndroidRecordingClient(),
) {
    private val destinationRequests = ConcurrentHashMap<
        String,
        CompletableDeferred<StreamingUploadDestination>
    >()
    private val finalizeRequests = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    @Volatile private var activeStreamingSessionId: String? = null

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

    suspend fun streamRecording(
        device: ConnectedDevice,
        recordingUuid: String,
        sessionId: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: ULong,
        onProgress: (BotaStreamingProgress) -> Unit,
        onDestinationRequest: (BotaStreamingDestinationRequest) -> Unit,
        onFinalizeRequest: (BotaStreamingFinalizeRequest) -> Unit,
    ): ULong {
        activeStreamingSessionId = sessionId
        var bytesReceived = 0uL
        var chunksUploaded = 0u
        onProgress(streamingProgress(sessionId, "streaming", bytesReceived, chunksUploaded))
        try {
            client.streamRecording(
                device,
                recordingUuid,
                sessionId,
                chunkSizeBytes,
                flushIntervalMilliseconds,
                StreamingChunkDestinationProvider { request ->
                    requestDestination(sessionId, request, onDestinationRequest)
                },
                StreamingFinalizeHandler { metadata ->
                    requestFinalize(sessionId, metadata, onFinalizeRequest)
                },
            ).collect { event ->
                when (event) {
                    is StreamingRecordingEvent.Paused -> {
                        bytesReceived = event.completedBytes
                        onProgress(streamingProgress(
                            sessionId,
                            "paused",
                            bytesReceived,
                            chunksUploaded,
                        ))
                    }
                    StreamingRecordingEvent.Resumed -> onProgress(streamingProgress(
                        sessionId,
                        "streaming",
                        bytesReceived,
                        chunksUploaded,
                    ))
                    is StreamingRecordingEvent.Completed -> {
                        bytesReceived = event.totalBytes
                        chunksUploaded = event.uploadedChunks
                        onProgress(streamingProgress(
                            sessionId,
                            "completing",
                            bytesReceived,
                            chunksUploaded,
                        ))
                    }
                }
            }
            return bytesReceived
        } finally {
            if (activeStreamingSessionId == sessionId) activeStreamingSessionId = null
        }
    }

    fun resolveStreamingDestination(
        requestId: String,
        url: String,
        method: String,
        contentType: String,
        bearerToken: String?,
    ) {
        val destination = StreamingUploadDestination(
            url,
            StreamingUploadMethod.entries.firstOrNull { it.wireValue == method }
                ?: error("unsupported streaming upload method: $method"),
            contentType,
            bearerToken,
        )
        destinationRequests.remove(requestId)?.complete(destination)
    }

    fun rejectStreamingDestination(requestId: String, message: String) {
        destinationRequests.remove(requestId)?.completeExceptionally(IllegalStateException(message))
    }

    fun resolveStreamingFinalize(requestId: String) {
        finalizeRequests.remove(requestId)?.complete(Unit)
    }

    fun rejectStreamingFinalize(requestId: String, message: String) {
        finalizeRequests.remove(requestId)?.completeExceptionally(IllegalStateException(message))
    }

    suspend fun abortStreaming(sessionId: String) {
        if (activeStreamingSessionId != sessionId) return
        rejectPendingRequests("streaming session was aborted")
        runCatching { client.cancelCurrentOperation() }
    }

    suspend fun cancelAll() {
        rejectPendingRequests("recording operations were cancelled")
        runCatching { client.cancelCurrentOperation() }
    }

    private suspend fun requestDestination(
        sessionId: String,
        request: StreamingChunkRequest,
        onRequest: (BotaStreamingDestinationRequest) -> Unit,
    ): StreamingUploadDestination {
        val requestId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<StreamingUploadDestination>()
        destinationRequests[requestId] = deferred
        onRequest(BotaStreamingDestinationRequest(
            requestId,
            sessionId,
            request.sequence,
            request.isEncrypted,
        ))
        return try {
            deferred.await()
        } finally {
            destinationRequests.remove(requestId, deferred)
        }
    }

    private suspend fun requestFinalize(
        sessionId: String,
        metadata: StreamingFinalizeMetadata,
        onRequest: (BotaStreamingFinalizeRequest) -> Unit,
    ) {
        val requestId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<Unit>()
        finalizeRequests[requestId] = deferred
        onRequest(BotaStreamingFinalizeRequest(
            requestId,
            sessionId,
            metadata.totalChunks,
            metadata.durationMilliseconds,
            metadata.fileSizeBytes,
            metadata.isEncrypted,
        ))
        try {
            deferred.await()
        } finally {
            finalizeRequests.remove(requestId, deferred)
        }
    }

    private fun rejectPendingRequests(message: String) {
        val error = IllegalStateException(message)
        destinationRequests.values.forEach { it.completeExceptionally(error) }
        finalizeRequests.values.forEach { it.completeExceptionally(error) }
        destinationRequests.clear()
        finalizeRequests.clear()
    }
}

private fun streamingProgress(
    sessionId: String,
    state: String,
    bytesReceived: ULong,
    chunksUploaded: UInt,
): BotaStreamingProgress = BotaStreamingProgress(
    sessionId,
    state,
    bytesReceived,
    chunksUploaded,
)
