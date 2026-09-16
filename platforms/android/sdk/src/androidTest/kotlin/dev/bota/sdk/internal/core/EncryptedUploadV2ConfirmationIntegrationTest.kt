package dev.bota.sdk.internal.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.bota.sdk.internal.jni.NativeCoreBridge
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class EncryptedUploadV2ConfirmationIntegrationTest {
    @Test
    fun rustAndAndroidDeferCancellationToTheExactConfirmationOutcome() = runBlocking {
        val confirmationEntered = CompletableDeferred<Unit>()
        val confirmationRelease = CompletableDeferred<Unit>()
        val hostCancellationCount = AtomicInteger()
        val handler = object : CoreEffectHandler {
            override fun execute(effect: CoreEffect): Flow<CoreHostEvent> = when (effect.kind) {
                CoreEffectKind.EncryptedUploadV2LoadCheckpoint -> reply(
                    effect, HostEventKind.EncryptedUploadV2CheckpointLoaded,
                )
                CoreEffectKind.EncryptedUploadV2TruncateSink -> reply(
                    effect, HostEventKind.EncryptedUploadV2SinkTruncated,
                )
                CoreEffectKind.EncryptedUploadV2PrepareSession -> reply(
                    effect, HostEventKind.EncryptedUploadV2SessionPrepared,
                    listOf(CoreField.Bytes(161, ByteArray(32) { 0x66 })),
                )
                CoreEffectKind.EncryptedUploadV2StartTransfer -> flowOf(
                    CoreHostEvent.fromEffect(effect, HostEventKind.EncryptedUploadV2TransferStarted),
                    CoreHostEvent.fromEffect(
                        effect,
                        HostEventKind.EncryptedUploadV2TransferCompleted,
                        evidence(),
                    ),
                )
                CoreEffectKind.EncryptedUploadV2StageArtifacts -> reply(
                    effect, HostEventKind.EncryptedUploadV2ArtifactsStaged,
                )
                CoreEffectKind.EncryptedUploadV2AwaitReceipt -> reply(
                    effect,
                    HostEventKind.EncryptedUploadV2ReceiptAccepted,
                    listOf(CoreField.Bytes(162, ByteArray(32) { 0x77 })),
                )
                CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt -> flow {
                    confirmationEntered.complete(Unit)
                    confirmationRelease.await()
                    emit(CoreHostEvent.fromEffect(effect, HostEventKind.EncryptedUploadV2RecordingConfirmed))
                }
                else -> error("unexpected v2 integration effect ${effect.kind}")
            }

            override suspend fun cancel(cancellationId: CoreCancellationId) {
                hostCancellationCount.incrementAndGet()
            }
        }
        val runtime = CoreEngineRuntime(NativeCoreBridge(), handler)
        val command = command()
        try {
            val notifications = async { runtime.run(command, capabilities()).toList() }
            confirmationEntered.await()
            val cancellation = async {
                runtime.cancelAndReportExactSettlement(command.cancellationId)
            }
            confirmationRelease.complete(Unit)

            assertTrue(cancellation.await())
            assertEquals(
                listOf(
                    CoreNotificationKind.Started,
                    CoreNotificationKind.EncryptedUploadV2Staged,
                    CoreNotificationKind.Completed,
                ),
                notifications.await().map(CoreNotification::kind),
            )
            assertEquals(0, hostCancellationCount.get())
        } finally {
            runtime.close()
        }
    }

    private fun reply(effect: CoreEffect, kind: HostEventKind, fields: List<CoreField> = emptyList()) =
        flowOf(CoreHostEvent.fromEffect(effect, kind, fields))

    private fun evidence() = listOf(
        CoreField.Unsigned(130, 330u),
        CoreField.Bytes(144, ByteArray(32) { 0x33 }),
        CoreField.Unsigned(168, 580u),
        CoreField.Bytes(142, ByteArray(32) { 0x55 }),
        CoreField.Unsigned(145, 1u),
    )

    private fun capabilities() = CoreCapabilities.Bluetooth + CoreCapabilities.Persistence +
        CoreCapabilities.Progress + CoreCapabilities.HostMaterial + CoreCapabilities.RecordingSink +
        CoreCapabilities.NetworkTransfer

    private fun command(): CoreCommand = CoreCommand.transferEncryptedRecording(
        EncryptedUploadV2CommandRequest(
            serialNumber = "EVFXXW67KP",
            recordingUuid = "22222222222222222222222222222222",
            recordingGeneration = 9u,
            storageFormat = 3u,
            uploadSessionId = UUID.fromString("11111111-1111-1111-1111-111111111111"),
            ownerRevision = 3u,
            transportSessionId = 0x112233445566u,
            materialId = "v2-material-1",
            sinkId = "11111111-2222-3333-4444-555555555555",
            securityPolicy = 2u,
            capabilities = EncryptedUploadV2CapabilitiesValue(1u, 408u, 580u, 244u, 16u, 8u, 16u),
            windowPackets = 16u,
            dataPayloadBytes = 244u,
            ciphertextLength = 330u,
            ciphertextSha256 = ByteArray(32) { 0x33 },
        ),
    )
}
