package dev.bota.sdk

import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.model.DeviceLogLine
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceLogManagerTest {
    @Test
    fun streamMapsOnlyCompleteSanitizedCoreLines() = runTest {
        val runner = ManagerWorkflowRunner(
            responses = {
                listOf(
                    managerNotification(
                        CoreNotificationKind.DeviceLog,
                        operation = 11,
                        fields = listOf(CoreField.Text(46, "ready"), CoreField.BooleanValue(51, true)),
                    ),
                    completedNotification(operation = 11),
                )
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)

        val lines = manager.streamLogs(fixture.device).toList()

        assertEquals(listOf(DeviceLogLine("ready", isBacklog = true)), lines)
        manager.detach()
    }

    @Test
    fun collectorCancellationCancelsTheExactLogWorkflow() = runTest {
        val runner = ManagerWorkflowRunner(keepOpen = { it.kind == 0x0108 })
        val fixture = ManagerRuntimeFixture(runner)
        val manager = DeviceLogManager()
        manager.attach(fixture.runtime)
        val collecting = async { manager.streamLogs(fixture.device).toList() }
        withTimeout(1_000) {
            while (runner.commands.isEmpty()) delay(1)
        }

        collecting.cancel()
        runCatching { collecting.await() }
        withTimeout(1_000) {
            while (runner.cancelledIds.isEmpty()) delay(1)
        }

        assertEquals(runner.commands.single().cancellationId, runner.cancelledIds.single())
        manager.detach()
    }
}
