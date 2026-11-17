package dev.bota.sdk.speech

/** Native control boundary for one already-started direct activity. Implementations
 * own input, live transport, playback and independent optional original archival.
 * close must join all owned media; credentials and PCM stay in the native host. */
public interface RecordingSpeechConnection {
    public suspend fun changeTarget(language: String, requestId: String)
    public suspend fun qualifyHeadphones(): Boolean
    public suspend fun finish()
    public suspend fun close()
}
