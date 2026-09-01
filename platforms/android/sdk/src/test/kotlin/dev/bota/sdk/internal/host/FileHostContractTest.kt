package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.model.StreamingChunkRequest
import dev.bota.sdk.model.StreamingFinalizeMetadata
import dev.bota.sdk.model.StreamingUploadDestination
import dev.bota.sdk.model.StreamingUploadMethod
import java.nio.file.Files
import java.util.UUID
import java.util.zip.CRC32
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileHostContractTest {
    @Test
    fun sinkTruncatesAppendsFlushesAndVerifiesProtocolCrc32() = runTest {
        val root = Files.createTempDirectory("bota-sink-test")
        val file = root.resolve("recording.ogg")
        val sinkId = UUID.randomUUID().toString()
        val host = FileRecordingSinkHost()
        host.registerPath(sinkId, file)
        val payload = "recording".encodeToByteArray()

        host.execute(
            hostEffect(
                CoreEffectKind.RecordingSinkTruncate,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(36, 0u),
            ),
        ).toList()
        val appended = host.execute(
            hostEffect(
                CoreEffectKind.RecordingSinkAppend,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(38, 1u),
                CoreField.Bytes(33, payload),
            ),
        ).toList().single()
        val checksum = CRC32().apply { update(payload) }.value.toULong()
        val finalized = host.execute(
            hostEffect(
                CoreEffectKind.RecordingSinkFinalize,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(37, checksum),
            ),
        ).toList().single()

        assertEquals(payload.size.toULong(), appended.unsigned(54))
        assertEquals(HostEventKind.RecordingSinkFinalized, finalized.kind)
        assertArrayEquals(payload, Files.readAllBytes(file))

        val mismatch = host.execute(
            hostEffect(
                CoreEffectKind.RecordingSinkFinalize,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(37, checksum + 1u),
            ),
        ).toList().single()
        assertEquals(HostEventKind.RecordingSinkIntegrityFailed, mismatch.kind)
    }

    @Test
    fun firmwareReadsOnlyRegisteredBoundedChunks() = runTest {
        val file = Files.createTempFile("bota-firmware", ".bin")
        Files.write(file, byteArrayOf(0, 1, 2, 3, 4, 5))
        val host = FileFirmwareBlobHost(maximumChunkLength = 4)
        host.registerPath(9u, file)

        val event = host.execute(
            hostEffect(
                CoreEffectKind.FirmwareBlobRead,
                CoreField.Unsigned(21, 9u),
                CoreField.Unsigned(39, 2u),
                CoreField.Unsigned(40, 3u),
            ),
        ).toList().single()

        assertArrayEquals(byteArrayOf(2, 3, 4), event.bytes(30))
        assertEquals(2uL, event.unsigned(39))
        assertTrue(
            runCatching {
                host.execute(
                    hostEffect(
                        CoreEffectKind.FirmwareBlobRead,
                        CoreField.Unsigned(21, 9u),
                        CoreField.Unsigned(39, 0u),
                        CoreField.Unsigned(40, 5u),
                    ),
                ).toList()
            }.isFailure,
        )
    }

    @Test
    fun streamingSinkBuffersPlaintextAndFinalizesAfterNativeUploads() = runTest {
        val destinations = mutableListOf<StreamingChunkRequest>()
        val bodies = mutableListOf<ByteArray>()
        val finalizations = mutableListOf<StreamingFinalizeMetadata>()
        val host = FileRecordingSinkHost { destination, body ->
            destinations += StreamingChunkRequest(
                destination.url.substringAfterLast('/').toUInt(),
                destination.method == StreamingUploadMethod.Post,
            )
            bodies += body
        }
        val sinkId = UUID.randomUUID().toString()
        host.registerStreaming(
            sinkId = sinkId,
            chunkSizeBytes = 4,
            flushIntervalMilliseconds = 0u,
            destinationProvider = { request ->
                StreamingUploadDestination(
                    url = "https://example.test/chunk/${request.sequence}",
                    method = StreamingUploadMethod.Put,
                    contentType = "audio/ogg",
                )
            },
            finalize = { finalizations += it },
        )

        val first = host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkAppendPlaintext,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(38, 0u),
                CoreField.Bytes(33, byteArrayOf(1, 2, 3)),
            ),
        ).toList().single()
        val second = host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkAppendPlaintext,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(38, 1u),
                CoreField.Bytes(33, byteArrayOf(4, 5, 6)),
            ),
        ).toList().single()
        val finalized = host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkFinalize,
                CoreField.Text(14, sinkId),
                CoreField.BooleanValue(90, false),
                CoreField.Unsigned(125, 0u),
                CoreField.Unsigned(15, 6u),
            ),
        ).toList().single()

        assertEquals(3uL, first.unsigned(36))
        assertEquals(6uL, second.unsigned(36))
        assertEquals(listOf(1u, 2u), destinations.map(StreamingChunkRequest::sequence))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), bodies[0])
        assertArrayEquals(byteArrayOf(5, 6), bodies[1])
        val metadata = finalizations.single()
        assertEquals(2u, metadata.totalChunks)
        assertEquals(6uL, metadata.fileSizeBytes)
        assertEquals(false, metadata.isEncrypted)
        assertTrue(metadata.durationMilliseconds >= 0u)
        assertEquals(2uL, finalized.unsigned(126))
        assertEquals(6uL, finalized.unsigned(15))
    }

    @Test
    fun streamingSinkPreservesEncryptedWireSequencesAndHeader() = runTest {
        val destinations = mutableListOf<StreamingChunkRequest>()
        val bodies = mutableListOf<ByteArray>()
        val finalizations = mutableListOf<StreamingFinalizeMetadata>()
        val host = FileRecordingSinkHost { destination, body ->
            destinations += StreamingChunkRequest(
                destination.url.substringAfterLast('/').toUInt(),
                destination.method == StreamingUploadMethod.Post,
            )
            bodies += body
        }
        val sinkId = UUID.randomUUID().toString()
        host.registerStreaming(
            sinkId = sinkId,
            chunkSizeBytes = 64 * 1024,
            flushIntervalMilliseconds = 0u,
            destinationProvider = { request ->
                StreamingUploadDestination(
                    url = "https://example.test/relay/${request.sequence}",
                    method = StreamingUploadMethod.Post,
                    contentType = "application/octet-stream",
                    bearerToken = "token",
                )
            },
            finalize = { finalizations += it },
        )
        val header = ByteArray(32) { 0x41 }
        val salt = ByteArray(4) { 0x52 }
        host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkBeginEncrypted,
                CoreField.Text(14, sinkId),
                CoreField.Bytes(93, header),
                CoreField.Bytes(94, salt),
            ),
        ).toList()
        host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkAppendEncrypted,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(38, 0u),
                CoreField.Bytes(33, ByteArray(20) { 0x61 }),
            ),
        ).toList()
        host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkAppendEncrypted,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(38, 2u),
                CoreField.Bytes(33, ByteArray(20) { 0x62 }),
            ),
        ).toList()
        host.execute(
            streamingEffect(
                CoreEffectKind.StreamingSinkFinalize,
                CoreField.Text(14, sinkId),
                CoreField.BooleanValue(90, true),
                CoreField.Unsigned(125, 3u),
                CoreField.Unsigned(15, 8u),
            ),
        ).toList()

        assertEquals(listOf(0u, 2u), destinations.map(StreamingChunkRequest::sequence))
        assertArrayEquals(header + salt + ByteArray(20) { 0x61 }, bodies[0])
        assertArrayEquals(ByteArray(20) { 0x62 }, bodies[1])
        val metadata = finalizations.single()
        assertEquals(3u, metadata.totalChunks)
        assertEquals(8uL, metadata.fileSizeBytes)
        assertEquals(true, metadata.isEncrypted)
        assertTrue(metadata.durationMilliseconds >= 0u)
    }
}

private fun streamingEffect(kind: CoreEffectKind, vararg fields: CoreField): CoreEffect =
    hostEffect(kind, *fields)
