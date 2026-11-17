package dev.bota.sdk.speech

import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Exercises the real JNI policy with a native transport and borrowed PCM. */
class RecordingSpeechSessionTest {
    private class Transport : RecordingSpeechTransport {
        val incoming = Channel<RecordingSpeechMessage>(32)
        val sent = CopyOnWriteArrayList<ByteArray>()
        var closed = false
        var failClose = false
        var beforeClose: () -> Unit = {}
        override fun send(message: RecordingSpeechMessage) {
            check(!closed)
            sent += when (message) {
                is RecordingSpeechMessage.Audio -> message.bytes.copyOf()
                is RecordingSpeechMessage.Control -> message.bytes.copyOf()
            }
        }
        override suspend fun receive() = incoming.receive()
        override suspend fun close() { beforeClose(); closed = true; incoming.close(); if (failClose) error("synthetic cleanup failure") }
    }
    private class Playback : RecordingSpeechPlayback {
        var clears = 0
        override suspend fun clear() { clears++ }
        override fun play(pcm: ByteArray, outputId: String, offsetSamples: Long) = true
        override suspend fun drain() {}
    }
    private fun bytes(value: JSONObject) = value.toString().toByteArray(Charsets.UTF_8)
    private suspend fun open(transport: Transport, playback: Playback): RecordingSpeechSession {
        val id = "11111111-1111-4111-8111-111111111111"
        val endpoint = "wss://api.example.com/v1/recording-speech/ws"
        val configuration = JSONObject().put("projectId", "prj_test").put("activityId", id).put("endpoint", endpoint)
        val grant = JSONObject().put("version", 1).put("project_id", "prj_test").put("activity_id", id)
            .put("transport", "websocket").put("protocol", "bota.recording-speech.v1").put("url", endpoint)
            .put("token", "a".repeat(43)).put("generation", 1).put("expires_at", Instant.now().plusSeconds(20).toString())
        val session = RecordingSpeechSession(bytes(configuration), bytes(grant), playback, { _, _ -> transport })
        transport.incoming.send(RecordingSpeechMessage.Control("""{"type":"ready","version":1,"activityId":"$id","generation":1,
            "target":{"revision":1,"language":"zh"},"sources":[{"id":"mixed","epoch":1,"role":"mixed","speaker":"unknown","language":"en","startSample":0}],
            "input":{"format":"pcm_s16le","sampleRate":48000,"maxFrameSamples":4800},"playbackRoute":"unqualified"}""".toByteArray()))
        withTimeout(5000) { session.ready() }
        return session
    }
    @Test fun borrowedCaptureFramesRemainIndependentOfJoinedLiveClose() = runBlocking {
        val transport = Transport(); val playback = Playback(); val session = open(transport, playback)
        session.setRoute(true)
        val pcm = byteArrayOf(1, 0, 2, 0)
        assertTrue(session.offer(0, 0, pcm))
        val frame = transport.sent.last()
        assertEquals("BRS1", frame.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        assertArrayEquals(pcm, frame.copyOfRange(32, frame.size))
        val before = playback.clears; var clearedFirst = false
        transport.beforeClose = { clearedFirst = playback.clears > before }
        session.close(); session.close(); assertTrue(clearedFirst)
        assertTrue(transport.closed); assertTrue(playback.clears >= 2)
        assertArrayEquals(byteArrayOf(1, 0, 2, 0), pcm)
        assertFalse(session.offer(0, 2, pcm))
    }
    @Test fun failingTransportCleanupStillClearsPlayback() = runBlocking {
        val transport = Transport(); val playback = Playback(); val session = open(transport, playback)
        val before = playback.clears; transport.failClose = true
        val result = runCatching { withTimeout(5000) { session.close() } }
        assertTrue(result.isFailure); assertTrue(transport.closed); assertEquals(before + 1, playback.clears)
    }
}
