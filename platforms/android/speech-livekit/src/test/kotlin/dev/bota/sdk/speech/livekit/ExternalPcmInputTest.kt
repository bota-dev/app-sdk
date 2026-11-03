package dev.bota.sdk.speech.livekit

import dev.bota.sdk.speech.SpeechGrant
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class ExternalPcmInputTest {
    private val grant = SpeechGrant(1, "livekit", "wss://example.invalid", "room", "listener", "secret",
        "2099-01-01T00:00:00Z", "session", "participant", 1, 1, "processor")
    private fun frame(value: Int = 7): ByteBuffer = ByteBuffer.wrap(ByteArray(960) { value.toByte() })
    private fun read(input: ExternalPcmInput, format: Int = 2, bytes: Int = 0): ByteArray {
        val buffer = ByteBuffer.wrap(ByteArray(960) { 99 })
        assertEquals(0L, input.render(buffer, format, 1, 48000, bytes))
        return buffer.array()
    }
    private fun start(input: ExternalPcmInput, failed: () -> Unit = {}) {
        input.attach(failed); input.validate(grant); input.capture(true); input.setMuted(false)
    }

    @Test fun startsSilentCopiesBorrowedFramesAndDoesNotAlterTheHostBuffer() {
        val input = ExternalPcmInput("participant", 1)
        assertFalse(input.offer(frame()))
        input.attach {}; input.validate(grant); input.capture(true)
        assertFalse(input.offer(frame()))
        input.setMuted(false)
        val borrowed = frame(); assertTrue(input.offer(borrowed))
        assertEquals(0, borrowed.position()); borrowed.put(0, 55)
        assertArrayEquals(ByteArray(960) { 7 }, read(input))
        assertArrayEquals(ByteArray(960), read(input))
    }

    @Test fun hostMuteAndSdkHoldClearQueuedFramesIndependently() {
        val input = ExternalPcmInput("participant", 1); start(input)
        input.offer(frame()); input.setMuted(true); input.setMuted(false)
        assertArrayEquals(ByteArray(960), read(input))
        input.offer(frame()); input.capture(false); input.setMuted(false)
        assertFalse(input.offer(frame())); input.capture(true)
        assertArrayEquals(ByteArray(960), read(input))
        assertTrue(input.offer(frame(8))); assertArrayEquals(ByteArray(960) { 8 }, read(input))
    }

    @Test fun overloadIsTerminalAndCannotReplayOldSpeech() {
        var failures = 0
        val input = ExternalPcmInput("participant", 1); start(input) { failures++ }
        repeat(20) { assertTrue(input.offer(frame())) }
        assertFalse(input.offer(frame())); assertEquals(1, failures)
        input.capture(true); input.setMuted(false)
        assertFalse(input.offer(frame())); assertArrayEquals(ByteArray(960), read(input))
        assertEquals(1, failures)
    }

    @Test fun staleAudioFailsInsteadOfPlayingAfterAStalledRtcConsumer() {
        var now = 0L; var failures = 0
        val input = ExternalPcmInput("participant", 1) { now }; start(input) { failures++ }
        input.offer(frame()); now = 201_000_000L
        assertArrayEquals(ByteArray(960), read(input)); assertEquals(1, failures)
    }

    @Test fun malformedInputAndUnexpectedRtcFormatNeverExposeOriginalBufferContents() {
        var failures = 0
        val input = ExternalPcmInput("participant", 1); start(input) { failures++ }
        assertFalse(input.offer(ByteBuffer.allocate(961))); assertEquals(1, failures)
        val other = ExternalPcmInput("participant", 1); start(other) { failures++ }
        other.offer(frame())
        assertArrayEquals(ByteArray(960), read(other, format = 4)); assertEquals(2, failures)
        val microphone = ExternalPcmInput("participant", 1); start(microphone) { failures++ }
        microphone.offer(frame())
        assertArrayEquals(ByteArray(960), read(microphone, bytes = 960)); assertEquals(3, failures)
    }

    @Test fun endingAndRetirementFenceLateProducerCallbacksAndRejectReuse() {
        var failures = 0
        val input = ExternalPcmInput("participant", 1); start(input) { failures++ }
        input.offer(frame()); input.end(); input.end()
        assertEquals(1, failures); assertFalse(input.offer(frame()))
        assertArrayEquals(ByteArray(960), read(input))
        assertTrue(runCatching { input.attach {} }.isFailure)
        val closed = ExternalPcmInput("participant", 1); start(closed) { failures++ }
        closed.retire(); closed.end(); closed.capture(true)
        assertFalse(closed.offer(frame())); assertEquals(1, failures)
    }

    @Test fun participantGenerationMustMatchBeforeAudioCanBeAdmitted() {
        val input = ExternalPcmInput("different", 1); input.attach {}
        assertTrue(runCatching { input.validate(grant) }.isFailure)
        input.capture(true); input.setMuted(false); assertFalse(input.offer(frame()))
        val stale = ExternalPcmInput("participant", 2); stale.attach {}
        assertTrue(runCatching { stale.validate(grant) }.isFailure)
        assertTrue(runCatching { ExternalPcmInput("", 1) }.isFailure)
        assertTrue(runCatching { ExternalPcmInput("participant", 0) }.isFailure)
    }

    @Test fun oneSourceCannotBeAttachedToTwoMediaOwners() {
        val input = ExternalPcmInput("participant", 1); start(input)
        assertTrue(runCatching { input.attach {} }.isFailure)
        assertTrue(input.offer(frame())); assertArrayEquals(ByteArray(960) { 7 }, read(input))
    }
}
