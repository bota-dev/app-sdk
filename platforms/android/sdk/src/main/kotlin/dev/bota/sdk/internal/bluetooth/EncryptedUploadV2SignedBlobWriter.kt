package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import java.security.MessageDigest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal class EncryptedUploadV2SignedBlobWriter(
    private val driver: BluetoothDriver,
    private val mapper: CoreModelMapper,
    private val cleanupTimeoutMilliseconds: Long = CleanupTimeoutMilliseconds,
) {
    private val mutex = Mutex()
    private var cleanupUncertainOwner: ConfirmedBluetoothDisconnect? = null

    suspend fun send(
        peripheralId: String,
        kind: UByte,
        writeId: UInt,
        value: ByteArray,
        maximumBlobBytes: UShort,
        resultTimeoutMilliseconds: Long = ResultTimeoutMilliseconds,
    ) = mutex.withLock {
        if (cleanupUncertainOwner != null) ownershipUnknown()
        val owner = ConfirmedBluetoothDisconnect(peripheralId, driver.connectionGeneration(peripheralId))
        require(writeId != 0u && value.isNotEmpty() && value.size <= maximumBlobBytes.toInt()) {
            "signed document is outside negotiated bounds"
        }
        val maximumFrameBytes = minOf(driver.maximumWriteLength(peripheralId), 512)
        require(maximumFrameBytes >= 64) { "negotiated write length is too small" }
        var began = false
        var primary: Throwable? = null
        try {
            coroutineScope {
                val notifications = driver.subscribe(
                    peripheralId,
                    BotaBluetoothUUIDs.StorageService,
                    BotaBluetoothUUIDs.TransferSignedBlobV2,
                )
                val result = CompletableDeferred<dev.bota.sdk.internal.core.EncryptedUploadV2SignedBlobResult>()
                val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                    var unmatchedResults = 0
                    var unmatchedBytes = 0
                    try {
                        notifications.collect { notification ->
                            val decoded = mapper.decodeEncryptedUploadV2SignedBlobResult(notification.value)
                            if (decoded.kind == kind && decoded.writeId == writeId) {
                                result.complete(decoded)
                            } else {
                                unmatchedResults += 1
                                unmatchedBytes += notification.value.size
                                if (unmatchedResults > MaximumUnmatchedResults ||
                                    unmatchedBytes > MaximumUnmatchedResultBytes
                                ) {
                                    throw EncryptedUploadV2HostException(
                                        4u, false,
                                        message = "signed-document result stream exceeded its unmatched-result bound",
                                    )
                                }
                            }
                        }
                        result.completeExceptionally(
                            EncryptedUploadV2HostException(
                                12u, true, message = "signed-document notification stream ended without a result",
                            ),
                        )
                    } catch (error: Throwable) {
                        result.completeExceptionally(error)
                    }
                }
                write(
                    peripheralId,
                    mapper.createEncryptedUploadV2SignedBlobBegin(
                        kind, writeId, value.size.toUShort(), MessageDigest.getInstance("SHA-256").digest(value),
                    ),
                    maximumFrameBytes,
                )
                began = true
                var offset = 0
                while (offset < value.size) {
                    val chunk = largestChunk(kind, writeId, offset, value, maximumFrameBytes)
                    write(
                        peripheralId,
                        mapper.createEncryptedUploadV2SignedBlobData(
                            kind, writeId, offset.toUShort(), value.copyOfRange(offset, offset + chunk),
                        ),
                        maximumFrameBytes,
                    )
                    offset += chunk
                }
                write(peripheralId, mapper.createEncryptedUploadV2SignedBlobCommit(kind, writeId), maximumFrameBytes)
                val reply = try {
                    withTimeout(resultTimeoutMilliseconds) { result.await() }
                } catch (_: TimeoutCancellationException) {
                    throw EncryptedUploadV2HostException(
                        15u, true, message = "timed out waiting for the matching signed-document result",
                    )
                }
                if (reply.result != 0.toUShort()) {
                    throw EncryptedUploadV2HostException(
                        17u, false, reply.result,
                        "device rejected signed document with protocol status ${reply.result}",
                    )
                }
                collector.cancel()
            }
        } catch (error: Throwable) {
            primary = error
        }
        val cleanupFailure = cleanup(peripheralId, if (primary != null && began) {
            mapper.createEncryptedUploadV2SignedBlobAbort(kind, writeId)
        } else null, maximumFrameBytes)
        if (cleanupFailure != null) cleanupUncertainOwner = owner
        if (primary != null) {
            cleanupFailure?.let(primary!!::addSuppressed)
            throw primary!!
        }
        if (cleanupFailure != null) ownershipUnknown(cleanupFailure)
    }

    suspend fun resetAfterConfirmedDisconnect(disconnect: ConfirmedBluetoothDisconnect) = mutex.withLock {
        if (cleanupUncertainOwner == disconnect) cleanupUncertainOwner = null
    }

    private suspend fun cleanup(
        peripheralId: String,
        abort: ByteArray?,
        maximumFrameBytes: Int,
    ): Throwable? {
        var failure: Throwable? = null
        withContext(NonCancellable + Dispatchers.IO) {
            if (abort != null) {
                try {
                    withTimeout(cleanupTimeoutMilliseconds) { write(peripheralId, abort, maximumFrameBytes) }
                } catch (error: Throwable) {
                    failure = error
                }
            }
            try {
                withTimeout(cleanupTimeoutMilliseconds) {
                        driver.unsubscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.StorageService,
                            BotaBluetoothUUIDs.TransferSignedBlobV2,
                        )
                }
            } catch (error: Throwable) {
                val first = failure
                if (first == null) failure = error else first.addSuppressed(error)
            }
        }
        return failure
    }

    private fun ownershipUnknown(cause: Throwable? = null): Nothing = throw EncryptedUploadV2HostException(
        19u, false, message = "signed-document cleanup is uncertain; reconnect before retrying",
    ).also { if (cause != null) it.addSuppressed(cause) }

    private fun largestChunk(
        kind: UByte,
        writeId: UInt,
        offset: Int,
        value: ByteArray,
        maximumFrameBytes: Int,
    ): Int {
        var low = 1
        var high = minOf(value.size - offset, UShort.MAX_VALUE.toInt() - offset)
        var best = 0
        while (low <= high) {
            val middle = (low + high) / 2
            val frame = mapper.createEncryptedUploadV2SignedBlobData(
                kind, writeId, offset.toUShort(), value.copyOfRange(offset, offset + middle),
            )
            if (frame.size <= maximumFrameBytes) {
                best = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        require(best > 0) { "negotiated write length cannot carry signed document data" }
        return best
    }

    private suspend fun write(peripheralId: String, frame: ByteArray, maximumFrameBytes: Int) {
        require(frame.size <= maximumFrameBytes) { "Rust-generated frame exceeds negotiated write length" }
        driver.write(
            peripheralId,
            BotaBluetoothUUIDs.StorageService,
            BotaBluetoothUUIDs.TransferSignedBlobV2,
            frame,
            withResponse = true,
        )
    }

    private companion object {
        const val ResultTimeoutMilliseconds = 10_000L
        const val CleanupTimeoutMilliseconds = 1_000L
        const val MaximumUnmatchedResults = 64
        const val MaximumUnmatchedResultBytes = 32 * 1024
    }
}
