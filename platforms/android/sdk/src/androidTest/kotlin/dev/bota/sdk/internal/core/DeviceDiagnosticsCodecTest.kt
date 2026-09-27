package dev.bota.sdk.internal.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.bota.sdk.model.DeviceDiagnosticsBatch
import dev.bota.sdk.model.DeviceDiagnosticEvent
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceDiagnosticsCodecTest {
    @Test fun commandEncodingUsesRealRustAndPreservesUnsignedEventIds() {
        CoreModelMapper().use { mapper ->
            assertArrayEquals(byteArrayOf(0x10), mapper.createDiagnosticCommand(null))
            assertArrayEquals(byteArrayOf(0x11, 1, 0, 0, 0, 0, 0, 0, 0x80.toByte()),
                mapper.createDiagnosticCommand("8000000000000001"))
            assertArrayEquals(byteArrayOf(0x11) + ByteArray(8) { 0xff.toByte() },
                mapper.createDiagnosticCommand("ffffffffffffffff"))
            listOf("", "FFFFFFFFFFFFFFFF", "000000000000000g", "00000000000000000").forEach { id ->
                assertThrows(Exception::class.java) { mapper.createDiagnosticCommand(id) }
            }
        }
    }

    @Test fun completeDiagnosticAssemblyUsesRealRustAndResetDiscardsPartialState() {
        CoreModelMapper().use { mapper ->
            assertNull(mapper.decodeDiagnosticEvents(byteArrayOf()))
            val metadata = byteArrayOf(0x90.toByte(), 0, 3, 4, 0) +
                ByteArray(4) { 0xff.toByte() } + byteArrayOf(1, 0, 0, 0, 0, 0, 0, 0x80.toByte())
            assertNull(mapper.decodeDiagnosticEvents(metadata))
            assertNull(mapper.decodeDiagnosticEvents(byteArrayOf(0x91.toByte(), 0) + ByteArray(8) { 0xff.toByte() }))
            val detail = ByteArray(176)
            detail[0] = 1
            "012345abcdef".encodeToByteArray().copyInto(detail, 2)
            detail[14] = 1
            detail[15] = 2
            for (offset in detail.indices step 14) {
                val chunk = byteArrayOf(0x95.toByte(), 0, offset.toByte(), 0, 176.toByte(), 0) +
                    detail.copyOfRange(offset, minOf(offset + 14, detail.size))
                assertNull(mapper.decodeDiagnosticEvents(chunk))
            }
            assertEquals(DeviceDiagnosticsBatch(1, listOf(DeviceDiagnosticEvent(
                eventId = "8000000000000001", eventType = "hard_fault", reasonCode = "cpu_stack_overflow",
                uptimeMs = UInt.MAX_VALUE, signature = "ffffffffffffffff", firmwareBuildId = "012345abcdef",
                subsystem = "audio", stateBeforeEvent = "recording",
            ))), mapper.decodeDiagnosticEvents(byteArrayOf(0x92.toByte(), 1)))
            assertNull(mapper.decodeDiagnosticEvents(metadata))
            assertNull(mapper.decodeDiagnosticEvents(byteArrayOf()))
            assertEquals(DeviceDiagnosticsBatch(1, emptyList()), mapper.decodeDiagnosticEvents(byteArrayOf(0x92.toByte(), 0)))
            assertThrows(Exception::class.java) { mapper.decodeDiagnosticEvents(byteArrayOf(0x92.toByte(), 1)) }
            assertEquals(DeviceDiagnosticsBatch(1, emptyList()), mapper.decodeDiagnosticEvents(byteArrayOf(0x92.toByte(), 0)))
        }
    }
}
