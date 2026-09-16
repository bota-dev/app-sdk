package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2OpenResult
import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.EncryptedUploadV2DataValue
import dev.bota.sdk.internal.core.EncryptedUploadV2EofValue
import dev.bota.sdk.internal.core.EncryptedUploadV2ManifestChunkValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.core.EncryptedUploadV2WindowEndValue
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.internal.core.toNativePacket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2TransferHostTest {
    @Test
    fun successfulConfirmHandoffIsAtomicBeforeHostContinuation() = runTest {
        val actions = mutableListOf<String>()
        val cancelled = AtomicInteger()
        val registry = EncryptedUploadV2MaterialRegistry()
        val materialId = "material-1"
        val authorization = ByteArray(408) { 1 }
        val manifest = ByteArray(580) { (it % 251).toByte() }
        val ciphertext = byteArrayOf(3, 4)
        val material = EncryptedUploadV2Material(
            materialId, "recording-1", UploadSession, 2u, EncryptedUploadV2SecurityPolicy.V2Required,
            authorization,
            stagingRequest = {
                actions += "staging-request"
                Request.Builder().url("https://example.test/upload").put(byteArrayOf().toRequestBody()).build()
            },
            submitManifest = { value, _ ->
                assertTrue(value.contentEquals(manifest))
                actions += "manifest"
            },
            finalize = { actions += "finalize" },
            completionReceipt = {
                actions += "receipt"
                ByteArray(336) { 2 }
            },
            cancel = { cancelled.incrementAndGet() },
        )
        registry.register(materialId, material)
        val payloads = Channel<EncryptedUploadV2TransferPayload>(Channel.UNLIMITED)
        val root = Files.createTempDirectory("bota-v2-host")
        val driverWriteEntered = CompletableDeferred<Unit>()
        val driverWriteRelease = CompletableDeferred<Unit>()
        val confirmEntered = CompletableDeferred<Unit>()
        val confirmRelease = CompletableDeferred<Unit>()
        val confirmationQueryEntered = CompletableDeferred<Unit>()
        val confirmationQueryRelease = CompletableDeferred<Unit>()
        val host = host(
            root = root,
            registry = registry,
            payloads = payloads,
            actions = actions,
            driverWriteEntered = driverWriteEntered,
            driverWriteRelease = driverWriteRelease,
            confirmEntered = confirmEntered,
            confirmRelease = confirmRelease,
            confirmationQueryEntered = confirmationQueryEntered,
            confirmationQueryRelease = confirmationQueryRelease,
            removeConfirmationOwnerBeforeHostContinuation = true,
        ) { path ->
            assertTrue(Files.readAllBytes(path).contentEquals(ciphertext))
        }

        val prepared = host.execute(effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, materialId))).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val start = host.execute(startEffect(materialId, authorizationSha, ciphertext)).produceIn(this)
        assertEquals(
            HostEventKind.EncryptedUploadV2TransferStarted,
            withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { start.receive() } }.kind,
        )
        payloads.send(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 0u, 0u, ciphertext)))
        payloads.send(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 0u, 2u, sha(ciphertext), 1u),
            ),
        )
        val window = withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { start.receive() }
        }
        assertEquals(HostEventKind.EncryptedUploadV2WindowStaged, window.kind)
        val coreCheckpoint = byteArrayOf(7, 8, 9)
        host.execute(effect(CoreEffectKind.EncryptedUploadV2SaveCheckpoint, CoreField.Bytes(28, coreCheckpoint))).toList()
        host.execute(effect(CoreEffectKind.EncryptedUploadV2AcknowledgeWindow, CoreField.Bytes(28, coreCheckpoint))).toList()
        payloads.send(
            EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), manifest),
            ),
        )
        payloads.send(
            EncryptedUploadV2TransferPayload.Eof(
                EncryptedUploadV2EofValue(9u, 0u, 1u, 2u, sha(ciphertext), sha(manifest)),
            ),
        )
        val completed = withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { start.receive() }
        }
        assertEquals(HostEventKind.EncryptedUploadV2TransferCompleted, completed.kind)
        val evidence = evidenceFields(ciphertext, manifest)
        host.execute(
            effect(
                CoreEffectKind.EncryptedUploadV2StageArtifacts,
                CoreField.Text(12, materialId), CoreField.Text(14, SinkId), *evidence,
            ),
        ).toList()
        val receipt = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2AwaitReceipt, CoreField.Text(12, materialId), *evidence),
        ).toList().single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val confirmEffect = effect(
            CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt,
            CoreField.Text(12, materialId), CoreField.Bytes(162, receipt),
        )
        val confirming = async {
            host.execute(confirmEffect).toList()
        }
        driverWriteEntered.await()
        val cancellationQuery = async {
            host.confirmationAttemptedOrClaimCancellation(confirmEffect.cancellationId)
        }
        confirmationQueryEntered.await()
        driverWriteRelease.complete(Unit)
        confirmEntered.await()
        confirmationQueryRelease.complete(Unit)
        assertTrue(cancellationQuery.await())
        val cancelling = async { host.cancel(CoreCancellationId(1u, 2u)) }
        confirmRelease.complete(Unit)
        confirming.await()
        cancelling.await()
        assertTrue(host.confirmationAttemptedOrClaimCancellation(confirmEffect.cancellationId))
        host.cancel(CoreCancellationId(1u, 2u))

        assertEquals(
            listOf(
                "signed-1", "control-7", "staging-request", "upload", "manifest",
                "finalize", "receipt", "signed-2", "control-8", "release",
            ),
            actions,
        )
        assertEquals(0, cancelled.get())
        assertFalse(Files.exists(root.resolve("$SinkId.encrypted-upload-v2")))
        start.cancel()
        host.close()
    }

    @Test
    fun disconnectDuringPostWriteCleanupSettlesCompletionBeforeClearingPoison() = runTest {
        val actions = mutableListOf<String>()
        val cancelled = AtomicInteger()
        val registry = EncryptedUploadV2MaterialRegistry()
        registry.register(
            "material-1",
            EncryptedUploadV2Material(
                "material-1", "recording-1", UploadSession, 2u,
                EncryptedUploadV2SecurityPolicy.V2Required, ByteArray(408),
                { Request.Builder().url("https://example.test/upload").put(byteArrayOf().toRequestBody()).build() },
                { _, _ -> }, {}, { ByteArray(336) }, { cancelled.incrementAndGet() },
            ),
        )
        val payloads = Channel<EncryptedUploadV2TransferPayload>(Channel.UNLIMITED)
        val root = Files.createTempDirectory("bota-v2-confirm-disconnect")
        val cleanupEntered = CompletableDeferred<Unit>()
        val cleanupRelease = CompletableDeferred<Unit>()
        val host = host(
            root = root,
            registry = registry,
            payloads = payloads,
            actions = actions,
            confirmEntered = cleanupEntered,
            confirmRelease = cleanupRelease,
            removeConfirmationOwnerBeforeHostContinuation = true,
            confirmFailure = EncryptedUploadV2ConfirmationException(
                writeSucceeded = true,
                message = "CONFIRM succeeded but unsubscribe is uncertain",
                cause = IllegalStateException("disconnected during unsubscribe"),
            ),
        ) {}
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val ciphertext = byteArrayOf(3, 4)
        val manifest = ByteArray(580) { (it % 251).toByte() }
        val start = host.execute(startEffect("material-1", authorizationSha, ciphertext)).produceIn(this)
        assertEquals(HostEventKind.EncryptedUploadV2TransferStarted, start.receive().kind)
        payloads.send(EncryptedUploadV2TransferPayload.Data(EncryptedUploadV2DataValue(9u, 0u, 0u, ciphertext)))
        payloads.send(
            EncryptedUploadV2TransferPayload.WindowEnd(
                EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 0u, 2u, sha(ciphertext), 1u),
            ),
        )
        assertEquals(HostEventKind.EncryptedUploadV2WindowStaged, start.receive().kind)
        val coreCheckpoint = byteArrayOf(7, 8, 9)
        host.execute(effect(CoreEffectKind.EncryptedUploadV2SaveCheckpoint, CoreField.Bytes(28, coreCheckpoint))).toList()
        host.execute(
            effect(CoreEffectKind.EncryptedUploadV2AcknowledgeWindow, CoreField.Bytes(28, coreCheckpoint)),
        ).toList()
        payloads.send(
            EncryptedUploadV2TransferPayload.ManifestChunk(
                EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, sha(manifest), manifest),
            ),
        )
        payloads.send(
            EncryptedUploadV2TransferPayload.Eof(
                EncryptedUploadV2EofValue(9u, 0u, 1u, 2u, sha(ciphertext), sha(manifest)),
            ),
        )
        assertEquals(HostEventKind.EncryptedUploadV2TransferCompleted, start.receive().kind)
        val evidence = evidenceFields(ciphertext, manifest)
        host.execute(
            effect(
                CoreEffectKind.EncryptedUploadV2StageArtifacts,
                CoreField.Text(12, "material-1"), CoreField.Text(14, SinkId), *evidence,
            ),
        ).toList()
        val receipt = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2AwaitReceipt, CoreField.Text(12, "material-1"), *evidence),
        ).toList().single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val confirming = async(Dispatchers.Default) {
            runCatching {
                host.execute(
                    effect(
                        CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt,
                        CoreField.Text(12, "material-1"), CoreField.Bytes(162, receipt),
                    ),
                ).toList()
            }.exceptionOrNull()
        }
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { cleanupEntered.await() } }

        val resetting = async(start = CoroutineStart.UNDISPATCHED) { host.resetAfterConfirmedDisconnect() }
        val resetReturnedBeforeCleanupSettled = resetting.isCompleted
        cleanupRelease.complete(Unit)
        val failure = withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { confirming.await() }
        }
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { resetting.await() } }
        registry.register(
            "material-2",
            EncryptedUploadV2Material(
                "material-2", "recording-2", UploadSession, 2u,
                EncryptedUploadV2SecurityPolicy.V2Required, ByteArray(408),
                { error("unused") }, { _, _ -> }, {}, { ByteArray(336) }, {},
            ),
        )
        val replacement = runCatching {
            host.execute(
                effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-2")),
            ).toList()
        }.exceptionOrNull()

        assertFalse(resetReturnedBeforeCleanupSettled)
        assertEquals(19u, (failure as EncryptedUploadV2HostException).errorCode)
        assertEquals(0, cancelled.get())
        assertFalse(registry.contains("material-1"))
        assertEquals(null, replacement)
        host.close()
    }

    @Test
    fun notificationStreamCompletionBeforeEofFailsTheActiveTransfer() = runTest {
        val registry = registry(AtomicInteger())
        val payloads = Channel<EncryptedUploadV2TransferPayload>(Channel.UNLIMITED)
        val host = host(Files.createTempDirectory("bota-v2-ended"), registry, payloads, mutableListOf()) {}
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val outcomes = Channel<Result<CoreHostEventPayload>>(Channel.UNLIMITED)
        val startJob = launch {
            host.execute(startEffect("material-1", authorizationSha, byteArrayOf(3, 4)))
                .catch { outcomes.send(Result.failure(it)) }
                .collect { outcomes.send(Result.success(it)) }
        }
        assertEquals(HostEventKind.EncryptedUploadV2TransferStarted, outcomes.receive().getOrThrow().kind)

        payloads.close()
        val error = runCatching {
            withContext(Dispatchers.Default) {
                withTimeout(AsyncSettlementTimeoutMilliseconds) { outcomes.receive().getOrThrow() }
            }
        }.exceptionOrNull()

        assertTrue(error.toString(), error is EncryptedUploadV2HostException)
        assertEquals(12u, (error as EncryptedUploadV2HostException).errorCode)
        startJob.join()
        host.close()
    }

    @Test
    fun mixedProfileTransportEmitsTheDedicatedRustWorkflowEvent() = runTest {
        val registry = registry(AtomicInteger())
        val mixedProfile = BotaSDKError.Core(
            BotaErrorCode.ProtocolRejected,
            BotaOperation.Decode,
            false,
            null,
            dev.bota.sdk.internal.core.MixedEncryptedUploadProfile,
        )
        val services = services(registry, mutableListOf()).copyForOpen { _, _ ->
            EncryptedUploadV2OpenResult.Opened(flow { throw mixedProfile })
        }
        val host = EncryptedUploadV2TransferHost(Files.createTempDirectory("bota-v2-mixed"), services)
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value

        val events = withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) {
                host.execute(startEffect("material-1", authorizationSha, byteArrayOf(3, 4))).toList()
            }
        }

        assertEquals(
            listOf(
                HostEventKind.EncryptedUploadV2TransferStarted,
                HostEventKind.EncryptedUploadV2MixedProfile,
            ),
            events.map { it.kind },
        )
        host.close()
    }

    @Test
    fun cancellationSettlesALateSuccessfulOpenWithoutResurrectingTransfer() = runTest {
        val registry = registry(AtomicInteger())
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val actions = mutableListOf<String>()
        val services = services(registry, actions).copyForOpen { _, _ ->
            entered.complete(Unit)
            withContext(NonCancellable) { release.await() }
            EncryptedUploadV2OpenResult.Opened(kotlinx.coroutines.flow.emptyFlow())
        }
        val host = EncryptedUploadV2TransferHost(Files.createTempDirectory("bota-v2-late-open"), services)
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val starting = async {
            runCatching { host.execute(startEffect("material-1", authorizationSha, byteArrayOf(3, 4))).toList() }
        }
        entered.await()

        val cancelling = async { host.cancel(CoreCancellationId(1u, 2u)) }
        release.complete(Unit)
        cancelling.await()
        val error = withTimeout(AsyncSettlementTimeoutMilliseconds) { starting.await() }.exceptionOrNull()

        assertTrue(error.toString(), error != null)
        assertTrue(actions.contains("abort-9"))
        assertFalse(actions.contains("release"))
        host.close()
    }

    @Test
    fun cancellationAfterOpenReturnsCannotInstallTheTransferPump() = runTest {
        val registry = registry(AtomicInteger())
        val returned = CompletableDeferred<Unit>()
        val actions = mutableListOf<String>()
        val services = services(registry, actions).copyForOpen { _, _ ->
            EncryptedUploadV2OpenResult.Opened(kotlinx.coroutines.flow.emptyFlow()).also {
                returned.complete(Unit)
            }
        }
        val host = EncryptedUploadV2TransferHost(Files.createTempDirectory("bota-v2-open-install"), services)
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val starting = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { host.execute(startEffect("material-1", authorizationSha, byteArrayOf(3, 4))).toList() }
        }
        returned.await()

        host.cancel(CoreCancellationId(1u, 2u))
        val error = starting.await().exceptionOrNull()

        assertTrue(error.toString(), error != null)
        assertEquals(1, actions.count { it == "abort-9" })
        host.close()
    }

    @Test
    fun cancellationDuringOpenAbortsTheOwnedSessionAndCleansMaterialOnce() = runTest {
        val registry = EncryptedUploadV2MaterialRegistry()
        val cancelled = AtomicInteger()
        registry.register(
            "material-1",
            EncryptedUploadV2Material(
                "material-1", "recording-1", UploadSession, 2u, EncryptedUploadV2SecurityPolicy.V2Required,
                ByteArray(408), { error("unused") }, { _, _ -> }, {}, { ByteArray(336) },
                { cancelled.incrementAndGet() },
            ),
        )
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val actions = mutableListOf<String>()
        val journals = TestJournals()
        val services = EncryptedUploadV2TransferHostServices(
            registry, EncryptedUploadV2CheckpointStore(journals),
            openTransfer = { _, _ -> entered.complete(Unit); release.await(); error("cancelled open") },
            sendControl = { _, _, _ -> }, confirmTransfer = { _, _, _ -> },
            abortTransfer = { actions += "abort-$it" },
            releaseTransfer = {}, sendSignedDocument = { kind, _, _, _ -> actions += "signed-$kind" },
            uploadCiphertext = { _, _ -> }, cancelUploads = {}, nextWriteId = { 1u },
            encodeAcknowledgement = { byteArrayOf() }, encodeConfirm = { _, _, _, _, _, _ -> byteArrayOf() },
        )
        val host = EncryptedUploadV2TransferHost(Files.createTempDirectory("bota-v2-cancel"), services)
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val starting = async {
            runCatching { host.execute(startEffect("material-1", authorizationSha, byteArrayOf(3, 4))).toList() }
        }
        entered.await()

        val cancelling = async { host.cancel(CoreCancellationId(1u, 2u)) }
        release.complete(Unit)
        cancelling.await()
        starting.await()

        assertTrue(actions.contains("abort-9"))
        assertEquals(1, cancelled.get())
        host.close()
    }

    @Test
    fun confirmedDisconnectBeforeConfirmCancelsMaterialInsteadOfCompletingIt() = runTest {
        val cancelled = AtomicInteger()
        val registry = registry(cancelled)
        val host = EncryptedUploadV2TransferHost(
            Files.createTempDirectory("bota-v2-disconnect"),
            services(registry, mutableListOf()),
        )
        host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()

        val prepare = effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1"))
        assertFalse(host.confirmationAttemptedOrClaimCancellation(prepare.cancellationId))

        host.resetAfterConfirmedDisconnect()

        assertEquals(1, cancelled.get())
        assertFalse(registry.contains("material-1"))
        host.close()
    }

    @Test
    fun replacementWaitsWhileExactTransportResetIsPrepared() = runTest {
        val registry = registry(AtomicInteger())
        val host = EncryptedUploadV2TransferHost(
            Files.createTempDirectory("bota-v2-reset-preparation"),
            services(registry, mutableListOf()),
        )
        val transportResetEntered = CompletableDeferred<Unit>()
        val transportResetRelease = CompletableDeferred<Unit>()
        val replacementPrepared = CompletableDeferred<Unit>()

        val resetting = async(start = CoroutineStart.UNDISPATCHED) {
            host.resetAfterConfirmedDisconnect {
                transportResetEntered.complete(Unit)
                transportResetRelease.await()
                true
            }
        }
        withTimeout(AsyncSettlementTimeoutMilliseconds) { transportResetEntered.await() }
        val replacement = async(start = CoroutineStart.UNDISPATCHED) {
            host.execute(
                effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
            ).toList()
            replacementPrepared.complete(Unit)
        }
        val replacementAdmittedBeforeTransportReset = replacementPrepared.isCompleted
        transportResetRelease.complete(Unit)

        withTimeout(AsyncSettlementTimeoutMilliseconds) { resetting.await() }
        withTimeout(AsyncSettlementTimeoutMilliseconds) { replacement.await() }

        assertFalse(replacementAdmittedBeforeTransportReset)
        assertTrue(replacementPrepared.isCompleted)
        host.close()
    }

    @Test
    fun confirmedDisconnectFailsTheExactOldEffectAndWaitsForItsPumpToExit() = runTest {
        val registry = registry(AtomicInteger())
        val pumpCancellationEntered = CompletableDeferred<Unit>()
        val pumpRelease = CompletableDeferred<Unit>()
        val oldNotifications = flow<EncryptedUploadV2TransferPayload> {
            try {
                awaitCancellation()
            } finally {
                pumpCancellationEntered.complete(Unit)
                withContext(NonCancellable) { pumpRelease.await() }
            }
        }
        val host = EncryptedUploadV2TransferHost(
            Files.createTempDirectory("bota-v2-reset-pump"),
            services(registry, mutableListOf()).copyForOpen { _, _ ->
                EncryptedUploadV2OpenResult.Opened(oldNotifications)
            },
        )
        val prepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val authorizationSha = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val startEvents = Channel<CoreHostEventPayload>(Channel.UNLIMITED)
        val start = async {
            runCatching {
                host.execute(
                    startEffect("material-1", authorizationSha, byteArrayOf(3, 4)),
                ).collect { startEvents.send(it) }
            }
        }
        assertEquals(HostEventKind.EncryptedUploadV2TransferStarted, startEvents.receive().kind)

        val resetting = async(start = CoroutineStart.UNDISPATCHED) { host.resetAfterConfirmedDisconnect() }
        withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { pumpCancellationEntered.await() }
        }
        val resetReturnedBeforePumpExit = resetting.isCompleted
        pumpRelease.complete(Unit)
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { resetting.await() } }
        val terminal = start.await().exceptionOrNull()

        assertFalse(resetReturnedBeforePumpExit)
        assertEquals(12u, (terminal as EncryptedUploadV2HostException).errorCode)
        host.close()
    }

    @Test
    fun replacementWaitsForResetAndCannotBeClosedByTheLateOldPump() = runTest {
        val registry = registry(AtomicInteger())
        registry.register(
            "material-2",
            EncryptedUploadV2Material(
                "material-2", "recording-2", UploadSession, 2u,
                EncryptedUploadV2SecurityPolicy.V2Required, ByteArray(408),
                { error("unused") }, { _, _ -> }, {}, { ByteArray(336) }, {},
            ),
        )
        val oldPumpCancellationEntered = CompletableDeferred<Unit>()
        val oldPumpRelease = CompletableDeferred<Unit>()
        val replacementPayloads = Channel<EncryptedUploadV2TransferPayload>(Channel.UNLIMITED)
        val opens = AtomicInteger()
        val actions = mutableListOf<String>()
        val host = EncryptedUploadV2TransferHost(
            Files.createTempDirectory("bota-v2-reset-replacement"),
            services(registry, actions).copyForOpen { _, _ ->
                if (opens.getAndIncrement() == 0) {
                    EncryptedUploadV2OpenResult.Opened(flow {
                        try {
                            awaitCancellation()
                        } finally {
                            oldPumpCancellationEntered.complete(Unit)
                            withContext(NonCancellable) { oldPumpRelease.await() }
                        }
                    })
                } else {
                    EncryptedUploadV2OpenResult.Opened(replacementPayloads.receiveAsFlow())
                }
            },
        )
        val firstPrepared = host.execute(
            effect(CoreEffectKind.EncryptedUploadV2PrepareSession, CoreField.Text(12, "material-1")),
        ).toList()
        val firstAuthorization = firstPrepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
        val firstStartEvents = Channel<CoreHostEventPayload>(Channel.UNLIMITED)
        val firstStart = async {
            runCatching {
                host.execute(
                    startEffect("material-1", firstAuthorization, byteArrayOf(3, 4)),
                ).collect { firstStartEvents.send(it) }
            }
        }
        assertEquals(HostEventKind.EncryptedUploadV2TransferStarted, firstStartEvents.receive().kind)

        val resetting = async(start = CoroutineStart.UNDISPATCHED) { host.resetAfterConfirmedDisconnect() }
        withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { oldPumpCancellationEntered.await() }
        }
        val replacementStarted = CompletableDeferred<Unit>()
        val replacementCancellation = CoreCancellationId(9u, 10u)
        val replacement = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching {
                val prepared = host.execute(
                    effect(
                        CoreEffectKind.EncryptedUploadV2PrepareSession,
                        CoreField.Text(12, "material-2"),
                        cancellationId = replacementCancellation,
                    ),
                ).toList()
                val authorization = prepared.single().fields.filterIsInstance<CoreField.Bytes>().single().value
                host.execute(
                    startEffect(
                        "material-2", authorization, byteArrayOf(3, 4),
                        cancellationId = replacementCancellation,
                    ),
                ).collect { event ->
                    if (event.kind == HostEventKind.EncryptedUploadV2TransferStarted) {
                        replacementStarted.complete(Unit)
                    }
                }
            }
        }
        val replacementStartedBeforeOldPumpExit = replacementStarted.isCompleted
        val replacementPreparedBeforeOldPumpExit = actions.count { it == "signed-1" } > 1
        oldPumpRelease.complete(Unit)
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { resetting.await() } }
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { firstStart.await() } }
        withContext(Dispatchers.Default) {
            withTimeout(AsyncSettlementTimeoutMilliseconds) { replacementStarted.await() }
        }
        val replacementFinishedBeforeOwnCancellation = replacement.isCompleted
        host.cancel(replacementCancellation)
        withContext(Dispatchers.Default) { withTimeout(AsyncSettlementTimeoutMilliseconds) { replacement.await() } }

        assertFalse(replacementStartedBeforeOldPumpExit)
        assertFalse(replacementPreparedBeforeOldPumpExit)
        assertFalse(replacementFinishedBeforeOwnCancellation)
        host.close()
    }

    private fun host(
        root: java.nio.file.Path,
        registry: EncryptedUploadV2MaterialRegistry,
        payloads: Channel<EncryptedUploadV2TransferPayload>,
        actions: MutableList<String>,
        driverWriteEntered: CompletableDeferred<Unit>? = null,
        driverWriteRelease: CompletableDeferred<Unit>? = null,
        confirmEntered: CompletableDeferred<Unit>? = null,
        confirmRelease: CompletableDeferred<Unit>? = null,
        confirmationQueryEntered: CompletableDeferred<Unit>? = null,
        confirmationQueryRelease: CompletableDeferred<Unit>? = null,
        removeConfirmationOwnerBeforeHostContinuation: Boolean = false,
        confirmFailure: Throwable? = null,
        upload: (java.nio.file.Path) -> Unit,
    ): EncryptedUploadV2TransferHost {
        val confirmationOwnerPresent = AtomicBoolean(false)
        val services = EncryptedUploadV2TransferHostServices(
            registry, EncryptedUploadV2CheckpointStore(TestJournals()),
            openTransfer = { _, _ -> EncryptedUploadV2OpenResult.Opened(payloads.receiveAsFlow()) },
            sendControl = { _, value, _ -> actions += "control-${value.single()}" },
            confirmTransfer = { _, value, writeSucceeded ->
                confirmationOwnerPresent.set(true)
                driverWriteEntered?.complete(Unit)
                driverWriteRelease?.await()
                writeSucceeded()
                if (removeConfirmationOwnerBeforeHostContinuation) {
                    confirmationOwnerPresent.set(false)
                }
                confirmEntered?.complete(Unit)
                confirmRelease?.await()
                actions += "control-${value.single()}"
                actions += "release"
                confirmFailure?.let { throw it }
            },
            confirmationAttemptedOrClaimCancellation = {
                confirmationQueryEntered?.complete(Unit)
                confirmationQueryRelease?.await()
                confirmationOwnerPresent.get()
            },
            abortTransfer = { actions += "abort" }, releaseTransfer = { actions += "release" },
            sendSignedDocument = { kind, _, _, expected ->
                assertEquals(if (kind == 1.toUByte()) 408u.toUShort() else 336u.toUShort(), expected)
                if (kind == 2.toUByte()) {
                    assertFalse(Files.exists(root.resolve("$SinkId.encrypted-upload-v2")))
                }
                actions += "signed-$kind"
            },
            uploadCiphertext = { _, path -> upload(path); actions += "upload" },
            cancelUploads = {}, nextWriteId = { 1u },
            encodeAcknowledgement = { byteArrayOf(7) },
            encodeConfirm = { _, _, _, _, _, _ -> byteArrayOf(8) },
        )
        return EncryptedUploadV2TransferHost(root, services)
    }

    private fun registry(cancelled: AtomicInteger): EncryptedUploadV2MaterialRegistry =
        EncryptedUploadV2MaterialRegistry().also { registry ->
            kotlinx.coroutines.runBlocking {
                registry.register(
                    "material-1",
                    EncryptedUploadV2Material(
                        "material-1", "recording-1", UploadSession, 2u,
                        EncryptedUploadV2SecurityPolicy.V2Required, ByteArray(408),
                        { error("unused") }, { _, _ -> }, {}, { ByteArray(336) },
                        { cancelled.incrementAndGet() },
                    ),
                )
            }
        }

    private fun services(
        registry: EncryptedUploadV2MaterialRegistry,
        actions: MutableList<String>,
    ) = EncryptedUploadV2TransferHostServices(
        registry, EncryptedUploadV2CheckpointStore(TestJournals()),
        openTransfer = { _, _ -> error("replace in test") },
        sendControl = { _, _, _ -> }, confirmTransfer = { _, _, _ -> },
        abortTransfer = { actions += "abort-$it" },
        releaseTransfer = { actions += "release" }, sendSignedDocument = { kind, _, _, _ -> actions += "signed-$kind" },
        uploadCiphertext = { _, _ -> }, cancelUploads = {}, nextWriteId = { 1u },
        encodeAcknowledgement = { byteArrayOf(7) }, encodeConfirm = { _, _, _, _, _, _ -> byteArrayOf(8) },
    )

    private fun EncryptedUploadV2TransferHostServices.copyForOpen(
        open: suspend (dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest, dev.bota.sdk.internal.bluetooth.EncryptedUploadV2CheckpointValue?) -> EncryptedUploadV2OpenResult,
    ) = EncryptedUploadV2TransferHostServices(
        materialRegistry = materialRegistry,
        checkpointStore = checkpointStore,
        openTransfer = open,
        sendControl = sendControl,
        confirmTransfer = confirmTransfer,
        confirmationAttemptedOrClaimCancellation = confirmationAttemptedOrClaimCancellation,
        abortTransfer = abortTransfer,
        releaseTransfer = releaseTransfer,
        sendSignedDocument = sendSignedDocument,
        uploadCiphertext = uploadCiphertext,
        cancelUploads = cancelUploads,
        nextWriteId = nextWriteId,
        encodeAcknowledgement = encodeAcknowledgement,
        encodeConfirm = encodeConfirm,
    )

    private fun startEffect(
        materialId: String,
        authorizationSha: ByteArray,
        ciphertext: ByteArray,
        cancellationId: CoreCancellationId = CoreCancellationId(0u, 0u),
    ) = effect(
        CoreEffectKind.EncryptedUploadV2StartTransfer,
        CoreField.Text(3, "EVFXXW67KP"), CoreField.Text(13, RecordingId), CoreField.Unsigned(129, 4u),
        CoreField.Unsigned(147, 3u), CoreField.Bytes(132, uuidBytes(UploadSession)), CoreField.Unsigned(165, 2u),
        CoreField.Unsigned(128, 9u), CoreField.Text(12, materialId), CoreField.Text(14, SinkId),
        CoreField.Unsigned(137, 0x7fu), CoreField.Unsigned(138, 408u), CoreField.Unsigned(139, 580u),
        CoreField.Unsigned(169, 2u), CoreField.Unsigned(170, 1u), CoreField.Unsigned(140, 1u),
        CoreField.Unsigned(141, 1u), CoreField.Unsigned(134, 1u), CoreField.Unsigned(135, 2u),
        CoreField.Unsigned(130, ciphertext.size.toULong()), CoreField.Bytes(144, sha(ciphertext)),
        CoreField.Bytes(161, authorizationSha),
        cancellationId = cancellationId,
    )

    private fun evidenceFields(ciphertext: ByteArray, manifest: ByteArray): Array<CoreField> = arrayOf(
        CoreField.Unsigned(130, ciphertext.size.toULong()), CoreField.Bytes(144, sha(ciphertext)),
        CoreField.Unsigned(168, 580u), CoreField.Bytes(142, sha(manifest)), CoreField.Unsigned(145, 1u),
    )

    private fun effect(
        kind: CoreEffectKind,
        vararg fields: CoreField,
        cancellationId: CoreCancellationId = CoreCancellationId(0u, 0u),
    ) = CoreEffect(
        kind,
        fields.toList().toNativePacket(
            kind.wireValue,
            operation = 8,
            requestId = 1u,
            cancellationId = cancellationId,
        ),
    )

    private fun uuidBytes(id: UUID) = java.nio.ByteBuffer.allocate(16)
        .putLong(id.mostSignificantBits).putLong(id.leastSignificantBits).array()

    private fun sha(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value)

    private companion object {
        const val AsyncSettlementTimeoutMilliseconds = 5_000L
        val UploadSession: UUID = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        const val RecordingId = "00112233-4455-6677-8899-aabbccddeeff"
        const val SinkId = "11111111-2222-3333-4444-555555555555"
    }
}

private class TestJournals : JournalStore {
    private val values = mutableMapOf<String, ByteArray>()
    override suspend fun read(name: String): ByteArray? = values[name]
    override suspend fun write(name: String, value: ByteArray) { values[name] = value.copyOf() }
    override suspend fun delete(name: String) { values.remove(name) }
}
