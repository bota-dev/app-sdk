package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

internal class EncryptedUploadV2SignedBlobWriter(
    private val driver: BluetoothDriver,
    private val mapper: CoreModelMapper,
) {
    private val mutex = Mutex()

    suspend fun send(
        peripheralId: String,
        kind: UByte,
        writeId: UInt,
        value: ByteArray,
        maximumBlobBytes: UShort,
        resultTimeoutMilliseconds: Long = ResultTimeoutMilliseconds,
    ) = mutex.withLock {
        require(writeId != 0u && value.isNotEmpty() && value.size <= maximumBlobBytes.toInt()) {
            "signed document is outside negotiated bounds"
        }
        val maximumFrameBytes = minOf(driver.maximumWriteLength(peripheralId), 512)
        require(maximumFrameBytes >= 64) { "negotiated write length is too small" }
        var began = false
        try {
            coroutineScope {
                val ready = CompletableDeferred<Unit>()
                val result = async(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        val notifications = driver.subscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.StorageService,
                            BotaBluetoothUUIDs.TransferSignedBlobV2,
                        )
                        ready.complete(Unit)
                        notifications.first { notification ->
                            val decoded = mapper.decodeEncryptedUploadV2SignedBlobResult(notification.value)
                            decoded.kind == kind && decoded.writeId == writeId
                        }.let { mapper.decodeEncryptedUploadV2SignedBlobResult(it.value) }
                    } catch (error: Throwable) {
                        ready.completeExceptionally(error)
                        throw error
                    }
                }
                ready.await()
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
                require(reply.result == 0.toUShort()) { "device rejected signed document with ${reply.result}" }
            }
        } catch (error: Throwable) {
            if (began) runCatching {
                write(
                    peripheralId,
                    mapper.createEncryptedUploadV2SignedBlobAbort(kind, writeId),
                    maximumFrameBytes,
                )
            }
            throw error
        } finally {
            runCatching {
                driver.unsubscribe(
                    peripheralId,
                    BotaBluetoothUUIDs.StorageService,
                    BotaBluetoothUUIDs.TransferSignedBlobV2,
                )
            }
        }
    }

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
    }
}
