package dev.bota.sdk.internal.host

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
    private val mutex = Mutex()

    suspend fun load(uploadSessionId: UUID): PersistedEncryptedUploadV2Checkpoint? = mutex.withLock {
        loadCatalog().firstOrNull { it.uploadSessionId == uploadSessionId }
    }

    suspend fun loadForRecording(
        serialNumber: String,
        recordingUuid: String,
        recordingGeneration: UInt,
    ): PersistedEncryptedUploadV2Checkpoint? = mutex.withLock {
        val current = loadCatalog().firstOrNull {
            it.serialNumber == serialNumber &&
                normalizeRecordingUuid(it.recordingUuid) == normalizeRecordingUuid(recordingUuid) &&
                it.recordingGeneration == recordingGeneration
        }
        if (current != null) return@withLock current
        val index = legacyIndexName(serialNumber, recordingUuid, recordingGeneration)
        val pointer = journals.read(index) ?: return@withLock null
        if (pointer.size == 16) {
            val input = DataInputStream(ByteArrayInputStream(pointer))
            journals.delete(legacyName(UUID(input.readLong(), input.readLong())))
        }
        journals.delete(index)
        null
    }

    suspend fun save(value: PersistedEncryptedUploadV2Checkpoint) = mutex.withLock {
        val values = loadCatalog().filterNot {
            it.uploadSessionId == value.uploadSessionId ||
                (it.serialNumber == value.serialNumber &&
                    normalizeRecordingUuid(it.recordingUuid) == normalizeRecordingUuid(value.recordingUuid) &&
                    it.recordingGeneration == value.recordingGeneration)
        } + value
        if (values.size > MaximumCatalogEntries) invalid("checkpoint catalog has too many entries")
        journals.write(CatalogName, encodeCatalog(values))
    }

    suspend fun delete(uploadSessionId: UUID) = mutex.withLock {
        val values = loadCatalog()
        val retained = values.filterNot { it.uploadSessionId == uploadSessionId }
        if (retained.size == values.size) return@withLock
        journals.write(CatalogName, encodeCatalog(retained))
    }

    private suspend fun loadCatalog(): List<PersistedEncryptedUploadV2Checkpoint> =
        mergeLegacyCatalog(readCatalog().orEmpty())

    private suspend fun readCatalog(): List<PersistedEncryptedUploadV2Checkpoint>? =
        journals.read(CatalogName)?.let(::decodeCatalog)

    private suspend fun mergeLegacyCatalog(
        existing: List<PersistedEncryptedUploadV2Checkpoint>,
    ): List<PersistedEncryptedUploadV2Checkpoint> {
        val storedNames = journals.names()
        val names = storedNames + storedNames.filter { it.endsWith(".bak") }.map { it.removeSuffix(".bak") }
        val legacyNames = names.filter { LegacyName.matches(it) }.sorted()
        if (legacyNames.isEmpty()) return existing
        val indexNames = legacyNames.filter { it.endsWith(".index") }
        if (indexNames.size > MaximumCatalogEntries) invalid("legacy checkpoint index has too many entries")
        val legacyValues = indexNames.mapNotNull { indexName ->
            val pointer = journals.read(indexName) ?: return@mapNotNull null
            if (pointer.size != 16) return@mapNotNull null
            val input = DataInputStream(ByteArrayInputStream(pointer))
            val id = UUID(input.readLong(), input.readLong())
            val sidecar = journals.read(legacyName(id)) ?: return@mapNotNull null
            runCatching { decode(sidecar) }.getOrNull()?.takeIf { value ->
                value.uploadSessionId == id &&
                    legacyIndexName(value.serialNumber, value.recordingUuid, value.recordingGeneration) == indexName
            }
        }
        validateCatalogIdentities(legacyValues)
        val values = legacyValues.fold(existing) { values, candidate ->
            if (values.any {
                    it.uploadSessionId == candidate.uploadSessionId ||
                        (it.serialNumber == candidate.serialNumber &&
                            normalizeRecordingUuid(it.recordingUuid) == normalizeRecordingUuid(candidate.recordingUuid) &&
                            it.recordingGeneration == candidate.recordingGeneration)
                }
            ) values else values + candidate
        }
        if (values.size > MaximumCatalogEntries) invalid("checkpoint catalog has too many entries")
        validateCatalogIdentities(values)
        journals.write(CatalogName, encodeCatalog(values))
        legacyNames.forEach { journals.delete(it) }
        return values
    }

    private fun legacyName(id: UUID): String = "encrypted-upload-v2-$id.checkpoint"

    private fun legacyIndexName(serialNumber: String, recordingUuid: String, generation: UInt): String {
        val identity = "$serialNumber\u0000${normalizeRecordingUuid(recordingUuid)}\u0000$generation".encodeToByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
        return "encrypted-upload-v2-$digest.index"
    }

    private fun encodeCatalog(values: List<PersistedEncryptedUploadV2Checkpoint>): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(CatalogMagic)
                output.writeInt(CatalogVersion)
                output.writeInt(values.size)
                values.forEach { output.writeBounded(encode(it), MaximumSidecarBytes) }
            }
            bytes.toByteArray().also {
                if (it.size > MaximumCatalogBytes) invalid("checkpoint catalog is oversized")
            }
        }

    private fun decodeCatalog(value: ByteArray): List<PersistedEncryptedUploadV2Checkpoint> {
        if (value.size > MaximumCatalogBytes) invalid("checkpoint catalog is oversized")
        return DataInputStream(ByteArrayInputStream(value)).use { input ->
            if (input.readInt() != CatalogMagic || input.readInt() != CatalogVersion) {
                invalid("checkpoint catalog header is invalid")
            }
            val count = input.readInt()
            if (count !in 0..MaximumCatalogEntries) invalid("checkpoint catalog count is invalid")
            List(count) { decode(input.readBounded(MaximumSidecarBytes)) }.also {
                if (input.available() != 0 || it.map(PersistedEncryptedUploadV2Checkpoint::uploadSessionId).distinct().size != it.size) {
                    invalid("checkpoint catalog payload is invalid")
                }
                validateCatalogIdentities(it)
            }
        }
    }

    private fun validateCatalogIdentities(values: List<PersistedEncryptedUploadV2Checkpoint>) {
        val identities = values.map {
            Triple(it.serialNumber, normalizeRecordingUuid(it.recordingUuid), it.recordingGeneration)
        }
        if (identities.distinct().size != identities.size) invalid("checkpoint catalog recording identity is duplicated")
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
        const val CatalogName = "encrypted-upload-v2-checkpoints.catalog"
        const val CatalogMagic = 0x4256324c
        const val CatalogVersion = 1
        const val MaximumCatalogEntries = 64
        const val MaximumCatalogBytes = 4 * 1024 * 1024
        const val Magic = 0x42563243
        const val Version = 1
        const val DigestBytes = 32
        const val MaximumIdentifierBytes = 128
        const val MaximumCoreCheckpointBytes = 32 * 1024
        const val MaximumSidecarBytes = 65_536
        val LegacyName = Regex("encrypted-upload-v2-[0-9a-fA-F-]{36}\\.checkpoint|encrypted-upload-v2-[0-9a-f]{64}\\.index")
    }
}
