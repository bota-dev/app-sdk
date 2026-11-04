package dev.bota.sdk.speech.livekit

import java.nio.ByteBuffer
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VendorPcmSinkTest {
    @Test fun malformedNativeDataCannotReenterSinkRemovalOnTheAudioThread() = runTest {
        var insideNativeCallback = true
        var failures = 0
        val sink = VendorPcmSink(backgroundScope, { true }, { fail("Invalid frame was admitted") }) {
            assertFalse("Sink removal can wait for this callback; never invoke it inline", insideNativeCallback)
            failures++
        }
        sink.onData(ByteBuffer.allocate(8), 32, 48000, 1, 4, 0L)
        insideNativeCallback = false
        runCurrent()
        assertEquals(1, failures)
    }

    @Test fun retiredNativeFailureCannotAffectTheNextOwner() = runTest {
        var active = true
        var failures = 0
        val sink = VendorPcmSink(backgroundScope, { active }, {}) { failures++ }
        sink.onData(ByteBuffer.allocate(8), 16, 48000, 1, 5, 0L)
        active = false
        runCurrent()
        assertEquals(0, failures)
    }

    @Test fun nativeBufferReuseCannotChangeAnAdmittedFrame() = runTest {
        val source = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4))
        var received: PcmFrame? = null
        val sink = VendorPcmSink(backgroundScope, { true }, { received = it }) { fail("Valid frame rejected") }
        sink.onData(source, 16, 48000, 1, 2, 0L)
        source.put(0, 9)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), received!!.samples)
        assertEquals(0, source.position())
    }
}
