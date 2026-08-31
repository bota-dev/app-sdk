package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
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
}

