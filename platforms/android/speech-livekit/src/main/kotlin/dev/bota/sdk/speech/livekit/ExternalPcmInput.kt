package dev.bota.sdk.speech.livekit

import dev.bota.sdk.speech.SpeechErrorCode
import dev.bota.sdk.speech.SpeechGrant
import dev.bota.sdk.speech.SpeechSessionException
import java.nio.ByteBuffer
import java.util.ArrayDeque

/**
 * One authorized participant's original audio branch, owned by one media session.
 * The host supplies 10 ms of 48 kHz mono signed PCM16 little-endian per offer (960 bytes).
 * The host owns consent, resampling, source mute/end notifications and its conference audio route.
 * This object never stops or changes the host track. It starts muted and cannot be reused after close.
 */
public class ExternalPcmInput internal constructor(
    private val participantId: String,
    private val memberGeneration: Int,
    private val now: () -> Long,
) {
    public constructor(participantId: String, memberGeneration: Int) : this(participantId, memberGeneration, System::nanoTime)

    init {
        if (participantId.isBlank() || participantId.length > 128 || memberGeneration < 1) {
            throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT)
        }
    }

    private data class Frame(val bytes: ByteArray, val offeredAt: Long)
    private val lock = Any()
    private val queue = ArrayDeque<Frame>()
    private var attached = false
    private var validated = false
    private var capturing = false
    private var muted = true
    private var terminal = false
    private var failed: (() -> Unit)? = null

    internal fun requireAvailable() {
        synchronized(lock) {
            if (attached || terminal) throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT)
        }
    }

    internal fun attach(report: () -> Unit) {
        synchronized(lock) { requireAvailable(); attached = true; failed = report }
    }

    internal fun validate(grant: SpeechGrant) {
        synchronized(lock) {
            if (terminal || !attached || participantId != grant.participantId || memberGeneration != grant.memberGeneration) {
                throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT)
            }
            validated = true
        }
    }

    internal fun capture(enabled: Boolean) {
        synchronized(lock) {
            capturing = enabled && !terminal
            if (!capturing) queue.clear()
        }
    }

    /** Forward every host mute change. Unmuting never overrides an SDK input hold. */
    public fun setMuted(muted: Boolean) {
        synchronized(lock) { this.muted = muted; if (muted) queue.clear() }
    }

    /**
     * Copies a borrowed frame without changing its position. False means no audio was accepted.
     * At most 200 ms is queued. Invalid, overflowing or stale audio retires this branch;
     * inactive/muted audio is discarded. Never offer generated speech or a mixed conference track.
     */
    public fun offer(pcm: ByteBuffer): Boolean {
        var report: (() -> Unit)? = null
        val accepted = synchronized(lock) {
            if (terminal || !validated || !capturing || muted) return@synchronized false
            val time = now()
            if (pcm.remaining() != FRAME_BYTES || queue.size >= MAX_FRAMES || stale(time)) {
                report = failLocked()
                false
            } else {
                val bytes = ByteArray(FRAME_BYTES)
                pcm.duplicate().get(bytes)
                queue.addLast(Frame(bytes, time))
                true
            }
        }
        report?.invoke()
        return accepted
    }

    /** Unexpected source end retires the media session. Use SpeechSession.finishInput for a normal finish. */
    public fun end() { val report = synchronized(lock) { failLocked() }; report?.invoke() }

    internal fun retire() {
        synchronized(lock) { terminal = true; capturing = false; queue.clear(); failed = null }
    }

    private fun stale(time: Long): Boolean = queue.peekFirst()?.let { time - it.offeredAt > MAX_AGE_NS } ?: false

    private fun failLocked(): (() -> Unit)? {
        if (terminal) return null
        terminal = true; capturing = false; queue.clear()
        return failed.also { failed = null }
    }

    /** The no-device ADM reports zero bytes read. Always overwrite the entire borrowed buffer. */
    internal fun render(buffer: ByteBuffer, format: Int, channels: Int, rate: Int, bytesRead: Int): Long {
        var report: (() -> Unit)? = null
        synchronized(lock) {
            val destination = buffer.duplicate()
            destination.clear()
            while (destination.hasRemaining()) destination.put(0.toByte())
            if (!terminal) {
                if (format != 2 || channels != 1 || rate != 48000 || buffer.capacity() != FRAME_BYTES || bytesRead != 0 || stale(now())) {
                    report = failLocked()
                } else if (validated && capturing && !muted) {
                    queue.pollFirst()?.let { destination.clear(); destination.put(it.bytes) }
                }
            }
        }
        report?.invoke()
        // Arrival time is not a source capture clock or an archival alignment claim.
        return 0L
    }

    private companion object {
        const val FRAME_BYTES = 960
        const val MAX_FRAMES = 20
        const val MAX_AGE_NS = 200_000_000L
    }
}
