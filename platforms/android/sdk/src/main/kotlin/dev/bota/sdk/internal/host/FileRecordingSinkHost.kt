package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.model.StreamingChunkDestinationProvider
import dev.bota.sdk.model.StreamingChunkRequest
import dev.bota.sdk.model.StreamingFinalizeHandler
import dev.bota.sdk.model.StreamingFinalizeMetadata
import dev.bota.sdk.model.StreamingUploadDestination
import java.nio.ByteBuffer
import java.nio.file.Path
import java.util.zip.CRC32
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class FileRecordingSinkHost(
    private val registry: FileResourceRegistry = FileResourceRegistry(),
    private val networkClient: OkHttpClient = OkHttpClient(),
    private val streamingUpload: suspend (StreamingUploadDestination, ByteArray) -> Unit = { destination, body ->
        upload(networkClient, destination, body)
    },
) : RecordingSinkHost, AutoCloseable {
    private val mutex = Mutex()
    private val prepared = mutableSetOf<String>()
    private val streaming = mutableMapOf<String, StreamingSinkSession>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun registerPath(sinkId: String, path: Path) = registry.registerPath(sinkId, path)

    fun registerDescriptor(sinkId: String, descriptor: ParcelFileDescriptor) =
        registry.registerDescriptor(sinkId, descriptor)

    fun unregister(sinkId: String) {
        prepared.remove(sinkId)
        registry.remove(sinkId)
    }

    suspend fun registerStreaming(
        sinkId: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: ULong,
        destinationProvider: StreamingChunkDestinationProvider,
        finalize: StreamingFinalizeHandler,
    ) {
        validOpaqueId(sinkId)
        require(chunkSizeBytes > 0) { "streaming chunk size must be positive" }
        mutex.withLock {
            streaming.remove(sinkId)?.discard()
            streaming[sinkId] = StreamingSinkSession(
                chunkSizeBytes,
                flushIntervalMilliseconds,
                destinationProvider,
                finalize,
            )
        }
    }

    suspend fun unregisterStreaming(sinkId: String) {
        mutex.withLock { streaming.remove(sinkId)?.discard() }
    }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        mutex.withLock {
            val sinkId = validOpaqueId(requiredText(effect, HostFieldId.SinkId))
            when (effect.kind) {
                CoreEffectKind.RecordingSinkTruncate -> {
                    val resource = registry.resource(sinkId)
                    val completed = requiredUnsigned(effect, HostFieldId.CompletedUnits).toLongChecked()
                    resource.openWrite().use { channel ->
                        channel.truncate(completed)
                        channel.force(true)
                    }
                    prepared += sinkId
                    emit(CoreHostEventPayload(HostEventKind.RecordingSinkTruncated))
                }
                CoreEffectKind.RecordingSinkAppend -> {
                    val resource = registry.resource(sinkId)
                    requirePrepared(sinkId)
                    val payload = requiredBytes(effect, HostFieldId.Payload)
                    val durable = resource.openWrite().use { channel ->
                        channel.position(channel.size())
                        val buffer = ByteBuffer.wrap(payload)
                        while (buffer.hasRemaining()) channel.write(buffer)
                        channel.force(true)
                        channel.position().toULong()
                    }
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.RecordingSinkAppendCompleted,
                            listOf(CoreField.Unsigned(HostFieldId.DurableUnits, durable)),
                        ),
                    )
                }
                CoreEffectKind.RecordingSinkFinalize -> {
                    val resource = registry.resource(sinkId)
                    requirePrepared(sinkId)
                    val size = resource.openRead().use(FileChannelSize)
                    val expected = effect.packet.unsigneds(HostFieldId.ExpectedCrc32).firstOrNull()
                    val kind = if (expected != null && crc32(resource).toULong() != expected) {
                        HostEventKind.RecordingSinkIntegrityFailed
                    } else {
                        HostEventKind.RecordingSinkFinalized
                    }
                    val fields = if (kind == HostEventKind.RecordingSinkFinalized) {
                        listOf(CoreField.Unsigned(HostFieldId.DurableUnits, size))
                    } else {
                        emptyList()
                    }
                    emit(CoreHostEventPayload(kind, fields))
                }
                CoreEffectKind.RecordingSinkDiscard -> {
                    prepared -= sinkId
                    registry.remove(sinkId, discard = true)
                }
                CoreEffectKind.StreamingSinkAppendPlaintext -> {
                    val session = requiredStreaming(sinkId)
                    val completed = session.appendPlaintext(requiredBytes(effect, HostFieldId.Payload))
                    emit(streamingAccepted(completed))
                }
                CoreEffectKind.StreamingSinkBeginEncrypted -> {
                    val session = requiredStreaming(sinkId)
                    session.beginEncrypted(
                        requiredBytes(effect, HostFieldId.EphemeralPublicKey),
                        requiredBytes(effect, HostFieldId.Salt),
                    )
                    emit(streamingAccepted(session.completedUnits))
                }
                CoreEffectKind.StreamingSinkAppendEncrypted -> {
                    val session = requiredStreaming(sinkId)
                    val sequence = requiredUnsigned(effect, HostFieldId.Sequence).toUIntChecked()
                    val completed = session.appendEncrypted(sequence, requiredBytes(effect, HostFieldId.Payload))
                    emit(streamingAccepted(completed))
                }
                CoreEffectKind.StreamingSinkFinalize -> {
                    val session = requiredStreaming(sinkId)
                    val result = session.finalize(
                        encrypted = requiredBoolean(effect, HostFieldId.Encrypted),
                        expectedChunks = requiredUnsigned(effect, HostFieldId.ExpectedChunks).toUIntChecked(),
                        totalUnits = requiredUnsigned(effect, HostFieldId.TotalUnits),
                    )
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.StreamingSinkFinalized,
                            listOf(
                                CoreField.Unsigned(HostFieldId.UploadedChunks, result.first.toULong()),
                                CoreField.Unsigned(HostFieldId.TotalUnits, result.second),
                            ),
                        ),
                    )
                }
                CoreEffectKind.StreamingSinkDiscard -> {
                    streaming.remove(sinkId)?.discard()
                }
                else -> throw NativeHostException(422, "non-recording effect reached recording sink")
            }
        }
    }.flowOn(Dispatchers.IO)

    override fun close() {
        scope.cancel()
        streaming.values.forEach(StreamingSinkSession::discard)
        streaming.clear()
        prepared.clear()
        registry.close()
    }

    private fun requiredStreaming(sinkId: String): StreamingSinkSession =
        streaming[sinkId] ?: throw NativeHostException(404, "streaming sink is not registered: $sinkId")

    private fun streamingAccepted(completed: ULong): CoreHostEventPayload = CoreHostEventPayload(
        HostEventKind.StreamingSinkAccepted,
        listOf(CoreField.Unsigned(HostFieldId.CompletedUnits, completed)),
    )

    private fun requirePrepared(sinkId: String) {
        if (sinkId !in prepared) throw NativeHostException(409, "recording sink was not prepared")
    }

    private fun crc32(resource: FileResource): Long {
        val checksum = CRC32()
        resource.openRead().use { channel ->
            val buffer = ByteBuffer.allocate(64 * 1024)
            while (channel.read(buffer) >= 0) {
                if (buffer.position() == 0) continue
                checksum.update(buffer.array(), 0, buffer.position())
                buffer.clear()
            }
        }
        return checksum.value
    }

    private companion object {
        val FileChannelSize: (java.nio.channels.FileChannel) -> ULong = { it.size().toULong() }

        suspend fun upload(
            client: OkHttpClient,
            destination: StreamingUploadDestination,
            body: ByteArray,
        ) {
            val requestBody = body.toRequestBody(destination.contentType.toMediaType())
            val request = Request.Builder()
                .url(destination.url)
                .method(destination.method.wireValue, requestBody)
                .apply {
                    destination.bearerToken?.let { header("Authorization", "Bearer $it") }
                }
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw NativeHostException(response.code, "streaming upload failed with HTTP ${response.code}")
                }
            }
        }
    }

    private inner class StreamingSinkSession(
        private val chunkSizeBytes: Int,
        private val flushIntervalMilliseconds: ULong,
        private val destinationProvider: StreamingChunkDestinationProvider,
        private val finalizeHandler: StreamingFinalizeHandler,
    ) {
        private val startedAtMilliseconds = System.currentTimeMillis()
        private var plaintextBuffer = ByteArray(0)
        private var encryptedHeader: ByteArray? = null
        private var encrypted: Boolean? = null
        var completedUnits: ULong = 0u
            private set
        private var uploadedChunks: UInt = 0u
        private var nextPlaintextSequence: UInt = 1u
        private var flushJob: Job? = null
        private var backgroundFailure: Throwable? = null
        private var discarded = false

        suspend fun appendPlaintext(payload: ByteArray): ULong {
            checkActive()
            check(encrypted != true) { "streaming sink mixed plaintext and encrypted payloads" }
            encrypted = false
            plaintextBuffer += payload
            completedUnits += payload.size.toULong()
            while (plaintextBuffer.size >= chunkSizeBytes) {
                val body = plaintextBuffer.copyOfRange(0, chunkSizeBytes)
                plaintextBuffer = plaintextBuffer.copyOfRange(chunkSizeBytes, plaintextBuffer.size)
                uploadPlaintext(body)
            }
            scheduleFlush()
            return completedUnits
        }

        fun beginEncrypted(ephemeralPublicKey: ByteArray, salt: ByteArray) {
            checkActive()
            check(encrypted != false && ephemeralPublicKey.size == 32 && salt.size == 4) {
                "invalid encrypted streaming header"
            }
            encrypted = true
            encryptedHeader = ephemeralPublicKey + salt
        }

        suspend fun appendEncrypted(sequence: UInt, payload: ByteArray): ULong {
            checkActive()
            val header = checkNotNull(encryptedHeader) { "encrypted streaming header is missing" }
            check(encrypted == true && payload.size >= 16) { "invalid encrypted streaming payload" }
            val body = if (sequence == 0u) header + payload else payload
            runCatching { uploadWithRetry(StreamingChunkRequest(sequence, true), body) }
                .onSuccess { uploadedChunks += 1u }
                .onFailure { if (sequence == 0u) throw it }
            completedUnits += (payload.size - 16).toULong()
            return completedUnits
        }

        suspend fun finalize(
            encrypted: Boolean,
            expectedChunks: UInt,
            totalUnits: ULong,
        ): Pair<UInt, ULong> {
            checkActive()
            flushJob?.cancel()
            flushJob = null
            backgroundFailure?.let { throw it }
            check(this.encrypted == encrypted && completedUnits == totalUnits) {
                "streaming finalize metadata does not match accepted bytes"
            }
            if (!encrypted) flushPartial()
            val finalizedChunks = if (encrypted) expectedChunks else uploadedChunks
            finalizeHandler.finalize(
                StreamingFinalizeMetadata(
                    finalizedChunks,
                    (System.currentTimeMillis() - startedAtMilliseconds).coerceAtLeast(0).toULong(),
                    completedUnits,
                    encrypted,
                ),
            )
            return uploadedChunks to completedUnits
        }

        fun discard() {
            discarded = true
            flushJob?.cancel()
            flushJob = null
            plaintextBuffer = ByteArray(0)
            encryptedHeader = null
        }

        private suspend fun flushPartial() {
            if (plaintextBuffer.isEmpty()) return
            val body = plaintextBuffer
            plaintextBuffer = ByteArray(0)
            uploadPlaintext(body)
        }

        private suspend fun uploadPlaintext(body: ByteArray) {
            val sequence = nextPlaintextSequence++
            uploadWithRetry(StreamingChunkRequest(sequence, false), body)
            uploadedChunks += 1u
        }

        private suspend fun uploadWithRetry(request: StreamingChunkRequest, body: ByteArray) {
            var failure: Throwable? = null
            repeat(3) { attempt ->
                try {
                    streamingUpload(destinationProvider.destination(request), body)
                    return
                } catch (error: Throwable) {
                    failure = error
                    if (attempt < 2) delay(50L * (attempt + 1))
                }
            }
            throw failure ?: NativeHostException(1, "streaming upload failed")
        }

        private fun scheduleFlush() {
            flushJob?.cancel()
            if (flushIntervalMilliseconds == 0uL || plaintextBuffer.isEmpty()) return
            flushJob = scope.launch {
                delay(flushIntervalMilliseconds.coerceAtMost(Long.MAX_VALUE.toULong()).toLong())
                mutex.withLock {
                    runCatching { flushPartial() }.exceptionOrNull()?.let { backgroundFailure = it }
                }
            }
        }

        private fun checkActive() {
            check(!discarded) { "streaming sink was discarded" }
            backgroundFailure?.let { throw it }
        }
    }
}

internal fun ULong.toLongChecked(): Long {
    if (this > Long.MAX_VALUE.toULong()) throw NativeHostException(422, "file offset is too large")
    return toLong()
}

private fun ULong.toUIntChecked(): UInt {
    if (this > UInt.MAX_VALUE.toULong()) throw NativeHostException(422, "unsigned value is too large")
    return toUInt()
}

private fun requiredBoolean(effect: CoreEffect, id: Int): Boolean =
    effect.packet.booleans(id).firstOrNull()
        ?: throw NativeHostException(422, "required boolean field $id is missing")
