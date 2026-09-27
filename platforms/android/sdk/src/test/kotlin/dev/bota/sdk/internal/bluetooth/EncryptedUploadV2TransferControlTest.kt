package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.toNativePacket
import dev.bota.sdk.internal.core.EncryptedUploadV2StartRequest
import dev.bota.sdk.internal.core.EncryptedUploadV2DataValue
import dev.bota.sdk.internal.core.EncryptedUploadV2ManifestChunkValue
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferPayload
import dev.bota.sdk.internal.core.EncryptedUploadV2WindowEndValue
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import dev.bota.sdk.internal.host.EncryptedUploadV2ConfirmationException
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativePacket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2TransferControlTest {
    @Test
    fun reconciliationRetainsOneSubscriptionAndUsesRustStartOrResumeEncoding() = runBlocking {
        for (offset in listOf(0uL, 1uL)) {
            val driver = ControlDriver()
            val core = TransferControlCore(listOf(openingReply(0x46, offset), openingReply(if (offset == 0uL) 0x40 else 0x45, offset)))
            val mapper = CoreModelMapper(core)
            val control = testControl(driver, mapper)
            try {
                val rejected = control.open("device", request(), oldCheckpoint()) as EncryptedUploadV2OpenResult.ResumeRejected
                assertEquals(0, driver.unsubscribeCount)
                rejected.assertActive()
                rejected.retry(reconciledCheckpoint(offset))
                assertEquals(1, driver.subscribeCount)
                assertEquals(0, driver.unsubscribeCount)
                assertEquals(2, driver.writeCount)
                assertEquals(listOf(0x22L, if (offset == 0uL) 0x20L else 0x22L), core.encoded.map { it.unsignedField(127) })
                assertEquals(listOf(9L, 9L), core.encoded.map { it.unsignedField(128) })
                assertEquals(offset.toLong(), core.encoded.last().unsignedField(39))
                assertEquals(if (offset == 0uL) 0L else 1L, core.encoded.last().unsignedField(133))
                val repeated = runCatching { rejected.retry(reconciledCheckpoint(offset)) }.exceptionOrNull()
                assertEquals(11u, (repeated as EncryptedUploadV2HostException).errorCode)
                assertEquals(2, driver.writeCount)
            } finally {
                control.release(9u)
                control.close()
                mapper.close()
            }
        }
    }

    @Test
    fun repeatedDeviceRejectionFailsAndAbortsExactlyOnce() = runBlocking {
        val driver = ControlDriver()
        val core = TransferControlCore(listOf(openingReply(0x46, 1u), openingReply(0x46, 0u)))
        val mapper = CoreModelMapper(core)
        val control = testControl(driver, mapper)
        try {
            val rejected = control.open("device", request(), oldCheckpoint()) as EncryptedUploadV2OpenResult.ResumeRejected
            val error = runCatching { rejected.retry(reconciledCheckpoint(1u)) }.exceptionOrNull()
            assertEquals(11u, (error as EncryptedUploadV2HostException).errorCode)
            assertEquals(listOf(0x22L, 0x22L, 0x24L), core.encoded.map { it.unsignedField(127) })
            assertEquals(1, driver.unsubscribeCount)
        } finally {
            control.close()
            mapper.close()
        }
    }

    @Test
    fun rejectsForeignNewerEqualAndNonMismatchDeviceCheckpoints() = runBlocking {
        for (reply in listOf(
            openingReply(0x46, 1u, reason = 0x13),
            openingReply(0x46, 1u, session = 10),
            openingReply(0x46, 2u, revision = 3),
            openingReply(0x46, 2u, revision = 2),
            openingReply(0x46, 1u, revision = 0),
        )) {
            val driver = ControlDriver()
            val core = TransferControlCore(listOf(reply))
            val mapper = CoreModelMapper(core)
            val control = testControl(driver, mapper)
            try {
                val error = runCatching { control.open("device", request(), oldCheckpoint()) }.exceptionOrNull()
                assertEquals(11u, (error as EncryptedUploadV2HostException).errorCode)
                assertEquals(listOf(0x22L, 0x24L), core.encoded.map { it.unsignedField(127) })
                assertEquals(1, driver.unsubscribeCount)
            } finally {
                control.close()
                mapper.close()
            }
        }
    }

    @Test
    fun savedReconciliationCannotWriteOrReleaseANewerConnection() = runBlocking {
        val driver = ControlDriver()
        val core = TransferControlCore(listOf(openingReply(0x46, 1u), openingReply(0x40, 0u)))
        val mapper = CoreModelMapper(core)
        val control = testControl(driver, mapper)
        try {
            val rejected = control.open("device", request(), oldCheckpoint()) as EncryptedUploadV2OpenResult.ResumeRejected
            control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
            driver.connectionGeneration = 2
            control.open("device", request(), null)
            val error = runCatching { rejected.retry(reconciledCheckpoint(1u)) }.exceptionOrNull()
            assertEquals(12u, (error as EncryptedUploadV2HostException).errorCode)
            rejected.cancel()
            assertEquals(2, driver.writeCount)
            assertEquals(0, driver.unsubscribeCount)
            control.confirm(9u, byteArrayOf(1)) {}
            assertEquals(3, driver.writeCount)
        } finally {
            control.close()
            mapper.close()
        }
    }

    @Test
    fun concurrentAbortJoinsOneCleanup() = runBlocking(Dispatchers.IO) {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val driver = ControlDriver(unsubscribeEntered = entered, unsubscribeRelease = release)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        try {
            control.open("device", request(), null)
            val first = async(Dispatchers.Default) { control.abort(9u) }
            withTimeout(TestSettlementTimeoutMilliseconds) { entered.await() }
            val second = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { control.abort(9u) }
            release.complete(Unit)
            withTimeout(TestSettlementTimeoutMilliseconds) { first.await(); second.await() }
            assertEquals(2, driver.writeCount)
            assertEquals(1, driver.unsubscribeCount)
        } finally {
            release.complete(Unit)
            control.close()
            mapper.close()
        }
    }

    private fun oldCheckpoint() = EncryptedUploadV2CheckpointValue(2u, 2u, ByteArray(32), 9u)

    private fun reconciledCheckpoint(offset: ULong) = EncryptedUploadV2CheckpointValue(
        if (offset == 0uL) 0u else 1u, offset, EmptyDigest, if (offset == 0uL) null else 0u,
    )

    private fun openingReply(
        type: Int,
        offset: ULong,
        revision: Long = if (offset == 0uL) 0 else 1,
        reason: Long = 15,
        session: Long = 9,
    ) = listOf(
        CoreField.Unsigned(61, 3u), CoreField.Unsigned(127, type.toULong()),
        CoreField.Unsigned(128, session.toULong()), CoreField.Unsigned(133, revision.toULong()),
        CoreField.Unsigned(39, offset), CoreField.Bytes(143, EmptyDigest), CoreField.Unsigned(155, reason.toULong()),
        CoreField.Bytes(132, java.nio.ByteBuffer.allocate(16).putLong(Session.mostSignificantBits).putLong(Session.leastSignificantBits).array()),
        CoreField.Text(13, Session.toString()), CoreField.Unsigned(129, 1u),
        CoreField.Unsigned(134, 1u), CoreField.Unsigned(135, 1u), CoreField.Unsigned(130, 2u),
        CoreField.Bytes(144, ByteArray(32)), CoreField.Unsigned(140, 1u),
    ).toNativePacket(0x0525)

    private fun NativePacket.unsignedField(id: Int): Long = unsignedValues[fieldIds.indexOf(id)]

    @Test
    fun staleConnectionCannotReceiveAbortOrUnsubscribe() = runBlocking {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        try {
            control.open("device", request(), null)
            driver.connectionGeneration = 2
            control.abort(9u)
            assertEquals(1, driver.writeCount)
            assertEquals(0, driver.unsubscribeCount)
        } finally {
            control.close()
            mapper.close()
        }
    }

    @Test
    fun staleConnectionCannotReceiveActiveControlWrite() = runBlocking {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        try {
            control.open("device", request(), null)
            driver.connectionGeneration = 2
            val failure = runCatching {
                control.writeActiveFrame(9u, byteArrayOf(1), EncryptedUploadV2TransferContinuation.Window)
            }.exceptionOrNull()
            assertTrue(failure is EncryptedUploadV2HostException)
            assertEquals(12u, (failure as EncryptedUploadV2HostException).errorCode)
            assertEquals(1, driver.writeCount)
        } finally {
            control.close()
            mapper.close()
        }
    }

    @Test
    fun collectorIsAttachedBeforeStartWriteSoImmediateReplyIsNotLost() = runBlocking {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)

        val opened = control.open("device", request(), null)

        assertTrue(opened is EncryptedUploadV2OpenResult.Opened)
        assertEquals(1, driver.subscribersAtWrite)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun transferQueueFailsClosedAtTheDocumentedTotalByteBound() = runBlocking {
        val driver = ControlDriver(overflow = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)

        val opened = control.open("device", request(), null) as EncryptedUploadV2OpenResult.Opened
        withContext(Dispatchers.Default) { withTimeout(1_000) { driver.awaitOverflowAttempt() } }
        val error = runCatching { opened.notifications.toList() }.exceptionOrNull()

        assertTrue(error.toString(), error is EncryptedUploadV2HostException)
        assertEquals(4u, (error as EncryptedUploadV2HostException).errorCode)
        control.close()
        mapper.close()
    }

    @Test
    fun unsubscribeFailurePoisonsTheOwnerUntilConfirmedDisconnectReset() = runBlocking {
        val driver = ControlDriver(failUnsubscribe = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        control.open("device", request(), null)
        val cleanup = runCatching { control.release(9u) }.exceptionOrNull() as EncryptedUploadV2HostException
        assertEquals(19u, cleanup.errorCode)

        val poisoned = runCatching { control.open("device", request(), null) }.exceptionOrNull()
            as EncryptedUploadV2HostException
        assertEquals(19u, poisoned.errorCode)

        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        driver.failUnsubscribe = false
        assertTrue(control.open("device", request(), null) is EncryptedUploadV2OpenResult.Opened)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun staleDisconnectGenerationCannotClearANewerPoisonedOwner() = runBlocking {
        val driver = ControlDriver(failUnsubscribe = true, connectionGeneration = 2)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        control.open("device", request(), null)
        runCatching { control.release(9u) }

        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        assertEquals(
            19u,
            (runCatching { control.open("device", request(), null) }.exceptionOrNull()
                as EncryptedUploadV2HostException).errorCode,
        )
        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 2))
        driver.failUnsubscribe = false
        assertTrue(control.open("device", request(), null) is EncryptedUploadV2OpenResult.Opened)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun abortTimeoutStillAttemptsUnsubscribeAndPoisonsUntilReset() = runBlocking {
        val driver = ControlDriver(abortDelayMilliseconds = 1_000, unsubscribeDelayMilliseconds = 10)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = EncryptedUploadV2TransferControl(driver, mapper, cleanupTimeoutMilliseconds = 200)
        control.open("device", request(), null)

        val cleanup = runCatching { control.abort(9u) }.exceptionOrNull() as EncryptedUploadV2HostException

        assertEquals(19u, cleanup.errorCode)
        assertEquals(1, driver.unsubscribeCompletedCount)
        assertEquals(19u, (runCatching { control.open("device", request(), null) }.exceptionOrNull()
            as EncryptedUploadV2HostException).errorCode)
        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        control.close()
        mapper.close()
    }

    @Test
    fun cancellationBeforeConfirmAbortsAndNeverSendsConfirm() = runBlocking {
        val driver = ControlDriver()
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        control.open("device", request(), null)

        assertFalse(control.confirmationAttemptedOrClaimCancellation(9u))
        control.abort(9u)
        val confirmFailure = runCatching { control.confirm(9u, byteArrayOf(1)) {} }.exceptionOrNull()

        assertTrue(confirmFailure is IllegalStateException)
        assertEquals(2, driver.writeCount)
        control.close()
        mapper.close()
    }

    @Test
    fun cancellationDuringAndAfterConfirmNeverSendsAbort() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val driver = ControlDriver(
            immediateSubscribeReply = true,
            confirmEntered = entered,
            confirmRelease = release,
        )
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        control.open("device", request(), null)
        val confirming = async(Dispatchers.Default) { control.confirm(9u, byteArrayOf(1)) {} }
        withContext(Dispatchers.Default) { withTimeout(TestSettlementTimeoutMilliseconds) { entered.await() } }

        val during = async(Dispatchers.Default) {
            control.confirmationAttemptedOrClaimCancellation(9u)
        }
        try {
            assertFalse(during.isCompleted)
        } finally {
            release.complete(Unit)
        }
        withContext(Dispatchers.Default) {
            withTimeout(TestSettlementTimeoutMilliseconds) { confirming.await() }
        }
        assertTrue(withContext(Dispatchers.Default) {
            withTimeout(TestSettlementTimeoutMilliseconds) { during.await() }
        })
        control.abort(9u)

        assertEquals(2, driver.writeCount)
        assertEquals(1, driver.unsubscribeCount)
        control.close()
        mapper.close()
    }

    @Test
    fun successfulConfirmWriteWithFailedUnsubscribeReportsDeletionAndPoisonsUntilDisconnect() = runBlocking {
        val driver = ControlDriver(failUnsubscribe = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        val opened = control.open("device", request(), null)

        val failure = runCatching { control.confirm(9u, byteArrayOf(1)) {} }.exceptionOrNull()
            as EncryptedUploadV2ConfirmationException
        val replacement = runCatching { control.open("device", request(), null) }.exceptionOrNull()

        assertTrue(failure.writeSucceeded)
        assertEquals(19u, failure.errorCode)
        assertEquals(19u, (replacement as EncryptedUploadV2HostException).errorCode)
        val lateCancellation = runCatching { opened.cancel() }.exceptionOrNull()
        assertEquals(19u, (lateCancellation as EncryptedUploadV2HostException).errorCode)
        assertEquals(2, driver.writeCount)
        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        driver.failUnsubscribe = false
        assertTrue(control.open("device", request(), null) is EncryptedUploadV2OpenResult.Opened)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun disconnectDuringConfirmUnsubscribeWaitsForSettlementAndClearsTheExactPoison() = runBlocking {
        val unsubscribeEntered = CompletableDeferred<Unit>()
        val unsubscribeRelease = CompletableDeferred<Unit>()
        val driver = ControlDriver(
            failUnsubscribe = true,
            unsubscribeEntered = unsubscribeEntered,
            unsubscribeRelease = unsubscribeRelease,
        )
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        control.open("device", request(), null)
        val confirming = async(Dispatchers.Default) {
            runCatching { control.confirm(9u, byteArrayOf(1)) {} }.exceptionOrNull()
        }
        withContext(Dispatchers.Default) { withTimeout(1_000) { unsubscribeEntered.await() } }

        val resetting = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        }
        val resetReturnedBeforeConfirmationSettled = try {
            resetting.isCompleted
        } finally {
            unsubscribeRelease.complete(Unit)
        }
        val failure = withContext(Dispatchers.Default) { withTimeout(1_000) { confirming.await() } }
        withContext(Dispatchers.Default) { withTimeout(1_000) { resetting.await() } }

        assertFalse(resetReturnedBeforeConfirmationSettled)
        assertTrue((failure as EncryptedUploadV2ConfirmationException).writeSucceeded)
        driver.failUnsubscribe = false
        assertTrue(control.open("device", request(), null) is EncryptedUploadV2OpenResult.Opened)
        control.release(9u)
        control.close()
        mapper.close()
    }

    @Test
    fun intakeRemainsPausedUntilAcknowledgementWriteCompletes() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val driver = ControlDriver(activeWriteEntered = entered, activeWriteRelease = release)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        val opened = control.open("device", request(), null) as EncryptedUploadV2OpenResult.Opened
        val windowObserved = CompletableDeferred<Unit>()
        val collecting = async(Dispatchers.Default) {
            runCatching { opened.notifications.onEach { windowObserved.complete(Unit) }.toList() }.exceptionOrNull()
        }
        driver.emit(byteArrayOf(0x42))
        withContext(Dispatchers.Default) { withTimeout(1_000) { windowObserved.await() } }

        val acknowledging = async(Dispatchers.Default) {
            control.writeActiveFrame(9u, byteArrayOf(1), EncryptedUploadV2TransferContinuation.Window)
        }
        withContext(Dispatchers.Default) { withTimeout(1_000) { entered.await() } }
        val failure = try {
            withContext(Dispatchers.Default) { withTimeout(1_000) { driver.emit(byteArrayOf(0x41)) } }
            withContext(Dispatchers.Default) { withTimeout(1_000) { collecting.await() } }
        } finally {
            release.complete(Unit)
        }

        assertEquals(9u, (failure as EncryptedUploadV2HostException).errorCode)
        withContext(Dispatchers.Default) { withTimeout(1_000) { runCatching { acknowledging.await() } } }
        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        control.close()
        mapper.close()
    }

    @Test
    fun failedAcknowledgementWritePoisonsWithoutAdvancingIntake() = runBlocking {
        val driver = ControlDriver(failActiveWrite = true)
        val mapper = CoreModelMapper(TransferControlCore())
        val control = testControl(driver, mapper)
        val opened = control.open("device", request(), null) as EncryptedUploadV2OpenResult.Opened
        val windowObserved = CompletableDeferred<Unit>()
        val collecting = async(Dispatchers.Default) {
            runCatching { opened.notifications.onEach { windowObserved.complete(Unit) }.toList() }.exceptionOrNull()
        }
        driver.emit(byteArrayOf(0x42))
        withContext(Dispatchers.Default) { withTimeout(1_000) { windowObserved.await() } }

        val failure = runCatching {
            control.writeActiveFrame(9u, byteArrayOf(1), EncryptedUploadV2TransferContinuation.Manifest)
        }.exceptionOrNull()
        val replacement = runCatching { control.open("device", request(), null) }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        assertEquals(19u, (replacement as EncryptedUploadV2HostException).errorCode)
        assertTrue(withContext(Dispatchers.Default) { withTimeout(1_000) { collecting.await() } } != null)
        control.resetAfterConfirmedDisconnect(ConfirmedBluetoothDisconnect("device", 1))
        control.close()
        mapper.close()
    }

    @Test
    fun intakeRejectsPrematureNextWindowAndManifestAtArrival() {
        val nextWindow = EncryptedUploadV2TransferIntake(9u)
        nextWindow.accept(windowEnd())
        val nextWindowError = runCatching { nextWindow.accept(data(sequence = 2u)) }.exceptionOrNull()

        val manifest = EncryptedUploadV2TransferIntake(9u)
        manifest.accept(windowEnd())
        val manifestError = runCatching { manifest.accept(manifest()) }.exceptionOrNull()

        assertEquals(9u, (nextWindowError as EncryptedUploadV2HostException).errorCode)
        assertEquals(9u, (manifestError as EncryptedUploadV2HostException).errorCode)
    }

    @Test
    fun intakeRejectsRepairWindowEndUntilEveryRequestedRetransmissionArrives() {
        val intake = EncryptedUploadV2TransferIntake(9u)
        intake.accept(windowEnd())
        intake.continueWith(EncryptedUploadV2TransferContinuation.Repair(setOf(1u)))

        val error = runCatching { intake.accept(windowEnd()) }.exceptionOrNull()

        assertEquals(9u, (error as EncryptedUploadV2HostException).errorCode)
        val valid = EncryptedUploadV2TransferIntake(9u)
        valid.accept(windowEnd())
        valid.continueWith(EncryptedUploadV2TransferContinuation.Repair(setOf(1u)))
        valid.accept(data(sequence = 1u))
        valid.accept(windowEnd())
    }

    private fun data(sequence: UInt) = EncryptedUploadV2TransferPayload.Data(
        EncryptedUploadV2DataValue(9u, sequence, sequence.toULong(), byteArrayOf(1)),
    )

    private fun windowEnd() = EncryptedUploadV2TransferPayload.WindowEnd(
        EncryptedUploadV2WindowEndValue(9u, 0u, 0u, 1u, 2u, EmptyDigest, 1u),
    )

    private fun manifest() = EncryptedUploadV2TransferPayload.ManifestChunk(
        EncryptedUploadV2ManifestChunkValue(9u, 580u, 0u, EmptyDigest, byteArrayOf(1)),
    )

    private fun request() = EncryptedUploadV2StartRequest(
        9u, Session, Session.toString(), 1u, ByteArray(32), 2u, ByteArray(32),
        1u, 0u, 0u, EmptyDigest, 1u, 1u,
    )

    private fun testControl(driver: ControlDriver, mapper: CoreModelMapper) =
        EncryptedUploadV2TransferControl(
            driver,
            mapper,
            cleanupTimeoutMilliseconds = TestCleanupTimeoutMilliseconds,
        )

    companion object {
        private const val TestCleanupTimeoutMilliseconds = 30_000L
        private const val TestSettlementTimeoutMilliseconds = 5_000L
        val Session: UUID = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        val EmptyDigest: ByteArray = MessageDigest.getInstance("SHA-256").digest(byteArrayOf())
    }
}

private class ControlDriver(
    private val overflow: Boolean = false,
    var failUnsubscribe: Boolean = false,
    private val confirmEntered: CompletableDeferred<Unit>? = null,
    private val confirmRelease: CompletableDeferred<Unit>? = null,
    private val immediateSubscribeReply: Boolean = false,
    private val abortDelayMilliseconds: Long = 0,
    private val unsubscribeDelayMilliseconds: Long = 0,
    private val activeWriteEntered: CompletableDeferred<Unit>? = null,
    private val activeWriteRelease: CompletableDeferred<Unit>? = null,
    private val failActiveWrite: Boolean = false,
    var connectionGeneration: Long = 1,
    private val unsubscribeEntered: CompletableDeferred<Unit>? = null,
    private val unsubscribeRelease: CompletableDeferred<Unit>? = null,
) : BluetoothDriver {
    private val replies = MutableSharedFlow<BluetoothNotification>()
    private val overflowAttempted = CompletableDeferred<Unit>()
    private val startReplyPending = AtomicReference<CompletableDeferred<Unit>?>()
    var subscribersAtWrite = 0
    var writeCount = 0
    var unsubscribeCount = 0
    var unsubscribeCompletedCount = 0
    var subscribeCount = 0

    override suspend fun write(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
    ) {
        writeCount += 1
        startReplyPending.getAndSet(null)?.let { attached ->
            withTimeout(5_000) { attached.await() }
        }
        subscribersAtWrite = replies.subscriptionCount.value
        if (activeWriteEntered != null && writeCount == 2) {
            activeWriteEntered.complete(Unit)
            withContext(NonCancellable) { activeWriteRelease?.await() }
        } else if (failActiveWrite && writeCount == 2) {
            throw IllegalStateException("ACK write failed")
        } else if (confirmEntered != null && writeCount == 2) {
            confirmEntered.complete(Unit)
            withContext(NonCancellable) { confirmRelease?.await() }
        } else if (abortDelayMilliseconds > 0 && writeCount == 2) {
            delay(abortDelayMilliseconds)
        } else if (!immediateSubscribeReply) {
            replies.emit(BluetoothNotification(1, byteArrayOf(0x40)))
        }
    }

    override suspend fun subscribe(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> {
        subscribeCount++
        return if (immediateSubscribeReply) flow {
            emit(BluetoothNotification(1, byteArrayOf(0x40)))
            awaitCancellation()
        } else if (overflow) flow {
            try {
                emit(BluetoothNotification(1, byteArrayOf(0x40)))
                repeat(2_000) { emit(BluetoothNotification(1, ByteArray(512))) }
            } finally {
                overflowAttempted.complete(Unit)
            }
            awaitCancellation()
        } else {
            val attached = CompletableDeferred<Unit>()
            startReplyPending.set(attached)
            replies.onSubscription { attached.complete(Unit) }
        }
    }

    override suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) {
        unsubscribeCount += 1
        unsubscribeEntered?.complete(Unit)
        if (unsubscribeRelease != null) withContext(NonCancellable) { unsubscribeRelease.await() }
        if (unsubscribeDelayMilliseconds > 0) delay(unsubscribeDelayMilliseconds)
        unsubscribeCompletedCount += 1
        if (failUnsubscribe) throw IllegalStateException("unsubscribe failed")
    }

    suspend fun emit(value: ByteArray) { replies.emit(BluetoothNotification(1, value)) }

    suspend fun awaitOverflowAttempt() = overflowAttempted.await()

    override fun maximumWriteLength(peripheralId: String) = 512
    override fun connectionGeneration(peripheralId: String) = connectionGeneration
    override suspend fun connectedAdvertisements() = emptyList<BluetoothAdvertisement>()
    override fun scan(allowDuplicates: Boolean) = emptyFlow<BluetoothAdvertisement>()
    override suspend fun stopScan() = Unit
    override suspend fun connect(peripheralId: String) = Unit
    override suspend fun discoverServices(peripheralId: String) = Unit
    override suspend fun read(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) = byteArrayOf()
    override suspend fun disconnect(peripheralId: String) = Unit
    override fun close() = Unit
}

private class TransferControlCore(controlReplies: List<NativePacket> = emptyList()) : NativeCore {
    private val controlReplies = controlReplies.iterator()
    val encoded = mutableListOf<NativePacket>()
    override fun encode(packet: NativePacket): NativePacket {
        encoded += packet
        return packetWithBytes(30, byteArrayOf(1))
    }

    override fun decode(packet: NativePacket): NativePacket {
        val value = packet.dataValues.firstOrNull() as? ByteArray
        return when {
            value?.size == 512 -> dataPacket()
            value?.firstOrNull()?.toInt() == 0x41 -> dataPacket()
            value?.firstOrNull()?.toInt() == 0x42 -> windowEndPacket()
            else -> if (controlReplies.hasNext()) controlReplies.next() else controlPacket()
        }
    }

    private fun controlPacket(): NativePacket = NativePacket(
        kind = 0x0525,
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

    private fun dataPacket(): NativePacket = NativePacket(
        kind = 0x0525,
        fieldIds = intArrayOf(61, 127, 128, 38, 39, 150, 30),
        fieldTypes = intArrayOf(
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_UNSIGNED, NativePacket.FIELD_TYPE_UNSIGNED,
            NativePacket.FIELD_TYPE_BYTES,
        ),
        unsignedValues = longArrayOf(3, 0x41, 9, 0, 0, 512, 0),
        signedValues = LongArray(7),
        dataValues = arrayOf(null, null, null, null, null, null, ByteArray(512)),
    )

    private fun windowEndPacket(): NativePacket = NativePacket(
        kind = 0x0525,
        fieldIds = intArrayOf(61, 127, 128, 160, 158, 159, 39, 143, 133),
        fieldTypes = IntArray(9) { if (it == 7) NativePacket.FIELD_TYPE_BYTES else NativePacket.FIELD_TYPE_UNSIGNED },
        unsignedValues = longArrayOf(3, 0x42, 9, 0, 0, 1, 2, 0, 1),
        signedValues = LongArray(9),
        dataValues = arrayOf(null, null, null, null, null, null, null, EncryptedUploadV2TransferControlTest.EmptyDigest, null),
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
