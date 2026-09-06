package dev.bota.sdk.internal.core

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.jni.NativePacket
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreEngineRuntimeTest {
    @Test
    fun runsEffectsAndNotificationsInOrderOnOneNativeThread() = runTest {
        val core = ScriptedCore(terminalOnStart = true, staleDispatchesRemaining = 1)
        val effects = mutableListOf<CoreEffectKind>()
        val runtime = CoreEngineRuntime(core) { effect ->
            effects += effect.kind
            flowOf(CoreHostEvent.fromEffect(effect, HostEventKind.BleScanStopped))
        }

        val notifications = runtime.run(
            CoreCommand.discoverDevices(timeoutMilliseconds = 10u, allowDuplicates = false),
            CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
        ).toList()

        assertEquals(
            listOf(CoreNotificationKind.Started, CoreNotificationKind.DeviceDiscovered, CoreNotificationKind.Completed),
            notifications.map(CoreNotification::kind),
        )
        assertEquals(
            listOf(CoreEffectKind.BluetoothStartScan, CoreEffectKind.TimerSchedule, CoreEffectKind.BluetoothStopScan),
            effects,
        )
        assertEquals(listOf(1uL, 2uL, 3uL), core.polledRequestIds)
        assertEquals(3, core.dispatchCount)
        assertEquals(1, core.nativeThreadIds.distinct().size)
        runtime.close()
    }

    @Test
    fun secondCommandReachesCoreAndDoesNotReplaceTheFirstOwner() = runTest {
        val core = ScriptedCore(terminalOnStart = false)
        val runtime = CoreEngineRuntime(core) { flowOf() }
        val firstId = UUID.fromString("01010101-0101-0101-0101-010101010101")
        val first = async {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, firstId),
                CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
            ).toList()
        }
        core.started.await()

        val second = runCatching {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false),
                CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
            ).toList()
        }.exceptionOrNull()

        assertTrue(second is NativeCoreException && second.code == 8)
        runtime.cancel(firstId)
        assertEquals(listOf(CoreNotificationKind.Started, CoreNotificationKind.Cancelled), first.await().map { it.kind })
        runtime.close()
    }

    @Test
    fun cancellationPreservesUuidHalvesAndCloseCancelsBeforeFreeingCore() = runTest {
        val core = ScriptedCore(terminalOnStart = false)
        val runtime = CoreEngineRuntime(core) { callbackFlow { awaitClose {} } }
        val cancellationId = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        val collector = launch {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, cancellationId),
                CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
            ).collect()
        }
        core.started.await()

        collector.cancelAndJoin()
        withContext(Dispatchers.Default) {
            withTimeout(2_000) { core.cancelled.await() }
        }
        runtime.close()

        assertEquals(0x0011223344556677uL, core.cancelledHigh)
        assertEquals(0x8899aabbccddeeffuL, core.cancelledLow)
        assertTrue(core.closed)
        assertFalse(core.cancelAfterClose)
    }

    @Test
    fun cancellationRegistersQueuedEffectsAndReachesCoreBeforeHostCancellation() = runTest {
        val order = mutableListOf<String>()
        val core = ScriptedCore(terminalOnStart = false, cancellationOrder = order)
        val effectStarted = CompletableDeferred<Unit>()
        val handler = object : CoreEffectHandler {
            override fun execute(effect: CoreEffect): kotlinx.coroutines.flow.Flow<CoreHostEvent> = callbackFlow {
                order += "effect-started"
                effectStarted.complete(Unit)
                awaitClose {}
            }

            override suspend fun cancel(cancellationId: CoreCancellationId) {
                order += "host-cancelled"
            }
        }
        val runtime = CoreEngineRuntime(core, handler)
        val cancellationId = UUID.randomUUID()
        val collector = launch {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, cancellationId),
                CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
            ).collect()
        }
        effectStarted.await()

        collector.cancelAndJoin()
        withContext(Dispatchers.Default) { withTimeout(2_000) { core.cancelled.await() } }

        assertTrue(order.indexOf("effect-started") < order.indexOf("core-cancelled"))
        assertTrue(order.indexOf("core-cancelled") < order.indexOf("host-cancelled"))
        runtime.close()
    }

    @Test
    fun hostCancellationFailureStillDrainsTheOldOwnerBeforeReplacementRun() = runTest {
        val core = RestartableCore()
        val handler = object : CoreEffectHandler {
            override fun execute(effect: CoreEffect) = callbackFlow<CoreHostEvent> { awaitClose {} }

            override suspend fun cancel(cancellationId: CoreCancellationId) {
                throw IllegalStateException("application cleanup failed")
            }
        }
        val runtime = CoreEngineRuntime(core, handler)
        val firstId = UUID.randomUUID()
        val first = async {
            runtime.run(CoreCommand.discoverDevices(10_000u, false, firstId), CoreCapabilities.Bluetooth).toList()
        }
        core.started.await()

        val cancellationFailure = runCatching { runtime.cancel(firstId) }.exceptionOrNull()
        val second = runtime.run(
            CoreCommand.discoverDevices(10_000u, false),
            CoreCapabilities.Bluetooth,
        ).toList()

        assertEquals(listOf(CoreNotificationKind.Started, CoreNotificationKind.Cancelled), first.await().map { it.kind })
        assertEquals("application cleanup failed", cancellationFailure?.message)
        assertEquals(listOf(CoreNotificationKind.Started, CoreNotificationKind.Completed), second.map { it.kind })
        assertEquals(0, core.pendingOutputCount)
        runtime.close()
    }

    @Test
    fun closeAlwaysClosesCoreWhenHostCancellationFails() = runTest {
        val core = RestartableCore(completeReplacement = false)
        val runtime = CoreEngineRuntime(core, object : CoreEffectHandler {
            override fun execute(effect: CoreEffect) = callbackFlow<CoreHostEvent> { awaitClose {} }
            override suspend fun cancel(cancellationId: CoreCancellationId) {
                throw IllegalStateException("cleanup failed")
            }
        })
        val collecting = launch {
            runtime.run(CoreCommand.discoverDevices(10_000u, false), CoreCapabilities.Bluetooth).collect()
        }
        core.started.await()

        runCatching { runtime.close() }

        assertTrue(core.closed)
        collecting.cancelAndJoin()
    }

    @Test
    fun cancellationDuringConfirmationWaitsForTheExactHostCompletion() = runTest {
        val core = DeferredConfirmationCore()
        val confirmationEntered = CompletableDeferred<Unit>()
        val confirmationRelease = CompletableDeferred<Unit>()
        var hostCancellationCount = 0
        val runtime = CoreEngineRuntime(core, object : CoreEffectHandler {
            override fun execute(effect: CoreEffect) = flow {
                confirmationEntered.complete(Unit)
                confirmationRelease.await()
                emit(CoreHostEvent.fromEffect(effect, HostEventKind.EncryptedUploadV2RecordingConfirmed))
            }

            override suspend fun cancel(cancellationId: CoreCancellationId) {
                hostCancellationCount += 1
            }

            override suspend fun confirmationAttemptedOrClaimCancellation(
                cancellationId: CoreCancellationId,
            ) = true
        })
        val cancellationId = UUID.randomUUID()
        val collecting = async {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, cancellationId),
                CoreCapabilities.Bluetooth,
            ).toList()
        }
        confirmationEntered.await()

        val cancelling = async { runtime.cancel(cancellationId) }
        confirmationRelease.complete(Unit)
        withContext(Dispatchers.Default) { withTimeout(2_000) { cancelling.await() } }

        assertEquals(0, hostCancellationCount)
        assertEquals(
            listOf(CoreNotificationKind.Started, CoreNotificationKind.Completed),
            collecting.await().map { it.kind },
        )
        runtime.close()
    }

    @Test
    fun cancellationDuringConfirmationSurfacesTheExactOwnershipUncertainty() = runTest {
        val core = DeferredConfirmationCore(
            terminal = listOf(
                CoreField.Unsigned(47, 19u),
                CoreField.BooleanValue(48, false),
                CoreField.Text(50, "CONFIRM outcome is uncertain"),
            ).toNativePacket(kind = 0x040c, operation = 8),
        )
        val confirmationEntered = CompletableDeferred<Unit>()
        val confirmationRelease = CompletableDeferred<Unit>()
        val runtime = CoreEngineRuntime(core, object : CoreEffectHandler {
            override fun execute(effect: CoreEffect) = flow {
                    confirmationEntered.complete(Unit)
                    confirmationRelease.await()
                    emit(CoreHostEvent.fromEffect(effect, HostEventKind.EncryptedUploadV2RecordingConfirmed))
            }
            override suspend fun confirmationAttemptedOrClaimCancellation(
                cancellationId: CoreCancellationId,
            ) = true
        })
        val cancellationId = UUID.randomUUID()
        val collecting = async {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, cancellationId),
                CoreCapabilities.Bluetooth,
            ).toList()
        }
        confirmationEntered.await()

        val cancelling = async { runCatching { runtime.cancelAndReportExactSettlement(cancellationId) }.exceptionOrNull() }
        confirmationRelease.complete(Unit)
        try {
            val failure = withContext(Dispatchers.Default) { withTimeout(2_000) { cancelling.await() } }
            assertTrue(failure is BotaSDKError.Core)
            failure as BotaSDKError.Core
            assertEquals(BotaErrorCode.UploadOwnershipUnknown, failure.code)
            assertEquals("CONFIRM outcome is uncertain", failure.detail)
            assertEquals(CoreNotificationKind.Failed, collecting.await().last().kind)
        } finally {
            runtime.close()
        }
    }

    @Test
    fun collectorCancellationCanConsumeTheAlreadySettledExactConfirmation() = runTest {
        val core = DeferredConfirmationCore()
        val confirmationEntered = CompletableDeferred<Unit>()
        val confirmationRelease = CompletableDeferred<Unit>()
        var hostCancellationCount = 0
        val runtime = CoreEngineRuntime(core, object : CoreEffectHandler {
            override fun execute(effect: CoreEffect) = flow {
                confirmationEntered.complete(Unit)
                confirmationRelease.await()
                emit(CoreHostEvent.fromEffect(effect, HostEventKind.EncryptedUploadV2RecordingConfirmed))
            }

            override suspend fun cancel(cancellationId: CoreCancellationId) {
                hostCancellationCount += 1
            }

            override suspend fun confirmationAttemptedOrClaimCancellation(
                cancellationId: CoreCancellationId,
            ) = true
        })
        val cancellationId = UUID.randomUUID()
        val collector = launch {
            runtime.run(
                CoreCommand.discoverDevices(10_000u, false, cancellationId),
                CoreCapabilities.Bluetooth,
            ).collect()
        }
        confirmationEntered.await()

        collector.cancelAndJoin()
        confirmationRelease.complete(Unit)
        withContext(Dispatchers.Default) { withTimeout(2_000) { core.settled.await() } }
        val exactSettlement = runtime.cancelAndReportExactSettlement(cancellationId)

        assertTrue(exactSettlement)
        assertEquals(0, hostCancellationCount)
        assertFalse(core.cancelEntered.isCompleted)
        runtime.close()
    }
}

private class DeferredConfirmationCore(
    private val terminal: NativePacket = NativePacket(kind = 0x040a),
) : NativeCore {
    private val outputs = ArrayDeque<NativePacket>()
    val cancelEntered = CompletableDeferred<Unit>()
    val settled = CompletableDeferred<Unit>()

    override fun start(command: NativePacket, capabilityBits: ULong) {
        outputs += NativePacket(kind = 0x0401)
        outputs += NativePacket(
            kind = CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt.wireValue,
            operation = 8,
            requestIdBits = 1,
            cancellationHighBits = command.cancellationHighBits,
            cancellationLowBits = command.cancellationLowBits,
        )
    }

    override fun poll(): NativePacket? = outputs.removeFirstOrNull()?.also {
        if (it === terminal) settled.complete(Unit)
    }
    override fun dispatch(event: NativePacket) { outputs += terminal }
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) { cancelEntered.complete(Unit) }
    override fun decode(packet: NativePacket): NativePacket = error("unused")
    override fun encode(packet: NativePacket): NativePacket = error("unused")
    override fun close() = Unit
}

private class RestartableCore(private val completeReplacement: Boolean = true) : NativeCore {
    private val outputs = ArrayDeque<NativePacket>()
    private var runCount = 0
    val started = CompletableDeferred<Unit>()
    var closed = false
    val pendingOutputCount: Int get() = outputs.size

    override fun start(command: NativePacket, capabilityBits: ULong) {
        runCount += 1
        outputs += packet(0x0401)
        if (runCount > 1 && completeReplacement) outputs += packet(0x040a)
        started.complete(Unit)
    }

    override fun poll(): NativePacket? = outputs.removeFirstOrNull()
    override fun dispatch(event: NativePacket) = Unit
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) {
        outputs += packet(0x040b)
    }
    override fun decode(packet: NativePacket): NativePacket = error("unused")
    override fun encode(packet: NativePacket): NativePacket = error("unused")
    override fun close() { closed = true }

    private fun packet(kind: Int) = NativePacket(kind = kind)
}

private class ScriptedCore(
    private val terminalOnStart: Boolean,
    private var staleDispatchesRemaining: Int = 0,
    private val cancellationOrder: MutableList<String>? = null,
) : NativeCore {
    private val outputs = ArrayDeque<NativePacket>()
    private var active = false
    val started = CompletableDeferred<Unit>()
    val cancelled = CompletableDeferred<Unit>()
    val nativeThreadIds = mutableListOf<Int>()
    val polledRequestIds = mutableListOf<ULong>()
    var cancelledHigh: ULong? = null
    var cancelledLow: ULong? = null
    var closed = false
    var cancelAfterClose = false
    var dispatchCount = 0

    override fun start(command: NativePacket, capabilityBits: ULong) {
        recordThread()
        if (active) throw NativeCoreException(8, 1, false, -1, "operation in progress")
        active = true
        outputs += packet(0x0401)
        outputs += packet(0x0310, 1u)
        outputs += packet(0x0301, 2u)
        outputs += packet(0x0311, 3u)
        if (terminalOnStart) {
            outputs += packet(0x0402)
            outputs += packet(0x040a)
            active = false
        }
        started.complete(Unit)
    }

    override fun poll(): NativePacket? {
        recordThread()
        return outputs.removeFirstOrNull()?.also { if (it.requestId != 0uL) polledRequestIds += it.requestId }
    }

    override fun dispatch(event: NativePacket) {
        recordThread()
        dispatchCount += 1
        if (staleDispatchesRemaining > 0) {
            staleDispatchesRemaining -= 1
            throw NativeCoreException(9, 1, false, -1, "stale callback")
        }
    }

    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) {
        recordThread()
        if (closed) cancelAfterClose = true
        if (!active) throw NativeCoreException(9, 1, false, -1, "unexpected cancellation")
        cancelledHigh = cancellationHigh
        cancelledLow = cancellationLow
        cancellationOrder?.add("core-cancelled")
        outputs += packet(0x040b)
        active = false
        cancelled.complete(Unit)
    }

    override fun decode(packet: NativePacket): NativePacket = error("unused")
    override fun encode(packet: NativePacket): NativePacket = error("unused")

    override fun close() {
        recordThread()
        closed = true
    }

    private fun recordThread() {
        nativeThreadIds += System.identityHashCode(Thread.currentThread())
    }

    private fun packet(kind: Int, requestId: ULong = 0u): NativePacket = NativePacket(
        kind = kind,
        requestIdBits = requestId.toLong(),
        cancellationHighBits = 0x0011223344556677,
        cancellationLowBits = 0x8899aabbccddeeffuL.toLong(),
    )
}
