package dev.bota.sdk.internal.core

import dev.bota.sdk.model.DeviceDiagnosticBreadcrumb
import dev.bota.sdk.model.DeviceDiagnosticExecution
import dev.bota.sdk.model.DeviceDiagnosticFault
import dev.bota.sdk.model.DeviceDiagnosticReport
import dev.bota.sdk.model.DeviceDiagnosticRuntime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceDiagnosticsMappingTest {
    @Test fun typedFieldsPreserveEveryReportFieldAndSparseEventBoundaries() {
        val fields = listOf(CoreField.Unsigned(171, 1u), CoreField.Unsigned(172, 2u)) +
            event("ffffffffffffffff", true) + listOf(
                CoreField.Unsigned(182, 1u), CoreField.Text(183, "ffffffff"),
                CoreField.Text(184, "00000002"), CoreField.Text(185, "00000003"),
                CoreField.Text(186, "00000004"), CoreField.Text(187, "00000005"),
                CoreField.Text(188, "audio"), CoreField.Text(189, "rom:00001234"),
                CoreField.Text(190, "ram:00005678"), CoreField.Unsigned(191, 2u),
                CoreField.Text(192, "rom:00000001"), CoreField.Text(192, "sdram:00000002"),
                CoreField.Unsigned(193, UInt.MAX_VALUE.toULong()), CoreField.Unsigned(194, 0u),
                CoreField.Unsigned(195, 2u), CoreField.Signed(196, Int.MIN_VALUE.toLong()),
                CoreField.Text(197, "boot"), CoreField.Signed(198, Int.MAX_VALUE.toLong()),
                CoreField.Signed(196, -1), CoreField.Text(197, "state_changed"), CoreField.Signed(198, -2),
            ) + event("8000000000000001", false)
        val batch = requireNotNull(mapDiagnosticFields(fields.toNativePacket(0x0525)))
        assertEquals(1, batch.schemaVersion)
        assertEquals(listOf("ffffffffffffffff", "8000000000000001"), batch.events.map { it.eventId })
        assertEquals("fedcba9876543210", batch.events[0].signature)
        assertEquals(UInt.MAX_VALUE, batch.events[0].uptimeMs)
        assertEquals(
            DeviceDiagnosticReport(
                DeviceDiagnosticFault(1, "ffffffff", "00000002", "00000003", "00000004", "00000005"),
                DeviceDiagnosticExecution("audio", "rom:00001234", "ram:00005678", listOf("rom:00000001", "sdram:00000002")),
                DeviceDiagnosticRuntime(UInt.MAX_VALUE, 0u),
                listOf(DeviceDiagnosticBreadcrumb(Int.MIN_VALUE, "boot", Int.MAX_VALUE),
                    DeviceDiagnosticBreadcrumb(-1, "state_changed", -2)),
            ),
            batch.events[0].report,
        )
        assertNull(batch.events[1].report)
        assertNull(mapDiagnosticFields(emptyList<CoreField>().toNativePacket(0x0525)))
    }

    private fun event(id: String, report: Boolean): List<CoreField> = listOf(
        CoreField.Text(173, id), CoreField.Text(174, "hard_fault"),
        CoreField.Text(175, "cpu_stack_overflow"), CoreField.Unsigned(176, UInt.MAX_VALUE.toULong()),
        CoreField.Text(177, "fedcba9876543210"), CoreField.Text(178, "012345abcdef"),
        CoreField.Text(179, "audio"), CoreField.Text(180, "recording"), CoreField.BooleanValue(181, report),
    )
}
