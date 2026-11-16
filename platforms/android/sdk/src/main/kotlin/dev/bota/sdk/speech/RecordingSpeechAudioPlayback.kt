package dev.bota.sdk.speech

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRouting
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout

internal interface RecordingSpeechAudioSink {
    val playedSamples: Long
    fun write(pcm: ByteArray): Int
    fun clear()
    fun routeListener(listener: () -> Unit)
    fun close()
}
private class AndroidRecordingSpeechAudioSink : RecordingSpeechAudioSink {
    private val track = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(48000).setTransferMode(AudioTrack.MODE_STREAM).build()
    private var route: AudioRouting.OnRoutingChangedListener? = null
    init {
        try { check(track.state == AudioTrack.STATE_INITIALIZED); track.play() }
        catch (error: Throwable) { track.release(); throw error }
    }
    override val playedSamples: Long get() = track.playbackHeadPosition.toLong() and 0xffffffffL
    override fun write(pcm: ByteArray): Int = track.write(pcm, 0, pcm.size, AudioTrack.WRITE_NON_BLOCKING)
    override fun clear() { track.pause(); track.flush(); track.play() }
    override fun routeListener(listener: () -> Unit) {
        route = AudioRouting.OnRoutingChangedListener { listener() }.also { track.addOnRoutingChangedListener(it, Handler(Looper.getMainLooper())) }
    }
    override fun close() { route?.let { track.removeOnRoutingChangedListener(it) }; track.pause(); track.flush(); track.release() }
}

/** Volatile 24 kHz mono PCM playback. The App owns audio focus and supplies an
 * explicit qualification of its current headphone route; device labels are not
 * evidence. A route change immediately clears output and requires requalification.
 * This owner never opens the microphone or stores generated audio. */
public class RecordingSpeechAudioPlayback internal constructor(
    private val sink: RecordingSpeechAudioSink,
    private val headphoneRoute: () -> Boolean,
    private val onRouteLost: () -> Unit,
) : RecordingSpeechPlayback, AutoCloseable {
    public constructor(headphoneRoute: () -> Boolean, onRouteLost: () -> Unit = {}) :
        this(AndroidRecordingSpeechAudioSink(), headphoneRoute, onRouteLost)
    private val lock = Any()
    private var written = 0L
    private var closed = false
    private var qualified = false
    init {
        try { qualified = headphoneRoute(); sink.routeListener { invalidateRoute() } }
        catch (error: Throwable) { sink.close(); throw error }
    }
    private fun invalidateRoute() {
        synchronized(lock) {
            if (closed) return
            qualified = false; sink.clear(); written = 0
        }
        runCatching { onRouteLost() }
    }
    public fun qualifyHeadphones(): Boolean = synchronized(lock) {
        if (closed) false else runCatching { headphoneRoute() }.getOrDefault(false).also {
            if (qualified && !it) { sink.clear(); written = 0 }
            qualified = it
        }
    }
    override fun play(pcm: ByteArray, outputId: String, offsetSamples: Long): Boolean = synchronized(lock) {
        if (!closed && qualified && !runCatching { headphoneRoute() }.getOrDefault(false)) {
            qualified = false; sink.clear(); written = 0
            runCatching { onRouteLost() }
        }
        if (closed || !qualified || pcm.isEmpty() || pcm.size % 2 != 0 || pcm.size > 48000) return@synchronized false
        val outstanding = (written - sink.playedSamples).coerceAtLeast(0)
        if (outstanding + pcm.size / 2 > 24000) return@synchronized false
        val count = sink.write(pcm)
        if (count != pcm.size) { sink.clear(); written = 0; return@synchronized false }
        written += count / 2; true
    }
    override suspend fun clear() { synchronized(lock) { if (!closed) { sink.clear(); written = 0 } } }
    override suspend fun drain() {
        withTimeout(2000) { while (synchronized(lock) { !closed && written > sink.playedSamples }) delay(10) }
    }
    override fun close() { synchronized(lock) { if (!closed) { closed = true; qualified = false; written = 0; sink.close() } } }
}
