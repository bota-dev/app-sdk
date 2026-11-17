package dev.bota.sdk.speech.livekit

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import livekit.org.webrtc.AudioTrackSink

/** Copies borrowed vendor buffers before returning from the native callback. */
internal class VendorPcmSink(
    private val scope: CoroutineScope,
    private val accepts: () -> Boolean,
    private val frame: (PcmFrame) -> Unit,
    private val failed: () -> Unit,
) : AudioTrackSink {
    private val rejected = AtomicBoolean()
    override fun onData(data: ByteBuffer, bits: Int, rate: Int, channels: Int, frames: Int, timestamp: Long) {
        if (rejected.get() || !accepts()) return
        val size = frames.toLong() * channels * 2
        if (bits != 16 || channels !in 1..2 || rate !in setOf(8000, 16000, 24000, 32000, 44100, 48000) ||
            frames <= 0 || frames > rate / 10 || size > data.remaining()) {
            // removeSink can wait for this native callback. Never start retirement on this thread.
            if (rejected.compareAndSet(false, true)) scope.launch { if (accepts()) failed() }
        } else {
            val copy = ByteArray(size.toInt())
            data.duplicate().get(copy)
            frame(PcmFrame(copy, rate, channels))
        }
    }
}
