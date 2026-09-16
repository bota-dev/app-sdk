package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2ResumeRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferControlValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import dev.bota.sdk.internal.host.EncryptedUploadV2ConfirmationException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal sealed interface EncryptedUploadV2OpenResult {
    data class Opened(val notifications: Flow<EncryptedUploadV2TransferPayload>) : EncryptedUploadV2OpenResult
    data object ResumeRejected : EncryptedUploadV2OpenResult
}

internal sealed interface EncryptedUploadV2TransferContinuation {
    data object Window : EncryptedUploadV2TransferContinuation
    data object Manifest : EncryptedUploadV2TransferContinuation
    data class Repair(val sequences: Set<UInt>) : EncryptedUploadV2TransferContinuation
}

internal class EncryptedUploadV2TransferIntake(private val transportSessionId: ULong) {
    private sealed interface State {
        data object Window : State
        data object Paused : State
        data object Manifest : State
        data object Terminal : State
        data class Repair(val remaining: MutableSet<UInt>) : State
    }

    private var state: State = State.Window

    @Synchronized
    fun accept(payload: EncryptedUploadV2TransferPayload) {
        val session = when (payload) {
            is EncryptedUploadV2TransferPayload.Data -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.WindowEnd -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.ManifestChunk -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.Eof -> payload.value.transportSessionId
            is EncryptedUploadV2TransferPayload.Error -> payload.value.transportSessionId
        }
        expected(session == transportSessionId, "transfer payload belongs to another transport session")
        if (payload is EncryptedUploadV2TransferPayload.Error) {
            state = State.Terminal
            return
        }
        when (val current = state) {
            State.Window -> when (payload) {
                is EncryptedUploadV2TransferPayload.Data -> Unit
                is EncryptedUploadV2TransferPayload.WindowEnd -> state = State.Paused
                else -> expected(false, "transfer payload arrived outside the active window phase")
            }
            State.Manifest -> when (payload) {
                is EncryptedUploadV2TransferPayload.ManifestChunk -> Unit
                is EncryptedUploadV2TransferPayload.Eof -> state = State.Terminal
                else -> expected(false, "transfer payload arrived outside the manifest phase")
            }
            is State.Repair -> when (payload) {
                is EncryptedUploadV2TransferPayload.Data -> expected(
                    current.remaining.remove(payload.value.sequence),
                    "repair retransmission was not requested or was duplicated",
                )
                is EncryptedUploadV2TransferPayload.WindowEnd -> {
                    expected(current.remaining.isEmpty(), "repair ended before every requested retransmission arrived")
                    state = State.Paused
                }
                else -> expected(false, "transfer payload arrived outside the repair phase")
            }
            State.Paused -> expected(false, "transfer payload arrived while the host was deciding the next phase")
            State.Terminal -> expected(false, "transfer payload arrived after the stream terminated")
        }
    }

    @Synchronized
    fun continueWith(next: EncryptedUploadV2TransferContinuation) {
        expected(state == State.Paused, "transfer continuation is not at a window boundary")
        state = when (next) {
            EncryptedUploadV2TransferContinuation.Window -> State.Window
            EncryptedUploadV2TransferContinuation.Manifest -> State.Manifest
            is EncryptedUploadV2TransferContinuation.Repair -> {
                expected(next.sequences.isNotEmpty(), "repair continuation has no requested sequence")
                State.Repair(next.sequences.toMutableSet())
            }
        }
    }

    private fun expected(condition: Boolean, detail: String) {
        if (!condition) throw EncryptedUploadV2HostException(9u, false, message = detail)
    }
}

internal class EncryptedUploadV2TransferControl(
    private val driver: BluetoothDriver,
    private val mapper: CoreModelMapper,
    private val controlTimeoutMilliseconds: Long = ControlTimeoutMilliseconds,
    private val cleanupTimeoutMilliseconds: Long = CleanupTimeoutMilliseconds,
) : AutoCloseable {
    private enum class Phase { Active, Cleaning, Confirming, Confirmed }

    private data class Session(
        val peripheralId: String,
        val generation: Long,
        val raw: Channel<ByteArray>,
        val bufferedBytes: AtomicInteger,
        val intake: EncryptedUploadV2TransferIntake,
        val controlAccepted: CompletableDeferred<Unit>,
        val job: Job,
        val confirmationFinished: CompletableDeferred<Unit> = CompletableDeferred(),
        var phase: Phase = Phase.Active,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val sessions = mutableMapOf<ULong, Session>()
    private var cleanupUncertainOwner: ConfirmedBluetoothDisconnect? = null

    suspend fun open(
        peripheralId: String,
        request: EncryptedUploadV2StartRequest,
        checkpoint: EncryptedUploadV2CheckpointValue?,
    ): EncryptedUploadV2OpenResult {
        val ready = CompletableDeferred<Unit>()
        val connectionGeneration = driver.connectionGeneration(peripheralId)
        val owner = ConfirmedBluetoothDisconnect(peripheralId, connectionGeneration)
        val raw = Channel<ByteArray>(Channel.UNLIMITED)
        val bufferedBytes = AtomicInteger()
        val intake = EncryptedUploadV2TransferIntake(request.transportSessionId)
        val controlAccepted = CompletableDeferred<Unit>()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val notifications = driver.subscribe(
                    peripheralId,
                    BotaBluetoothUUIDs.StorageService,
                    BotaBluetoothUUIDs.RecordingTransferV2,
                )
                val collector = launch(start = CoroutineStart.UNDISPATCHED) {
                    var awaitingControl = true
                    try {
                        notifications.collect { notification ->
                            val value = notification.value
                            if (value.size > MaximumNotificationBytes ||
                                bufferedBytes.addAndGet(value.size) > TransferQueueByteLimit
                            ) {
                                throw EncryptedUploadV2HostException(
                                    4u, false, message = "encrypted transfer notification queue exceeded its byte bound",
                                )
                            }
                            if (awaitingControl) {
                                awaitingControl = false
                                raw.send(value)
                                controlAccepted.await()
                                return@collect
                            }
                            intake.accept(mapper.decodeEncryptedUploadV2TransferPayload(value))
                            raw.send(value)
                        }
                        throw EncryptedUploadV2HostException(
                            12u, true, message = "encrypted transfer notification stream ended before EOF",
                        )
                    } catch (error: Throwable) {
                        if (error !is kotlinx.coroutines.CancellationException) {
                            mutex.withLock { cleanupUncertainOwner = owner }
                        }
                        ready.completeExceptionally(error)
                        raw.close(error)
                    }
                }
                ready.complete(Unit)
                collector.join()
            } catch (error: Throwable) {
                ready.completeExceptionally(error)
                raw.close(error)
            }
        }
        val session = Session(peripheralId, connectionGeneration, raw, bufferedBytes, intake, controlAccepted, job)
        mutex.withLock {
            if (cleanupUncertainOwner != null) ownershipUnknown()
            require(request.transportSessionId != 0uL && sessions.isEmpty()) {
                "encrypted transfer session is already active"
            }
            sessions[request.transportSessionId] = session
        }
        try {
            job.start()
            ready.await()
            val frame = if (checkpoint == null) startFrame(request) else resumeFrame(request, checkpoint)
            write(peripheralId, frame)
            val response = try {
                withTimeout(controlTimeoutMilliseconds) { raw.receive() }
            } catch (_: TimeoutCancellationException) {
                throw EncryptedUploadV2HostException(
                    15u, true, message = "timed out waiting for the encrypted transfer acknowledgement",
                )
            }
            bufferedBytes.addAndGet(-response.size)
            val decodedControl = mapper.decodeEncryptedUploadV2TransferControl(response)
            controlAccepted.complete(Unit)
            when (val control = decodedControl) {
                is EncryptedUploadV2TransferControlValue.StartAccepted -> {
                    expected(checkpoint == null, "START received an unexpected reply type")
                    validateStart(request, control.value)
                }
                is EncryptedUploadV2TransferControlValue.ResumeAccepted -> {
                    expected(checkpoint != null, "RESUME received an unexpected reply type")
                    validateResume(request, checkpoint, control.value)
                }
                is EncryptedUploadV2TransferControlValue.ResumeRejected -> {
                    identity(
                        control.value.transportSessionId == request.transportSessionId,
                        "RESUME_REJECT belongs to another transport session",
                    )
                    expected(checkpoint != null && control.value.reason != 0.toUShort(), "RESUME_REJECT is invalid")
                    releaseSession(request.transportSessionId, session, abort = false)
                    return EncryptedUploadV2OpenResult.ResumeRejected
                }
                is EncryptedUploadV2TransferControlValue.Error -> {
                    identity(
                        control.value.transportSessionId == request.transportSessionId,
                        "transfer ERROR belongs to another transport session",
                    )
                    val expectedMessage = if (checkpoint == null) 0x20.toUByte() else 0x22.toUByte()
                    expected(
                        control.value.result != 0.toUShort() && control.value.failedMessageType == expectedMessage,
                        "transfer ERROR does not match the active request",
                    )
                    throw EncryptedUploadV2HostException(
                        17u, false, control.value.result, "device rejected the encrypted transfer",
                    )
                }
            }
            return EncryptedUploadV2OpenResult.Opened(flow {
                for (value in raw) {
                    try {
                        emit(mapper.decodeEncryptedUploadV2TransferPayload(value))
                    } finally {
                        bufferedBytes.addAndGet(-value.size)
                    }
                }
            })
        } catch (error: Throwable) {
            runCatching { releaseSession(request.transportSessionId, session, abort = true) }
                .exceptionOrNull()?.let { cleanup -> if (cleanup !== error) error.addSuppressed(cleanup) }
            throw error
        }
    }

    suspend fun writeActiveFrame(
        transportSessionId: ULong,
        frame: ByteArray,
        continuation: EncryptedUploadV2TransferContinuation,
    ) {
        val session = mutex.withLock {
            sessions[transportSessionId]?.takeIf { it.phase == Phase.Active }
                ?: error("encrypted transfer session is not active")
        }
        try {
            write(session.peripheralId, frame)
            session.intake.continueWith(continuation)
        } catch (error: Throwable) {
            mutex.withLock {
                cleanupUncertainOwner = ConfirmedBluetoothDisconnect(session.peripheralId, session.generation)
            }
            session.raw.close(error)
            throw error
        }
    }

    suspend fun confirm(
        transportSessionId: ULong,
        frame: ByteArray,
        writeSucceeded: () -> Unit,
    ) {
        currentCoroutineContext().ensureActive()
        val session = mutex.withLock {
            if (cleanupUncertainOwner != null) ownershipUnknown()
            sessions[transportSessionId]?.takeIf { it.phase == Phase.Active }
                ?: error("encrypted transfer session is not active")
        }
        var sent = false
        var attempted = false
        try {
            withContext(NonCancellable + Dispatchers.IO) {
                require(frame.size <= minOf(driver.maximumWriteLength(session.peripheralId), MaximumNotificationBytes)) {
                    "Rust-generated transfer frame exceeds negotiated write length"
                }
                mutex.withLock {
                    sessions[transportSessionId]?.takeIf { it === session && it.phase == Phase.Active }
                        ?.also { it.phase = Phase.Confirming }
                        ?: throw EncryptedUploadV2HostException(
                            16u, false, message = "transfer cancellation preceded CONFIRM",
                        )
                    attempted = true
                    driver.write(
                        session.peripheralId,
                        BotaBluetoothUUIDs.StorageService,
                        BotaBluetoothUUIDs.TransferControlV2,
                        frame,
                        withResponse = true,
                    )
                    sent = true
                    session.phase = Phase.Confirmed
                    writeSucceeded()
                }
                cleanupSubscription(session)
            }
            mutex.withLock { sessions.remove(transportSessionId, session) }
        } catch (error: Throwable) {
            if (!attempted) throw error
            mutex.withLock {
                cleanupUncertainOwner = ConfirmedBluetoothDisconnect(session.peripheralId, session.generation)
            }
            throw EncryptedUploadV2ConfirmationException(
                writeSucceeded = sent,
                message = if (sent) "CONFIRM succeeded but transfer subscription cleanup is uncertain"
                else "CONFIRM outcome is uncertain; reconnect before retrying",
                cause = error,
            )
        } finally {
            session.confirmationFinished.complete(Unit)
        }
    }

    suspend fun confirmationAttemptedOrClaimCancellation(transportSessionId: ULong): Boolean = mutex.withLock {
        val session = sessions[transportSessionId] ?: return@withLock false
        when (session.phase) {
            Phase.Confirming, Phase.Confirmed -> true
            Phase.Active -> {
                session.phase = Phase.Cleaning
                false
            }
            Phase.Cleaning -> false
        }
    }

    suspend fun abort(transportSessionId: ULong, reason: UShort = 0x00ffu.toUShort()) {
        val session = mutex.withLock {
            val value = sessions[transportSessionId] ?: return
            if (value.phase == Phase.Confirming || value.phase == Phase.Confirmed) ownershipUnknown()
            value.phase = Phase.Cleaning
            value
        }
        releaseSession(transportSessionId, session, abort = true, reason = reason)
    }

    suspend fun release(transportSessionId: ULong) {
        val session = mutex.withLock {
            val value = sessions[transportSessionId] ?: return
            if (value.phase == Phase.Confirming || value.phase == Phase.Confirmed) ownershipUnknown()
            value.phase = Phase.Cleaning
            value
        }
        releaseSession(transportSessionId, session, abort = false)
    }

    suspend fun resetAfterConfirmedDisconnect(disconnect: ConfirmedBluetoothDisconnect) {
        withContext(NonCancellable) {
            val settling = mutex.withLock {
                sessions.values.filter {
                    it.peripheralId == disconnect.peripheralId &&
                        it.generation == disconnect.generation &&
                        (it.phase == Phase.Confirming || it.phase == Phase.Confirmed)
                }.map { it.confirmationFinished }
            }
            settling.forEach { it.await() }
            val owned = mutex.withLock {
                if (cleanupUncertainOwner == disconnect) cleanupUncertainOwner = null
                sessions.values.filter {
                    it.peripheralId == disconnect.peripheralId && it.generation == disconnect.generation
                }.also { matching -> matching.forEach { sessions.values.remove(it) } }
            }
            owned.forEach {
                it.job.cancelAndJoin()
                it.raw.close()
            }
        }
    }

    override fun close() {
        runBlocking {
            val owned = mutex.withLock { sessions.toMap() }
            owned.forEach { (id, session) -> runCatching { releaseSession(id, session, abort = false) } }
        }
        scope.coroutineContext[Job]?.cancel()
    }

    private suspend fun releaseSession(
        id: ULong,
        session: Session,
        abort: Boolean,
        reason: UShort = 0x00ffu.toUShort(),
    ) {
        var failure: Throwable? = null
        withContext(NonCancellable + Dispatchers.IO) {
            try {
                withTimeout(cleanupTimeoutMilliseconds) { session.job.cancelAndJoin() }
            } catch (error: Throwable) {
                failure = aggregate(failure, error)
            }
            if (abort) {
                try {
                    withTimeout(cleanupTimeoutMilliseconds) {
                        write(session.peripheralId, mapper.createEncryptedUploadV2Abort(id, reason))
                    }
                } catch (error: Throwable) {
                    failure = aggregate(failure, error)
                }
            }
            try {
                withTimeout(cleanupTimeoutMilliseconds) {
                    driver.unsubscribe(
                        session.peripheralId,
                        BotaBluetoothUUIDs.StorageService,
                        BotaBluetoothUUIDs.RecordingTransferV2,
                    )
                }
            } catch (error: Throwable) {
                failure = aggregate(failure, error)
            }
        }
        session.raw.close(failure)
        if (failure == null) {
            mutex.withLock { sessions.remove(id, session) }
        } else {
            mutex.withLock {
                cleanupUncertainOwner = ConfirmedBluetoothDisconnect(session.peripheralId, session.generation)
            }
            throw EncryptedUploadV2HostException(
                19u, false, message = "encrypted transfer cleanup is uncertain; reconnect before retrying",
            ).also { it.addSuppressed(failure!!) }
        }
    }

    private suspend fun cleanupSubscription(session: Session) {
        var failure: Throwable? = null
        try {
            withTimeout(cleanupTimeoutMilliseconds) { session.job.cancelAndJoin() }
        } catch (error: Throwable) {
            failure = error
        }
        try {
            withTimeout(cleanupTimeoutMilliseconds) {
                driver.unsubscribe(
                    session.peripheralId,
                    BotaBluetoothUUIDs.StorageService,
                    BotaBluetoothUUIDs.RecordingTransferV2,
                )
            }
        } catch (error: Throwable) {
            failure = aggregate(failure, error)
        }
        session.raw.close(failure)
        failure?.let { throw it }
    }

    private fun startFrame(request: EncryptedUploadV2StartRequest) = mapper.createEncryptedUploadV2Start(
        request.transportSessionId, request.uploadSessionId, request.recordingUuid,
        request.recordingGeneration, request.authorizationSha256, request.checkpointRevision,
        request.nextCiphertextOffset, request.prefixSha256, request.windowPackets, request.dataPayloadBytes,
    )

    private fun resumeFrame(request: EncryptedUploadV2StartRequest, checkpoint: EncryptedUploadV2CheckpointValue) =
        mapper.createEncryptedUploadV2ResumeRequest(
            EncryptedUploadV2ResumeRequest(
                request.transportSessionId, request.uploadSessionId, request.recordingUuid,
                request.recordingGeneration, checkpoint.revision, checkpoint.nextCiphertextOffset,
                checkpoint.prefixSha256, request.windowPackets, request.dataPayloadBytes,
            ),
        )

    private suspend fun write(peripheralId: String, frame: ByteArray) {
        require(frame.size <= minOf(driver.maximumWriteLength(peripheralId), MaximumNotificationBytes)) {
            "Rust-generated transfer frame exceeds negotiated write length"
        }
        driver.write(
            peripheralId, BotaBluetoothUUIDs.StorageService, BotaBluetoothUUIDs.TransferControlV2,
            frame, withResponse = true,
        )
    }

    private fun validateStart(request: EncryptedUploadV2StartRequest, value: dev.bota.sdk.internal.core.EncryptedUploadV2StartAcknowledgement) {
        identity(
            value.transportSessionId == request.transportSessionId && value.uploadSessionId == request.uploadSessionId &&
                value.recordingUuid == request.recordingUuid && value.recordingGeneration == request.recordingGeneration &&
                value.ciphertextLength == request.expectedCiphertextLength &&
                MessageDigest.isEqual(value.ciphertextSha256, request.expectedCiphertextSha256) &&
                value.windowPackets == request.windowPackets && value.dataPayloadBytes == request.dataPayloadBytes &&
                value.checkpointIntervalBlocks == request.expectedCheckpointIntervalBlocks &&
                value.checkpointRevision == request.checkpointRevision &&
                value.nextCiphertextOffset == request.nextCiphertextOffset &&
                MessageDigest.isEqual(value.prefixSha256, request.prefixSha256),
            "START acknowledgement does not match the selected encrypted transfer",
        )
    }

    private fun validateResume(
        request: EncryptedUploadV2StartRequest,
        checkpoint: EncryptedUploadV2CheckpointValue?,
        value: dev.bota.sdk.internal.core.EncryptedUploadV2ResumeValue,
    ) {
        identity(checkpoint != null && value.transportSessionId == request.transportSessionId &&
            value.uploadSessionId == request.uploadSessionId && value.recordingUuid == request.recordingUuid &&
            value.recordingGeneration == request.recordingGeneration && value.checkpointRevision == checkpoint.revision &&
            value.nextCiphertextOffset == checkpoint.nextCiphertextOffset &&
            MessageDigest.isEqual(value.prefixSha256, checkpoint.prefixSha256) &&
            value.windowPackets == request.windowPackets && value.dataPayloadBytes == request.dataPayloadBytes,
            "RESUME acknowledgement does not match the durable checkpoint",
        )
    }

    private fun identity(condition: Boolean, detail: String) {
        if (!condition) throw EncryptedUploadV2HostException(11u, false, message = detail)
    }

    private fun expected(condition: Boolean, detail: String) {
        if (!condition) throw EncryptedUploadV2HostException(9u, false, message = detail)
    }

    private fun ownershipUnknown(): Nothing = throw EncryptedUploadV2HostException(
        19u, false, message = "encrypted transfer ownership is uncertain; reconnect before retrying",
    )

    private fun aggregate(primary: Throwable?, secondary: Throwable): Throwable =
        primary?.also { if (it !== secondary) it.addSuppressed(secondary) } ?: secondary

    private companion object {
        const val ControlTimeoutMilliseconds = 10_000L
        const val CleanupTimeoutMilliseconds = 1_000L
        const val MaximumNotificationBytes = 512
        const val PlatformNotificationReserveBytes = 64 * MaximumNotificationBytes
        const val TransferQueueByteLimit = 1024 * 1024 - PlatformNotificationReserveBytes
    }
}
