package dev.bota.sdk.internal.host

import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2CheckpointStoreTest {
    @Test
    fun persistsExactResumeMetadataAndIndexesOnlyNonSecretIdentity() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val session = UUID.randomUUID()
        val checkpoint = PersistedEncryptedUploadV2Checkpoint(
            byteArrayOf(1, 2, 3), "EVFXXW67KP", "00112233445566778899aabbccddeeff", 4u,
            session, 7u, 9u, UUID.randomUUID().toString(), 18u, 157u,
            2u, 2048u, ByteArray(32) { 0x5a }, 22u,
        )

        store.save(checkpoint)
        assertEquals(1, journals.values.size)
        val recovered = store.loadForRecording(checkpoint.serialNumber, checkpoint.recordingUuid, 4u)!!

        assertEquals(checkpoint.uploadSessionId, recovered.uploadSessionId)
        assertEquals(checkpoint.transportSessionId, recovered.transportSessionId)
        assertEquals(checkpoint.sinkId, recovered.sinkId)
        assertTrue(checkpoint.coreCheckpoint.contentEquals(recovered.coreCheckpoint))
        assertTrue(journals.values.keys.all { "EVFXXW67KP" !in it && checkpoint.recordingUuid !in it })

        store.delete(session)
        assertNull(store.loadForRecording(checkpoint.serialNumber, checkpoint.recordingUuid, 4u))
        assertEquals(setOf(CatalogName), journals.values.keys)
    }

    @Test
    fun rejectsOversizedOrMalformedSidecars() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val session = UUID.randomUUID()
        journals.values["encrypted-upload-v2-checkpoints.catalog"] = ByteArray(4 * 1024 * 1024 + 1)

        assertThrows(EncryptedUploadV2HostException::class.java) { kotlinx.coroutines.runBlocking { store.load(session) } }
    }

    @Test
    fun failedCatalogReplacementLeavesThePriorCheckpointRecoverable() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val session = UUID.randomUUID()
        val first = checkpoint(session, revision = 1u)
        store.save(first)
        journals.failNextWrite = true

        assertThrows(IllegalStateException::class.java) {
            kotlinx.coroutines.runBlocking { store.save(checkpoint(session, revision = 2u)) }
        }

        assertEquals(1u, store.load(session)!!.revision)
        assertEquals(1u, store.loadForRecording(first.serialNumber, first.recordingUuid, 4u)!!.revision)
    }

    @Test
    fun migratesLegacyCheckpointAndIdentityIndexIntoTheAtomicCatalog() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val checkpoint = checkpoint(UUID.randomUUID(), revision = 3u)
        store.save(checkpoint)
        val legacySidecar = firstCatalogSidecar(journals.values.getValue(CatalogName))
        journals.values.clear()
        journals.values[legacyName(checkpoint.uploadSessionId)] = legacySidecar
        journals.values[legacyIndexName(checkpoint)] = ByteBuffer.allocate(16)
            .putLong(checkpoint.uploadSessionId.mostSignificantBits)
            .putLong(checkpoint.uploadSessionId.leastSignificantBits)
            .array()

        val recovered = store.loadForRecording(
            checkpoint.serialNumber,
            checkpoint.recordingUuid,
            checkpoint.recordingGeneration,
        )

        assertEquals(checkpoint.uploadSessionId, recovered?.uploadSessionId)
        assertEquals(setOf(CatalogName), journals.values.keys)
    }

    @Test
    fun staleLegacyIndexAfterCheckpointDeletionIsReconciledInsteadOfFailingResume() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val checkpoint = checkpoint(UUID.randomUUID(), revision = 3u)
        val index = legacyIndexName(checkpoint)
        journals.values[index] = ByteBuffer.allocate(16)
            .putLong(checkpoint.uploadSessionId.mostSignificantBits)
            .putLong(checkpoint.uploadSessionId.leastSignificantBits)
            .array()

        assertNull(store.loadForRecording(
            checkpoint.serialNumber,
            checkpoint.recordingUuid,
            checkpoint.recordingGeneration,
        ))
        assertTrue(index !in journals.values)
    }

    @Test
    fun interruptedLegacyMigrationLeavesTheLegacyPairRecoverable() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val checkpoint = checkpoint(UUID.randomUUID(), revision = 4u)
        store.save(checkpoint)
        val sidecar = firstCatalogSidecar(journals.values.getValue(CatalogName))
        val index = legacyIndexName(checkpoint)
        journals.values.clear()
        journals.values[legacyName(checkpoint.uploadSessionId)] = sidecar
        journals.values[index] = ByteBuffer.allocate(16)
            .putLong(checkpoint.uploadSessionId.mostSignificantBits)
            .putLong(checkpoint.uploadSessionId.leastSignificantBits)
            .array()
        journals.failNextWrite = true

        assertThrows(IllegalStateException::class.java) {
            kotlinx.coroutines.runBlocking {
                store.loadForRecording(checkpoint.serialNumber, checkpoint.recordingUuid, checkpoint.recordingGeneration)
            }
        }
        assertTrue(legacyName(checkpoint.uploadSessionId) in journals.values)
        assertTrue(index in journals.values)
        assertEquals(checkpoint.uploadSessionId, store.load(checkpoint.uploadSessionId)?.uploadSessionId)
    }

    @Test
    fun deleteReconcilesALegacyPairBeforeItWasLoaded() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val checkpoint = checkpoint(UUID.randomUUID(), revision = 5u)
        store.save(checkpoint)
        val sidecar = firstCatalogSidecar(journals.values.getValue(CatalogName))
        journals.values.clear()
        journals.values[legacyName(checkpoint.uploadSessionId)] = sidecar
        journals.values[legacyIndexName(checkpoint)] = ByteBuffer.allocate(16)
            .putLong(checkpoint.uploadSessionId.mostSignificantBits)
            .putLong(checkpoint.uploadSessionId.leastSignificantBits)
            .array()

        store.delete(checkpoint.uploadSessionId)

        assertNull(store.load(checkpoint.uploadSessionId))
        assertNull(store.loadForRecording(
            checkpoint.serialNumber,
            checkpoint.recordingUuid,
            checkpoint.recordingGeneration,
        ))
        assertEquals(setOf(CatalogName), journals.values.keys)
    }

    @Test
    fun firstUpgradeAtomicallyMigratesEveryLegacyCheckpoint() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val first = checkpoint(UUID.randomUUID(), revision = 6u)
        store.save(first)
        val firstSidecar = firstCatalogSidecar(journals.values.getValue(CatalogName))
        journals.values.clear()
        val second = checkpoint(UUID.randomUUID(), revision = 7u).copy(
            recordingUuid = "112233445566778899aabbccddeeff00",
        )
        store.save(second)
        val secondSidecar = firstCatalogSidecar(journals.values.getValue(CatalogName))
        journals.values.clear()
        listOf(first to firstSidecar, second to secondSidecar).forEach { (checkpoint, sidecar) ->
            journals.values[legacyName(checkpoint.uploadSessionId)] = sidecar
            journals.values[legacyIndexName(checkpoint)] = ByteBuffer.allocate(16)
                .putLong(checkpoint.uploadSessionId.mostSignificantBits)
                .putLong(checkpoint.uploadSessionId.leastSignificantBits)
                .array()
        }

        assertEquals(first.uploadSessionId, store.load(first.uploadSessionId)?.uploadSessionId)
        assertEquals(
            second.uploadSessionId,
            store.loadForRecording(second.serialNumber, second.recordingUuid, second.recordingGeneration)
                ?.uploadSessionId,
        )
        assertEquals(setOf(CatalogName), journals.values.keys)
    }

    private fun firstCatalogSidecar(catalog: ByteArray): ByteArray =
        DataInputStream(ByteArrayInputStream(catalog)).use { input ->
            input.readInt()
            input.readInt()
            assertEquals(1, input.readInt())
            ByteArray(input.readInt()).also(input::readFully)
        }

    private fun legacyName(session: UUID) = "encrypted-upload-v2-$session.checkpoint"

    private fun legacyIndexName(value: PersistedEncryptedUploadV2Checkpoint): String {
        val identity = "${value.serialNumber}\u0000${normalize(value.recordingUuid)}\u0000${value.recordingGeneration}"
            .encodeToByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
        return "encrypted-upload-v2-$digest.index"
    }

    private fun normalize(value: String): String {
        val compact = value.replace("-", "")
        return if (compact.length == 32) {
            UUID.fromString(
                "${compact.substring(0, 8)}-${compact.substring(8, 12)}-${compact.substring(12, 16)}-" +
                    "${compact.substring(16, 20)}-${compact.substring(20)}",
            ).toString()
        } else value.lowercase()
    }

    private fun checkpoint(session: UUID, revision: UInt) = PersistedEncryptedUploadV2Checkpoint(
        byteArrayOf(1, 2, 3), "EVFXXW67KP", "00112233445566778899aabbccddeeff", 4u,
        session, 7u, 9u, UUID.randomUUID().toString(), 18u, 157u,
        revision, 2048u, ByteArray(32) { 0x5a }, 22u,
    )

    private companion object {
        const val CatalogName = "encrypted-upload-v2-checkpoints.catalog"
    }
}

private class MemoryJournals : JournalStore {
    val values = mutableMapOf<String, ByteArray>()
    var failNextWrite = false
    override suspend fun read(name: String): ByteArray? = values[name]?.copyOf()
    override suspend fun write(name: String, value: ByteArray) {
        if (failNextWrite) {
            failNextWrite = false
            throw IllegalStateException("simulated atomic replacement failure")
        }
        values[name] = value.copyOf()
    }
    override suspend fun delete(name: String) { values.remove(name) }
    override suspend fun names(): Set<String> = values.keys.toSet()
}
