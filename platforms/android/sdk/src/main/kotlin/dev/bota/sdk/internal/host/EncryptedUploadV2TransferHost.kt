package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2Checkpoint
import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2CheckpointValue
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2OpenResult
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferReceiver
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferReceiverEvent
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferContinuation
import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.internal.core.MixedEncryptedUploadProfile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

internal class EncryptedUploadV2TransferHostServices(
    val materialRegistry: EncryptedUploadV2MaterialRegistry,
    val checkpointStore: EncryptedUploadV2CheckpointStore,
    val openTransfer: suspend (EncryptedUploadV2StartRequest, EncryptedUploadV2CheckpointValue?) -> EncryptedUploadV2OpenResult,
    val sendControl: suspend (ULong, ByteArray, EncryptedUploadV2TransferContinuation) -> Unit,
    val confirmTransfer: suspend (ULong, ByteArray, () -> Unit) -> Unit,
    val confirmationAttemptedOrClaimCancellation: suspend (ULong) -> Boolean = { false },
    val abortTransfer: suspend (ULong) -> Unit,
    val releaseTransfer: suspend (ULong) -> Unit,
    val sendSignedDocument: suspend (UByte, UInt, ByteArray, UShort) -> Unit,
    val uploadCiphertext: suspend (okhttp3.Request, Path) -> Unit,
    val cancelUploads: () -> Unit,
    val nextWriteId: () -> UInt,
    val encodeAcknowledgement: (dev.bota.sdk.internal.bluetooth.EncryptedUploadV2WindowAcknowledgement) -> ByteArray,
    val encodeConfirm: (ULong, UUID, String, UInt, UInt, ByteArray) -> ByteArray,
    val refreshUploadContext: suspend (dev.bota.sdk.EncryptedUploadV2ContextProvider) -> Unit = {
        error("upload context exchange unavailable")
    },
)

internal class EncryptedUploadV2TransferHost(
    private val rootDirectory: Path,
    private val services: EncryptedUploadV2TransferHostServices,
) : EncryptedUploadV2Host, AutoCloseable {
    private data class Context(
        val serialNumber: String,
        val recordingUuid: String,
        val recordingGeneration: UInt,
        val uploadSessionId: UUID,
        val uploadSessionBytes: ByteArray,
        val ownerRevision: UInt,
        val transportSessionId: ULong,
        val materialId: String,
        val sinkId: String,
        val windowPackets: UShort,
        val dataPayloadBytes: UShort,
        val checkpointInterval: UInt,
        val maximumMissingSequences: UShort,
        val ciphertextLength: ULong,
        val ciphertextSha256: ByteArray,
        val authorizationSha256: ByteArray,
    )

    private data class DetachedLifecycle(
        val openingJob: Deferred<EncryptedUploadV2OpenResult>?,
        val pumpJob: Job?,
        val startEvents: Channel<CoreHostEventPayload>?,
        val boundaryTarget: Channel<CoreHostEventPayload>?,
        val pendingResume: CompletableDeferred<Unit>?,
        val materialId: String?,
        val materialLease: EncryptedUploadV2MaterialLease?,
        val materialOutcome: EncryptedUploadV2TerminalOutcome,
    )

    private data class CancelledLifecycle(
        val transportSessionId: ULong?,
        val openingJob: Deferred<EncryptedUploadV2OpenResult>?,
        val pumpJob: Job?,
        val startEvents: Channel<CoreHostEventPayload>?,
        val boundaryTarget: Channel<CoreHostEventPayload>?,
        val pendingResume: CompletableDeferred<Unit>?,
        val materialId: String?,
        val materialLease: EncryptedUploadV2MaterialLease?,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val stateLock = Any()
    private var generation = 0L
    private var loadedCheckpoint: PersistedEncryptedUploadV2Checkpoint? = null
    private var activeContext: Context? = null
    private var receiver: EncryptedUploadV2TransferReceiver? = null
    private var preparedMaterialId: String? = null
    private var preparedAuthorizationSha256: ByteArray? = null
    private var materialLease: EncryptedUploadV2MaterialLease? = null
    private var pendingCheckpoint: EncryptedUploadV2CheckpointValue? = null
    private var pendingMissing: List<UInt> = emptyList()
    private var persistedCoreCheckpoint: ByteArray? = null
    private var completedTransfer: dev.bota.sdk.internal.bluetooth.EncryptedUploadV2CompletedTransferValue? = null
    private var stagedEvidence: EncryptedUploadV2TransferEvidence? = null
    private var acceptedReceipt: EncryptedUploadV2AcceptedReceipt? = null
    private var pumpJob: Job? = null
    private var openingSessionId: ULong? = null
    private var openingJob: Deferred<EncryptedUploadV2OpenResult>? = null
    private var pendingResume: CompletableDeferred<Unit>? = null
    private var boundaryTarget: Channel<CoreHostEventPayload>? = null
    private var startEvents: Channel<CoreHostEventPayload>? = null
    private var confirmationAttempted = false
    private var confirmationSucceeded = false
    private var confirmationFinished: CompletableDeferred<Result<Unit>>? = null
    private var activeCancellationId: CoreCancellationId? = null
    private var confirmationCancellationId: CoreCancellationId? = null
    private var cancellationStarted = false
    private var ownershipPoisoned = false
    private var resetFinished: CompletableDeferred<Unit>? = null

    suspend fun checkpoint(serialNumber: String, recordingUuid: String, generation: UInt): EncryptedUploadV2Checkpoint? {
        val value = services.checkpointStore.loadForRecording(serialNumber, recordingUuid, generation) ?: return null
        return EncryptedUploadV2Checkpoint(
            value.uploadSessionId, value.ownerRevision, value.revision, value.nextCiphertextOffset,
            value.prefixSha256, value.highestContiguousSequence, value.transportSessionId,
            value.sinkId, value.windowPackets, value.dataPayloadBytes,
            value.ciphertextLength, value.ciphertextSha256, value.checkpointIntervalBlocks,
        )
    }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        beginEffect(effect)
        val upstream = when (effect.kind) {
            CoreEffectKind.EncryptedUploadV2LoadCheckpoint -> loadCheckpoint(effect)
            CoreEffectKind.EncryptedUploadV2DeleteCheckpoint -> deleteCheckpoint(effect)
            CoreEffectKind.EncryptedUploadV2TruncateSink -> truncateSink(effect)
            CoreEffectKind.EncryptedUploadV2PrepareSession -> prepareSession(effect)
            CoreEffectKind.EncryptedUploadV2StartTransfer -> startTransfer(effect)
            CoreEffectKind.EncryptedUploadV2RepairWindow -> repairWindow(effect)
            CoreEffectKind.EncryptedUploadV2SaveCheckpoint -> saveCheckpoint(effect)
            CoreEffectKind.EncryptedUploadV2AcknowledgeWindow -> acknowledgeWindow(effect)
            CoreEffectKind.EncryptedUploadV2StageArtifacts -> stageArtifacts(effect)
            CoreEffectKind.EncryptedUploadV2AwaitReceipt -> awaitReceipt(effect)
            CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt -> confirmWithReceipt(effect)
            CoreEffectKind.EncryptedUploadV2Abort -> abort(effect)
            else -> flow<CoreHostEventPayload> { fail(7u, "non-v2 effect reached encrypted upload v2 host") }
        }
        upstream.collect { emit(it) }
    }

    override suspend fun confirmationAttemptedOrClaimCancellation(
        cancellationId: CoreCancellationId,
    ): Boolean {
        val transportSessionId = synchronized(stateLock) {
            if (confirmationCancellationId == cancellationId && confirmationAttempted) return true
            if (activeCancellationId != cancellationId) return false
            activeContext?.transportSessionId
        }
        val attempted = transportSessionId?.let {
            services.confirmationAttemptedOrClaimCancellation(it)
        } == true
        return synchronized(stateLock) {
            if (confirmationCancellationId == cancellationId && confirmationAttempted) {
                true
            } else if (attempted) {
                confirmationAttempted = true
                confirmationCancellationId = cancellationId
                true
            } else if (activeCancellationId == cancellationId) {
                cancellationStarted = true
                false
            } else {
                false
            }
        }
    }

    override suspend fun cancel(cancellationId: CoreCancellationId) {
        abortState(EncryptedUploadV2TerminalOutcome.Cancelled)
    }

    override fun close() {
        try {
            runBlocking { abortState(EncryptedUploadV2TerminalOutcome.Cancelled) }
        } finally {
            scope.coroutineContext[Job]?.cancel()
        }
    }

    suspend fun resetAfterConfirmedDisconnect(
        resetTransportOwnership: suspend () -> Boolean = { true },
    ) {
        val barrier = CompletableDeferred<Unit>()
        val pendingReset = synchronized(stateLock) {
            resetFinished?.also { return@synchronized it }
            resetFinished = barrier
            null
        }
        if (pendingReset != null) {
            pendingReset.await()
            return
        }
        try {
            withContext(NonCancellable) {
                if (!resetTransportOwnership()) return@withContext
                synchronized(stateLock) { confirmationFinished }?.await()
                val disconnected = EncryptedUploadV2HostException(
                    12u,
                    true,
                    message = "confirmed disconnect interrupted encrypted upload v2",
                )
                val detached = synchronized(stateLock) {
                    generation += 1
                    DetachedLifecycle(
                        openingJob = openingJob,
                        pumpJob = pumpJob,
                        startEvents = startEvents,
                        boundaryTarget = boundaryTarget,
                        pendingResume = pendingResume,
                        materialId = preparedMaterialId ?: activeContext?.materialId,
                        materialLease = materialLease,
                        materialOutcome = if (confirmationSucceeded) {
                            EncryptedUploadV2TerminalOutcome.Completed
                        } else {
                            EncryptedUploadV2TerminalOutcome.Failed
                        },
                    ).also { clearStateLocked() }
                }
                detached.pendingResume?.completeExceptionally(disconnected)
                detached.startEvents?.close(disconnected)
                if (detached.boundaryTarget !== detached.startEvents) {
                    detached.boundaryTarget?.close(disconnected)
                }
                detached.openingJob?.cancelAndJoin()
                detached.pumpJob?.cancelAndJoin()
                if (detached.materialId != null && detached.materialLease != null) {
                    runCatching {
                        services.materialRegistry.terminate(
                            detached.materialId,
                            detached.materialLease,
                            detached.materialOutcome,
                        )
                    }
                }
                synchronized(stateLock) { ownershipPoisoned = false }
            }
        } finally {
            synchronized(stateLock) {
                if (resetFinished === barrier) resetFinished = null
            }
            barrier.complete(Unit)
        }
    }

    private fun loadCheckpoint(effect: CoreEffect) = flow {
        val session = requiredUuid(effect, 132)
        val value = services.checkpointStore.load(session)
        if (value != null) {
            requireValue(value.serialNumber == requiredText(effect, 3), "checkpoint serial number is stale")
            requireValue(value.recordingUuid == requiredText(effect, 13), "checkpoint recording is stale")
            requireValue(value.recordingGeneration == requiredUInt(effect, 129), "checkpoint generation is stale")
            requireValue(value.ownerRevision == requiredUInt(effect, 165), "checkpoint owner revision is stale")
        }
        loadedCheckpoint = value
        emit(
            CoreHostEventPayload(
                HostEventKind.EncryptedUploadV2CheckpointLoaded,
                value?.let { listOf(CoreField.Bytes(28, it.coreCheckpoint)) }.orEmpty(),
            ),
        )
    }

    private fun deleteCheckpoint(effect: CoreEffect) = flow<CoreHostEventPayload> {
        services.checkpointStore.delete(requiredUuid(effect, 132))
        loadedCheckpoint = null
    }

    private fun truncateSink(effect: CoreEffect) = flow {
        val sinkId = requiredText(effect, 14)
        requireValue(runCatching { UUID.fromString(sinkId) }.isSuccess, "sink ID is invalid")
        var offset = requiredULong(effect, 39)
        loadedCheckpoint?.let {
            requireValue(
                it.sinkId == sinkId && (it.replayBoundary?.offset ?: it.nextCiphertextOffset) == offset,
                "sink truncation is stale",
            )
            offset = it.nextCiphertextOffset
        } ?: requireValue(offset == 0uL, "nonzero truncation requires a checkpoint")
        val file = sinkFile(sinkId)
        if (Files.exists(file)) {
            FileChannel.open(file, StandardOpenOption.WRITE).use {
                it.truncate(offset.toLong())
                it.force(true)
            }
        }
        emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2SinkTruncated))
    }

    private fun prepareSession(effect: CoreEffect) = flow {
        requireValue(!synchronized(stateLock) { ownershipPoisoned }, "encrypted upload ownership is uncertain", 19u)
        requireValue(activeContext == null && materialLease == null, "another encrypted upload v2 session is active", 8u)
        val materialId = requiredText(effect, 12)
        val prepared = services.materialRegistry.preparedMaterial(materialId)
        services.materialRegistry.refreshUploadContext(materialId, prepared.lease, services.refreshUploadContext)
        services.sendSignedDocument(1u, nonzeroWriteId(), prepared.authorization, 408u)
        preparedMaterialId = materialId
        preparedAuthorizationSha256 = prepared.authorizationSha256
        materialLease = prepared.lease
        emit(
            CoreHostEventPayload(
                HostEventKind.EncryptedUploadV2SessionPrepared,
                listOf(CoreField.Bytes(161, prepared.authorizationSha256)),
            ),
        )
    }

    private fun startTransfer(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        requireValue(activeContext == null && pumpJob == null, "another encrypted upload v2 transfer is active", 8u)
        val context = context(effect)
        requireValue(context.materialId == preparedMaterialId, "START material was not prepared")
        requireValue(
            preparedAuthorizationSha256?.let { MessageDigest.isEqual(it, context.authorizationSha256) } == true,
            "START authorization does not match prepared material",
        )
        val persisted = effect.packet.bytes(28)?.let { core ->
            val loaded = loadedCheckpoint ?: fail(11u, "resume checkpoint is not loaded")
            requireValue(loaded.coreCheckpoint.contentEquals(core) && loaded.matches(context), "resume checkpoint is stale")
            loaded
        }
        val checkpoint = persisted?.nativeCheckpoint ?: EncryptedUploadV2CheckpointValue(
            0u, 0u, MessageDigest.getInstance("SHA-256").digest(byteArrayOf()), null,
        )
        var transferReceiver = createReceiver(context, checkpoint)
        transferReceiver.prepare()
        val request = EncryptedUploadV2StartRequest(
            context.transportSessionId, context.uploadSessionId, context.recordingUuid,
            context.recordingGeneration, context.authorizationSha256, context.ciphertextLength,
            context.ciphertextSha256, context.checkpointInterval, checkpoint.revision,
            checkpoint.nextCiphertextOffset, checkpoint.prefixSha256, context.windowPackets,
            context.dataPayloadBytes,
        )
        val callerContext = currentCoroutineContext()
        var startGeneration = 0L
        var cancelOpening: suspend () -> Unit = {}
        suspend fun ensureOpening() {
            callerContext.ensureActive()
            currentCoroutineContext().ensureActive()
            synchronized(stateLock) {
                requireValue(
                    generation == startGeneration && openingSessionId == context.transportSessionId && !cancellationStarted,
                    "encrypted transfer opening was cancelled", 16u,
                )
            }
        }
        val opening = scope.async(start = CoroutineStart.LAZY) {
            try {
                ensureOpening()
                val result = services.openTransfer(request, persisted?.nativeCheckpoint?.takeIf { it.nextCiphertextOffset > 0uL })
                cancelOpening = result.cancel
                when (result) {
                    is EncryptedUploadV2OpenResult.Opened -> result
                    is EncryptedUploadV2OpenResult.ResumeRejected -> {
                        ensureOpening()
                        result.assertActive()
                        val original = persisted ?: fail(11u, "START cannot reconcile a rejected checkpoint")
                        val reconciled = transferReceiver.reconciliationCheckpoint(result.value)
                        val recovered = original.copy(
                            revision = reconciled.revision,
                            nextCiphertextOffset = reconciled.nextCiphertextOffset,
                            prefixSha256 = reconciled.prefixSha256,
                            highestContiguousSequence = reconciled.highestContiguousSequence,
                            replayBoundary = original.replayBoundary ?: EncryptedUploadV2ReplayBoundary(
                                original.revision, original.nextCiphertextOffset,
                            ),
                        )
                        ensureOpening()
                        // Keep Rust's opaque checkpoint as the forward-progress boundary.
                        // The native durable prefix must move back before any bytes are removed.
                        services.checkpointStore.save(recovered)
                        ensureOpening()
                        result.assertActive()
                        transferReceiver = createReceiver(context, reconciled)
                        transferReceiver.prepare()
                        ensureOpening()
                        result.assertActive()
                        synchronized(stateLock) {
                            requireValue(generation == startGeneration && !cancellationStarted, "transfer was cancelled", 16u)
                            loadedCheckpoint = recovered
                        }
                        result.retry(reconciled)
                    }
                }
            } catch (error: Throwable) {
                withContext(NonCancellable) {
                    runCatching { cancelOpening() }
                        .exceptionOrNull()?.let { if (it !== error) error.addSuppressed(it) }
                }
                throw error
            }
        }
        startGeneration = synchronized(stateLock) {
            generation += 1
            openingSessionId = context.transportSessionId
            openingJob = opening
            generation
        }
        opening.start()
        val opened = try {
            opening.await()
        } catch (error: CancellationException) {
            withContext(NonCancellable) {
                opening.cancelAndJoin()
                runCatching { cancelOpening() }.exceptionOrNull()?.let { if (it !== error) error.addSuppressed(it) }
            }
            if (currentCoroutineContext().isActive && synchronized(stateLock) { generation != startGeneration }) {
                fail(16u, "encrypted transfer opening was cancelled")
            }
            throw error
        }
        val events = Channel<CoreHostEventPayload>(capacity = 4)
        val installed = synchronized(stateLock) {
            val owned = generation == startGeneration && openingSessionId == context.transportSessionId && !cancellationStarted
            if (owned) {
                openingSessionId = null
                openingJob = null
                activeContext = context
                receiver = transferReceiver
                startEvents = events
                boundaryTarget = events
                pumpJob = scope.launch {
                    pump(startGeneration, context, events, opened.notifications, transferReceiver)
                }
            }
            owned
        }
        if (!installed) {
            withContext(NonCancellable) { opened.cancel() }
            fail(16u, "encrypted transfer opening was cancelled")
        }
        emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2TransferStarted))
        for (event in events) emit(event)
    }

    private fun repairWindow(effect: CoreEffect) = flow {
        val transferReceiver = receiver ?: fail(9u, "no repairable window")
        val missing = decodeUInts(requiredBytes(effect, 136))
        requireValue(missing == pendingMissing && missing.isNotEmpty(), "repair sequence list is stale")
        val acknowledgement = transferReceiver.repairAcknowledgement(missing)
        val next = Channel<CoreHostEventPayload>(1)
        boundaryTarget = next
        services.sendControl(
            acknowledgement.transportSessionId,
            encode(acknowledgement),
            EncryptedUploadV2TransferContinuation.Repair(missing.toSet()),
        )
        pendingResume?.complete(Unit)
        val event = next.receive()
        emit(event)
    }

    private fun saveCheckpoint(effect: CoreEffect) = flow {
        val context = activeContext ?: fail(9u, "no staged window")
        val checkpoint = pendingCheckpoint ?: fail(9u, "no staged checkpoint")
        requireValue(pendingMissing.isEmpty(), "cannot persist an incomplete window")
        val core = requiredBytes(effect, 28)
        val persisted = PersistedEncryptedUploadV2Checkpoint(
            core, context.serialNumber, context.recordingUuid, context.recordingGeneration,
            context.uploadSessionId, context.ownerRevision, context.transportSessionId,
            context.sinkId, context.windowPackets, context.dataPayloadBytes, checkpoint.revision,
            checkpoint.nextCiphertextOffset, checkpoint.prefixSha256, checkpoint.highestContiguousSequence,
            ciphertextLength = context.ciphertextLength, ciphertextSha256 = context.ciphertextSha256,
            checkpointIntervalBlocks = context.checkpointInterval,
        )
        services.checkpointStore.save(persisted)
        receiver?.checkpointDidPersist(checkpoint)
        loadedCheckpoint = persisted
        persistedCoreCheckpoint = core.copyOf()
        emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2CheckpointSaved))
    }

    private fun acknowledgeWindow(effect: CoreEffect) = flow {
        val context = activeContext ?: fail(9u, "no active transfer")
        val checkpoint = pendingCheckpoint ?: fail(9u, "no persisted window")
        val core = requiredBytes(effect, 28)
        requireValue(persistedCoreCheckpoint?.contentEquals(core) == true, "checkpoint acknowledgement is stale")
        val acknowledgement = receiver?.windowAcknowledgement(checkpoint) ?: fail(9u, "receiver is missing")
        boundaryTarget = startEvents ?: fail(9u, "START stream is missing")
        services.sendControl(
            context.transportSessionId,
            encode(acknowledgement),
            if (checkpoint.nextCiphertextOffset == context.ciphertextLength) {
                EncryptedUploadV2TransferContinuation.Manifest
            } else {
                EncryptedUploadV2TransferContinuation.Window
            },
        )
        pendingCheckpoint = null
        pendingMissing = emptyList()
        persistedCoreCheckpoint = null
        pendingResume?.complete(Unit)
        emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2WindowAcknowledged, listOf(CoreField.Bytes(28, core))))
    }

    private fun stageArtifacts(effect: CoreEffect) = flow {
        val state = completionState(effect, requireSink = true)
        val shouldUpload = services.materialRegistry.shouldUploadCiphertext(state.context.materialId, state.lease, state.completed.evidence)
        withContext(Dispatchers.IO) {
            val digest = MessageDigest.getInstance("SHA-256")
            var length = 0uL
            Files.newInputStream(state.completed.file).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    length += count.toULong()
                    digest.update(buffer, 0, count)
                }
            }
            requireValue(length == state.completed.evidence.ciphertextLength &&
                MessageDigest.isEqual(digest.digest(), state.completed.evidence.ciphertextSha256),
                "staged ciphertext identity changed", 18u)
        }
        if (shouldUpload) {
            val request = services.materialRegistry.stagingRequest(state.context.materialId, state.lease, state.completed.evidence)
            services.uploadCiphertext(request, state.completed.file)
        }
        services.materialRegistry.submitManifest(
            state.context.materialId, state.lease, state.completed.manifest, state.completed.evidence,
        )
        stagedEvidence = state.completed.evidence
        emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2ArtifactsStaged))
    }

    private fun awaitReceipt(effect: CoreEffect) = flow {
        val state = completionState(effect, requireSink = false)
        requireValue(stagedEvidence?.let { sameEvidence(it, state.completed.evidence) } == true, "artifacts are not staged")
        val receipt = services.materialRegistry.finalizeAndReceiveReceipt(
            state.context.materialId, state.lease, state.completed.evidence,
        )
        acceptedReceipt = receipt
        emit(
            CoreHostEventPayload(
                HostEventKind.EncryptedUploadV2ReceiptAccepted,
                listOf(CoreField.Bytes(162, receipt.receiptSha256)),
            ),
        )
    }

    private fun confirmWithReceipt(effect: CoreEffect) = flow {
        val context = activeContext ?: fail(9u, "transfer is not complete")
        val completed = completedTransfer ?: fail(9u, "transfer is not complete")
        val lease = materialLease ?: fail(9u, "material lease is missing")
        val receipt = acceptedReceipt ?: fail(9u, "receipt is not accepted")
        requireValue(!synchronized(stateLock) { cancellationStarted }, "transfer cancellation already started", 16u)
        requireValue(requiredText(effect, 12) == context.materialId, "CONFIRM material is stale")
        requireValue(MessageDigest.isEqual(requiredBytes(effect, 162), receipt.receiptSha256), "CONFIRM receipt is stale")
        services.materialRegistry.refreshUploadContext(context.materialId, lease, services.refreshUploadContext)
        services.checkpointStore.delete(context.uploadSessionId)
        if (Files.deleteIfExists(completed.file)) syncDirectory(completed.file.parent)
        services.sendSignedDocument(2u, nonzeroWriteId(), receipt.receipt, 336u)
        val frame = services.encodeConfirm(
            context.transportSessionId, context.uploadSessionId, context.recordingUuid,
            context.recordingGeneration, context.ownerRevision, receipt.receiptSha256,
        )
        val finished = CompletableDeferred<Result<Unit>>()
        val canConfirm = synchronized(stateLock) {
            (!cancellationStarted && activeContext === context && materialLease == lease && acceptedReceipt === receipt)
                .also { allowed ->
                if (allowed) {
                    confirmationFinished = finished
                }
            }
        }
        requireValue(canConfirm, "transfer cancellation already started", 16u)
        try {
            services.confirmTransfer(context.transportSessionId, frame) {
                synchronized(stateLock) {
                    confirmationAttempted = true
                    confirmationCancellationId = effect.cancellationId
                    confirmationSucceeded = true
                }
            }
            services.materialRegistry.terminate(context.materialId, lease, EncryptedUploadV2TerminalOutcome.Completed)
            emit(CoreHostEventPayload(HostEventKind.EncryptedUploadV2RecordingConfirmed))
            clearState(preserveConfirmation = true)
            finished.complete(Result.success(Unit))
        } catch (error: Throwable) {
            val transportFailure = error as? EncryptedUploadV2ConfirmationException
            val attempted = synchronized(stateLock) {
                confirmationAttempted || transportFailure != null
            }
            if (!attempted) {
                finished.complete(Result.failure(error))
                throw error
            }
            synchronized(stateLock) {
                confirmationAttempted = true
                confirmationCancellationId = effect.cancellationId
            }
            val didConfirm = synchronized(stateLock) { confirmationSucceeded } ||
                transportFailure?.writeSucceeded == true
            if (didConfirm) {
                synchronized(stateLock) { confirmationSucceeded = true }
                runCatching {
                    services.materialRegistry.terminate(
                        context.materialId, lease, EncryptedUploadV2TerminalOutcome.Completed,
                    )
                }.exceptionOrNull()?.let { cleanup -> if (cleanup !== error) error.addSuppressed(cleanup) }
            }
            val unknown = EncryptedUploadV2HostException(
                19u, false,
                message = if (didConfirm) "CONFIRM succeeded but completion cleanup is uncertain"
                else "CONFIRM outcome is uncertain; reconnect before retrying",
            ).also { if (it !== error) it.addSuppressed(error) }
            synchronized(stateLock) { ownershipPoisoned = true }
            finished.complete(Result.failure(unknown))
            throw unknown
        }
    }

    private fun abort(effect: CoreEffect): Flow<CoreHostEventPayload> = flow<CoreHostEventPayload> {
        val materialId = requiredText(effect, 12)
        val owned = preparedMaterialId ?: activeContext?.materialId
        requireValue(owned == null || owned == materialId, "ABORT material is stale")
        abortState(EncryptedUploadV2TerminalOutcome.Failed)
    }

    private suspend fun pump(
        ownerGeneration: Long,
        ownerContext: Context,
        ownerStartEvents: Channel<CoreHostEventPayload>,
        notifications: Flow<EncryptedUploadV2TransferPayload>,
        transferReceiver: EncryptedUploadV2TransferReceiver,
    ) {
        var completed = false
        try {
            notifications.collect { payload ->
                when (val event = transferReceiver.receive(payload)) {
                    null -> Unit
                    is EncryptedUploadV2TransferReceiverEvent.WindowStaged -> {
                        if (replayWindow(ownerGeneration, ownerContext, transferReceiver, event.value)) return@collect
                        val gate = CompletableDeferred<Unit>()
                        val target = synchronized(stateLock) {
                            if (!ownsPump(ownerGeneration, ownerContext)) return@collect
                            pendingCheckpoint = event.value.checkpoint
                            pendingMissing = event.value.missingSequences
                            pendingResume = gate
                            boundaryTarget ?: fail(9u, "window event has no owner")
                        }
                        target.send(windowStaged(ownerContext, event.value))
                        gate.await()
                    }
                    is EncryptedUploadV2TransferReceiverEvent.Completed -> {
                        val target = synchronized(stateLock) {
                            if (!ownsPump(ownerGeneration, ownerContext)) return@collect
                            completedTransfer = event.value
                            completed = true
                            boundaryTarget ?: fail(9u, "completion event has no owner")
                        }
                        target.send(transferCompleted(event.value.evidence))
                        ownerStartEvents.close()
                    }
                }
            }
            if (!completed) {
                throw EncryptedUploadV2HostException(
                    12u, true, message = "encrypted transfer stream ended before EOF",
                )
            }
        } catch (error: Throwable) {
            if (error is BotaSDKError.Core &&
                error.code == BotaErrorCode.ProtocolRejected &&
                error.detail == MixedEncryptedUploadProfile
            ) {
                val target = synchronized(stateLock) {
                    if (ownsPump(ownerGeneration, ownerContext)) boundaryTarget ?: ownerStartEvents else null
                }
                target?.send(CoreHostEventPayload(HostEventKind.EncryptedUploadV2MixedProfile))
                target?.close()
                if (target !== ownerStartEvents) ownerStartEvents.close()
            } else {
                val target = synchronized(stateLock) {
                    if (ownsPump(ownerGeneration, ownerContext)) boundaryTarget else null
                }
                ownerStartEvents.close(error)
                if (target !== ownerStartEvents) target?.close(error)
            }
        }
    }

    private fun createReceiver(context: Context, checkpoint: EncryptedUploadV2CheckpointValue) =
        EncryptedUploadV2TransferReceiver(
            rootDirectory, context.sinkId, context.transportSessionId, context.ciphertextLength,
            context.ciphertextSha256, context.dataPayloadBytes, context.windowPackets,
            context.maximumMissingSequences, checkpoint,
        )

    private suspend fun replayWindow(
        ownerGeneration: Long,
        context: Context,
        transferReceiver: EncryptedUploadV2TransferReceiver,
        window: dev.bota.sdk.internal.bluetooth.EncryptedUploadV2WindowStageValue,
    ): Boolean {
        val original = synchronized(stateLock) {
            if (!ownsPump(ownerGeneration, context)) fail(16u, "transfer was cancelled")
            loadedCheckpoint?.takeIf { it.replayBoundary != null }
        } ?: return false
        val boundary = original.replayBoundary!!
        val checkpoint = window.checkpoint
        if (checkpoint.revision > boundary.revision && checkpoint.nextCiphertextOffset >= boundary.offset) return false
        // Rewindowing can cross either coordinate first; the receiver verifies native progress.
        val acknowledgement = if (window.missingSequences.isEmpty()) {
            val persisted = original.copy(
                revision = checkpoint.revision, nextCiphertextOffset = checkpoint.nextCiphertextOffset,
                prefixSha256 = checkpoint.prefixSha256, highestContiguousSequence = checkpoint.highestContiguousSequence,
            )
            services.checkpointStore.save(persisted)
            currentCoroutineContext().ensureActive()
            synchronized(stateLock) {
                if (!ownsPump(ownerGeneration, context)) fail(16u, "transfer was cancelled")
                loadedCheckpoint = persisted
            }
            transferReceiver.checkpointDidPersist(checkpoint)
            transferReceiver.windowAcknowledgement(checkpoint)
        } else transferReceiver.repairAcknowledgement(window.missingSequences)
        services.sendControl(
            context.transportSessionId, encode(acknowledgement),
            if (window.missingSequences.isNotEmpty()) EncryptedUploadV2TransferContinuation.Repair(window.missingSequences.toSet())
            else if (checkpoint.nextCiphertextOffset == context.ciphertextLength) EncryptedUploadV2TransferContinuation.Manifest
            else EncryptedUploadV2TransferContinuation.Window,
        )
        return true
    }

    private suspend fun abortState(outcome: EncryptedUploadV2TerminalOutcome) {
        val confirmation = synchronized(stateLock) {
            if (confirmationAttempted) confirmationFinished
            else {
                cancellationStarted = true
                null
            }
        }
        if (confirmation != null) {
            val result = confirmation.await()
            result.exceptionOrNull()?.let { throw it }
            return
        }
        var failure: Throwable? = null
        withContext(NonCancellable) {
            val cancelled = EncryptedUploadV2HostException(
                16u,
                false,
                message = "encrypted transfer was cancelled",
            )
            val detached = synchronized(stateLock) {
                val context = activeContext
                generation += 1
                CancelledLifecycle(
                    transportSessionId = context?.transportSessionId ?: openingSessionId,
                    openingJob = openingJob,
                    pumpJob = pumpJob,
                    startEvents = startEvents,
                    boundaryTarget = boundaryTarget,
                    pendingResume = pendingResume,
                    materialId = preparedMaterialId ?: context?.materialId,
                    materialLease = materialLease,
                )
            }
            detached.pendingResume?.completeExceptionally(cancelled)
            detached.startEvents?.close(cancelled)
            if (detached.boundaryTarget !== detached.startEvents) {
                detached.boundaryTarget?.close(cancelled)
            }
            try {
                services.cancelUploads()
            } catch (error: Throwable) {
                failure = error
            }
            detached.pumpJob?.cancelAndJoin()
            detached.openingJob?.cancelAndJoin()
            if (detached.transportSessionId != null) {
                try {
                    services.abortTransfer(detached.transportSessionId)
                } catch (error: Throwable) {
                    failure = aggregate(failure, error)
                }
            }
            if (detached.materialId != null && detached.materialLease != null) {
                try {
                    services.materialRegistry.terminate(detached.materialId, detached.materialLease, outcome)
                } catch (error: Throwable) {
                    failure = aggregate(failure, error)
                }
            }
            clearState()
        }
        failure?.let { throw it }
    }

    private suspend fun beginEffect(effect: CoreEffect) {
        while (true) {
            val pending = synchronized(stateLock) {
                resetFinished?.let { return@synchronized it }
                if (activeCancellationId != effect.cancellationId && activeContext == null && openingJob == null) {
                    clearConfirmationState()
                }
                activeCancellationId = effect.cancellationId
                null
            } ?: return
            pending.await()
        }
    }

    private fun ownsPump(ownerGeneration: Long, ownerContext: Context): Boolean =
        generation == ownerGeneration && activeContext === ownerContext

    private fun clearState(preserveConfirmation: Boolean = false) = synchronized(stateLock) {
        clearStateLocked(preserveConfirmation)
    }

    private fun clearStateLocked(preserveConfirmation: Boolean = false) {
        activeContext = null
        receiver = null
        loadedCheckpoint = null
        preparedMaterialId = null
        preparedAuthorizationSha256 = null
        materialLease = null
        pendingCheckpoint = null
        pendingMissing = emptyList()
        persistedCoreCheckpoint = null
        completedTransfer = null
        stagedEvidence = null
        acceptedReceipt = null
        pumpJob = null
        openingSessionId = null
        openingJob = null
        pendingResume = null
        boundaryTarget = null
        startEvents = null
        activeCancellationId = if (preserveConfirmation) activeCancellationId else null
        if (!preserveConfirmation) clearConfirmationState()
    }

    private fun clearConfirmationState() {
        confirmationAttempted = false
        confirmationSucceeded = false
        confirmationFinished = null
        confirmationCancellationId = null
        cancellationStarted = false
    }

    private data class CompletionState(
        val context: Context,
        val completed: dev.bota.sdk.internal.bluetooth.EncryptedUploadV2CompletedTransferValue,
        val lease: EncryptedUploadV2MaterialLease,
    )

    private fun completionState(effect: CoreEffect, requireSink: Boolean): CompletionState {
        val context = activeContext ?: fail(9u, "transfer is not complete")
        val completed = completedTransfer ?: fail(9u, "transfer is not complete")
        val lease = materialLease ?: fail(9u, "material lease is missing")
        requireValue(requiredText(effect, 12) == context.materialId, "completion material is stale")
        if (requireSink) requireValue(requiredText(effect, 14) == context.sinkId, "completion sink is stale")
        requireValue(sameEvidence(evidence(effect), completed.evidence), "completion evidence is stale")
        return CompletionState(context, completed, lease)
    }

    private fun context(effect: CoreEffect): Context {
        val sessionBytes = requiredBytes(effect, 132)
        val session = uuid(sessionBytes)
        val window = requiredUShort(effect, 134)
        val data = requiredUShort(effect, 135)
        val maximumWindow = requiredUShort(effect, 170)
        val maximumData = requiredUShort(effect, 169)
        val maximumMissing = requiredUShort(effect, 141)
        requireValue(window <= maximumWindow && data <= maximumData && maximumMissing > 0u, "negotiated bounds are invalid")
        return Context(
            requiredText(effect, 3), requiredText(effect, 13), requiredUInt(effect, 129),
            session, sessionBytes, requiredUInt(effect, 165), requiredULong(effect, 128),
            requiredText(effect, 12), requiredText(effect, 14), window, data,
            requiredUInt(effect, 140), maximumMissing, requiredULong(effect, 130),
            requiredDigest(effect, 144), requiredDigest(effect, 161),
        )
    }

    private fun evidence(effect: CoreEffect) = EncryptedUploadV2TransferEvidence(
        requiredULong(effect, 130), requiredDigest(effect, 144), requiredUShort(effect, 168),
        requiredDigest(effect, 142), requiredUInt(effect, 145),
    )

    private fun sameEvidence(left: EncryptedUploadV2TransferEvidence, right: EncryptedUploadV2TransferEvidence): Boolean =
        left.ciphertextLength == right.ciphertextLength &&
            MessageDigest.isEqual(left.ciphertextSha256, right.ciphertextSha256) &&
            left.manifestLength == right.manifestLength &&
            MessageDigest.isEqual(left.manifestSha256, right.manifestSha256) &&
            left.blockCount == right.blockCount

    private fun windowStaged(
        context: Context,
        value: dev.bota.sdk.internal.bluetooth.EncryptedUploadV2WindowStageValue,
    ) = CoreHostEventPayload(
        HostEventKind.EncryptedUploadV2WindowStaged,
        listOf(
            CoreField.Text(3, context.serialNumber), CoreField.Text(13, context.recordingUuid),
            CoreField.Unsigned(129, context.recordingGeneration.toULong()),
            CoreField.Bytes(132, context.uploadSessionBytes), CoreField.Unsigned(165, context.ownerRevision.toULong()),
            CoreField.Unsigned(128, context.transportSessionId), CoreField.Unsigned(133, value.checkpoint.revision.toULong()),
            CoreField.Unsigned(39, value.checkpoint.nextCiphertextOffset), CoreField.Bytes(143, value.checkpoint.prefixSha256),
            CoreField.Unsigned(134, context.windowPackets.toULong()), CoreField.Unsigned(135, context.dataPayloadBytes.toULong()),
            CoreField.Bytes(136, encodeUInts(value.missingSequences)),
        ),
    )

    private fun transferCompleted(value: EncryptedUploadV2TransferEvidence) = CoreHostEventPayload(
        HostEventKind.EncryptedUploadV2TransferCompleted,
        listOf(
            CoreField.Unsigned(130, value.ciphertextLength), CoreField.Bytes(144, value.ciphertextSha256),
            CoreField.Unsigned(168, value.manifestLength.toULong()), CoreField.Bytes(142, value.manifestSha256),
            CoreField.Unsigned(145, value.blockCount.toULong()),
        ),
    )

    private fun encode(value: dev.bota.sdk.internal.bluetooth.EncryptedUploadV2WindowAcknowledgement): ByteArray =
        services.encodeAcknowledgement(value)

    private fun PersistedEncryptedUploadV2Checkpoint.matches(context: Context): Boolean =
        serialNumber == context.serialNumber && recordingUuid == context.recordingUuid &&
            recordingGeneration == context.recordingGeneration && uploadSessionId == context.uploadSessionId &&
            ownerRevision == context.ownerRevision && transportSessionId == context.transportSessionId &&
            sinkId == context.sinkId && windowPackets == context.windowPackets && dataPayloadBytes == context.dataPayloadBytes

    private val PersistedEncryptedUploadV2Checkpoint.nativeCheckpoint: EncryptedUploadV2CheckpointValue
        get() = EncryptedUploadV2CheckpointValue(revision, nextCiphertextOffset, prefixSha256, highestContiguousSequence)

    private fun sinkFile(sinkId: String): Path = rootDirectory.resolve("$sinkId.encrypted-upload-v2")

    private fun syncDirectory(directory: Path?) {
        if (directory == null) return
        FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) }
    }

    private fun requiredText(effect: CoreEffect, id: Int): String =
        effect.packet.texts(id).firstOrNull()?.takeIf { it.isNotEmpty() } ?: fail(1u, "field $id is missing")

    private fun requiredBytes(effect: CoreEffect, id: Int): ByteArray =
        effect.packet.bytes(id) ?: fail(1u, "field $id is missing")

    private fun requiredULong(effect: CoreEffect, id: Int): ULong =
        effect.packet.unsigneds(id).firstOrNull() ?: fail(1u, "field $id is missing")

    private fun requiredUInt(effect: CoreEffect, id: Int): UInt =
        requiredULong(effect, id).takeIf { it <= UInt.MAX_VALUE.toULong() }?.toUInt() ?: fail(1u, "field $id is invalid")

    private fun requiredUShort(effect: CoreEffect, id: Int): UShort =
        requiredULong(effect, id).takeIf { it <= UShort.MAX_VALUE.toULong() }?.toUShort() ?: fail(1u, "field $id is invalid")

    private fun requiredDigest(effect: CoreEffect, id: Int): ByteArray =
        requiredBytes(effect, id).takeIf { it.size == 32 } ?: fail(1u, "digest field $id is invalid")

    private fun requiredUuid(effect: CoreEffect, id: Int): UUID = uuid(requiredBytes(effect, id))

    private fun uuid(value: ByteArray): UUID {
        requireValue(value.size == 16, "UUID field is invalid")
        val bytes = ByteBuffer.wrap(value)
        return UUID(bytes.long, bytes.long)
    }

    private fun encodeUInts(values: List<UInt>): ByteArray = ByteBuffer
        .allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        .also { buffer -> values.forEach { buffer.putInt(it.toInt()) } }.array()

    private fun decodeUInts(value: ByteArray): List<UInt> {
        requireValue(value.size % 4 == 0, "missing sequence list is malformed")
        val buffer = ByteBuffer.wrap(value).order(ByteOrder.LITTLE_ENDIAN)
        return buildList { while (buffer.hasRemaining()) add(buffer.int.toUInt()) }
    }

    private fun nonzeroWriteId(): UInt = services.nextWriteId().takeIf { it != 0u }
        ?: fail(1u, "signed document write ID is zero")

    private fun requireValue(condition: Boolean, detail: String, code: UInt = 11u) {
        if (!condition) fail(code, detail)
    }

    private fun fail(code: UInt, detail: String): Nothing =
        throw EncryptedUploadV2HostException(code, false, message = detail)

    private fun aggregate(primary: Throwable?, secondary: Throwable): Throwable =
        primary?.also { if (it !== secondary) it.addSuppressed(secondary) } ?: secondary
}
