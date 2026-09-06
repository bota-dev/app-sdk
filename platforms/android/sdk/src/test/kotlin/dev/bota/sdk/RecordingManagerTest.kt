package dev.bota.sdk

import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.StreamingUploadDestination
import dev.bota.sdk.model.StreamingUploadMethod
import dev.bota.sdk.model.StreamingRecordingEvent
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingManagerTest {
    @Test
    fun encryptedV2SelectsFromFreshCapabilitiesBeforeStartingAndNeverFallsBack() = runTest {
        val runner = ManagerWorkflowRunner(responses = { listOf(completedNotification(operation = 8)) })
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)
        val calls = mutableListOf<String>()
        fixture.encryptedV2Calls = calls
        val cancelled = AtomicInteger()
        val material = encryptedMaterial(cancelled)

        manager.syncEncryptedRecordingV2(
            fixture.device,
            EncryptedUploadV2Recording(fixture.recording.uuid, 4u, 4_096u, ByteArray(32) { 0x5a }),
        ) { context ->
            calls += "provider"
            assertEquals(157u.toUShort(), context.capability.capabilities.maximumDataPayloadBytes)
            material
        }

        assertEquals(listOf("capability", "checkpoint", "maximum-write", "provider", "register", "terminate-Completed"), calls)
        assertEquals(0x010c, runner.commands.single().kind)
        assertEquals(0, cancelled.get())

        val providerFailure = runCatching {
            manager.syncEncryptedRecordingV2(
                fixture.device,
                EncryptedUploadV2Recording(fixture.recording.uuid, 4u, 4_096u, ByteArray(32) { 0x5a }),
            ) { throw IllegalStateException("selection failed") }
        }.exceptionOrNull()
        assertTrue(providerFailure is BotaSDKError)
        assertEquals(1, runner.commands.size)
        manager.detach()
    }

    @Test
    fun encryptedV2CancellationDuringLateProviderCleanupNeverStartsCore() = runTest {
        val runner = ManagerWorkflowRunner()
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val cancelled = AtomicInteger()
        val operation = async {
            manager.syncEncryptedRecordingV2(
                fixture.device,
                EncryptedUploadV2Recording(fixture.recording.uuid, 4u, 4_096u, ByteArray(32) { 0x5a }),
            ) {
                entered.complete(Unit)
                withContext(NonCancellable) { release.await() }
                encryptedMaterial(cancelled)
            }
        }
        entered.await()

        operation.cancel()
        release.complete(Unit)
        runCatching { operation.await() }

        assertTrue(runner.commands.isEmpty())
        assertEquals(1, cancelled.get())
        manager.detach()
    }

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
                listOf(
                    progressNotification(2_048u, 4_096u),
                    managerNotification(
                        CoreNotificationKind.Completed,
                        operation = 8,
                        fields = listOf(
                            CoreField.BooleanValue(90, true),
                            CoreField.Bytes(123, ByteArray(32) { 0x5a }),
                        ),
                    ),
                )
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)

        val events = manager.syncRecording(
            fixture.device,
            fixture.recording,
            sinkId = "sink-1",
            confirmOnCompletion = false,
        ).toList()

        assertEquals(RecordingSyncEvent.Progress(RecordingTransferProgress(2_048u, 4_096u)), events[0])
        assertEquals(RecordingSyncEvent.Completed(fixture.sinkPaths.getValue("sink-1")), events[1])
        assertEquals(
            RecordingTransferMetadata(true, "5a".repeat(32)),
            manager.transferMetadata("sink-1"),
        )
        assertNull(manager.transferMetadata("sink-1"))
        assertTrue(runner.commands.single().fields.contains(CoreField.BooleanValue(124, false)))
        assertEquals(listOf("sink-1"), fixture.removedSinks)
        manager.detach()
    }

    @Test
    fun confirmRecordingWritesDeleteOnlyAfterTheCallerRequestsIt() = runTest {
        val fixture = ManagerRuntimeFixture(ManagerWorkflowRunner())
        val manager = RecordingManager()
        manager.attach(fixture.runtime)

        manager.confirmRecording(fixture.device, fixture.recording.uuid)

        assertEquals(listOf("encode-Confirm", "write"), fixture.actions)
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
    fun streamingRegistersNativeSinkAndMapsLifecycleNotifications() = runTest {
        val runner = ManagerWorkflowRunner(
            responses = {
                listOf(
                    managerNotification(
                        CoreNotificationKind.StreamingPaused,
                        operation = 8,
                        fields = listOf(CoreField.Unsigned(36, 512u)),
                    ),
                    managerNotification(CoreNotificationKind.StreamingResumed, operation = 8),
                    managerNotification(
                        CoreNotificationKind.StreamingCompleted,
                        operation = 8,
                        fields = listOf(
                            CoreField.Unsigned(15, 1_024u),
                            CoreField.Unsigned(126, 2u),
                            CoreField.BooleanValue(90, true),
                        ),
                    ),
                )
            },
        )
        val fixture = ManagerRuntimeFixture(runner)
        val manager = RecordingManager()
        manager.attach(fixture.runtime)
        val sinkId = UUID.randomUUID().toString()

        val events = manager.streamRecording(
            fixture.device,
            recordingUuid = fixture.recording.uuid,
            sinkId = sinkId,
            chunkSizeBytes = 512,
            flushIntervalMilliseconds = 1_000u,
            destinationProvider = {
                StreamingUploadDestination(
                    "https://example.test/chunk",
                    StreamingUploadMethod.Put,
                    "audio/ogg",
                )
            },
            finalize = {},
        ).toList()

        assertEquals(
            listOf(
                StreamingRecordingEvent.Paused(512u),
                StreamingRecordingEvent.Resumed,
                StreamingRecordingEvent.Completed(1_024u, 2u, true),
            ),
            events,
        )
        assertEquals(listOf(sinkId), fixture.streamingSinks)
        assertEquals(listOf(sinkId), fixture.removedStreamingSinks)
        assertEquals(0x010b, runner.commands.single().kind)
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

    private fun encryptedMaterial(cancelled: AtomicInteger) = EncryptedUploadV2Material(
        materialId = "material-1",
        recordingId = "recording-1",
        uploadSessionId = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff"),
        ownerRevision = 2u,
        policy = EncryptedUploadV2SecurityPolicy.V2Required,
        authorization = ByteArray(408),
        stagingRequest = { Request.Builder().url("https://example.test/upload").put(byteArrayOf().toRequestBody()).build() },
        submitManifest = { _, _ -> },
        finalize = {},
        completionReceipt = { ByteArray(336) },
        cancel = { cancelled.incrementAndGet() },
    )
}
