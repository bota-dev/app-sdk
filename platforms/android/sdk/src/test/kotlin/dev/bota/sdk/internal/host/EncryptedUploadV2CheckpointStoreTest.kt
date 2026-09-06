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
        val recovered = store.loadForRecording(checkpoint.serialNumber, checkpoint.recordingUuid, 4u)!!

        assertEquals(checkpoint.uploadSessionId, recovered.uploadSessionId)
        assertEquals(checkpoint.transportSessionId, recovered.transportSessionId)
        assertEquals(checkpoint.sinkId, recovered.sinkId)
        assertTrue(checkpoint.coreCheckpoint.contentEquals(recovered.coreCheckpoint))
        assertTrue(journals.values.keys.all { "EVFXXW67KP" !in it && checkpoint.recordingUuid !in it })

        store.delete(session)
        assertNull(store.loadForRecording(checkpoint.serialNumber, checkpoint.recordingUuid, 4u))
    }

    @Test
    fun rejectsOversizedOrMalformedSidecars() = runTest {
        val journals = MemoryJournals()
        val store = EncryptedUploadV2CheckpointStore(journals)
        val session = UUID.randomUUID()
        journals.values["encrypted-upload-v2-$session.checkpoint"] = ByteArray(65_537)

        assertThrows(EncryptedUploadV2HostException::class.java) { kotlinx.coroutines.runBlocking { store.load(session) } }
    }
}

private class MemoryJournals : JournalStore {
    val values = mutableMapOf<String, ByteArray>()
    override suspend fun read(name: String): ByteArray? = values[name]?.copyOf()
    override suspend fun write(name: String, value: ByteArray) { values[name] = value.copyOf() }
    override suspend fun delete(name: String) { values.remove(name) }
}
