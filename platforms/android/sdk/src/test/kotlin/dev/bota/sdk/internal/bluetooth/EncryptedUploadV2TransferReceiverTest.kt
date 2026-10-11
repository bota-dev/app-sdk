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
    fun markedTransfersRequireCompleteOrderedAndUntamperedDocuments() {
        val audio = byteArrayOf(1, 2, 3, 4)
        val manifest = ByteArray(580) { 7 }
        for (fault in listOf("none", "missing", "reorder", "tampered", "count", "offset", "ordinary")) {
            val receiver = resumedReceiver(audio, 4, fault != "ordinary")
            receiver.prepare()
            receiver.resumeAccepted()
            receiver.receive(EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), manifest)))
            val documents = listOf(ByteArray(200) { 8 }, ByteArray(402) { 9 })
            val transfer = {
                documents.forEachIndexed { index, document ->
                    if (!(fault == "missing" && index == 1)) {
                        for (offset in document.indices step 100) {
                            val bytes = document.copyOfRange(offset, minOf(offset + 100, document.size))
                            if (fault == "tampered") bytes[0] = 42
                            receiver.receive(EncryptedUploadV2TransferPayload.MarkerChunk(
                                dev.bota.sdk.internal.core.EncryptedUploadV2MarkerChunkValue(
                                    9u, if (fault == "reorder") 1u else index.toUInt(),
                                    if (fault == "count") 4098u else 2u,
                                    if (fault == "offset") 1u else offset.toUShort(), document.size.toUShort(), sha(document), bytes)))
                        }
                    }
                }
                receiver.receive(EncryptedUploadV2TransferPayload.Eof(
                    EncryptedUploadV2EofValue(9u, 0u, 1u, 4u, sha(audio), sha(manifest))))
            }
            if (fault == "none") {
                val result = transfer() as EncryptedUploadV2TransferReceiverEvent.Completed
                assertEquals(2, result.value.markerDocuments.size)
                documents.forEachIndexed { index, document -> assertTrue(document.contentEquals(result.value.markerDocuments[index])) }
            } else assertThrows(fault, EncryptedUploadV2TransferReceiverException::class.java) { transfer() }
            assertTrue(Files.readAllBytes(receiver.file).contentEquals(audio))
        }
    }

    @Test
    fun completedResumeUsesAttemptSequenceAndStillChecksEveryEofIntegrityField() {
        val ciphertext = byteArrayOf(1, 2, 3, 4)
        val manifest = ByteArray(580) { (it % 251).toByte() }
        for (fault in listOf("none", "old-sequence", "ciphertext-hash", "manifest-hash", "manifest-bytes", "file", "length", "block-count")) {
            val receiver = resumedReceiver(ciphertext, ciphertext.size)
            receiver.prepare()
            receiver.resumeAccepted()
            val receivedManifest = manifest.copyOf().also { if (fault == "manifest-bytes") it[0] = 42 }
            receiver.receive(EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), receivedManifest),
            ))
            if (fault == "file") Files.write(receiver.file, byteArrayOf(4, 3, 2, 1))
            val eof = EncryptedUploadV2TransferPayload.Eof(EncryptedUploadV2EofValue(
                9u, if (fault == "old-sequence") 339u else 0u,
                if (fault == "block-count") 0u else 1u,
                if (fault == "length") 3u else 4u,
                if (fault == "ciphertext-hash") ByteArray(32) else sha(ciphertext),
                if (fault == "manifest-hash") ByteArray(32) else sha(manifest),
            ))
            if (fault == "none") {
                assertTrue(receiver.receive(eof) is EncryptedUploadV2TransferReceiverEvent.Completed)
            } else {
                assertThrows(fault, EncryptedUploadV2TransferReceiverException::class.java) { receiver.receive(eof) }
            }
        }
    }

    @Test
    fun partialResumeRejectsOldWindowSequenceAndRequiresPersistedNewAttemptProgress() {
        val ciphertext = byteArrayOf(1, 2, 3, 4)
        for (sequence in listOf(1u, 340u)) {
            val receiver = resumedReceiver(ciphertext, 2)
            receiver.prepare()
            receiver.resumeAccepted()
            receiver.receive(EncryptedUploadV2TransferPayload.Data(
                EncryptedUploadV2DataValue(9u, sequence, 2u, byteArrayOf(3, 4)),
            ))
            val window = EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, sequence, sequence, 4u, sha(ciphertext), 35u),
            )
            if (sequence != 1u) {
                assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { receiver.receive(window) }
                continue
            }
            val staged = receiver.receive(window) as EncryptedUploadV2TransferReceiverEvent.WindowStaged
            assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { receiver.windowAcknowledgement(staged.value.checkpoint) }
            receiver.checkpointDidPersist(staged.value.checkpoint)
            assertEquals(1u, receiver.windowAcknowledgement(staged.value.checkpoint).highestContiguousSequence)
            val manifest = ByteArray(580)
            receiver.receive(EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), manifest),
            ))
            assertTrue(receiver.receive(EncryptedUploadV2TransferPayload.Eof(
                EncryptedUploadV2EofValue(9u, 1u, 1u, 4u, sha(ciphertext), sha(manifest)),
            )) is EncryptedUploadV2TransferReceiverEvent.Completed)
        }
    }

    @Test
    fun resumeSequenceResetIsOnlyAllowedOnceBeforeReceivingPayload() {
        val ciphertext = byteArrayOf(1, 2, 3, 4)
        val resumed = resumedReceiver(ciphertext, 2)
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { resumed.resumeAccepted() }
        resumed.prepare()
        resumed.resumeAccepted()
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { resumed.resumeAccepted() }
        resumed.receive(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 1u, 2u, byteArrayOf(3, 4))))
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { resumed.resumeAccepted() }
        val fresh = receiver(Files.createTempDirectory("bota-v2-fresh"), ciphertext, 2u, 2u)
        fresh.prepare()
        assertThrows(EncryptedUploadV2TransferReceiverException::class.java) { fresh.resumeAccepted() }
    }

    private fun resumedReceiver(ciphertext: ByteArray, offset: Int, marked: Boolean = false): EncryptedUploadV2TransferReceiver {
        val root = Files.createTempDirectory("bota-v2-resume-sequence")
        val sink = UUID.randomUUID().toString()
        Files.write(root.resolve("$sink.encrypted-upload-v2"), ciphertext)
        return EncryptedUploadV2TransferReceiver(
            root, sink, 9u, ciphertext.size.toULong(), sha(ciphertext), 4u, 2u, 2u,
            EncryptedUploadV2CheckpointValue(34u, offset.toULong(), sha(ciphertext.copyOf(offset)), 339u), marked,
        )
    }

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
