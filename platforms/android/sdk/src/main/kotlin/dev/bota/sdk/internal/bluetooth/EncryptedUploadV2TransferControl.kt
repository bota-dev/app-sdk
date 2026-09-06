package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2ResumeRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferControlValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import java.security.MessageDigest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException

internal sealed interface EncryptedUploadV2OpenResult {
    data class Opened(val notifications: Flow<EncryptedUploadV2TransferPayload>) : EncryptedUploadV2OpenResult
    data object ResumeRejected : EncryptedUploadV2OpenResult
}

internal class EncryptedUploadV2TransferControl(
    private val driver: BluetoothDriver,
    private val mapper: CoreModelMapper,
    private val controlTimeoutMilliseconds: Long = ControlTimeoutMilliseconds,
) : AutoCloseable {
    private data class Session(
        val peripheralId: String,
        val raw: Channel<ByteArray>,
        val job: Job,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val sessions = mutableMapOf<ULong, Session>()

    suspend fun open(
        peripheralId: String,
        request: EncryptedUploadV2StartRequest,
        checkpoint: EncryptedUploadV2CheckpointValue?,
    ): EncryptedUploadV2OpenResult {
        val ready = CompletableDeferred<Unit>()
        val raw = Channel<ByteArray>(capacity = 2_048)
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val notifications = driver.subscribe(
                    peripheralId,
                    BotaBluetoothUUIDs.StorageService,
                    BotaBluetoothUUIDs.RecordingTransferV2,
                )
                ready.complete(Unit)
                notifications.collect { raw.send(it.value) }
                raw.close()
            } catch (error: Throwable) {
                ready.completeExceptionally(error)
                raw.close(error)
            }
        }
        val session = Session(peripheralId, raw, job)
        try {
            mutex.withLock {
                require(request.transportSessionId != 0uL && sessions.isEmpty()) {
                    "encrypted transfer session is already active"
                }
                sessions[request.transportSessionId] = session
            }
            job.start()
            ready.await()
            val frame = if (checkpoint == null) {
                mapper.createEncryptedUploadV2Start(
                    request.transportSessionId, request.uploadSessionId, request.recordingUuid,
                    request.recordingGeneration, request.authorizationSha256, request.checkpointRevision,
                    request.nextCiphertextOffset, request.prefixSha256, request.windowPackets, request.dataPayloadBytes,
                )
            } else {
                mapper.createEncryptedUploadV2ResumeRequest(
                    EncryptedUploadV2ResumeRequest(
                        request.transportSessionId, request.uploadSessionId, request.recordingUuid,
                        request.recordingGeneration, checkpoint.revision, checkpoint.nextCiphertextOffset,
                        checkpoint.prefixSha256, request.windowPackets, request.dataPayloadBytes,
                    ),
                )
            }
            write(peripheralId, frame)
            val response = try {
                withTimeout(controlTimeoutMilliseconds) { raw.receive() }
            } catch (_: TimeoutCancellationException) {
                throw EncryptedUploadV2HostException(
                    15u, true, message = "timed out waiting for the encrypted transfer acknowledgement",
                )
            }
            when (val control = mapper.decodeEncryptedUploadV2TransferControl(response)) {
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
                    releaseSession(request.transportSessionId, session)
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
                        17u, false, control.value.result,
                        "device rejected the encrypted transfer",
                    )
                }
            }
            return EncryptedUploadV2OpenResult.Opened(
                raw.consumeAsFlow().map(mapper::decodeEncryptedUploadV2TransferPayload),
            )
        } catch (error: Throwable) {
            releaseSession(request.transportSessionId, session)
            throw error
        }
    }

    suspend fun writeActiveFrame(transportSessionId: ULong, frame: ByteArray) = mutex.withLock {
        val session = sessions[transportSessionId] ?: error("encrypted transfer session is not active")
        write(session.peripheralId, frame)
    }

    suspend fun abort(transportSessionId: ULong, reason: UShort = 0x00ffu.toUShort()) {
        val session = mutex.withLock { sessions[transportSessionId] } ?: return
        runCatching { write(session.peripheralId, mapper.createEncryptedUploadV2Abort(transportSessionId, reason)) }
        releaseSession(transportSessionId, session)
    }

    suspend fun release(transportSessionId: ULong) {
        val session = mutex.withLock { sessions[transportSessionId] } ?: return
        releaseSession(transportSessionId, session)
    }

    override fun close() {
        scope.coroutineContext[Job]?.cancel()
        sessions.clear()
    }

    private suspend fun releaseSession(id: ULong, session: Session) {
        mutex.withLock { sessions.remove(id, session) }
        session.job.cancel()
        session.raw.close()
        runCatching {
            driver.unsubscribe(
                session.peripheralId,
                BotaBluetoothUUIDs.StorageService,
                BotaBluetoothUUIDs.RecordingTransferV2,
            )
        }
    }

    private suspend fun write(peripheralId: String, frame: ByteArray) {
        require(frame.size <= minOf(driver.maximumWriteLength(peripheralId), 512)) {
            "Rust-generated transfer frame exceeds negotiated write length"
        }
        driver.write(
            peripheralId,
            BotaBluetoothUUIDs.StorageService,
            BotaBluetoothUUIDs.TransferControlV2,
            frame,
            withResponse = true,
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

    private companion object {
        const val ControlTimeoutMilliseconds = 10_000L
    }
}
