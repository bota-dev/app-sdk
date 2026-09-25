package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.EncryptedUploadV2CapabilitySnapshot
import dev.bota.sdk.EncryptedUploadV2Checkpoint
import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2ProfileProvider
import dev.bota.sdk.EncryptedUploadV2ProviderContext
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.PendingRecording
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect

internal interface BotaDeviceSDKAndroidRecordingClient {
    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording>
    suspend fun listPendingRecordings(device: ConnectedDevice): List<PendingRecording>

    fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        sinkId: String,
    ): Flow<RecordingSyncEvent>

    fun transferMetadata(sinkId: String): RecordingTransferMetadata?

    suspend fun syncEncryptedRecordingV2(
        device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        operationId: UUID,
        provider: EncryptedUploadV2ProfileProvider,
    )

    suspend fun cancelEncryptedRecordingV2(operationId: UUID)

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
        putDouble("fileSizeBytes", fileSizeBytes.toDouble())
        contentSha256Hex?.let { putString("contentSha256", it) }
    }

internal data class BotaStreamingProgress(
    val sessionId: String,
    val state: String,
    val bytesReceived: ULong,
    val chunksUploaded: UInt,
)

internal data class BotaEncryptedUploadV2Recording(
    val uuid: String,
    val generation: UInt,
    val ciphertextLength: String,
    val ciphertextSha256: String,
    val startedAtMs: String,
    val durationMs: String,
    val plaintextLength: String,
    val storageFormat: Int,
)

internal data class BotaEncryptedUploadV2Capability(
    val encodingVersion: Int,
    val transferProfileVersion: Int,
    val rawValueHex: String,
    val sha256Hex: String,
    val flags: UInt,
    val maximumSignedBlobBytes: UShort,
    val maximumManifestBytes: UShort,
    val maximumDataPayloadBytes: UShort,
    val maximumWindowPackets: UShort,
    val durableCheckpointIntervalBlocks: UInt,
    val maximumMissingSequences: UShort,
)

internal data class BotaEncryptedUploadV2Checkpoint(
    val version: Int,
    val uploadSessionId: String,
    val ownerRevision: UInt,
    val revision: UInt,
    val nextCiphertextOffset: String,
    val prefixSha256: String,
    val highestContiguousSequence: UInt?,
    val transportSessionId: String,
    val sinkRegistrationId: String,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
)

internal data class BotaEncryptedUploadV2ProfileRequest(
    val requestId: String,
    val operationId: String,
    val recording: BotaEncryptedUploadV2Recording,
    val capability: BotaEncryptedUploadV2Capability,
    val checkpoint: BotaEncryptedUploadV2Checkpoint?,
)

internal data class BotaEncryptedUploadV2Progress(
    val operationId: String,
    val recordingUuid: String,
    val phase: String,
    val completedBytes: String,
    val totalBytes: String,
    val checkpointRevision: UInt? = null,
    val errorCode: String? = null,
    val retryable: Boolean? = null,
    val protocolStatus: UShort? = null,
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

internal fun BotaEncryptedUploadV2ProfileRequest.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("requestId", requestId)
        putString("operationId", operationId)
        putMap("recording", recording.toWritableMap())
        putMap("capability", capability.toWritableMap())
        checkpoint?.let { putMap("checkpoint", it.toWritableMap()) }
    }

internal fun BotaEncryptedUploadV2Progress.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("operationId", operationId)
    putString("recordingUuid", recordingUuid)
    putString("phase", phase)
    putString("completedBytes", completedBytes)
    putString("totalBytes", totalBytes)
    checkpointRevision?.let { putDouble("checkpointRevision", it.toDouble()) }
    errorCode?.let { putString("errorCode", it) }
    retryable?.let { putBoolean("retryable", it) }
    protocolStatus?.let { putDouble("protocolStatus", it.toDouble()) }
}

internal fun BotaEncryptedUploadV2Recording.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("uuid", uuid)
    putDouble("generation", generation.toDouble())
    putString("ciphertextLength", ciphertextLength)
    putString("ciphertextSha256", ciphertextSha256)
    putString("startedAtMs", startedAtMs)
    putString("durationMs", durationMs)
    putString("plaintextLength", plaintextLength)
    putInt("storageFormat", storageFormat)
}

private fun BotaEncryptedUploadV2Capability.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putDouble("encodingVersion", encodingVersion.toDouble())
    putDouble("transferProfileVersion", transferProfileVersion.toDouble())
    putString("rawValueHex", rawValueHex)
    putString("sha256Hex", sha256Hex)
    putDouble("flags", flags.toDouble())
    putDouble("maximumSignedBlobBytes", maximumSignedBlobBytes.toDouble())
    putDouble("maximumManifestBytes", maximumManifestBytes.toDouble())
    putDouble("maximumDataPayloadBytes", maximumDataPayloadBytes.toDouble())
    putDouble("maximumWindowPackets", maximumWindowPackets.toDouble())
    putDouble("durableCheckpointIntervalBlocks", durableCheckpointIntervalBlocks.toDouble())
    putDouble("maximumMissingSequences", maximumMissingSequences.toDouble())
}

private fun BotaEncryptedUploadV2Checkpoint.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putDouble("version", version.toDouble())
    putString("uploadSessionId", uploadSessionId)
    putDouble("ownerRevision", ownerRevision.toDouble())
    putDouble("revision", revision.toDouble())
    putString("nextCiphertextOffset", nextCiphertextOffset)
    putString("prefixSha256", prefixSha256)
    highestContiguousSequence?.let { putDouble("highestContiguousSequence", it.toDouble()) }
    putString("transportSessionId", transportSessionId)
    putString("sinkRegistrationId", sinkRegistrationId)
    putDouble("windowPackets", windowPackets.toDouble())
    putDouble("dataPayloadBytes", dataPayloadBytes.toDouble())
}

internal class BotaDeviceSDKSharedAndroidRecordingClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidRecordingClient {
    override suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.recordings.listRecordings(device)

    override suspend fun listPendingRecordings(device: ConnectedDevice): List<PendingRecording> =
        client.recordings.listPendingRecordings(device)

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

    override suspend fun syncEncryptedRecordingV2(
        device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        operationId: UUID,
        provider: EncryptedUploadV2ProfileProvider,
    ) {
        client.recordings.syncEncryptedRecordingV2(device, recording, operationId, provider)
    }

    override suspend fun cancelEncryptedRecordingV2(operationId: UUID) {
        client.recordings.cancelEncryptedRecordingV2(operationId)
    }

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
    private val fileSize: (String) -> Long = { path ->
        val file = java.nio.file.Paths.get(path)
        check(java.nio.file.Files.isRegularFile(file)) { "recording transfer did not produce a regular file" }
        java.nio.file.Files.size(file)
    },
) {
    private val destinationRequests = ConcurrentHashMap<
        String,
        CompletableDeferred<StreamingUploadDestination>
    >()
    private data class EncryptedUploadV2Request(
        val operationId: String,
        val recording: EncryptedUploadV2Recording,
        val material: CompletableDeferred<EncryptedUploadV2Material>,
    ) {
        @Volatile var selectedMaterial: EncryptedUploadV2Material? = null
    }
    private val encryptedUploadV2Requests =
        ConcurrentHashMap<String, EncryptedUploadV2Request>()
    private data class EncryptedUploadV2Operation(val id: UUID, val job: Job)
    private val encryptedUploadV2Operations = ConcurrentHashMap<String, EncryptedUploadV2Operation>()
    private val cancelledEncryptedUploadV2Operations = ConcurrentHashMap.newKeySet<String>()
    private val finalizeRequests = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    @Volatile private var activeStreamingSessionId: String? = null

    internal data class BotaRecordingFile(
        val localPath: String,
        val isE2EEncrypted: Boolean,
        val contentSha256Hex: String?,
        val fileSizeBytes: Long,
    )

    suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> =
        client.listRecordings(device)

    suspend fun listPendingRecordings(device: ConnectedDevice): List<PendingRecording> =
        client.listPendingRecordings(device)

    suspend fun cancelEncryptedRecordingV2(operationId: String) {
        val caller = currentCoroutineContext().job
        cancelledEncryptedUploadV2Operations.add(operationId)
        val operation = encryptedUploadV2Operations[operationId]
        operation?.job?.cancel()
        encryptedUploadV2Requests.entries.forEach { (id, request) ->
            if (request.operationId == operationId && encryptedUploadV2Requests.remove(id, request)) {
                request.material.completeExceptionally(CancellationException())
            }
        }
        BotaDeviceSDKEncryptedUploadV2Materials.removeContext(operationId)
        if (operation != null) {
            withContext(NonCancellable) {
                try {
                    client.cancelEncryptedRecordingV2(operation.id)
                } finally {
                    if (operation.job !== caller) operation.job.join()
                }
            }
        }
    }

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
            fileSize(localPath),
        )
    }

    suspend fun syncEncryptedRecordingV2(
        device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        operationId: String,
        onProfileRequest: (BotaEncryptedUploadV2ProfileRequest) -> Unit,
        onProgress: (BotaEncryptedUploadV2Progress) -> Unit,
    ) {
        val operation = EncryptedUploadV2Operation(UUID.randomUUID(), currentCoroutineContext().job)
        check(encryptedUploadV2Operations.putIfAbsent(operationId, operation) == null) {
            "encrypted upload v2 operation is already active"
        }
        try {
            if (cancelledEncryptedUploadV2Operations.contains(operationId)) throw CancellationException()
            client.syncEncryptedRecordingV2(
                device,
                recording,
                operation.id,
                EncryptedUploadV2ProfileProvider { context ->
                    val completedBytes = context.checkpoint?.nextCiphertextOffset?.toString() ?: "0"
                    val checkpointRevision = context.checkpoint?.revision
                    onProgress(BotaEncryptedUploadV2Progress(
                        operationId,
                        recording.uuid,
                        "profile_requested",
                        completedBytes,
                        recording.ciphertextLength.toString(),
                        checkpointRevision,
                    ))
                    val material = requestEncryptedUploadV2Profile(
                        operationId,
                        context,
                        onProfileRequest,
                    )
                    try {
                        currentCoroutineContext().ensureActive()
                        onProgress(BotaEncryptedUploadV2Progress(
                            operationId,
                            recording.uuid,
                            "transferring",
                            completedBytes,
                            recording.ciphertextLength.toString(),
                            checkpointRevision,
                        ))
                        material
                    } catch (error: Throwable) {
                        withContext(NonCancellable) { material.cancelPreparation() }
                        throw error
                    }
                },
            )
            currentCoroutineContext().ensureActive()
            onProgress(BotaEncryptedUploadV2Progress(
                operationId,
                recording.uuid,
                "completed",
                recording.ciphertextLength.toString(),
                recording.ciphertextLength.toString(),
            ))
        } catch (error: Throwable) {
            val failure = error.encryptedUploadV2Failure()
            onProgress(BotaEncryptedUploadV2Progress(
                operationId,
                recording.uuid,
                "failed",
                "0",
                recording.ciphertextLength.toString(),
                errorCode = failure.code,
                retryable = failure.retryable,
                protocolStatus = failure.protocolStatus,
            ))
            throw error
        } finally {
            BotaDeviceSDKEncryptedUploadV2Materials.removeContext(operationId)
            encryptedUploadV2Operations.remove(operationId, operation)
        }
    }

    suspend fun resolveEncryptedUploadV2Profile(
        requestId: String,
        profile: String,
        uploadSessionId: String,
        ownerRevision: UInt,
        securityPolicy: String,
        materialRegistrationId: String,
    ) {
        val request = encryptedUploadV2Requests.remove(requestId)
        if (request == null) {
            withContext(NonCancellable) { BotaDeviceSDKEncryptedUploadV2Materials.release(materialRegistrationId) }
            error("encrypted upload v2 profile request is no longer pending")
        }
        BotaDeviceSDKEncryptedUploadV2Materials.removeContext(request.operationId)
        var selected: EncryptedUploadV2Material? = null
        try {
            require(profile == "encrypted_upload_v2") {
                "encrypted upload v2 requires an explicit matching profile"
            }
            selected = BotaDeviceSDKEncryptedUploadV2Materials.consume(
                materialRegistrationId,
                request.recording,
                UUID.fromString(uploadSessionId),
                ownerRevision,
                securityPolicy,
            )
            request.selectedMaterial = selected
            check(request.material.complete(selected)) {
                "encrypted upload v2 profile request is no longer pending"
            }
        } catch (error: Throwable) {
            request.material.completeExceptionally(error)
            withContext(NonCancellable) {
                if (selected != null) selected.cancelPreparation()
                else BotaDeviceSDKEncryptedUploadV2Materials.release(materialRegistrationId)
            }
            throw error
        }
    }

    fun rejectEncryptedUploadV2Profile(requestId: String, errorCode: String) {
        val request = encryptedUploadV2Requests.remove(requestId)
            ?: error("encrypted upload v2 profile request is no longer pending")
        BotaDeviceSDKEncryptedUploadV2Materials.removeContext(request.operationId)
        val error = if (errorCode == "application_material_rejected") {
            IllegalStateException("encrypted upload v2 material was rejected")
        } else {
            IllegalArgumentException("encrypted upload v2 rejection code is unsupported")
        }
        request.material.completeExceptionally(error)
        if (errorCode != "application_material_rejected") throw error
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
        val operations = encryptedUploadV2Operations.toMap()
        operations.values.forEach { it.job.cancel() }
        operations.keys.forEach { runCatching { cancelEncryptedRecordingV2(it) } }
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

    private suspend fun requestEncryptedUploadV2Profile(
        operationId: String,
        context: EncryptedUploadV2ProviderContext,
        onRequest: (BotaEncryptedUploadV2ProfileRequest) -> Unit,
    ): EncryptedUploadV2Material {
        val requestId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<EncryptedUploadV2Material>()
        val request = EncryptedUploadV2Request(
            operationId,
            context.recording,
            deferred,
        )
        BotaDeviceSDKEncryptedUploadV2Materials.registerContext(operationId, context)
        encryptedUploadV2Requests[requestId] = request
        var delivered = false
        return try {
            if (cancelledEncryptedUploadV2Operations.contains(operationId)) throw CancellationException()
            onRequest(BotaEncryptedUploadV2ProfileRequest(
                requestId,
                operationId,
                context.recording.toBridgeValue(),
                context.capability.toBridgeValue(),
                context.checkpoint?.toBridgeValue(),
            ))
            deferred.await().also {
                currentCoroutineContext().ensureActive()
                delivered = true
            }
        } finally {
            encryptedUploadV2Requests.remove(requestId, request)
            BotaDeviceSDKEncryptedUploadV2Materials.removeContext(operationId)
            if (!delivered) {
                // A completed deferred can still lose to prompt coroutine cancellation.
                deferred.cancel()
                withContext(NonCancellable) { request.selectedMaterial?.cancelPreparation() }
            }
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
        encryptedUploadV2Requests.values.forEach {
            BotaDeviceSDKEncryptedUploadV2Materials.removeContext(it.operationId)
            it.material.completeExceptionally(error)
        }
        destinationRequests.values.forEach { it.completeExceptionally(error) }
        finalizeRequests.values.forEach { it.completeExceptionally(error) }
        destinationRequests.clear()
        finalizeRequests.clear()
        encryptedUploadV2Requests.clear()
    }
}

internal fun EncryptedUploadV2Recording.toBridgeValue(): BotaEncryptedUploadV2Recording =
    BotaEncryptedUploadV2Recording(
        uuid,
        generation,
        ciphertextLength.toString(),
        ciphertextSha256.toHex(),
        startedAtMs.toString(),
        durationMs.toString(),
        plaintextLength.toString(),
        storageFormat.toInt(),
    )

private fun EncryptedUploadV2CapabilitySnapshot.toBridgeValue(): BotaEncryptedUploadV2Capability {
    val values = capabilities
    return BotaEncryptedUploadV2Capability(
        rawValue.getOrElse(0) { 0 }.toUByte().toInt(),
        rawValue.getOrElse(1) { 0 }.toUByte().toInt(),
        rawValue.toHex(),
        sha256.toHex(),
        values.flags,
        values.maximumSignedBlobBytes,
        values.maximumManifestBytes,
        values.maximumDataPayloadBytes,
        values.maximumWindowPackets,
        values.durableCheckpointIntervalBlocks,
        values.maximumMissingSequences,
    )
}

private fun EncryptedUploadV2Checkpoint.toBridgeValue(): BotaEncryptedUploadV2Checkpoint =
    BotaEncryptedUploadV2Checkpoint(
        1,
        uploadSessionId.toString(),
        ownerRevision,
        revision,
        nextCiphertextOffset.toString(),
        prefixSha256.toHex(),
        highestContiguousSequence,
        transportSessionId.toString(),
        sinkId,
        windowPackets,
        dataPayloadBytes,
    )

private data class EncryptedUploadV2Failure(
    val code: String,
    val retryable: Boolean,
    val protocolStatus: UShort?,
)

private fun Throwable.encryptedUploadV2Failure(): EncryptedUploadV2Failure = when (this) {
    is BotaSDKError.Core -> EncryptedUploadV2Failure(
        code.stableName(),
        retryable,
        protocolStatus,
    )
    is BotaSDKError.AuthorizationRequired ->
        EncryptedUploadV2Failure("authorization_required", false, null)
    is kotlinx.coroutines.CancellationException ->
        EncryptedUploadV2Failure("cancelled", false, null)
    else -> EncryptedUploadV2Failure("application_material_rejected", false, null)
}

private fun BotaErrorCode.stableName(): String = when (this) {
    BotaErrorCode.InvalidInput -> "invalid_input"
    BotaErrorCode.TruncatedPacket -> "truncated_packet"
    BotaErrorCode.UnknownPacket -> "unknown_packet"
    BotaErrorCode.PayloadTooLarge -> "payload_too_large"
    BotaErrorCode.UnsupportedCapability -> "unsupported_capability"
    BotaErrorCode.UnsupportedOperation -> "unsupported_operation"
    BotaErrorCode.FeatureUnavailable -> "feature_unavailable"
    BotaErrorCode.OperationInProgress -> "operation_in_progress"
    BotaErrorCode.UnexpectedEvent -> "unexpected_event"
    BotaErrorCode.DeviceNotFound -> "device_not_found"
    BotaErrorCode.IdentityMismatch -> "identity_mismatch"
    BotaErrorCode.ConnectionFailed -> "connection_failed"
    BotaErrorCode.PersistenceFailed -> "persistence_failed"
    BotaErrorCode.NotConnected -> "not_connected"
    BotaErrorCode.Timeout -> "timeout"
    BotaErrorCode.Cancelled -> "cancelled"
    BotaErrorCode.ProtocolRejected -> "protocol_rejected"
    BotaErrorCode.IntegrityFailed -> "integrity_failed"
    BotaErrorCode.UploadOwnershipUnknown -> "upload_ownership_unknown"
    BotaErrorCode.DownloadFailed -> "download_failed"
    BotaErrorCode.Internal -> "internal"
    is BotaErrorCode.Unknown -> "unknown"
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

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
