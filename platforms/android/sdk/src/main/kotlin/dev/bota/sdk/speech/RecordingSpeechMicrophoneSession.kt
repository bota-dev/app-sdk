package dev.bota.sdk.speech

import android.content.Context
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*

/** The caller must retire its owner instead of falling back to another input. */
public class RecordingSpeechCleanupFailure : Exception("recording_speech_cleanup_failed")

/** Foreground direct microphone flow. The host creates the activity with the same
 * clockId and a mixed/unknown source at sample zero before calling start. Archive
 * upload/recovery remains independently owned; live failure never stops capture. */
public class RecordingSpeechMicrophoneSession private constructor(
    public val live: RecordingSpeechSession,
    public val microphone: SpeechMicrophoneCapture,
    private val playback: RecordingSpeechAudioPlayback,
    private val routeTasks: CoroutineScope,
) : RecordingSpeechConnection {
    public companion object {
        public suspend fun start(context: Context, configurationJson: ByteArray, grantJson: ByteArray,
            clockId: String, expiresAt: Instant, archive: SpeechCaptureArchive? = null,
            headphoneRoute: () -> Boolean, onCaption: (ByteArray) -> Unit = {}, onStatus: (String) -> Unit = {}, captureAllowed: () -> Boolean = { true }): RecordingSpeechMicrophoneSession {
            val tasks = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val current = AtomicReference<RecordingSpeechSession?>(null)
            val playback = RecordingSpeechAudioPlayback(headphoneRoute) {
                tasks.launch { runCatching { current.get()?.setRoute(false) } }
            }
            var live: RecordingSpeechSession? = null
            try {
                val session = RecordingSpeechSession(configurationJson, grantJson, playback, onCaption = onCaption, onStatus = onStatus)
                live = session; current.set(session); session.ready(); session.bindMicrophone(clockId)
                session.setRoute(playback.qualifyHeadphones())
                check(captureAllowed()) { "Capture owner retired" }
                val microphone = SpeechMicrophoneCapture.start(context, archive, expiresAt, clockId = clockId,
                    onAudio = { first, pcm -> session.offer(0, first, pcm) },
                    onArchiveError = { onStatus("archive_unavailable") }, ended = { reason ->
                        if (reason != SpeechCaptureEnd.STOPPED) { runCatching { onStatus("capture_interrupted") } }
                    })
                return RecordingSpeechMicrophoneSession(session, microphone, playback, tasks)
            } catch (error: Throwable) {
                val cleanup = withContext(NonCancellable) {
                    try { runCatching { live?.close() } } finally { playback.close(); tasks.cancel() }
                }
                if (cleanup.isFailure) throw RecordingSpeechCleanupFailure()
                throw error
            }
        }
    }
    override suspend fun changeTarget(language: String, requestId: String): Unit = live.changeTarget(language, requestId)
    override suspend fun qualifyHeadphones(): Boolean { val qualified = playback.qualifyHeadphones(); live.setRoute(qualified); return qualified }
    /** Send the final partial input before requesting the live ASR/MT/TTS drain. */
    override suspend fun finish() { microphone.stop(); live.finish() }
    override suspend fun close(): Unit = withContext(NonCancellable) {
        try { microphone.interruptAndStop() } finally {
            try { live.close() } finally { playback.close(); routeTasks.cancel() }
        }
    }
}
