package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativePacket
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2TransferControlTest {
    @Test
    fun collectorIsAttachedBeforeStartWriteSoImmediateReplyIsNotLost() = runTest {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper)

        val opened = control.open("device", request(), null)

        assertTrue(opened is EncryptedUploadV2OpenResult.Opened)
        assertEquals(1, driver.subscribersAtWrite)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun transferQueueFailsClosedAtTheDocumentedTotalByteBound() = runTest {
        val driver = ControlDriver(overflow = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper)

        val error = runCatching { control.open("device", request(), null) }.exceptionOrNull()

        assertTrue(error.toString(), error is EncryptedUploadV2HostException)
        assertEquals(4u, (error as EncryptedUploadV2HostException).errorCode)
        control.close()
        mapper.close()
    }

    @Test
    fun unsubscribeFailurePoisonsTheOwnerUntilConfirmedDisconnectReset() = runTest {
        val driver = ControlDriver(failUnsubscribe = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper)
        control.open("device", request(), null)
        val cleanup = runCatching { control.release(9u) }.exceptionOrNull() as EncryptedUploadV2HostException
        assertEquals(19u, cleanup.errorCode)

        val poisoned = runCatching { control.open("device", request(), null) }.exceptionOrNull()
            as EncryptedUploadV2HostException
        assertEquals(19u, poisoned.errorCode)

        control.resetAfterConfirmedDisconnect()
        driver.failUnsubscribe = false
        assertTrue(control.open("device", request(), null) is EncryptedUploadV2OpenResult.Opened)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun cancellationBeforeConfirmAbortsAndNeverSendsConfirm() = runTest {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper)
        control.open("device", request(), null)

        control.abort(9u)
        val confirmFailure = runCatching { control.confirm(9u, byteArrayOf(1)) }.exceptionOrNull()

        assertTrue(confirmFailure is IllegalStateException)
        assertEquals(2, driver.writeCount)
        control.close()
        mapper.close()
    }

    @Test
    fun cancellationDuringAndAfterConfirmNeverSendsAbort() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val driver = ControlDriver(confirmEntered = entered, confirmRelease = release)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper)
        control.open("device", request(), null)
        val confirming = async { control.confirm(9u, byteArrayOf(1)) }
        entered.await()

        val during = runCatching { control.abort(9u) }.exceptionOrNull() as EncryptedUploadV2HostException
        release.complete(Unit)
        confirming.await()
        control.abort(9u)

        assertEquals(19u, during.errorCode)
        assertEquals(2, driver.writeCount)
        assertEquals(1, driver.unsubscribeCount)
        control.close()
        mapper.close()
    }

    private fun request() = EncryptedUploadV2StartRequest(
        9u, Session, Session.toString(), 1u, ByteArray(32), 2u, ByteArray(32),
        1u, 0u, 0u, EmptyDigest, 1u, 1u,
    )

    companion object {
        val Session: UUID = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        val EmptyDigest: ByteArray = MessageDigest.getInstance("SHA-256").digest(byteArrayOf())
    }
}

private class ControlDriver(
    private val overflow: Boolean = false,
    var failUnsubscribe: Boolean = false,
    private val confirmEntered: CompletableDeferred<Unit>? = null,
    private val confirmRelease: CompletableDeferred<Unit>? = null,
) : BluetoothDriver {
    private val replies = MutableSharedFlow<BluetoothNotification>()
    var subscribersAtWrite = 0
    var writeCount = 0
    var unsubscribeCount = 0

    override suspend fun write(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
    ) {
        writeCount += 1
        subscribersAtWrite = replies.subscriptionCount.value
        if (confirmEntered != null && writeCount == 2) {
            confirmEntered.complete(Unit)
            withContext(NonCancellable) { confirmRelease?.await() }
        } else {
            replies.emit(BluetoothNotification(1, byteArrayOf(0x40)))
        }
    }

    override suspend fun subscribe(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> = if (overflow) flow {
        emit(BluetoothNotification(1, byteArrayOf(0x40)))
        repeat(2_000) { emit(BluetoothNotification(1, ByteArray(512))) }
        awaitCancellation()
    } else replies

    override suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) {
        unsubscribeCount += 1
        if (failUnsubscribe) throw IllegalStateException("unsubscribe failed")
    }

    override fun maximumWriteLength(peripheralId: String) = 512
    override suspend fun connectedAdvertisements() = emptyList<BluetoothAdvertisement>()
    override fun scan(allowDuplicates: Boolean) = emptyFlow<BluetoothAdvertisement>()
    override suspend fun stopScan() = Unit
    override suspend fun connect(peripheralId: String) = Unit
    override suspend fun discoverServices(peripheralId: String) = Unit
    override suspend fun read(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) = byteArrayOf()
    override suspend fun disconnect(peripheralId: String) = Unit
    override fun close() = Unit
}

private class TransferControlCore : NativeCore {
    override fun encode(packet: NativePacket) = packetWithBytes(30, byteArrayOf(1))

    override fun decode(packet: NativePacket): NativePacket = NativePacket(
        kind = packet.kind,
        fieldIds = intArrayOf(61, 127, 128, 132, 13, 129, 130, 144, 134, 135, 140, 133, 39, 143),
        fieldTypes = intArrayOf(
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_BYTES, NativePacket.FIELD_TYPE_UTF8, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_BYTES, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_BYTES,
        ),
        unsignedValues = longArrayOf(3, 0x40, 9, 0, 0, 1, 2, 0, 1, 1, 1, 0, 0, 0),
        signedValues = LongArray(14),
        dataValues = arrayOf(
            null, null, null, uuidBytes(EncryptedUploadV2TransferControlTest.Session),
            EncryptedUploadV2TransferControlTest.Session.toString().encodeToByteArray(), null, null,
            ByteArray(32), null, null, null, null, null, EncryptedUploadV2TransferControlTest.EmptyDigest,
        ),
    )

    override fun start(command: NativePacket, capabilityBits: ULong) = error("unused")
    override fun poll(): NativePacket? = error("unused")
    override fun dispatch(event: NativePacket) = error("unused")
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) = error("unused")
    override fun close() = Unit

    private fun packetWithBytes(id: Int, value: ByteArray) = NativePacket(
        kind = 0x0524,
        fieldIds = intArrayOf(id), fieldTypes = intArrayOf(NativePacket.FIELD_TYPE_BYTES),
        unsignedValues = longArrayOf(0), signedValues = longArrayOf(0), dataValues = arrayOf(value),
    )

    private fun uuidBytes(id: UUID) = java.nio.ByteBuffer.allocate(16)
        .putLong(id.mostSignificantBits).putLong(id.leastSignificantBits).array()
}
