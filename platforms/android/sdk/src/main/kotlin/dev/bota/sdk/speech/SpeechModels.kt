package dev.bota.sdk.speech

/** Source-preview speech control models. They carry metadata, never audio buffers. */
public enum class SpeechRetention(internal val wire: String) {
    ORIGINAL_AUDIO_AND_TEXT("original_audio_and_text"), TEXT_ONLY("text_only"), LIVE_ONLY("live_only"),
}

public enum class SpeechListeningMode(internal val wire: String) {
    TRANSLATED("translated"), ORIGINAL("original"), CAPTIONS_ONLY("captions_only"),
}

public data class SpeechContext(
    val projectId: String,
    val sessionId: String,
    val participantId: String,
    val memberGeneration: Int,
    val retention: SpeechRetention,
    val canPublish: Boolean,
    val canSubscribe: Boolean,
)

public data class SpeechSelection(
    val targetLanguage: String,
    val mode: SpeechListeningMode,
    val sourceParticipantIds: List<String>,
)

public data class SpeechSubscription(val revision: Int, val selection: SpeechSelection)
public data class SpeechConfiguration(val context: SpeechContext, val subscription: SpeechSubscription)

/** A host-issued, short-lived participant grant. Do not log or persist its token. */
public class SpeechGrant(
    public val protocolVersion: Int,
    public val provider: String,
    public val url: String,
    public val room: String,
    public val identity: String,
    public val token: String,
    public val expiresAt: String,
    public val sessionId: String,
    public val participantId: String,
    public val memberGeneration: Int,
    public val workerGeneration: Int,
    public val processorIdentity: String,
) {
    override fun toString(): String = "SpeechGrant(redacted)"
}

public data class SpeechTrack(
    val mediaTrackSid: String, val sourceId: String, val sourceEpoch: Long,
    val sourceParticipantId: String, val origin: String, val outputId: String?,
)

public data class SpeechCaptionRequest(
    val requestId: Int, val projectId: String, val sessionId: String, val participantId: String,
    val memberGeneration: Int, val subscriptionRevision: Int, val limit: Int, val cursor: String?,
)

public data class SpeechFinishRequest(
    val requestId: Int, val projectId: String, val sessionId: String, val participantId: String,
    val memberGeneration: Int, val workerGeneration: Int, val trackSid: String,
    val sourceId: String?, val sourceEpoch: Long?,
)

public data class SpeechFinishBoundary(
    val state: String, val workerGeneration: Int, val sequence: String?, val samples: String?,
)

public data class SpeechFinishedSource(
    val id: String, val epoch: Long, val participantId: String, val memberGeneration: Int,
    val trackSid: String, val state: String, val finish: SpeechFinishBoundary,
)

public data class SpeechSourceFinish(
    val status: String, val holdPublication: Boolean, val trackSid: String?,
    val source: SpeechFinishedSource?, val request: SpeechFinishRequest?,
)

public data class SpeechCaptionRecovery(
    val status: String, val cursor: String?, val hasMore: Boolean, val request: SpeechCaptionRequest?,
)

/** Content-free state. Caption content is delivered only through the observer. */
public data class SpeechState(
    val connected: Boolean, val disconnect: Boolean, val canCapture: Boolean, val canPlay: Boolean,
    val subscriptionRevision: Int, val changeId: Int, val clearGeneration: Int, val clearPlayback: Boolean,
    val expiresAtMs: Long, val gap: Boolean, val tracks: List<SpeechTrack>,
    val recovery: SpeechCaptionRecovery, val sourceFinish: SpeechSourceFinish,
)

/** Upsert by key. A final caption must not be replaced with a late draft. */
public data class SpeechCaption(
    val key: String, val origin: String, val isFinal: Boolean, val subscriptionRevision: Int,
    val sequence: String?, val sourceId: String, val sourceEpoch: Long, val sourceParticipantId: String,
    val sourceMemberGeneration: Int, val unitId: String, val sourceFirstSeq: Long, val sourceLastSeq: Long,
    val startMs: Double, val endMs: Double, val sourceLanguage: String, val targetLanguage: String?, val text: String,
) {
    override fun toString(): String = "SpeechCaption(content redacted)"
}

public enum class SpeechErrorCode {
    INVALID_INPUT, CLOSED, SUPERSEDED, MEDIA_FAILED, MEDIA_TIMEOUT,
    SUBSCRIPTION_UNAVAILABLE, AUTHORIZATION_UNAVAILABLE, PLAYBACK_BLOCKED, CLEANUP_FAILED,
    CAPTION_RECOVERY_UNAVAILABLE, CAPTION_RECOVERY_STALE,
    SOURCE_FINISH_UNAVAILABLE, SOURCE_FINISH_STALE, SOURCE_FINISH_PENDING,
}

public class SpeechSessionException(public val code: SpeechErrorCode) : IllegalStateException(code.name)

public enum class SpeechHostFailure(internal val wire: String) {
    UNAUTHORIZED("unauthorized"), STALE_SUBSCRIPTION("stale_subscription"),
    STALE_SOURCE("stale_source"), UNAVAILABLE("unavailable"),
}

/** Map an authenticated HTTP outcome without including response bodies or credentials. */
public class SpeechHostException(public val reason: SpeechHostFailure) : IllegalStateException(reason.name)
