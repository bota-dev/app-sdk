package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativePacket
import java.util.UUID
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2SignedBlobWriterTest {
    @Test
    fun immediateResultIsObservedBecauseCollectionIsAttachedBeforeBeginWrite() = runTest {
        val driver = WaitingResultDriver(immediateResult = true)
        val mapper = CoreModelMapper(SignedResultCore())
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper)

        writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 100)

        assertEquals(listOf("subscribe", "write", "write", "write", "unsubscribe"), driver.actions)
        mapper.close()
    }

    @Test
    fun uncertainCleanupPoisonsWriterUntilConfirmedDisconnectReset() = runTest {
        val driver = WaitingResultDriver(failUnsubscribe = true)
        val mapper = CoreModelMapper(EncodingOnlyCore())
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper)
        runCatching { writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 20) }

        val poisoned = runCatching {
            writer.send("device", 1u, 8u, ByteArray(8), 408u, resultTimeoutMilliseconds = 20)
        }.exceptionOrNull() as EncryptedUploadV2HostException
        assertEquals(19u, poisoned.errorCode)

        writer.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        driver.failUnsubscribe = false
        val afterReset = runCatching {
            writer.send("device", 1u, 9u, ByteArray(8), 408u, resultTimeoutMilliseconds = 20)
        }.exceptionOrNull() as EncryptedUploadV2HostException
        assertEquals(15u, afterReset.errorCode)
        mapper.close()
    }
    @Test
    fun matchingResultTimeoutBecomesAHostFailureAndAbortsTheWrite() = runTest {
        val driver = WaitingResultDriver()
        val mapper = CoreModelMapper(EncodingOnlyCore())
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper)

        val error = runCatching {
            writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 20)
        }.exceptionOrNull()

        assertTrue(error.toString(), error is EncryptedUploadV2HostException)
        error as EncryptedUploadV2HostException
        assertEquals(15u, error.errorCode)
        assertTrue(error.retryable)
        assertEquals(4, driver.writeCount)
        assertEquals(1, driver.unsubscribeCount)
        mapper.close()
    }

    @Test
    fun transferControlTimeoutBecomesAHostFailureAndReleasesTheSubscription() = runTest {
        val driver = WaitingResultDriver()
        val mapper = CoreModelMapper(EncodingOnlyCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper, controlTimeoutMilliseconds = 20)
        val session = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        val emptyDigest = java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf())

        val error = runCatching {
            control.open(
                "device",
                EncryptedUploadV2StartRequest(
                    9u, session, session.toString(), 1u, ByteArray(32), 2u, ByteArray(32),
                    1u, 0u, 0u, emptyDigest, 1u, 1u,
                ),
                null,
            )
        }.exceptionOrNull()

        assertTrue(error.toString(), error is EncryptedUploadV2HostException)
        error as EncryptedUploadV2HostException
        assertEquals(15u, error.errorCode)
        assertTrue(error.retryable)
        assertEquals(2, driver.writeCount)
        assertEquals(1, driver.unsubscribeCount)
        assertEquals(listOf("subscribe", "write", "write", "unsubscribe"), driver.actions)
        control.close()
        mapper.close()
    }

    @Test
    fun deviceRejectionPreservesExactProtocolStatus() = runTest {
        val driver = WaitingResultDriver(immediateResult = true)
        val mapper = CoreModelMapper(SignedResultCore(result = 0x85u))
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper)

        val error = runCatching {
            writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 100)
        }.exceptionOrNull() as EncryptedUploadV2HostException

        assertEquals(17u, error.errorCode)
        assertEquals(0x85u.toUShort(), error.protocolStatus)
        assertTrue(!error.retryable)
        mapper.close()
    }

    @Test
    fun unmatchedResultFloodFailsAtTheBoundWithoutAnUnboundedQueue() = runTest {
        val driver = WaitingResultDriver(unmatchedResultCount = 65)
        val mapper = CoreModelMapper(SignedResultCore(writeId = 8u))
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper)

        val error = runCatching {
            writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 1_000)
        }.exceptionOrNull() as EncryptedUploadV2HostException

        assertEquals(4u, error.errorCode)
        assertTrue(!error.retryable)
        assertEquals(1, driver.unsubscribeCount)
        mapper.close()
    }

    @Test
    fun abortTimeoutStillAttemptsSignedResultUnsubscribe() = runTest {
        val driver = WaitingResultDriver(abortDelayMilliseconds = 30, unsubscribeDelayMilliseconds = 1)
        val mapper = CoreModelMapper(EncodingOnlyCore())
        val writer = EncryptedUploadV2SignedBlobWriter(driver, mapper, cleanupTimeoutMilliseconds = 20)

        runCatching {
            writer.send("device", 1u, 7u, ByteArray(8), 408u, resultTimeoutMilliseconds = 20)
        }

        assertEquals(1, driver.unsubscribeCompletedCount)
        mapper.close()
    }
}

private class EncodingOnlyCore : NativeCore {
    override fun encode(packet: NativePacket): NativePacket = NativePacket(
        kind = packet.kind,
        fieldIds = intArrayOf(30),
        fieldTypes = intArrayOf(NativePacket.FIELD_TYPE_BYTES),
        unsignedValues = longArrayOf(0),
        signedValues = longArrayOf(0),
        dataValues = arrayOf(byteArrayOf(1)),
    )

    override fun start(command: NativePacket, capabilityBits: ULong) = error("unused")
    override fun poll(): NativePacket? = error("unused")
    override fun dispatch(event: NativePacket) = error("unused")
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) = error("unused")
    override fun decode(packet: NativePacket): NativePacket = error("unused")
    override fun close() = Unit
}

private class WaitingResultDriver(
    private val immediateResult: Boolean = false,
    private val unmatchedResultCount: Int = 0,
    var failUnsubscribe: Boolean = false,
    private val abortDelayMilliseconds: Long = 0,
    private val unsubscribeDelayMilliseconds: Long = 0,
) : BluetoothDriver {
    var writeCount = 0
    var unsubscribeCount = 0
    var unsubscribeCompletedCount = 0
    val actions = mutableListOf<String>()

    override suspend fun write(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
    ) {
        writeCount += 1
        actions += "write"
        if (writeCount == 4 && abortDelayMilliseconds > 0) delay(abortDelayMilliseconds)
    }

    override suspend fun subscribe(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> {
        actions += "subscribe"
        return if (immediateResult) flowOf(BluetoothNotification(1, byteArrayOf(1)))
        else if (unmatchedResultCount > 0) flow {
            repeat(unmatchedResultCount) { emit(BluetoothNotification(1, byteArrayOf(1))) }
        }
        else flow { awaitCancellation() }
    }

    override suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) {
        unsubscribeCount += 1
        actions += "unsubscribe"
        if (unsubscribeDelayMilliseconds > 0) delay(unsubscribeDelayMilliseconds)
        unsubscribeCompletedCount += 1
        if (failUnsubscribe) throw IllegalStateException("unsubscribe failed")
    }

    override fun maximumWriteLength(peripheralId: String): Int = 128
    override suspend fun connectedAdvertisements(): List<BluetoothAdvertisement> = emptyList()
    override fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement> = emptyFlow()
    override suspend fun stopScan() = Unit
    override suspend fun connect(peripheralId: String) = Unit
    override suspend fun discoverServices(peripheralId: String) = Unit
    override suspend fun read(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID): ByteArray =
        error("unused")
    override suspend fun disconnect(peripheralId: String) = Unit
    override fun close() = Unit
}

private class SignedResultCore(
    private val result: UInt = 0u,
    private val writeId: UInt = 7u,
) : NativeCore {
    override fun encode(packet: NativePacket): NativePacket = NativePacket(
        kind = packet.kind,
        fieldIds = intArrayOf(30),
        fieldTypes = intArrayOf(NativePacket.FIELD_TYPE_BYTES),
        unsignedValues = longArrayOf(0),
        signedValues = longArrayOf(0),
        dataValues = arrayOf(byteArrayOf(1)),
    )

    override fun decode(packet: NativePacket): NativePacket = NativePacket(
        kind = packet.kind,
        fieldIds = intArrayOf(127, 151, 152, 155),
        fieldTypes = IntArray(4) { NativePacket.FIELD_TYPE_UNSIGNED },
        unsignedValues = longArrayOf(0x64, 1, writeId.toLong(), result.toLong()),
        signedValues = LongArray(4),
        dataValues = arrayOfNulls(4),
    )

    override fun start(command: NativePacket, capabilityBits: ULong) = error("unused")
    override fun poll(): NativePacket? = error("unused")
    override fun dispatch(event: NativePacket) = error("unused")
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) = error("unused")
    override fun close() = Unit
}
