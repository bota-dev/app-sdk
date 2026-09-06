package dev.bota.sdk.internal.host

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.util.UUID
import java.security.MessageDigest

internal data class PersistedEncryptedUploadV2Checkpoint(
    val coreCheckpoint: ByteArray,
    val serialNumber: String,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val uploadSessionId: UUID,
    val ownerRevision: UInt,
    val transportSessionId: ULong,
    val sinkId: String,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
    val revision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val highestContiguousSequence: UInt?,
)

internal class EncryptedUploadV2CheckpointStore(private val journals: JournalStore) {
    suspend fun load(uploadSessionId: UUID): PersistedEncryptedUploadV2Checkpoint? =
        journals.read(name(uploadSessionId))?.let(::decode)

    suspend fun loadForRecording(
        serialNumber: String,
        recordingUuid: String,
        recordingGeneration: UInt,
    ): PersistedEncryptedUploadV2Checkpoint? {
        val pointer = journals.read(indexName(serialNumber, recordingUuid, recordingGeneration)) ?: return null
        if (pointer.size != 16) invalid("checkpoint identity index is invalid")
        val input = DataInputStream(ByteArrayInputStream(pointer))
        val value = load(UUID(input.readLong(), input.readLong())) ?: invalid("checkpoint identity index is stale")
        if (value.serialNumber != serialNumber || normalizeRecordingUuid(value.recordingUuid) != normalizeRecordingUuid(recordingUuid) ||
            value.recordingGeneration != recordingGeneration
        ) invalid("checkpoint recording identity is stale")
        return value
    }

    suspend fun save(value: PersistedEncryptedUploadV2Checkpoint) {
        journals.write(name(value.uploadSessionId), encode(value))
        val pointer = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeLong(value.uploadSessionId.mostSignificantBits)
                output.writeLong(value.uploadSessionId.leastSignificantBits)
            }
            bytes.toByteArray()
        }
        journals.write(indexName(value.serialNumber, value.recordingUuid, value.recordingGeneration), pointer)
    }

    suspend fun delete(uploadSessionId: UUID) {
        val value = load(uploadSessionId)
        journals.delete(name(uploadSessionId))
        if (value != null) {
            journals.delete(indexName(value.serialNumber, value.recordingUuid, value.recordingGeneration))
        }
    }

    private fun name(id: UUID): String = "encrypted-upload-v2-${id}.checkpoint"

    private fun indexName(serialNumber: String, recordingUuid: String, generation: UInt): String {
        val identity = "$serialNumber\u0000${normalizeRecordingUuid(recordingUuid)}\u0000$generation".encodeToByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
        return "encrypted-upload-v2-$digest.index"
    }

    private fun encode(value: PersistedEncryptedUploadV2Checkpoint): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(Magic)
                output.writeInt(Version)
                output.writeBounded(value.coreCheckpoint, MaximumCoreCheckpointBytes)
                output.writeBounded(value.serialNumber.encodeToByteArray(), MaximumIdentifierBytes)
                output.writeBounded(value.recordingUuid.encodeToByteArray(), MaximumIdentifierBytes)
                output.writeInt(value.recordingGeneration.toInt())
                output.writeLong(value.uploadSessionId.mostSignificantBits)
                output.writeLong(value.uploadSessionId.leastSignificantBits)
                output.writeInt(value.ownerRevision.toInt())
                output.writeLong(value.transportSessionId.toLong())
                output.writeBounded(value.sinkId.encodeToByteArray(), MaximumIdentifierBytes)
                output.writeShort(value.windowPackets.toInt())
                output.writeShort(value.dataPayloadBytes.toInt())
                output.writeInt(value.revision.toInt())
                output.writeLong(value.nextCiphertextOffset.toLong())
                output.writeBounded(value.prefixSha256, DigestBytes)
                output.writeBoolean(value.highestContiguousSequence != null)
                value.highestContiguousSequence?.let { output.writeInt(it.toInt()) }
            }
            bytes.toByteArray()
        }

    private fun decode(value: ByteArray): PersistedEncryptedUploadV2Checkpoint {
        if (value.size > MaximumSidecarBytes) invalid("checkpoint sidecar is oversized")
        return DataInputStream(ByteArrayInputStream(value)).use { input ->
            if (input.readInt() != Magic || input.readInt() != Version) invalid("checkpoint sidecar header is invalid")
            val decoded = PersistedEncryptedUploadV2Checkpoint(
                coreCheckpoint = input.readBounded(MaximumCoreCheckpointBytes),
                serialNumber = input.readBounded(MaximumIdentifierBytes).decodeToString(),
                recordingUuid = input.readBounded(MaximumIdentifierBytes).decodeToString(),
                recordingGeneration = input.readInt().toUInt(),
                uploadSessionId = UUID(input.readLong(), input.readLong()),
                ownerRevision = input.readInt().toUInt(),
                transportSessionId = input.readLong().toULong(),
                sinkId = input.readBounded(MaximumIdentifierBytes).decodeToString(),
                windowPackets = input.readUnsignedShort().toUShort(),
                dataPayloadBytes = input.readUnsignedShort().toUShort(),
                revision = input.readInt().toUInt(),
                nextCiphertextOffset = input.readLong().toULong(),
                prefixSha256 = input.readBounded(DigestBytes),
                highestContiguousSequence = if (input.readBoolean()) input.readInt().toUInt() else null,
            )
            if (input.available() != 0 || decoded.prefixSha256.size != DigestBytes) {
                invalid("checkpoint sidecar payload is invalid")
            }
            decoded
        }
    }

    private fun DataOutputStream.writeBounded(value: ByteArray, maximum: Int) {
        if (value.size > maximum) invalid("checkpoint field is oversized")
        writeInt(value.size)
        write(value)
    }

    private fun DataInputStream.readBounded(maximum: Int): ByteArray {
        val length = readInt()
        if (length < 0 || length > maximum || length > available()) invalid("checkpoint field length is invalid")
        return ByteArray(length).also(::readFully)
    }

    private fun invalid(detail: String): Nothing = throw EncryptedUploadV2HostException(11u, false, message = detail)

    private fun normalizeRecordingUuid(value: String): String {
        val compact = value.replace("-", "")
        if (compact.length != 32) return value.lowercase()
        val canonical = "${compact.substring(0, 8)}-${compact.substring(8, 12)}-${compact.substring(12, 16)}-" +
            "${compact.substring(16, 20)}-${compact.substring(20)}"
        return runCatching { UUID.fromString(canonical).toString() }.getOrDefault(value.lowercase())
    }

    private companion object {
        const val Magic = 0x42563243
        const val Version = 1
        const val DigestBytes = 32
        const val MaximumIdentifierBytes = 128
        const val MaximumCoreCheckpointBytes = 32 * 1024
        const val MaximumSidecarBytes = 65_536
    }
}
