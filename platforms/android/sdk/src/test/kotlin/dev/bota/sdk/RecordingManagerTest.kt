package dev.bota.sdk

import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.model.RecordingTransferProgress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingManagerTest {
    @Test
    fun listSubscribesBeforeWriteAndUsesTheSharedDecoder() = runTest {
        val fixture = ManagerRuntimeFixture(ManagerWorkflowRunner())
        val manager = RecordingManager()
        manager.attach(fixture.runtime)

        val recordings = manager.listRecordings(fixture.device)

        assertEquals(listOf(fixture.recording), recordings)
        assertEquals(listOf("subscribe", "collect", "encode-List", "write", "unsubscribe"), fixture.actions)
        manager.detach()
    }

    @Test
    fun syncMapsProgressAndReturnsOnlyTheNativePath() = runTest {
        val runner = ManagerWorkflowRunner(
            responses = {
                listOf(progressNotification(2_048u, 4_096u), completedNotification(operation = 8))
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)

        val events = manager.syncRecording(fixture.device, fixture.recording, sinkId = "sink-1").toList()

        assertEquals(RecordingSyncEvent.Progress(RecordingTransferProgress(2_048u, 4_096u)), events[0])
        assertEquals(RecordingSyncEvent.Completed(fixture.sinkPaths.getValue("sink-1")), events[1])
        assertEquals(listOf("sink-1"), fixture.removedSinks)
        manager.detach()
    }

    @Test
    fun uploadOwnershipMapsOnlyPreservedOrFallbackIdentifiers() = runTest {
        val runner = ManagerWorkflowRunner(
            responses = {
                listOf(
                    managerNotification(
                        CoreNotificationKind.BleFallbackReady,
                        operation = 9,
                        fields = listOf(
                            CoreField.Text(13, "recording-1"),
                            CoreField.Text(16, "upload-1"),
                            CoreField.Text(17, "destination-1"),
                        ),
                    ),
                    completedNotification(operation = 9),
                )
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)

        val events = manager.observeUploadOwnership(
            fixture.device,
            recordingUuid = "recording-1",
            uploadId = "upload-1",
            destinationId = "destination-1",
        ).toList()

        assertEquals(
            listOf(
                UploadOwnershipEvent.Result(
                    UploadOwnershipResult.BluetoothFallback("recording-1", "upload-1", "destination-1"),
                ),
            ),
            events,
        )
        manager.detach()
    }

    @Test
    fun collectorCancellationCancelsTheExactTransferAndReleasesTheSink() = runTest {
        val runner = ManagerWorkflowRunner(keepOpen = { it.kind == 0x0105 })
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)
        val collecting = async {
            manager.syncRecording(fixture.device, fixture.recording, sinkId = "sink-1").toList()
        }
        withTimeout(1_000) {
            while (runner.commands.isEmpty()) delay(1)
        }

        collecting.cancel()
        runCatching { collecting.await() }
        withTimeout(1_000) {
            while (runner.cancelledIds.isEmpty()) delay(1)
        }

        assertEquals(runner.commands.single().cancellationId, runner.cancelledIds.single())
        assertEquals(listOf("sink-1"), fixture.removedSinks)
        assertTrue(fixture.sinkPaths.keys.none { it != "sink-1" })
        manager.detach()
    }

    @Test
    fun activeTransferBlocksOtherManagersThroughTheFacadeCoordinator() = runTest {
        val runner = ManagerWorkflowRunner(keepOpen = { it.kind == 0x0105 })
        val fixture = ManagerRuntimeFixture(runner)
        val recordings = RecordingManager()
        val ota = OTAManager()
        recordings.attach(fixture.runtime)
        ota.attach(fixture.runtime)
        val transfer = async {
            recordings.syncRecording(fixture.device, fixture.recording, sinkId = "sink-1").toList()
        }
        withTimeout(1_000) {
            while (runner.commands.isEmpty()) delay(1)
        }

        val error = runCatching {
            ota.updateFirmware(
                fixture.device,
                FirmwareImage(
                    version = "1.0.18",
                    sizeBytes = 1u,
                    crc32 = 1u,
                    downloadId = 77u,
                    request = Request.Builder().url("https://example.test/firmware.bin").build(),
                ),
            ).toList()
        }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.OperationInProgress, error.code)
        assertTrue(fixture.firmwarePaths.isEmpty())
        transfer.cancel()
        runCatching { transfer.await() }
        recordings.detach()
        ota.detach()
    }

    @Test
    fun cancellingListStopsItsOwnedNotificationCollector() = runTest {
        val runner = ManagerWorkflowRunner()
        val fixture = ManagerRuntimeFixture(runner, holdRecordingList = true)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)
        val listing = async { manager.listRecordings(fixture.device) }
        withTimeout(1_000) {
            while ("write" !in fixture.actions) delay(1)
        }

        manager.cancelCurrentOperation()
        val error = runCatching { listing.await() }.exceptionOrNull()

        assertTrue(error is CancellationException)
        assertEquals(1, runner.cancelledIds.size)
        assertEquals("unsubscribe", fixture.actions.last())
        manager.detach()
    }
}
