package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject

internal class LabJoin(val role: String, val peerRole: String, val peerId: String,
    val languages: List<String>, val configuration: SpeechConfiguration, val grant: SpeechGrant)

/** This example accepts only the operator's loopback role credential, never project/provider keys. */
internal class LabHost(origin: String, private val role: String, code: String,
    private val transport: LabTransport = NativeLabTransport(), private val originalCapable: Boolean = false) : SpeechHostCallbacks {
    private val lock = Any()
    private val origin: String
    private var code = code
    private var closed = false
    private var joining = false
    private var joined: LabJoin? = null
    private var revision = 0
    private var renewal: ((SpeechGrant) -> Unit)? = null
    private var joinPayload: String? = null
    override val supportsCaptionRecovery = true
    override val supportsSourceFinish = true

    init {
        val uri = runCatching { URI(origin) }.getOrNull()
        if (uri == null || uri.scheme != "http" || uri.host != "127.0.0.1" || uri.rawUserInfo != null ||
            uri.rawQuery != null || uri.rawFragment != null || uri.path !in listOf("", "/") ||
            (uri.port != -1 && uri.port !in 1..65535) || role !in listOf("a", "b") ||
            !Regex("[A-Za-z0-9_-]{32,128}").matches(code)) {
            transport.close(); throw LabFailure()
        }
        this.origin = "http://127.0.0.1" + if (uri.port == -1) "" else ":${uri.port}"
    }
    suspend fun join(): LabJoin {
        synchronized(lock) { active(); if (joined != null || joining) throw LabFailure(); joining = true }
        try {
            val payload = request("join", JSONObject().apply { if (originalCapable) put("captureProfile", "speech_capture_pcm_v1") })
            val value = JSONObject(payload)
            val config = value.getJSONObject("configuration")
            val context = config.getJSONObject("context")
            val retention = when (context.getString("retention")) {
                "text_only" -> SpeechRetention.TEXT_ONLY
                "live_only" -> SpeechRetention.LIVE_ONLY
                "original_audio_and_text" -> if (originalCapable) SpeechRetention.ORIGINAL_AUDIO_AND_TEXT else throw LabFailure()
                else -> throw LabFailure()
            }
            val configuration = SpeechConfiguration(SpeechContext(context.getString("projectId"), context.getString("sessionId"),
                context.getString("participantId"), context.integer("memberGeneration"), retention,
                context.getBoolean("canPublish"), context.getBoolean("canSubscribe")), subscription(config.getJSONObject("subscription")))
            val peer = value.getJSONObject("peer")
            val result = LabJoin(value.getString("role"), peer.getString("role"), peer.getString("participantId"),
                value.getJSONArray("allowedLanguages").strings(), configuration, grant(value.getJSONObject("grant")))
            if (result.role != role || result.peerRole !in listOf("a", "b") || result.peerRole == role ||
                result.peerId == configuration.context.participantId || !configuration.context.canPublish || !configuration.context.canSubscribe ||
                configuration.subscription.selection.sourceParticipantIds != listOf(result.peerId) ||
                configuration.subscription.selection.targetLanguage !in result.languages || result.languages.size !in 1..7 ||
                result.languages.distinct().size != result.languages.size) throw LabFailure()
            return synchronized(lock) { active(); joined = result; joinPayload = payload; revision = configuration.subscription.revision; result }
        } finally { synchronized(lock) { joining = false } }
    }
    override suspend fun renewGrant(): SpeechGrant {
        return grant(JSONObject(renewResponse()))
    }
    fun takeJoinPayload(): String = synchronized(lock) {
        active(); val value = joinPayload ?: throw LabFailure(); joinPayload = null; value
    }
    suspend fun renewResponse(): String {
        synchronized(lock) { active(); if (joined == null) throw LabFailure() }
        val payload = request("grant", JSONObject())
        val value = grant(JSONObject(payload)); synchronized(lock) { renewal }?.invoke(value)
        return payload
    }
    fun observeRenewal(observer: (SpeechGrant) -> Unit) { synchronized(lock) { active(); renewal = observer } }
    suspend fun prepareCapture(id: String): ByteArray = request("capture_prepare", JSONObject().put("captureId", id)).toByteArray()
    fun capture(id: String): SpeechCaptureHost = object : SpeechCaptureHost {
        private fun body(captureId: String): JSONObject {
            if (captureId != id) throw LabFailure()
            return JSONObject().put("captureId", id)
        }
        override suspend fun status(captureId: String): ByteArray = request("capture_status", body(captureId)).toByteArray()
        override suspend fun upload(captureId: String, packet: ByteArray): ByteArray =
            request("capture_chunk", body(captureId).put("packet", JSONObject(packet.toString(Charsets.UTF_8)))).toByteArray()
        override suspend fun complete(captureId: String, manifest: ByteArray): ByteArray =
            request("capture_complete", body(captureId).put("packet", JSONObject(manifest.toString(Charsets.UTF_8)))).toByteArray()
    }
    suspend fun bindCapture(id: String, worker: Int, track: String) {
        request("capture_bind", JSONObject().put("captureId", id).put("workerGeneration", worker).put("trackSid", track))
    }
    suspend fun captureTranscript(id: String, after: Int, digest: String?): JSONObject = JSONObject(request("capture_transcript",
        JSONObject().put("captureId", id).put("afterSegment", after).apply { if (digest != null) put("resultSha256", digest) }))
    override suspend fun changeSubscription(selection: SpeechSelection): SpeechSubscription {
        val expected = synchronized(lock) {
            active(); val join = joined ?: throw LabFailure()
            if (selection.sourceParticipantIds != listOf(join.peerId) || selection.targetLanguage !in join.languages) throw LabFailure()
            revision
        }
        val body = JSONObject().put("expectedRevision", expected).put("targetLanguage", selection.targetLanguage).put("mode", mode(selection.mode))
        val selected = subscription(JSONObject(request("subscription", body)))
        synchronized(lock) { active(); revision = selected.revision }
        return selected
    }
    override suspend fun readCaptions(request: SpeechCaptionRequest): String {
        own(request.projectId, request.sessionId, request.participantId, request.memberGeneration)
        return this.request("captions", JSONObject().put("subscriptionRevision", request.subscriptionRevision)
            .put("limit", request.limit).put("cursor", request.cursor ?: JSONObject.NULL))
    }
    override suspend fun finishSource(request: SpeechFinishRequest): String {
        own(request.projectId, request.sessionId, request.participantId, request.memberGeneration)
        return this.request("finish", JSONObject().put("workerGeneration", request.workerGeneration).put("trackSid", request.trackSid)
            .put("sourceId", request.sourceId ?: JSONObject.NULL).put("sourceEpoch", request.sourceEpoch ?: JSONObject.NULL))
    }
    fun close() {
        synchronized(lock) { closed = true; code = ""; joined = null; renewal = null; joinPayload = null }
        transport.close()
    }
    private fun active() { if (closed) throw LabFailure() }
    private fun own(project: String, session: String, participant: String, generation: Int) = synchronized(lock) {
        active(); val context = joined?.configuration?.context ?: throw LabFailure()
        if (context.projectId != project || context.sessionId != session || context.participantId != participant || context.memberGeneration != generation) {
            throw SpeechHostException(SpeechHostFailure.UNAUTHORIZED)
        }
    }
    private suspend fun request(action: String, body: JSONObject): String {
        currentCoroutineContext().ensureActive()
        val request = synchronized(lock) {
            active(); LabRequest("$origin/speech-host/$action", mapOf("Origin" to origin, "Content-Type" to "application/json",
                "X-Speech-Role" to role, "X-Speech-Code" to code), body.toString())
        }
        val response = try { transport.send(request) }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { throw SpeechHostException(SpeechHostFailure.UNAVAILABLE) }
        currentCoroutineContext().ensureActive()
        synchronized(lock) { active() }
        if (response.body.toByteArray(Charsets.UTF_8).size > 524_288) throw SpeechHostException(SpeechHostFailure.UNAVAILABLE)
        if (response.status == 403) throw SpeechHostException(SpeechHostFailure.UNAUTHORIZED)
        if (response.status == 409) {
            val code = runCatching { JSONObject(response.body).getJSONObject("error").getString("code") }.getOrNull()
            throw SpeechHostException(when {
                code == "not_ready" -> SpeechHostFailure.UNAVAILABLE
                action == "captions" -> SpeechHostFailure.STALE_SUBSCRIPTION
                action == "finish" -> SpeechHostFailure.STALE_SOURCE
                else -> SpeechHostFailure.UNAVAILABLE
            })
        }
        if (response.status != 200 && !(action == "finish" && response.status == 202) &&
            !(action.startsWith("capture_") && response.status in listOf(201, 202))) throw SpeechHostException(SpeechHostFailure.UNAVAILABLE)
        return response.body
    }
    private fun JSONObject.integer(key: String): Int {
        val value = get(key)
        return if (value is Number) value.toString().toIntOrNull() ?: throw LabFailure() else throw LabFailure()
    }
    private fun JSONArray.strings() = (0 until length()).map { getString(it) }
    private fun subscription(value: JSONObject) = SpeechSubscription(value.integer("revision"), SpeechSelection(
        value.getString("targetLanguage"), when (value.getString("mode")) {
            "translated" -> SpeechListeningMode.TRANSLATED
            "original" -> SpeechListeningMode.ORIGINAL
            "captions_only" -> SpeechListeningMode.CAPTIONS_ONLY
            else -> throw LabFailure()
        }, value.getJSONArray("sourceParticipantIds").strings()))
    private fun grant(value: JSONObject) = SpeechGrant(value.integer("protocol_version"), value.getString("provider"), value.getString("url"),
        value.getString("room"), value.getString("identity"), value.getString("token"), value.getString("expires_at"),
        value.getString("session_id"), value.getString("participant_id"), value.integer("member_generation"),
        value.integer("worker_generation"), value.getString("processor_identity"))
    private fun mode(value: SpeechListeningMode) = when (value) {
        SpeechListeningMode.TRANSLATED -> "translated"
        SpeechListeningMode.ORIGINAL -> "original"
        SpeechListeningMode.CAPTIONS_ONLY -> "captions_only"
    }
}
