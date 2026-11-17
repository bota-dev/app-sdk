package dev.bota.sdk.speech

import java.util.Collections
import org.json.JSONArray
import org.json.JSONObject

internal fun <T> frozen(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
internal fun SpeechSelection.snapshot(): SpeechSelection = copy(sourceParticipantIds = frozen(sourceParticipantIds))
internal data class SpeechPolicyUpdate(val state: SpeechState, val event: String?, val captions: List<SpeechCaption>)

/** Projection only: identity, authority, revision, limits and recovery decisions stay in Rust. */
internal object SpeechJson {
    private fun json(vararg entries: Pair<String, Any?>): JSONObject = JSONObject().apply {
        entries.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
    }
    fun configuration(value: SpeechConfiguration): ByteArray = json(
        "context" to json("projectId" to value.context.projectId, "sessionId" to value.context.sessionId,
            "participantId" to value.context.participantId, "memberGeneration" to value.context.memberGeneration,
            "retention" to value.context.retention.wire, "canPublish" to value.context.canPublish,
            "canSubscribe" to value.context.canSubscribe),
        "subscription" to subscription(value.subscription),
    ).toString().toByteArray(Charsets.UTF_8)

    fun grant(value: SpeechGrant): String = json("protocol_version" to value.protocolVersion,
        "provider" to value.provider, "url" to value.url, "room" to value.room, "identity" to value.identity,
        "token" to value.token, "expires_at" to value.expiresAt, "session_id" to value.sessionId,
        "participant_id" to value.participantId, "member_generation" to value.memberGeneration,
        "worker_generation" to value.workerGeneration, "processor_identity" to value.processorIdentity).toString()

    fun subscription(value: SpeechSubscription): JSONObject = json("revision" to value.revision,
        "targetLanguage" to value.selection.targetLanguage, "mode" to value.selection.mode.wire,
        "sourceParticipantIds" to JSONArray(value.selection.sourceParticipantIds))

    fun command(type: String, vararg entries: Pair<String, Any?>): String =
        json("type" to type, *entries).toString()

    // Raw host bodies reach the single shared validator without numeric/string coercion.
    fun response(type: String, requestId: Int, field: String, body: String): String =
        "{\"type\":\"" + type + "\",\"requestId\":" + requestId + ",\"" + field + "\":" + body + "}"

    fun update(bytes: ByteArray): SpeechPolicyUpdate {
        val value = JSONObject(bytes.toString(Charsets.UTF_8))
        val tracks = value.getJSONArray("tracks")
        val state = SpeechState(value.getBoolean("connected"), value.getBoolean("disconnect"),
            value.getBoolean("canCapture"), value.getBoolean("canPlay"), value.getInt("subscriptionRevision"),
            value.getInt("changeId"), value.getInt("clearGeneration"), value.getBoolean("clearPlayback"),
            value.getLong("expiresAtMs"), value.getBoolean("gap"),
            frozen((0 until tracks.length()).map { index -> tracks.getJSONObject(index).let {
                SpeechTrack(it.getString("mediaTrackSid"), it.getString("sourceId"), it.getLong("sourceEpoch"),
                    it.getString("sourceParticipantId"), it.getString("origin"), it.nullableString("outputId"))
            } }), recovery(value.getJSONObject("recovery")), finish(value.getJSONObject("sourceFinish")))
        val captions = value.getJSONArray("captions")
        return SpeechPolicyUpdate(state, value.optJSONObject("event")?.toString(),
            frozen((0 until captions.length()).map { caption(captions.getJSONObject(it)) }))
    }

    private fun recovery(value: JSONObject): SpeechCaptionRecovery = SpeechCaptionRecovery(
        value.getString("status"), value.nullableString("cursor"), value.getBoolean("hasMore"),
        value.optJSONObject("request")?.let { SpeechCaptionRequest(it.getInt("requestId"), it.getString("projectId"),
            it.getString("sessionId"), it.getString("participantId"), it.getInt("memberGeneration"),
            it.getInt("subscriptionRevision"), it.getInt("limit"), it.nullableString("cursor")) },
    )

    private fun finish(value: JSONObject): SpeechSourceFinish = SpeechSourceFinish(
        value.getString("status"), value.getBoolean("holdPublication"), value.nullableString("trackSid"),
        value.optJSONObject("source")?.let { source -> source.getJSONObject("finish").let { boundary ->
            SpeechFinishedSource(source.getString("id"), source.getLong("epoch"), source.getString("participant_id"),
                source.getInt("member_generation"), source.getString("track_sid"), source.getString("state"),
                SpeechFinishBoundary(boundary.getString("state"), boundary.getInt("worker_generation"),
                    boundary.nullableString("sequence"), boundary.nullableString("samples")))
        } },
        value.optJSONObject("request")?.let { SpeechFinishRequest(it.getInt("requestId"), it.getString("projectId"),
            it.getString("sessionId"), it.getString("participantId"), it.getInt("memberGeneration"),
            it.getInt("workerGeneration"), it.getString("trackSid"), it.nullableString("sourceId"),
            if (it.isNull("sourceEpoch")) null else it.getLong("sourceEpoch")) },
    )

    private fun caption(value: JSONObject): SpeechCaption = value.getJSONObject("record").let {
        SpeechCaption(value.getString("key"), value.getString("origin"), value.getBoolean("final"),
            value.getInt("subscriptionRevision"), value.nullableString("sequence"), it.getString("sourceId"),
            it.getLong("sourceEpoch"), it.getString("sourceParticipantId"), it.getInt("sourceMemberGeneration"),
            it.getString("unitId"), it.getLong("sourceFirstSeq"), it.getLong("sourceLastSeq"),
            it.getDouble("startMs"), it.getDouble("endMs"), it.getString("sourceLanguage"),
            it.nullableString("targetLanguage"), it.getString("text"))
    }

    private fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else getString(key)
}
