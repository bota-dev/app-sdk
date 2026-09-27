package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.EncryptedUploadV2DataValue
import dev.bota.sdk.internal.core.EncryptedUploadV2EofValue
import dev.bota.sdk.internal.core.EncryptedUploadV2ManifestChunkValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.core.EncryptedUploadV2WindowEndValue
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2TransferReceiverTest {
    @Test
    fun repairsAWindowBeforePersistingAndAcknowledgingTheCleanCheckpoint() {
        val root = Files.createTempDirectory("bota-v2-receiver")
        val ciphertext = "abcdef".encodeToByteArray()
        val receiver = receiver(root, ciphertext, maximumWindowPackets = 3u, maximumMissing = 3u)
        receiver.prepare()
        receiver.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 0u, 0u, "ab".encodeToByteArray())))
        receiver.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 2u, 4u, "ef".encodeToByteArray())))

        val missing = receiver.receive(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 2u, 6u, sha(ciphertext), 1u),
            ),
        ) as EncryptedUploadV2TransferReceiverEvent.WindowStaged
        assertEquals(listOf(1u), missing.value.missingSequences)
        assertEquals(listOf(1u), receiver.repairAcknowledgement(listOf(1u)).missingSequences)

        receiver.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 1u, 2u, "cd".encodeToByteArray())))
        val clean = receiver.receive(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 2u, 6u, sha(ciphertext), 1u),
            ),
        ) as EncryptedUploadV2TransferReceiverEvent.WindowStaged
        assertTrue(clean.value.missingSequences.isEmpty())
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) {
            receiver.windowAcknowledgement(clean.value.checkpoint)
        }
        receiver.checkpointDidPersist(clean.value.checkpoint)
        assertTrue(receiver.windowAcknowledgement(clean.value.checkpoint).missingSequences.isEmpty())
        assertTrue(Files.readAllBytes(receiver.file).contentEquals(ciphertext))
    }

    @Test
    fun boundsPayloadWindowMissingManifestAndEofIntegrity() {
        val root = Files.createTempDirectory("bota-v2-bounds")
        val receiver = receiver(root, byteArrayOf(1, 2), maximumWindowPackets = 1u, maximumMissing = 1u)
        receiver.prepare()
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) {
            receiver.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 0u, 0u, byteArrayOf(1, 2, 3))))
        }

        val complete = receiver(root, byteArrayOf(1, 2), maximumWindowPackets = 1u, maximumMissing = 1u)
        complete.prepare()
        complete.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 0u, 0u, byteArrayOf(1, 2))))
        val staged = complete.receive(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 0u, 2u, sha(byteArrayOf(1, 2)), 1u),
            ),
        ) as EncryptedUploadV2TransferReceiverEvent.WindowStaged
        complete.checkpointDidPersist(staged.value.checkpoint)
        complete.windowAcknowledgement(staged.value.checkpoint)
        val manifest = ByteArray(580) { (it % 251).toByte() }
        complete.receive(
            EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), manifest),
            ),
        )
        val result = complete.receive(
            EncryptedUploadV2TransferPayload.Eof(
                EncryptedUploadV2EofValue(9u, 0u, 1u, 2u, sha(byteArrayOf(1, 2)), sha(manifest)),
            ),
        ) as EncryptedUploadV2TransferReceiverEvent.Completed
        assertEquals(580, result.value.manifest.size)
        assertEquals(2uL, result.value.evidence.ciphertextLength)
    }

    @Test
    fun resumeTruncatesUncommittedTailAndVerifiesPrefix() {
        val root = Files.createTempDirectory("bota-v2-resume")
        val sink = UUID.randomUUID().toString()
        val file = root.resolve("$sink.encrypted-upload-v2")
        Files.write(file, "committed-tail".encodeToByteArray())
        val receiver = EncryptedUploadV2TransferReceiver(
            root, sink, 9u, 9u, sha("committed".encodeToByteArray()), 4u, 2u, 2u,
            EncryptedUploadV2CheckpointValue(2u, 9u, sha("committed".encodeToByteArray()), 3u),
        )

        receiver.prepare()

        assertEquals("committed", String(Files.readAllBytes(file)))
    }

    @Test
    fun corruptResumePrefixDoesNotDestroyTheRetainedTail() {
        val root = Files.createTempDirectory("bota-v2-corrupt-resume")
        val sink = UUID.randomUUID().toString()
        val file = root.resolve("$sink.encrypted-upload-v2")
        val bytes = "corrupted-tail".encodeToByteArray()
        Files.write(file, bytes)
        val receiver = EncryptedUploadV2TransferReceiver(
            root, sink, 9u, 9u, sha("committed".encodeToByteArray()), 4u, 2u, 2u,
            EncryptedUploadV2CheckpointValue(2u, 9u, sha("committed".encodeToByteArray()), 3u),
        )
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { receiver.prepare() }
        assertTrue(Files.readAllBytes(file).contentEquals(bytes))
    }

    @Test
    fun rejectsNextWindowTrafficWhileRepairIsPending() {
        val root = Files.createTempDirectory("bota-v2-phase")
        val ciphertext = "abcdef".encodeToByteArray()
        val receiver = receiver(root, ciphertext, maximumWindowPackets = 3u, maximumMissing = 3u)
        receiver.prepare()
        receiver.receive(
            EncryptedUploadV2TransferPayload.Data(
                EncryptedUploadV2DataValue(9u, 0u, 0u, "ab".encodeToByteArray()),
            ),
        )
        receiver.receive(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 1u, 4u, sha("abcd".encodeToByteArray()), 1u),
            ),
        )

        val error = assertThrows(EncryptedUploadV2TransferReceiverException::class.java) {
            receiver.receive(
                EncryptedUploadV2TransferPayload.Data(
                    EncryptedUploadV2DataValue(9u, 2u, 4u, "ef".encodeToByteArray()),
                ),
            )
        }

        assertTrue(error.message!!.contains("repair"))
    }

    private fun receiver(
        root: java.nio.file.Path,
        ciphertext: ByteArray,
        maximumWindowPackets: UShort,
        maximumMissing: UShort,
    ) = EncryptedUploadV2TransferReceiver(
        root,
        UUID.randomUUID().toString(),
        9u,
        ciphertext.size.toULong(),
        sha(ciphertext),
        2u,
        maximumWindowPackets,
        maximumMissing,
        EncryptedUploadV2CheckpointValue(0u, 0u, sha(byteArrayOf()), null),
    )

    private fun sha(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
