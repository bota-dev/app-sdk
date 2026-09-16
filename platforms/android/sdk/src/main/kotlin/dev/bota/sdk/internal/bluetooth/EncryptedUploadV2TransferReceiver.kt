package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import dev.bota.sdk.internal.core.EncryptedUploadV2DataValue
import dev.bota.sdk.internal.core.EncryptedUploadV2EofValue
import dev.bota.sdk.internal.core.EncryptedUploadV2ManifestChunkValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.core.EncryptedUploadV2WindowEndValue
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest

internal data class EncryptedUploadV2CheckpointValue(
    val revision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val highestContiguousSequence: UInt?,
)

internal data class EncryptedUploadV2WindowStageValue(
    val checkpoint: EncryptedUploadV2CheckpointValue,
    val missingSequences: List<UInt>,
)

internal data class EncryptedUploadV2WindowAcknowledgement(
    val transportSessionId: ULong,
    val windowIndex: UInt,
    val highestContiguousSequence: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val checkpointRevision: UInt,
    val missingSequences: List<UInt>,
)

internal data class EncryptedUploadV2CompletedTransferValue(
    val file: Path,
    val manifest: ByteArray,
    val evidence: EncryptedUploadV2TransferEvidence,
)

internal sealed interface EncryptedUploadV2TransferReceiverEvent {
    data class WindowStaged(val value: EncryptedUploadV2WindowStageValue) :
        EncryptedUploadV2TransferReceiverEvent
    data class Completed(val value: EncryptedUploadV2CompletedTransferValue) :
        EncryptedUploadV2TransferReceiverEvent
}

internal class EncryptedUploadV2TransferReceiverException(message: String) :
    EncryptedUploadV2HostException(18u, false, message = message)

internal class EncryptedUploadV2TransferReceiver(
    rootDirectory: Path,
    sinkId: String,
    private val transportSessionId: ULong,
    private val expectedCiphertextLength: ULong,
    expectedCiphertextSha256: ByteArray,
    private val maximumDataPayloadBytes: UShort,
    private val maximumWindowPackets: UShort,
    private val maximumMissingSequences: UShort,
    checkpoint: EncryptedUploadV2CheckpointValue,
) {
    private data class PacketMetadata(val offset: ULong, val length: ULong, val sha256: ByteArray) {
        val endOffset: ULong get() = offset + length
    }

    private data class PendingWindow(
        val value: EncryptedUploadV2WindowEndValue,
        val checkpoint: EncryptedUploadV2CheckpointValue,
        val missingSequences: List<UInt>,
        val highestContiguousSequence: UInt,
        val contiguousOffset: ULong,
        val contiguousSha256: ByteArray,
        var checkpointPersisted: Boolean = false,
    )

    val file: Path = rootDirectory.resolve("$sinkId.encrypted-upload-v2")
    private val expectedCiphertextSha256 = expectedCiphertextSha256.copyOf()
    private var checkpoint = checkpoint.copy(prefixSha256 = checkpoint.prefixSha256.copyOf())
    private val packets = mutableMapOf<UInt, PacketMetadata>()
    private var pendingWindow: PendingWindow? = null
    private val manifest = ByteArray(ManifestLength)
    private val manifestPresent = BooleanArray(ManifestLength)
    private var manifestSha256: ByteArray? = null
    private var prepared = false
    private var terminal = false
    private var completed = false

    init {
        requireValid(
            runCatching { java.util.UUID.fromString(sinkId) }.isSuccess &&
                transportSessionId != 0uL && expectedCiphertextLength > 0uL &&
                expectedCiphertextLength <= Long.MAX_VALUE.toULong() &&
                expectedCiphertextSha256.size == 32 && maximumDataPayloadBytes > 0u &&
                maximumWindowPackets > 0u && maximumMissingSequences > 0u &&
                checkpoint.nextCiphertextOffset <= expectedCiphertextLength &&
                checkpoint.prefixSha256.size == 32 &&
                ((checkpoint.nextCiphertextOffset == 0uL) == (checkpoint.highestContiguousSequence == null)),
            "invalid receiver configuration",
        )
    }

    @Synchronized
    fun prepare() {
        file.parent?.let(Files::createDirectories)
        if (!Files.exists(file)) {
            requireValid(checkpoint.nextCiphertextOffset == 0uL, "resume sink is missing")
            Files.createFile(file)
        }
        FileChannel.open(file, StandardOpenOption.READ, StandardOpenOption.WRITE).use { channel ->
            requireValid(channel.size().toULong() >= checkpoint.nextCiphertextOffset, "resume sink is truncated")
            channel.truncate(checkpoint.nextCiphertextOffset.toLong())
            channel.force(true)
        }
        requireValid(secureEqual(sha256Prefix(checkpoint.nextCiphertextOffset), checkpoint.prefixSha256), "resume prefix mismatch")
        prepared = true
    }

    @Synchronized
    fun receive(payload: EncryptedUploadV2TransferPayload): EncryptedUploadV2TransferReceiverEvent? {
        requireValid(prepared && !terminal && !completed, "receiver is not active")
        val session = when (payload) {
            is EncryptedUploadV2TransferPayload.Data -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.WindowEnd -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.ManifestChunk -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.Eof -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.Error -> payload.value.transportSessionId
        }
        try {
            requireValid(session == transportSessionId, "transport session mismatch")
            return when (payload) {
                is EncryptedUploadV2TransferPayload.Data -> receiveData(payload.value).let { null }
                is EncryptedUploadV2TransferPayload.WindowEnd ->
                    EncryptedUploadV2TransferReceiverEvent.WindowStaged(receiveWindowEnd(payload.value))
                is EncryptedUploadV2TransferPayload.ManifestChunk -> receiveManifest(payload.value).let { null }
                is EncryptedUploadV2TransferPayload.Eof -> {
                    val result = receiveEof(payload.value)
                    completed = true
                    EncryptedUploadV2TransferReceiverEvent.Completed(result)
                }
                is EncryptedUploadV2TransferPayload.Error -> fail("device transfer error ${payload.value.result}")
            }
        } catch (error: Throwable) {
            terminal = true
            throw error
        }
    }

    @Synchronized
    fun repairAcknowledgement(missingSequences: List<UInt>): EncryptedUploadV2WindowAcknowledgement {
        val pending = pendingWindow ?: fail("no pending window")
        requireValid(pending.missingSequences.isNotEmpty() && pending.missingSequences == missingSequences, "repair mismatch")
        return acknowledgement(pending, pending.highestContiguousSequence, pending.contiguousOffset, pending.contiguousSha256, checkpoint.revision, missingSequences)
    }

    @Synchronized
    fun checkpointDidPersist(value: EncryptedUploadV2CheckpointValue) {
        val pending = pendingWindow ?: fail("no pending window")
        requireValid(pending.missingSequences.isEmpty() && sameCheckpoint(pending.checkpoint, value), "checkpoint mismatch")
        pending.checkpointPersisted = true
    }

    @Synchronized
    fun windowAcknowledgement(value: EncryptedUploadV2CheckpointValue): EncryptedUploadV2WindowAcknowledgement {
        val pending = pendingWindow ?: fail("no pending window")
        requireValid(pending.missingSequences.isEmpty() && sameCheckpoint(pending.checkpoint, value), "checkpoint mismatch")
        requireValid(pending.checkpointPersisted, "checkpoint was not persisted")
        val ack = acknowledgement(
            pending, pending.value.lastSequence, value.nextCiphertextOffset,
            value.prefixSha256, value.revision, emptyList(),
        )
        checkpoint = value.copy(prefixSha256 = value.prefixSha256.copyOf())
        packets.clear()
        pendingWindow = null
        return ack
    }

    private fun receiveData(value: EncryptedUploadV2DataValue) {
        val end = value.ciphertextOffset + value.bytes.size.toULong()
        val repair = pendingWindow?.missingSequences
        requireValid(
            pendingWindow?.missingSequences?.isEmpty() != true && value.bytes.isNotEmpty() &&
                (repair == null || value.sequence in repair) &&
                value.bytes.size <= maximumDataPayloadBytes.toInt() &&
                value.ciphertextOffset >= checkpoint.nextCiphertextOffset && end >= value.ciphertextOffset &&
                end <= expectedCiphertextLength,
            if (repair == null) "data payload is outside negotiated bounds"
            else "data payload does not belong to the pending repair",
        )
        val metadata = PacketMetadata(value.ciphertextOffset, value.bytes.size.toULong(), sha256(value.bytes))
        packets[value.sequence]?.let { existing ->
            requireValid(
                existing.offset == metadata.offset && existing.length == metadata.length &&
                    secureEqual(existing.sha256, metadata.sha256),
                "conflicting packet",
            )
            return
        }
        requireValid(
            packets.size < maximumWindowPackets.toInt() && packets.values.none { overlaps(it, metadata) },
            "packet window conflict",
        )
        FileChannel.open(file, StandardOpenOption.WRITE).use { channel ->
            channel.position(value.ciphertextOffset.toLong())
            val buffer = ByteBuffer.wrap(value.bytes)
            while (buffer.hasRemaining()) channel.write(buffer)
            channel.force(true)
        }
        packets[value.sequence] = metadata
    }

    private fun receiveWindowEnd(value: EncryptedUploadV2WindowEndValue): EncryptedUploadV2WindowStageValue {
        val previous = checkpoint.highestContiguousSequence
        val follows = previous?.let { it != UInt.MAX_VALUE && value.firstSequence == it + 1u } ?: true
        val span = value.lastSequence.toULong() - value.firstSequence.toULong()
        requireValid(
            value.firstSequence <= value.lastSequence && follows && value.checkpointRevision > checkpoint.revision &&
                value.nextCiphertextOffset > checkpoint.nextCiphertextOffset &&
                value.nextCiphertextOffset <= expectedCiphertextLength && value.prefixSha256.size == 32 &&
                span < maximumWindowPackets.toULong() && packets.keys.all { it in value.firstSequence..value.lastSequence },
            "malformed window",
        )
        val missing = (value.firstSequence..value.lastSequence).filterNot(packets::containsKey)
        requireValid(missing.size <= maximumMissingSequences.toInt(), "too many missing sequences")
        var contiguousOffset = checkpoint.nextCiphertextOffset
        var highest = if (value.firstSequence == 0u) 0u else value.firstSequence - 1u
        for (sequence in value.firstSequence..value.lastSequence) {
            val packet = packets[sequence] ?: break
            requireValid(packet.offset == contiguousOffset, "non-contiguous window")
            contiguousOffset = packet.endOffset
            highest = sequence
        }
        val contiguousSha = sha256Prefix(contiguousOffset)
        val candidate = EncryptedUploadV2CheckpointValue(
            value.checkpointRevision, value.nextCiphertextOffset, value.prefixSha256.copyOf(), value.lastSequence,
        )
        if (missing.isEmpty()) {
            requireValid(
                contiguousOffset == value.nextCiphertextOffset && secureEqual(contiguousSha, value.prefixSha256),
                "window prefix mismatch",
            )
        }
        pendingWindow = PendingWindow(value, candidate, missing, highest, contiguousOffset, contiguousSha)
        return EncryptedUploadV2WindowStageValue(candidate, missing)
    }

    private fun receiveManifest(value: EncryptedUploadV2ManifestChunkValue) {
        val end = value.chunkOffset.toInt() + value.bytes.size
        requireValid(
            pendingWindow == null && value.totalManifestLength.toInt() == ManifestLength &&
                value.manifestSha256.size == 32 && value.bytes.isNotEmpty() && end <= ManifestLength &&
                (manifestSha256 == null || secureEqual(manifestSha256!!, value.manifestSha256)),
            "manifest conflict",
        )
        value.bytes.forEachIndexed { relative, byte ->
            val index = value.chunkOffset.toInt() + relative
            requireValid(!manifestPresent[index] || manifest[index] == byte, "manifest conflict")
            manifest[index] = byte
            manifestPresent[index] = true
        }
        manifestSha256 = value.manifestSha256.copyOf()
    }

    private fun receiveEof(value: EncryptedUploadV2EofValue): EncryptedUploadV2CompletedTransferValue {
        requireValid(
            pendingWindow == null && packets.isEmpty() && checkpoint.highestContiguousSequence == value.finalSequence &&
                value.blockCount > 0u && value.ciphertextLength == expectedCiphertextLength &&
                secureEqual(value.ciphertextSha256, expectedCiphertextSha256) &&
                manifestSha256?.let { secureEqual(it, value.manifestSha256) } == true &&
                manifestPresent.all { it } && secureEqual(sha256(manifest), value.manifestSha256) &&
                Files.size(file).toULong() == expectedCiphertextLength &&
                secureEqual(sha256Prefix(expectedCiphertextLength), expectedCiphertextSha256),
            "EOF integrity mismatch",
        )
        return EncryptedUploadV2CompletedTransferValue(
            file,
            manifest.copyOf(),
            EncryptedUploadV2TransferEvidence(
                value.ciphertextLength, value.ciphertextSha256, ManifestLength.toUShort(),
                value.manifestSha256, value.blockCount,
            ),
        )
    }

    private fun acknowledgement(
        pending: PendingWindow,
        highest: UInt,
        offset: ULong,
        prefix: ByteArray,
        revision: UInt,
        missing: List<UInt>,
    ) = EncryptedUploadV2WindowAcknowledgement(
        transportSessionId, pending.value.windowIndex, highest, offset, prefix.copyOf(), revision, missing,
    )

    private fun sha256Prefix(length: ULong): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        FileChannel.open(file, StandardOpenOption.READ).use { channel ->
            var remaining = length.toLong()
            val buffer = ByteBuffer.allocate(minOf(64 * 1024L, maxOf(1L, remaining)).toInt())
            while (remaining > 0) {
                buffer.clear()
                buffer.limit(minOf(buffer.capacity().toLong(), remaining).toInt())
                val read = channel.read(buffer)
                requireValid(read > 0, "ciphertext prefix is truncated")
                digest.update(buffer.array(), 0, read)
                remaining -= read
            }
        }
        return digest.digest()
    }

    private fun sameCheckpoint(left: EncryptedUploadV2CheckpointValue, right: EncryptedUploadV2CheckpointValue) =
        left.revision == right.revision && left.nextCiphertextOffset == right.nextCiphertextOffset &&
            left.highestContiguousSequence == right.highestContiguousSequence &&
            secureEqual(left.prefixSha256, right.prefixSha256)

    private fun overlaps(left: PacketMetadata, right: PacketMetadata) =
        left.offset < right.endOffset && right.offset < left.endOffset

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun secureEqual(left: ByteArray, right: ByteArray): Boolean = MessageDigest.isEqual(left, right)

    private fun requireValid(condition: Boolean, detail: String) {
        if (!condition) fail(detail)
    }

    private fun fail(detail: String): Nothing = throw EncryptedUploadV2TransferReceiverException(detail)

    private companion object {
        const val ManifestLength = 580
    }
}
