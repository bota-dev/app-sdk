package dev.bota.sdk.internal.core

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
}

private class ScriptedCore(
    private val terminalOnStart: Boolean,
    private var staleDispatchesRemaining: Int = 0,
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
