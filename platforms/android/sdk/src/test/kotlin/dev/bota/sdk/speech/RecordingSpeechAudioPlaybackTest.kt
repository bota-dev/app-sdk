package dev.bota.sdk.speech

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class RecordingSpeechAudioPlaybackTest {
    private class Sink : RecordingSpeechAudioSink {
        var played = 0L; var bytes = 0; var clears = 0; var closed = false; var changed: (() -> Unit)? = null
        override val playedSamples: Long get() = played
        override fun write(pcm: ByteArray): Int { bytes += pcm.size; return pcm.size }
        override fun clear() { clears++; played = 0 }
        override fun routeListener(listener: () -> Unit) { changed = listener }
        override fun close() { closed = true }
    }
    @Test fun boundsQueuedAudioAndAllowsReusingCapacityOnlyAfterActualPlayback() = runBlocking {
        val sink = Sink(); val player = RecordingSpeechAudioPlayback(sink, { true }, {})
        val frame = ByteArray(48000) { 1 }
        assertTrue(player.play(frame, "one", 0)); assertFalse(player.play(byteArrayOf(1, 0), "two", 0))
        assertEquals(48000, sink.bytes); assertEquals(1.toByte(), frame[0])
        sink.played = 24000; player.drain(); assertTrue(player.play(byteArrayOf(2, 0), "three", 0))
        player.clear(); assertTrue(player.play(frame, "four", 0)); player.close(); assertTrue(sink.closed)
        assertFalse(player.play(byteArrayOf(1, 0), "five", 0))
    }
    @Test fun qualificationLossClearsAlreadyQueuedAudioEvenWithoutAPlatformCallback() {
        val sink = Sink(); var headphones = true
        val player = RecordingSpeechAudioPlayback(sink, { headphones }, {})
        assertTrue(player.play(byteArrayOf(1, 0), "first", 0))
        headphones = false
        assertFalse(player.play(byteArrayOf(1, 0), "later", 0))
        assertEquals(1, sink.clears)
        assertFalse(player.qualifyHeadphones())
        player.close()
    }
    @Test fun routeChangeSilencesImmediatelyAndNeedsExplicitRequalification() = runBlocking {
        val sink = Sink(); var qualified = true; var lost = 0
        val player = RecordingSpeechAudioPlayback(sink, { qualified }, { lost++ })
        assertTrue(player.play(byteArrayOf(1, 0), "one", 0)); sink.changed!!()
        assertEquals(1, lost); assertEquals(1, sink.clears)
        assertFalse(player.play(byteArrayOf(1, 0), "two", 0))
        qualified = false; assertFalse(player.qualifyHeadphones())
        qualified = true; assertTrue(player.qualifyHeadphones()); assertTrue(player.play(byteArrayOf(1, 0), "three", 0))
        player.close()
    }
}
