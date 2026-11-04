package dev.bota.speech.companion

import android.content.Context
import dev.bota.sdk.speech.*
import dev.bota.sdk.speech.livekit.LiveKitSpeechMedia
import java.util.UUID
import java.time.Instant
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** Native IO for the RN companion. No native SpeechSession is created: the RN
 * facade runs the shared session policy as generated JS. Call async methods on Main. */
internal class ReactNativeLabOwner(private val context: Context, origin: String, role: String, code: String,
    private val transport: LabTransport = NativeLabTransport(),
    dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val mediaFactory: (SpeechMediaCallbacks) -> SpeechMediaPort = { LiveKitSpeechMedia.create(context, it) },
    private val originalFactory: suspend (LabHost, LabJoin, (OriginalView) -> Unit) -> LabOriginalOwner =
        { host, joined, update -> LabOriginal.create(context, host, joined, update) }) {
    private val host = LabHost(origin, role, code, transport, originalCapable = true)
    private var joined: LabJoin? = null
    private var original: LabOriginalOwner? = null
    private var view = OriginalView()
    private val lock = Any()
    private var port: SpeechMediaPort? = null
    private var handle: String? = null
    private var mediaClosed = false
    private var mediaUsed = false
    private var closed = false
    private val events = ArrayDeque<JSONObject>()
    private var eventBytes = 0
    private var overflow = false
    private val commands = mutableSetOf<Job>()
    private var closingMedia: Deferred<Unit>? = null
    private var retirement: Deferred<Unit>? = null
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var expiry: Instant? = null
    private var expiryTask: Job? = null

    suspend fun prepare(): String {
        val value = host.join()
        if (closed) throw LabFailure()
        joined = value
        authorize(value.grant)
        if (value.configuration.context.retention == SpeechRetention.ORIGINAL_AUDIO_AND_TEXT) {
            val acquired = originalFactory(host, value) { if (!closed) view = it }
            if (closed) { acquired.close(); throw LabFailure() }
            original = acquired
        }
        return host.takeJoinPayload()
    }
    suspend fun renew(): String {
        val response = host.renewResponse(); authorize(grant(JSONObject(response))); return response
    }
    private fun authorize(grant: SpeechGrant) {
        val expected = joined?.configuration?.context ?: throw LabFailure()
        val deadline = Instant.parse(grant.expiresAt)
        if (grant.sessionId != expected.sessionId || grant.participantId != expected.participantId ||
            grant.memberGeneration != expected.memberGeneration || !deadline.isAfter(Instant.now())) throw LabFailure()
        expiry = deadline; expiryTask?.cancel()
        expiryTask = scope.launch {
            while (isActive && Instant.now().isBefore(deadline)) delay(minOf(1000, maxOf(1, deadline.toEpochMilli() - System.currentTimeMillis())))
            if (!closed && expiry == deadline) {
                offer(JSONObject().put("type", "disconnected"))
                handle?.let { id ->
                    fence(id, "silence"); fence(id, "mute")
                    try { closeMedia(id) } catch (_: Exception) { /* Explicit close preserves cleanup failure. */ }
                }
                try { original?.finish() } catch (_: Exception) { /* Encrypted recovery data remains durable. */ }
            }
        }
    }
    fun createMedia(sessionId: String): String {
        val value = joined ?: throw LabFailure()
        if (closed || mediaUsed || expiry?.isAfter(Instant.now()) != true || sessionId != value.configuration.context.sessionId) throw LabFailure()
        mediaUsed = true
        val callbacks = object : SpeechMediaCallbacks {
            override fun text(sender: String, json: String) = offer(JSONObject().put("type", "text").put("sender", sender).put("json", json))
            override fun trackRemoved(mediaTrackSid: String) = offer(JSONObject().put("type", "removed").put("sid", mediaTrackSid))
            override fun disconnected() = offer(JSONObject().put("type", "disconnected"))
            override fun failed() = offer(JSONObject().put("type", "failed"))
            override fun playbackBlocked() = offer(JSONObject().put("type", "blocked"))
        }
        val acquired = original?.media(callbacks) ?: mediaFactory(callbacks)
        return synchronized(lock) { port = acquired; UUID.randomUUID().toString().also { handle = it } }
    }
    private fun offer(event: JSONObject) {
        val fail = synchronized(lock) {
            if (closed || mediaClosed || overflow) return
            val size = event.toString().toByteArray().size
            if (size > 70000 || events.size >= 32 || eventBytes + size > 450000) {
                events.clear(); eventBytes = 0; overflow = true; true
            } else { events.addLast(event); eventBytes += size; false }
        }
        if (fail) {
            synchronized(lock) { port }?.let { runCatching { it.silencePlayback() }; runCatching { it.muteInput() } }
        }
    }
    fun fence(id: String, action: String): Boolean = synchronized(lock) {
        if (handle != id) return false
        if (mediaClosed || closed) return true
        val target = port ?: return false
        runCatching {
            when (action) { "silence" -> target.silencePlayback(); "mute" -> target.muteInput(); "hold" -> target.holdInput(); else -> throw LabFailure() }
        }.isSuccess
    }
    fun events(id: String): String = synchronized(lock) {
        if (handle != id) throw LabFailure()
        if (mediaClosed || closed) return "[]"
        if (overflow) return "[{\"type\":\"failed\"}]"
        val result = JSONArray(events.toList()).toString(); events.clear(); eventBytes = 0; result
    }
    suspend fun command(id: String, action: String, body: String): String {
        if (body.toByteArray().size > 65536 || commands.size >= 8 || expiry?.isAfter(Instant.now()) != true) throw LabFailure()
        val target = synchronized(lock) { if (handle != id || mediaClosed || closed) throw LabFailure(); port ?: throw LabFailure() }
        val job = currentCoroutineContext()[Job] ?: throw LabFailure(); commands.add(job)
        try { return withTimeout(15_000) {
            when (action) {
                "connect" -> {
                    val grant = grant(JSONObject(body)); val expected = joined?.configuration?.context ?: throw LabFailure()
                    if (grant.sessionId != expected.sessionId || grant.participantId != expected.participantId || grant.memberGeneration != expected.memberGeneration) throw LabFailure()
                    target.connect(grant)
                }
                "clear" -> target.clearPlayback()
                "input" -> {
                    if (body !in listOf("true", "false")) throw LabFailure()
                    target.setInput(body == "true")
                    return@withTimeout if (body == "true") target.inputPublication()?.let(JSONObject::quote) ?: "null" else "null"
                }
                "playback" -> {
                    val values = JSONArray(body); if (values.length() > 16) throw LabFailure()
                    target.setPlayback((0 until values.length()).map { index ->
                        val item = values.getJSONObject(index)
                        SpeechTrack(item.getString("mediaTrackSid"), item.getString("sourceId"), item.getLong("sourceEpoch"),
                            item.getString("sourceParticipantId"), item.getString("origin"), if (item.isNull("outputId")) null else item.getString("outputId"))
                    })
                }
                "resume" -> target.resumeAudio()
                else -> throw LabFailure()
            }
            "null"
        } } finally { commands.remove(job) }
    }
    suspend fun startOriginal() { if (closed) throw LabFailure(); original?.start() }
    suspend fun finishOriginal() { if (closed) throw LabFailure(); original?.finish() }
    fun originalView(): String {
        if (closed) throw LabFailure()
        return JSONObject().put("enabled", view.enabled).put("capturing", view.capturing).put("finished", view.finished)
            .put("rtcAvailable", original?.rtcLost != true).put("status", view.status).put("passages", JSONArray(view.passages)).toString()
    }
    suspend fun closeMedia(id: String) {
        if (handle != id) throw LabFailure()
        val task = closingMedia ?: scope.async(start = CoroutineStart.LAZY) {
            val target = synchronized(lock) { mediaClosed = true; events.clear(); eventBytes = 0; port }
            commands.toList().forEach { it.cancel() }
            var failure: Exception? = null
            try { target?.close() } catch (error: Exception) { failure = error }
            commands.toList().joinAll()
            synchronized(lock) { port = null }
            failure?.let { throw it }; Unit
        }.also { closingMedia = it; it.start() }
        task.await()
    }
    suspend fun close(): Unit = withContext(NonCancellable) {
        val task = retirement ?: scope.async(start = CoroutineStart.LAZY) {
            synchronized(lock) { closed = true }; expiryTask?.cancel(); host.close()
            var failure: Exception? = null
            try { original?.finish() } catch (error: Exception) { failure = error }
            try { handle?.let { closeMedia(it) } } catch (error: Exception) { failure = error }
            try { original?.close() } catch (error: Exception) { failure = error }
            original = null; joined = null; view = OriginalView()
            failure?.let { throw it }; Unit
        }.also { retirement = it; it.start() }
        try { task.await() } finally { scope.cancel() }
    }
    private fun grant(value: JSONObject) = SpeechGrant(value.getInt("protocol_version"), value.getString("provider"), value.getString("url"),
        value.getString("room"), value.getString("identity"), value.getString("token"), value.getString("expires_at"),
        value.getString("session_id"), value.getString("participant_id"), value.getInt("member_generation"),
        value.getInt("worker_generation"), value.getString("processor_identity"))
}
