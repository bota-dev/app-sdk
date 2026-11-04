package dev.bota.sdk.speech

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class SpeechCapturePumpTest {
    @Test fun stalledDiskBoundsMemoryAndPreservesRealSampleGaps() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val positions = mutableListOf<Long>(); var ended: Long? = null
        val sink = object : SpeechCaptureSink {
            override suspend fun begin(id: String) {}
            override suspend fun append(firstSample: Long, bytes: ByteArray) {
                if (positions.isEmpty()) { entered.complete(Unit); release.await() }
                assertEquals(96000, bytes.size); assertEquals(7.toByte(), bytes[0]); positions += firstSample
            }
            override suspend fun end(samples: Long) { ended = samples }
            override suspend fun interrupt() { fail("Known stop became an unknown tail") }
        }
        val pump = SpeechCapturePump.start(sink, "clock") {}
        val frame = ByteArray(96000) { 7 }
        assertTrue(pump.offer(frame))
        withTimeout(5000) { entered.await() }
        repeat(6) { assertTrue(pump.offer(frame)) }
        frame.fill(0)
        val stop = async { pump.stop(endKnown = true) }
        release.complete(Unit)
        withTimeout(5000) { stop.await() }
        assertEquals(listOf(0L, 48000L, 96000L, 144000L), positions)
        assertEquals(336000L, ended)
        assertFalse(pump.offer(ByteArray(960)))
        pump.stop(endKnown = true)
    }

    @Test fun interruptedPartialFrameDoesNotInventAnEndOrLoseCommittedSamples() = runBlocking {
        var count = 0; var interrupted = false
        val sink = object : SpeechCaptureSink {
            override suspend fun begin(id: String) {}
            override suspend fun append(firstSample: Long, bytes: ByteArray) { assertEquals(0L, firstSample); count += bytes.size / 2 }
            override suspend fun end(samples: Long) { fail("Invented known end") }
            override suspend fun interrupt() { interrupted = true }
        }
        val pump = SpeechCapturePump.start(sink, "clock") {}
        assertTrue(pump.offer(byteArrayOf(1, 0, 2, 0)))
        pump.stop(endKnown = false)
        assertEquals(2, count); assertTrue(interrupted)
    }
}
