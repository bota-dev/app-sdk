package dev.bota.speech.companion

import android.content.Context
import dev.bota.sdk.speech.*
import java.net.URI
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

internal class RecordingCleanupFailure : Exception("recording_cleanup_failed")

/** One native foreground recording. The loopback host owns project credentials;
 * this owner retains the grant/archive key, microphone, playback and uploads. */
internal class RecordingLabOwner private constructor(
    private val context: Context, private val origin: String, private var code: String,
    private val activityId: String, private val transport: LabTransport,
    private val status: (String) -> Unit,
) : RecordingSpeechConnection {
    private val tasks = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val archives = linkedMapOf<String, SpeechCaptureArchive>()
    private var live: RecordingSpeechMicrophoneSession? = null
    private var originalOnly: SpeechMicrophoneCapture? = null
    private var polling: Job? = null
    private var route: OriginalAudioRoute? = null
    private var closing: Deferred<Unit>? = null
    @Volatile private var closed = false
    private val displayLock = Any()
    private var display = OriginalView()
    private data class Page(var after: Int = 0, var digest: String? = null, val passages: MutableList<String> = mutableListOf(), var done: Boolean = false)
    private val completed = linkedMapOf<String, Page>()
    companion object {
        suspend fun start(context: Context, origin: String, code: String, activityId: String, target: String, retention: String,
            headphones: () -> Boolean, caption: (ByteArray) -> Unit, status: (String) -> Unit,
            transport: LabTransport = NativeLabTransport(), captureAllowed: () -> Boolean = { true }): RecordingLabOwner {
            val uri = runCatching { URI(origin) }.getOrNull()
            if (uri == null || uri.scheme != "http" || uri.host != "127.0.0.1" || uri.rawUserInfo != null || uri.rawQuery != null ||
                uri.rawFragment != null || uri.path != "" || (uri.port != -1 && uri.port !in 1..65535) ||
                !Regex("[A-Za-z0-9_-]{32,128}").matches(code) || runCatching { UUID.fromString(activityId).toString() == activityId }.getOrDefault(false) != true ||
                target !in listOf("en","zh","ja","ko","es","fr","de") || retention !in listOf("original_audio_and_text","text_only","live_only")) {
                transport.close(); throw LabFailure()
            }
            val owner = RecordingLabOwner(context.applicationContext, origin, code, activityId, transport, status)
            try { owner.prepare(target, retention, headphones, caption, captureAllowed); return owner }
            catch (error: Throwable) {
                try { withContext(NonCancellable) { owner.close() } } catch (_: Throwable) { throw RecordingCleanupFailure() }
                throw error
            }
        }
    }
    private fun show(value: String, passages: List<String>? = null) = synchronized(displayLock) {
        display = display.copy(status = value, passages = passages ?: display.passages)
    }
    fun originalView(): OriginalView = synchronized(displayLock) { display.copy(passages = display.passages.toList()) }
    private suspend fun request(action: String, body: JSONObject): JSONObject {
        check(!closed)
        val response = transport.send(LabRequest("$origin/recording-host/$action", mapOf("Origin" to origin,
            "Content-Type" to "application/json", "X-Recording-Code" to code), body.toString()))
        currentCoroutineContext().ensureActive(); check(!closed)
        if (response.status !in 200..299 || response.body.toByteArray().size > 524288) throw LabFailure()
        return JSONObject(response.body)
    }
    private fun host(id: String) = object : SpeechCaptureHost {
        private fun own(captureId: String): JSONObject { check(captureId == id); return JSONObject().put("captureId", id) }
        override suspend fun status(captureId: String) = request("capture_status", own(captureId)).toString().toByteArray()
        override suspend fun upload(captureId: String, packet: ByteArray) = request("capture_chunk", own(captureId).put("packet", JSONObject(packet.toString(Charsets.UTF_8)))).toString().toByteArray()
        override suspend fun complete(captureId: String, manifest: ByteArray) = request("capture_complete", own(captureId).put("packet", JSONObject(manifest.toString(Charsets.UTF_8)))).toString().toByteArray()
    }
    private suspend fun prepare(target: String, retention: String, headphones: () -> Boolean, caption: (ByteArray) -> Unit, captureAllowed: () -> Boolean) {
        val clock = UUID.randomUUID().toString(); val original = retention == "original_audio_and_text"
        val admission = request("start", JSONObject().put("activityId", activityId).put("clockId", clock).put("targetLanguage", target)
            .put("sourceLanguage", "multi").put("retention", retention).apply { if (original) put("captureId", UUID.randomUUID().toString()) })
        check(admission.getString("clockId") == clock && admission.getJSONObject("activity").getString("id") == activityId)
        val identity = admission.getString("scope"); check(identity.isNotBlank() && identity.length <= 512)
        val expiry = Instant.parse(admission.getJSONObject("activity").getString("expires_at"))
        var archive: SpeechCaptureArchive? = null
        synchronized(displayLock) { display = OriginalView(enabled = original) }
        if (original) {
            val retained = try { SpeechCaptureArchive.list(context, identity) }
                catch (_: Exception) { show("Earlier original storage could not be opened."); emptyList() }
            for (id in retained) {
                try { archives[id] = SpeechCaptureArchive.recover(context, identity, id) }
                catch (error: SpeechCaptureException) { if (error.error == SpeechCaptureError.CLOSED) completed[id] = Page() else show("An encrypted original needs recovery and is retained.") }
            }
            val prepared = admission.getJSONObject("prepared").toString().toByteArray()
            try { archive = SpeechCaptureArchive.create(context, identity, prepared); archives[admission.getJSONObject("prepared").getString("capture_id")] = archive }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { status("archive_unavailable"); show("Original storage unavailable. Live captions continue.") }
            finally { prepared.fill(0); admission.remove("prepared") }
        }
        check(captureAllowed())
        route = OriginalAudioRoute(context) { tasks.launch { runCatching { finish() }; status("capture_interrupted") } }
        val configuration = admission.getJSONObject("configuration").toString().toByteArray(); val grant = admission.getJSONObject("grant").toString().toByteArray()
        try { live = RecordingSpeechMicrophoneSession.start(context, configuration, grant, clock, expiry, archive, headphones, caption, status, captureAllowed) }
        catch (_: RecordingSpeechCleanupFailure) { throw RecordingCleanupFailure() }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            check(captureAllowed())
            status("interrupted")
            originalOnly = SpeechMicrophoneCapture.start(context, archive, expiry, clockId = clock, onArchiveError = { status("archive_unavailable") },
                ended = { if (it != SpeechCaptureEnd.STOPPED) status("capture_interrupted") })
        } finally { configuration.fill(0); grant.fill(0); admission.remove("grant") }
        synchronized(displayLock) { display = display.copy(capturing = true) }
        polling = tasks.launch { while (isActive) { delay(2000); poll() } }
    }
    private suspend fun poll() {
        for ((id, archive) in archives.toMap()) {
            try {
                val bytes = archive.flush(host(id))
                val receipt = try { JSONObject(bytes.toString(Charsets.UTF_8)) } finally { bytes.fill(0) }
                if (receipt.optString("state") == "published") { archive.close(); archives.remove(id); completed[id] = Page(); show("Original verified. Final text is pending.") }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { show("Encrypted original retained. Upload will retry while this activity is open.") }
        }
        for ((id, page) in completed) {
            if (page.done) continue
            try {
                val value = request("capture_transcript", JSONObject().put("captureId", id).put("afterSegment", page.after).apply { page.digest?.let { put("resultSha256", it) } })
                if (value.optString("alignment") == "no_audio" || value.optString("state") in listOf("failed","unavailable")) {
                    page.done = true; show("Final original text unavailable: ${value.optString("alignment")}", emptyList()); continue
                }
                if (value.optString("alignment") != "verified_original" || value.optString("state") != "completed") continue
                val digest = value.getString("result_sha256"); val next = value.getInt("next_segment"); val more = value.getBoolean("has_more")
                check(Regex("[a-f0-9]{64}").matches(digest) && next >= page.after && (!more || next > page.after))
                check(page.digest == null || page.digest == digest)
                page.digest = digest; page.after = next
                val segments = value.getJSONArray("segments")
                for (i in 0 until segments.length()) {
                    val segment = segments.getJSONObject(i); val units = segment.optJSONArray("translation_units")
                    val translations = (0 until (units?.length() ?: 0)).map { index -> val unit = units!!.getJSONObject(index)
                        "[${unit.getString("targetLanguage")}; revision ${unit.getInt("revision")}] ${if (unit.isNull("targetText")) unit.getString("state") else unit.getString("targetText")}" }
                    page.passages.add(segment.getString("text") + "\n" + translations.joinToString("\n"))
                }
                while (page.passages.size > 64) page.passages.removeAt(0)
                val state = value.getString("final_translation")
                show("Final source ${digest.take(12)}; translation $state", page.passages.toList())
                if (!more) { page.done = state in listOf("completed","failed"); if (!page.done) { page.after = 0; page.passages.clear() } }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { page.after = 0; page.digest = null; page.passages.clear(); show("Refreshing final original text.", emptyList()) }
        }
    }
    override suspend fun changeTarget(language: String, requestId: String) { (live ?: throw LabFailure()).changeTarget(language, requestId) }
    override suspend fun qualifyHeadphones(): Boolean = live?.qualifyHeadphones() ?: false
    override suspend fun finish() {
        try { if (live != null) live!!.finish() else originalOnly?.stop() }
        finally {
            synchronized(displayLock) { display = display.copy(capturing = false, finished = true) }
            request("end", JSONObject().put("activityId", activityId))
        }
    }
    override suspend fun close(): Unit = withContext(NonCancellable) {
        val cleanup = synchronized(displayLock) {
            closing ?: tasks.async(NonCancellable, start = CoroutineStart.LAZY) {
                closed = true; transport.close(); polling?.cancelAndJoin()
                var failed = false
                try { live?.close(); originalOnly?.interruptAndStop() } catch (_: Exception) { failed = true }
                for (archive in archives.values) try { archive.close() } catch (_: Exception) { failed = true }
                try { route?.close() } catch (_: Exception) { failed = true }
                code = ""; tasks.cancel(); if (failed) throw LabFailure()
            }.also { closing = it; it.start() }
        }
        cleanup.await()
    }
}
