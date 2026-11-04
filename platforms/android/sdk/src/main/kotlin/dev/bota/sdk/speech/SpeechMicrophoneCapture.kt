package dev.bota.sdk.speech

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Process
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext

public enum class SpeechCaptureEnd { STOPPED, AUTHORIZATION_EXPIRED, INTERRUPTED }

internal interface SpeechMicrophoneSource {
    fun read(buffer: ByteArray, offset: Int, length: Int): Int
    val route: Int
    fun close()
}
private class AndroidSpeechMicrophone : SpeechMicrophoneSource {
    private val recorder: AudioRecord
    private val echo: AcousticEchoCanceler?
    init {
        val minimum = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0 || minimum > 96000) throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
        recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(minimum, 9600)).build()
        var effect: AcousticEchoCanceler? = null
        try {
            if (recorder.state != AudioRecord.STATE_INITIALIZED) throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
            if (AcousticEchoCanceler.isAvailable()) {
                effect = AcousticEchoCanceler.create(recorder.audioSessionId)
                effect?.enabled = true
            }
            recorder.startRecording()
            if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
            echo = effect
        } catch (error: Exception) { effect?.release(); recorder.release(); throw error }
    }
    override val route: Int get() = recorder.routedDevice?.id ?: 0
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = recorder.read(buffer, offset, length, AudioRecord.READ_NON_BLOCKING)
    override fun close() {
        try { recorder.stop() } finally { try { echo?.release() } finally { recorder.release() } }
    }
}

/** Foreground microphone owner independent from RTC and HTTP. The host owns audio
 * focus/routing and must stop on backgrounding. Each RTC callback borrows exactly
 * 10 ms of the same 48 kHz mono PCM16LE submitted to the archive; do not retain or block it. */
public class SpeechMicrophoneCapture private constructor(
    private val source: SpeechMicrophoneSource,
    private val pump: SpeechCapturePump,
    expiresAt: Long,
    private val rtcFrame: (ByteArray) -> Unit,
    private val ended: (SpeechCaptureEnd) -> Unit,
    private val now: () -> Long,
    private val monotonic: () -> Long,
) {
    private val until = AtomicLong(expiresAt)
    private val reason = AtomicReference<SpeechCaptureEnd?>(null)
    private val lifetime = SupervisorJob()
    private val dispatcher = Executors.newSingleThreadExecutor { work -> Thread(work, "bota-original-capture") }.asCoroutineDispatcher()
    private lateinit var reader: Deferred<Unit>

    public companion object {
        public suspend fun start(context: Context, archive: SpeechCaptureArchive, expiresAt: Instant,
            rtcFrame: (ByteArray) -> Unit, ended: (SpeechCaptureEnd) -> Unit = {}): SpeechMicrophoneCapture {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw SpeechCaptureException(SpeechCaptureError.UNAUTHORIZED)
            }
            return start(archive, expiresAt.toEpochMilli(), rtcFrame, ended, { AndroidSpeechMicrophone() })
        }
        internal suspend fun start(archive: SpeechCaptureArchive, expiresAt: Long, rtcFrame: (ByteArray) -> Unit,
            ended: (SpeechCaptureEnd) -> Unit, open: () -> SpeechMicrophoneSource,
            now: () -> Long = System::currentTimeMillis, monotonic: () -> Long = System::nanoTime): SpeechMicrophoneCapture {
            var acquired: SpeechMicrophoneCapture? = null
            try { return withContext(Dispatchers.IO) {
            if (expiresAt <= now()) throw SpeechCaptureException(SpeechCaptureError.UNAUTHORIZED)
            val failed = AtomicReference<SpeechMicrophoneCapture?>(null)
            val pump = SpeechCapturePump.start(archive) { failed.get()?.interrupt() }
            var source: SpeechMicrophoneSource? = null
            try {
                if (expiresAt <= now()) throw SpeechCaptureException(SpeechCaptureError.UNAUTHORIZED)
                source = open()
                val owner = SpeechMicrophoneCapture(source, pump, expiresAt, rtcFrame, ended, now, monotonic)
                failed.set(owner)
                owner.reader = CoroutineScope(owner.lifetime + owner.dispatcher).async { owner.read() }
                acquired = owner
                owner
            } catch (error: Exception) {
                runCatching { source?.close() }; pump.stop(endKnown = false)
                if (error is CancellationException) throw error
                throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
            }
            } } catch (error: Throwable) { withContext(NonCancellable) { acquired?.interruptAndStop() }; throw error }
        }
    }
    /** Supply only a freshly authenticated grant for this capture's unchanged owner. */
    public fun renew(expiresAt: Instant) {
        if (reason.get() != null || expiresAt.toEpochMilli() <= now()) throw SpeechCaptureException(SpeechCaptureError.UNAUTHORIZED)
        until.set(expiresAt.toEpochMilli())
    }
    private fun interrupt() { reason.compareAndSet(null, SpeechCaptureEnd.INTERRUPTED) }
    private suspend fun read() {
        val frame = ByteArray(960)
        var size = 0; var last = monotonic(); var progress = last; var route = source.route
        try {
            runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) }
            while (reason.get() == null) {
                if (now() >= until.get()) { reason.compareAndSet(null, SpeechCaptureEnd.AUTHORIZATION_EXPIRED); break }
                val tick = monotonic(); val selected = source.route
                // An OS capture stall or route reset has no trustworthy continuous sample clock.
                if (tick < last || tick - last > 80_000_000L || tick - progress > 2_000_000_000L || route != 0 && selected != route) { interrupt(); break }
                last = tick; if (route == 0) route = selected
                val count = source.read(frame, size, frame.size - size)
                if (count < 0 || count % 2 != 0 || count > frame.size - size) { interrupt(); break }
                if (count == 0) { delay(2); continue }
                progress = tick
                size += count
                if (size == frame.size) {
                    if (!pump.offer(frame)) { interrupt(); break }
                    // A retired RTC branch does not own or stop this original capture.
                    runCatching { rtcFrame(frame) }
                    frame.fill(0); size = 0
                }
            }
        } catch (_: Exception) { interrupt() }
        finally {
            try {
                try { source.close() } catch (_: Exception) { reason.set(SpeechCaptureEnd.INTERRUPTED) }
                if (size > 0) {
                    val tail = frame.copyOf(size)
                    try { if (!pump.offer(tail)) reason.set(SpeechCaptureEnd.INTERRUPTED) } finally { tail.fill(0) }
                }
                frame.fill(0)
                val result = reason.get() ?: SpeechCaptureEnd.INTERRUPTED
                try { pump.stop(endKnown = result != SpeechCaptureEnd.INTERRUPTED) }
                catch (error: Exception) { reason.set(SpeechCaptureEnd.INTERRUPTED); throw error }
                finally { runCatching { ended(reason.get() ?: SpeechCaptureEnd.INTERRUPTED) } }
            } finally { lifetime.complete(); dispatcher.close() }
        }
    }
    /** Joins capture and disk writes; the independent archive can continue uploading. */
    public suspend fun stop(): Unit = withContext(NonCancellable) {
        reason.compareAndSet(null, SpeechCaptureEnd.STOPPED); reader.await()
    }
    /** OS interruption/background callback. No known end is synthesized. */
    public suspend fun interruptAndStop(): Unit = withContext(NonCancellable) { interrupt(); reader.await() }
}
