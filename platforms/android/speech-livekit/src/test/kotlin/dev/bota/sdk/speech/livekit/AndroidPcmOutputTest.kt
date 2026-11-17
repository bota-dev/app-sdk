package dev.bota.sdk.speech.livekit

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidPcmOutputTest {
    private class Player : PcmPlayer {
        var muted = false
        var closed = false
        var blocked = false
        var finished = true
        val samples = mutableListOf<Byte>()
        override fun mute() { muted = true }
        override fun write(samples: ByteArray, offset: Int): Int {
            check(!closed)
            if (blocked) return 0
            this.samples += samples.drop(offset)
            return samples.size - offset
        }
        override fun close() { muted = true; closed = true }
        override fun drained() = finished
    }
    private fun frame(value: Byte = 1) = PcmFrame(ByteArray(320) { value }, 16000, 1)

    @Test fun unselectedAndClearedFramesNeverReachAPlayer() = runTest {
        val players = mutableListOf<Player>()
        val output = AndroidPcmOutput(backgroundScope, { error("unexpected failure") }) { _, _ -> Player().also { players += it } }
        output.frame("foreign", frame()); runCurrent()
        assertTrue(players.isEmpty())
        output.select(setOf("old")); output.frame("old", frame())
        output.clear()
        output.select(setOf("new")); output.frame("old", frame(2)); output.frame("new", frame(3))
        runCurrent()
        assertEquals(1, players.size)
        assertTrue(players.single().samples.all { it == 3.toByte() })
        output.close(); assertTrue(players.single().closed)
    }

    @Test fun queueOverflowSilencesWithoutAccumulatingLatency() = runTest {
        var failures = 0
        val players = mutableListOf<Player>()
        val output = AndroidPcmOutput(backgroundScope, { failures++ }) { _, _ -> Player().also { players += it } }
        output.select(setOf("track"))
        repeat(21) { output.frame("track", frame()) }
        runCurrent()
        assertEquals(1, failures)
        assertTrue(players.isEmpty())
        output.close()
    }

    @Test fun silencedPlayerIsFlushedBeforeSameSidCanResume() = runTest {
        val players = mutableListOf<Player>()
        val output = AndroidPcmOutput(backgroundScope, { error("unexpected failure") }) { _, _ -> Player().also { players += it } }
        output.select(setOf("track")); output.frame("track", frame()); runCurrent()
        val old = players.single()
        output.silence(); assertTrue(old.muted)
        output.select(setOf("track")); output.frame("track", frame(2)); runCurrent()
        assertTrue(old.closed)
        assertEquals(2, players.size)
        assertFalse(players.last().muted)
        output.close()
    }

    @Test fun stalledNativeOutputFailsWithinOneSecondAndCanBeClosed() = runTest {
        var failures = 0
        val player = Player().also { it.blocked = true }
        val output = AndroidPcmOutput(backgroundScope, { failures++ }) { _, _ -> player }
        output.select(setOf("track")); output.frame("track", frame()); runCurrent()
        advanceTimeBy(1_001); runCurrent()
        assertEquals(1, failures); assertTrue(player.muted)
        output.close(); assertTrue(player.closed)
    }

    @Test fun normalEndWaitsForTheDevicePlaybackHeadAndClearStillCancels() = runTest {
        val player = Player().also { it.finished = false }
        val output = AndroidPcmOutput(backgroundScope, { error("unexpected failure") }) { _, _ -> player }
        output.select(setOf("track")); output.frame("track", frame()); runCurrent()
        val drain = async { output.drain("track") }; runCurrent()
        assertFalse(drain.isCompleted); assertFalse(player.muted)
        player.finished = true; advanceTimeBy(5); runCurrent(); drain.await()
        player.finished = false
        val cancelled = async { output.drain("track") }; runCurrent()
        output.clear(); advanceTimeBy(5); runCurrent(); cancelled.await()
        assertTrue(player.closed)
        output.close()
    }
}
