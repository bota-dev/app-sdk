package dev.bota.sdk.speech.livekit

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.ArrayDeque
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal interface PcmPlayer {
    fun mute()
    fun write(samples: ByteArray, offset: Int): Int
    fun drained(): Boolean
    fun close()
}

/** Native PCM never crosses JNI, Pigeon or Dart. Both the queue and OS buffers are bounded. */
internal class AndroidPcmOutput(
    scope: CoroutineScope,
    private val failed: () -> Unit,
    private val factory: (Int, Int) -> PcmPlayer = { rate, channels -> PlatformPcmPlayer(rate, channels) },
) : PcmOutput {
    private data class Chunk(val sid: String, val frame: PcmFrame, val epoch: Long, var offset: Int = 0)
    private data class Player(val rate: Int, val channels: Int, val epoch: Long, val output: PcmPlayer)
    private val lock = Any()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val queue = ArrayDeque<Chunk>()
    private val players = mutableMapOf<String, Player>()
    private var selected = emptySet<String>()
    private var epoch = 0L
    private var queuedUs = 0L
    private var closed = false
    private var cleanupFailed = false
    private val worker = scope.launch {
        for (ignored in wake) {
            var stalls = 0
            while (true) {
                var report = false
                val remaining = synchronized(lock) {
                    val chunk = queue.peekFirst() ?: return@synchronized false
                    if (closed || chunk.epoch != epoch || chunk.sid !in selected) {
                        removeFirst()
                        return@synchronized queue.isNotEmpty()
                    }
                    try {
                        val frame = chunk.frame
                        var player = players[chunk.sid]
                        if (player != null && (player.rate != frame.sampleRate || player.channels != frame.channels)) {
                            player.output.close()
                            players.remove(chunk.sid)
                            player = null
                        }
                        val active = player ?: Player(frame.sampleRate, frame.channels, epoch,
                            factory(frame.sampleRate, frame.channels)).also { players[chunk.sid] = it }
                        val count = active.output.write(frame.samples, chunk.offset)
                        check(count >= 0 && count <= frame.samples.size - chunk.offset)
                        chunk.offset += count
                        stalls = if (count == 0) stalls + 1 else 0
                        check(stalls < 200)
                        if (chunk.offset == frame.samples.size) removeFirst()
                    } catch (_: Exception) {
                        silenceLocked()
                        report = true
                    }
                    queue.isNotEmpty()
                }
                if (report) failed()
                if (!remaining) break
                if (stalls > 0) delay(5)
            }
        }
    }

    private fun durationUs(frame: PcmFrame): Long =
        frame.samples.size.toLong() * 1_000_000L / (frame.sampleRate * frame.channels * 2L)

    private fun removeFirst() { queuedUs -= durationUs(queue.removeFirst().frame) }

    private fun silenceLocked() {
        selected = emptySet()
        epoch++
        queue.clear()
        queuedUs = 0
        players.values.forEach { try { it.output.mute() } catch (_: Exception) { cleanupFailed = true } }
    }

    override fun silence() { synchronized(lock) { silenceLocked() } }

    override fun select(sids: Set<String>) {
        synchronized(lock) {
            check(!closed)
            check(sids.size <= 16)
            // A retired SID's buffered samples cannot be admitted by a later selection.
            for (sid in players.keys.toList()) if (sid !in sids || players.getValue(sid).epoch != epoch) {
                try { players.getValue(sid).output.close(); players.remove(sid) }
                catch (_: Exception) { cleanupFailed = true; throw IllegalStateException("pcm_cleanup_failed") }
            }
            selected = sids.toSet()
        }
    }

    override fun frame(sid: String, frame: PcmFrame) {
        var report = false
        synchronized(lock) {
            if (closed || sid !in selected) return
            val valid = frame.sampleRate in setOf(8000, 16000, 24000, 32000, 44100, 48000) &&
                frame.channels in 1..2 && frame.samples.isNotEmpty() && frame.samples.size % (frame.channels * 2) == 0
            if (!valid || durationUs(frame) > 100_000 || queuedUs + durationUs(frame) > 200_000) {
                silenceLocked()
                report = true
            } else {
                queue.addLast(Chunk(sid, frame, epoch))
                queuedUs += durationUs(frame)
                wake.trySend(Unit)
            }
        }
        if (report) failed()
    }

    override suspend fun clear() {
        synchronized(lock) {
            silenceLocked()
            players.keys.toList().forEach { sid ->
                try { players.getValue(sid).output.close(); players.remove(sid) }
                catch (_: Exception) { cleanupFailed = true }
            }
            check(!cleanupFailed) { "pcm_cleanup_failed" }
        }
    }

    override suspend fun drain(sid: String) {
        val generation = synchronized(lock) { epoch }
        while (synchronized(lock) {
            !closed && generation == epoch && sid in selected &&
                (queue.any { it.sid == sid } || players[sid]?.output?.drained() == false)
        }) delay(5)
    }

    override suspend fun close() {
        synchronized(lock) { closed = true; silenceLocked() }
        worker.cancelAndJoin()
        clear()
    }
}

private class PlatformPcmPlayer(rate: Int, private val channels: Int) : PcmPlayer {
    private val mask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
    private val minimum = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
    private val track: AudioTrack
    private var writtenFrames = 0L

    init {
        check(minimum > 0)
        // A device demanding a buffer over 200 ms is outside this adapter's latency budget.
        check(minimum <= rate * channels * 2 / 5)
        track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(mask)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minimum, rate * channels * 2 / 10))
            .setTransferMode(AudioTrack.MODE_STREAM).build()
        try {
            check(track.state == AudioTrack.STATE_INITIALIZED)
            track.play()
        } catch (error: Exception) { track.release(); throw error }
    }
    override fun mute() { check(track.setVolume(0f) == AudioTrack.SUCCESS) }
    override fun write(samples: ByteArray, offset: Int): Int {
        val written = track.write(samples, offset, samples.size - offset, AudioTrack.WRITE_NON_BLOCKING)
        if (written > 0) writtenFrames += written / (channels * 2)
        return written
    }
    override fun drained(): Boolean = (track.playbackHeadPosition.toLong() and 0xffff_ffffL) >= writtenFrames
    override fun close() {
        try { mute(); track.pause(); track.flush() } finally { track.release() }
    }
}
