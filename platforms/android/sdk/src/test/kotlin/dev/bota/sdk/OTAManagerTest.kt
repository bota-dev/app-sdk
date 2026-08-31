package dev.bota.sdk

import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Test

class OTAManagerTest {
    @Test
    fun updateRegistersOneNativeBlobAndMapsFirmwareProgress() = runTest {
        val runner = ManagerWorkflowRunner(
            responses = {
                listOf(firmwareProgressNotification(3u, 512u, 1_024u), completedNotification(operation = 10))
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = OTAManager()
        manager.attach(fixture.runtime)
        val image = firmwareImage()

        val progress = manager.updateFirmware(fixture.device, image).toList()

        assertEquals(listOf(FirmwareUpdateProgress(FirmwareUpdatePhase.Transferring, 512u, 1_024u)), progress)
        assertEquals(setOf(image.downloadId), fixture.firmwarePaths.keys)
        assertEquals(listOf(image.downloadId), fixture.removedFirmware)
        manager.detach()
    }

    @Test
    fun collectorCancellationCancelsFirmwareAndUnregistersTheBlob() = runTest {
        val runner = ManagerWorkflowRunner(keepOpen = { it.kind == 0x0107 })
        val fixture = ManagerRuntimeFixture(runner)
        val manager = OTAManager()
        manager.attach(fixture.runtime)
        val image = firmwareImage()
        val collecting = async { manager.updateFirmware(fixture.device, image).toList() }
        withTimeout(1_000) {
            while (runner.commands.isEmpty()) delay(1)
        }

        collecting.cancel()
        runCatching { collecting.await() }
        withTimeout(1_000) {
            while (runner.cancelledIds.isEmpty()) delay(1)
        }

        assertEquals(runner.commands.single().cancellationId, runner.cancelledIds.single())
        assertEquals(listOf(image.downloadId), fixture.removedFirmware)
        manager.detach()
    }

    private fun firmwareImage(): FirmwareImage = FirmwareImage(
        version = "1.0.18",
        sizeBytes = 1_024u,
        crc32 = 0x1234u,
        downloadId = 77u,
        request = Request.Builder().url("https://example.test/firmware.bin").build(),
    )
}
