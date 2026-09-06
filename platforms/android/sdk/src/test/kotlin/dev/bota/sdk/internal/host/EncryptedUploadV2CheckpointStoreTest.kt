package dev.bota.sdk.internal.host

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
        assertTrue(journals.values.isEmpty())
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

    private fun checkpoint(session: UUID, revision: UInt) = PersistedEncryptedUploadV2Checkpoint(
        byteArrayOf(1, 2, 3), "EVFXXW67KP", "00112233445566778899aabbccddeeff", 4u,
        session, 7u, 9u, UUID.randomUUID().toString(), 18u, 157u,
        revision, 2048u, ByteArray(32) { 0x5a }, 22u,
    )
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
}
