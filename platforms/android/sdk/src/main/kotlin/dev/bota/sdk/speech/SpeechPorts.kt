package dev.bota.sdk.speech

/** Callbacks are scoped to one media owner. Never infer sender identity from a track name. */
public interface SpeechMediaCallbacks {
    public fun text(sender: String, json: String)
    public fun trackRemoved(mediaTrackSid: String)
    public fun disconnected()
    public fun failed()
    public fun playbackBlocked()
}

/**
 * Platform media IO. Suspend operations must cooperate with coroutine cancellation
 * and fence late native callbacks. close must join/clean late acquisitions and
 * preserve unrelated host audio. A failure to clean up must throw.
 *
 * Synchronous mute/silence/hold apply to both current and pending acquisitions.
 * connect must not start capture. Newly acquired receive tracks must remain inaudible until setPlayback admits
 * their exact identity. No default subscription may bypass shared Rust policy.
 */
public interface SpeechMediaPort {
    public suspend fun connect(grant: SpeechGrant)
    public fun silencePlayback()
    public fun muteInput()
    public suspend fun clearPlayback()
    public suspend fun setPlayback(tracks: List<SpeechTrack>)
    public suspend fun setInput(enabled: Boolean)
    public val supportsSourceFinish: Boolean get() = false
    public fun holdInput(): Unit = throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_UNAVAILABLE)
    public fun inputPublication(): String? = throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_UNAVAILABLE)
    public suspend fun resumeAudio() {}
    public suspend fun close()
}

/** Host backend authorization stays outside the SDK; never supply a project/provider key. */
public interface SpeechHostCallbacks {
    public suspend fun changeSubscription(selection: SpeechSelection): SpeechSubscription
    public suspend fun renewGrant(): SpeechGrant
    public val supportsCaptionRecovery: Boolean get() = false
    /** Return the HTTP response body unchanged. Rust validates the entire page. */
    public suspend fun readCaptions(request: SpeechCaptionRequest): String =
        throw SpeechHostException(SpeechHostFailure.UNAVAILABLE)
    public val supportsSourceFinish: Boolean get() = false
    /** Resolve and finish only this publisher's exact current source; return its unchanged body. */
    public suspend fun finishSource(request: SpeechFinishRequest): String =
        throw SpeechHostException(SpeechHostFailure.UNAVAILABLE)
}

/** Observers run on the invoking SDK thread and must not block. Dispatch UI work
 * and suspend session calls to your application scope. Observer exceptions are isolated. */
public interface SpeechObserver {
    public fun stateChanged(state: SpeechState) {}
    public fun caption(caption: SpeechCaption) {}
    /** Validated protocol events, possibly containing captions. Do not log or persist them.
     * Use caption() for text UI with stable upsert identity and revision fencing. */
    public fun event(json: String) {}
    public fun error(error: SpeechSessionException) {}
}
