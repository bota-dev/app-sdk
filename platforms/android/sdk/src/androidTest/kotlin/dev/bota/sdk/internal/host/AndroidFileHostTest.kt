package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import java.io.File
import java.util.UUID
import java.util.zip.CRC32
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class AndroidFileHostTest {
    @Test
    fun parcelFileDescriptorsBackRecordingAndFirmwareHosts() {
        runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.noBackupFilesDir, "file-host-test-${UUID.randomUUID()}").apply { mkdirs() }
        val recording = File(root, "recording.ogg")
        val sinkId = UUID.randomUUID().toString()
        val sink = FileRecordingSinkHost()
        sink.registerDescriptor(
            sinkId,
            ParcelFileDescriptor.open(
                recording,
                ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_READ_WRITE or
                    ParcelFileDescriptor.MODE_TRUNCATE,
            ),
        )
        val payload = "recording".encodeToByteArray()
        sink.execute(
            androidHostEffect(
                CoreEffectKind.RecordingSinkTruncate,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(36, 0u),
            ),
        ).toList()
        sink.execute(
            androidHostEffect(
                CoreEffectKind.RecordingSinkAppend,
                CoreField.Text(14, sinkId),
                CoreField.Bytes(33, payload),
            ),
        ).toList()
        val crc = CRC32().apply { update(payload) }.value.toULong()
        sink.execute(
            androidHostEffect(
                CoreEffectKind.RecordingSinkFinalize,
                CoreField.Text(14, sinkId),
                CoreField.Unsigned(37, crc),
            ),
        ).toList()
        sink.close()

        assertArrayEquals(payload, recording.readBytes())

        val firmware = File(root, "firmware.bin").apply { writeBytes(byteArrayOf(0, 1, 2, 3, 4)) }
        val blob = FileFirmwareBlobHost(maximumChunkLength = 4)
        blob.registerDescriptor(9u, ParcelFileDescriptor.open(firmware, ParcelFileDescriptor.MODE_READ_ONLY))
        val event = blob.execute(
            androidHostEffect(
                CoreEffectKind.FirmwareBlobRead,
                CoreField.Unsigned(21, 9u),
                CoreField.Unsigned(39, 1u),
                CoreField.Unsigned(40, 3u),
            ),
        ).toList().single()

        assertArrayEquals(byteArrayOf(1, 2, 3), event.androidBytes(30))
        assertNoPersistedCredentialMaterial(root)
        assertEquals(5, firmware.length())
        blob.close()
            root.deleteRecursively()
        }
    }
}
