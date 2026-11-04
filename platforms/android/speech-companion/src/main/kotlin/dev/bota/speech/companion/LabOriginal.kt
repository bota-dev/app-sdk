package dev.bota.speech.companion

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import dev.bota.sdk.speech.*
import dev.bota.sdk.speech.livekit.ExternalPcmInput
import dev.bota.sdk.speech.livekit.LiveKitSpeechMedia
import java.nio.ByteBuffer
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

internal data class OriginalView(val enabled: Boolean = false, val capturing: Boolean = false, val finished: Boolean = false,
    val status: String = "", val passages: List<String> = emptyList()) {
    override fun toString() = "OriginalView(content redacted)"
}
internal interface LabOriginalOwner {
    val capturing: Boolean
    val finished: Boolean
    val rtcLost: Boolean
    fun media(callbacks: SpeechMediaCallbacks): SpeechMediaPort
    suspend fun start()
    suspend fun finish()
    suspend fun close()
}

/** Foreground native owner shared by the Android and Flutter source companions.
 * The application retains this owner after an RTC failure; only authorization,
 * explicit stop/leave or OS backgrounding stops its physical microphone. */
internal class LabOriginal private constructor(private val context: Context, private val host: LabHost, private val joined: LabJoin,
    private val update: (OriginalView) -> Unit) : LabOriginalOwner {
    private data class TextPage(var after: Int = 0, var digest: String? = null, val text: MutableList<String> = mutableListOf(), var done: Boolean = false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val contextId = joined.configuration.context
    private val identity = JSONArray(listOf(contextId.projectId, contextId.sessionId, contextId.participantId, contextId.memberGeneration)).toString()
    private val archives = linkedMapOf<String, SpeechCaptureArchive>()
    private val completed = linkedMapOf<String, TextPage>()
    private val input = ExternalPcmInput(contextId.participantId, contextId.memberGeneration)
    private lateinit var archive: SpeechCaptureArchive
    private lateinit var captureId: String
    private var microphone: SpeechMicrophoneCapture? = null
    private var expiry = Instant.parse(joined.grant.expiresAt)
    private var worker = joined.grant.workerGeneration
    private var track: String? = null
    private var bound: String? = null
    private var polling: Job? = null
    private var closed = false
    private var starting: Deferred<SpeechMicrophoneCapture>? = null
    private var retirement: Deferred<Unit>? = null
    private var route: OriginalAudioRoute? = null
    private var loseAudio: (() -> Unit)? = null
    private var view = OriginalView(enabled = true)
    @Volatile override var rtcLost = false
        private set
    override val capturing: Boolean get() = view.capturing
    override val finished: Boolean get() = view.finished
    companion object {
        suspend fun create(context: Context, host: LabHost, joined: LabJoin, update: (OriginalView) -> Unit): LabOriginal {
            val owner = LabOriginal(context.applicationContext, host, joined, update)
            try { owner.prepare(); return owner }
            catch (error: Throwable) { owner.close(); throw error }
        }
    }
    private fun show(status: String, passages: List<String> = view.passages) {
        view = view.copy(status = status, passages = passages.toList()); update(view)
    }
    private suspend fun prepare() {
        for (id in SpeechCaptureArchive.list(context, identity)) {
            try { archives[id] = SpeechCaptureArchive.recover(context, identity, id) }
            catch (error: SpeechCaptureException) {
                if (error.error == SpeechCaptureError.CLOSED) completed[id] = TextPage()
                else show("An existing encrypted original needs recovery and is retained on this phone.")
            }
        }
        captureId = UUID.randomUUID().toString()
        val preparation = host.prepareCapture(captureId)
        archive = try { SpeechCaptureArchive.create(context, identity, preparation) } finally { preparation.fill(0) }
        archives[captureId] = archive
        route = OriginalAudioRoute(context) {
            scope.launch {
                try { finish() } finally { loseAudio?.invoke(); if (!closed) show("Audio focus ended. Original retained on this phone.") }
            }
        }
        host.observeRenewal { grant -> scope.launch {
            try { renew(grant) } catch (error: Exception) { failure(error) }
        } }
        show("Original audio will be encrypted on this phone when you start the microphone.")
        polling = scope.launch {
            while (isActive) {
                delay(2000)
                try { poll() } catch (error: Exception) { failure(error) }
            }
        }
    }
    private suspend fun renew(grant: SpeechGrant) {
        if (closed) return
        if (grant.sessionId != contextId.sessionId || grant.participantId != contextId.participantId || grant.memberGeneration != contextId.memberGeneration) {
            finish(); return
        }
        expiry = Instant.parse(grant.expiresAt); worker = grant.workerGeneration
        microphone?.let { if (view.capturing) it.renew(expiry) }
    }
    override fun media(callbacks: SpeechMediaCallbacks): SpeechMediaPort {
        loseAudio = { callbacks.failed() }
        val port = LiveKitSpeechMedia.createExternal(context, object : SpeechMediaCallbacks by callbacks {
            override fun failed() { rtcLost = true; callbacks.failed() }
            override fun disconnected() { rtcLost = true; callbacks.disconnected() }
        }, input)
        return object : SpeechMediaPort by port {
            override suspend fun setInput(enabled: Boolean) {
                try { port.setInput(enabled); if (enabled) track = port.inputPublication() }
                catch (error: Exception) { rtcLost = true; throw error }
            }
        }
    }
    override suspend fun start() {
        if (closed || view.finished || microphone != null || starting != null || !expiry.isAfter(Instant.now())) throw LabFailure()
        input.setMuted(false)
        val task = scope.async(start = CoroutineStart.LAZY) {
            SpeechMicrophoneCapture.start(context, archive, expiry, { input.offer(ByteBuffer.wrap(it)) }) { reason ->
                scope.launch {
                    view = view.copy(capturing = false)
                    try { archive.finish() } catch (error: Exception) { failure(error) }
                    view = view.copy(finished = true)
                    if (!closed) show(if (reason == SpeechCaptureEnd.INTERRUPTED) "Capture was interrupted; its unknown tail is preserved." else "Microphone stopped. Original upload can continue.")
                }
            }
        }
        starting = task; task.start()
        try {
            val acquired = task.await()
            if (closed) { acquired.interruptAndStop(); throw LabFailure() }
            microphone = acquired
            if (!view.finished) { view = view.copy(capturing = true); show("Recording an encrypted original. Live captions remain provisional.") }
        } finally { if (starting === task) starting = null }
    }
    override suspend fun finish() {
        starting?.let { microphone = it.await() }; microphone?.stop(); input.drain(); input.setMuted(true)
        if (::archive.isInitialized && !archive.snapshot().finished) archive.finish()
        view = view.copy(capturing = false, finished = true)
        if (!closed) show("Microphone stopped. Original retained until verified publication.")
    }
    private suspend fun failure(error: Exception) {
        if (error is CancellationException) throw error
        if (error is SpeechHostException && error.reason == SpeechHostFailure.UNAUTHORIZED) {
            try { finish() } catch (error: CancellationException) { throw error } catch (_: Exception) { /* Recovery retains encrypted parts. */ }
            show("Authorization ended. Encrypted original remains on this phone.", emptyList())
        } else if (!closed) show("Encrypted original retained on this phone. Upload will retry while this screen is open.")
    }
    private suspend fun poll() {
        if (closed) return
        track?.takeIf { it != bound }?.let { sid ->
            try { host.bindCapture(captureId, worker, sid); bound = sid }
            catch (error: Exception) { if (error is SpeechHostException && error.reason == SpeechHostFailure.UNAUTHORIZED) failure(error) }
        }
        for ((id, retained) in archives.toMap()) {
            try {
                val receipt = JSONObject(String(retained.flush(host.capture(id))))
                if (receipt.optString("state") == "published") {
                    retained.close(); archives.remove(id); completed[id] = TextPage()
                    show(if (receipt.optBoolean("capture_complete")) "Original audio verified. Waiting for aligned text."
                        else "Original verified with capture gaps or an unknown tail. Waiting for aligned text.")
                } else if (receipt.optString("state") == "verification_failed") show("Original verification failed. Encrypted audio is retained.")
            } catch (error: Exception) { failure(error) }
        }
        for ((id, page) in completed) {
            if (page.done) continue
            val result = host.captureTranscript(id, page.after, page.digest)
            if (result.optString("alignment") == "no_audio") { page.done = true; show("No audio was captured.", emptyList()); continue }
            if (result.optString("alignment") == "unverified" || result.optString("state") == "failed") {
                show("Original verified. Aligned text is unavailable; transcription needs attention.", emptyList()); continue
            }
            if (result.optString("alignment") != "verified_original") continue
            val digest = result.getString("result_sha256"); val next = result.getInt("next_segment"); val more = result.getBoolean("has_more")
            if (!Regex("[a-f0-9]{64}").matches(digest) || next < page.after || next == page.after && more || page.digest != null && page.digest != digest) throw LabFailure()
            val segments = result.getJSONArray("segments")
            if (segments.length() > 20) throw LabFailure()
            for (index in 0 until segments.length()) {
                val segment = segments.getJSONObject(index); val spans = segment.getJSONArray("captureIntervals")
                if (spans.length() !in 1..512) throw LabFailure()
                val times = (0 until minOf(spans.length(), 4)).joinToString(", ") { offset ->
                    val span = spans.getJSONObject(offset)
                    val first = span.getLong("firstSample"); val samples = span.getLong("samples")
                    if (first !in 0..345600000L || samples !in 0..345600000L - first ||
                        !Regex("[0-9a-f-]{36}").matches(span.getString("clockId"))) throw LabFailure()
                    "${span.getString("clockId").take(8)} · ${span.getLong("firstSample") / 48000.0}–${(span.getLong("firstSample") + span.getLong("samples")) / 48000.0} s"
                }
                val text = segment.getString("text")
                val bytes = text.toByteArray(Charsets.UTF_8)
                if (bytes.size > 65536) throw LabFailure()
                val preview = bytes.copyOfRange(0, minOf(bytes.size, 4096)).toString(Charsets.UTF_8)
                page.text += "$times${if (segment.getBoolean("crossesDiscontinuity")) " · crosses a capture gap" else ""}\n$preview${if (bytes.size > 4096) "…" else ""}"
            }
            while (page.text.size > 64) page.text.removeAt(0)
            page.after = next; page.digest = digest; page.done = !more
            show(if (page.done && page.text.isEmpty()) "Original verified. No speech was recognized." else "Final text aligned to verified original samples${if (result.getBoolean("capture_complete")) "." else "; gaps or an unknown tail remain."}", page.text)
        }
    }
    override suspend fun close(): Unit = withContext(NonCancellable) {
        val task = retirement ?: scope.async(start = CoroutineStart.LAZY) {
            closed = true; polling?.cancelAndJoin()
            var failed = false
            try { finish() } catch (_: Exception) { failed = true }
            for (retained in archives.values) try { retained.close() } catch (_: Exception) { failed = true }
            archives.clear()
            try { route?.close() } catch (_: Exception) { failed = true }; route = null; loseAudio = null
            if (failed) throw LabFailure()
        }.also { retirement = it; it.start() }
        try { task.await() } finally { scope.cancel() }
    }
}

/** The companion reserves communication audio explicitly; reusable SDK capture
 * never changes a host application's audio focus or global mode. */
private class OriginalAudioRoute(context: Context, lost: () -> Unit) {
    private val manager = context.getSystemService(AudioManager::class.java) ?: throw LabFailure()
    private val prior = manager.mode
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener({ if (it != AudioManager.AUDIOFOCUS_GAIN) lost() }, Handler(Looper.getMainLooper())).build()
    init {
        if (prior != AudioManager.MODE_NORMAL || manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw LabFailure()
        try { manager.mode = AudioManager.MODE_IN_COMMUNICATION }
        catch (error: Exception) { manager.abandonAudioFocusRequest(request); throw error }
    }
    fun close() {
        try {
            if (manager.mode != AudioManager.MODE_IN_COMMUNICATION) throw LabFailure()
            manager.mode = prior
        } finally { manager.abandonAudioFocusRequest(request) }
    }
}
