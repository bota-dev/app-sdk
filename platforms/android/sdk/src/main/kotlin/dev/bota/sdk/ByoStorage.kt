package dev.bota.sdk

import java.io.File

/** Host-authenticated proxy; tokens are application access tokens, never Bota secret API keys. */
public data class ByoStorageOptions(
    public val baseUrl: String, public val scopeKey: String, public val organizationId: String, public val projectId: String,
    public val deviceId: String, public val environment: String, public val bindingGeneration: UInt, public val stateDirectory: File,
    public val accessToken: suspend ()->String, public val validateScope: suspend ()->Unit,
)
public data class ByoRecording(public val uuid: String, public val generation: UInt)
public data class ByoUploadResult(public val recordingId: String, public val uploadSessionId: String)

public class ByoStorageException internal constructor(
    public val code: String, public val retryable: Boolean, public val httpStatus: Int? = null,
): Exception("BOTA_BYO_" + code.uppercase()) {
    internal companion object {
        fun safe(error: Throwable): Throwable {
            if(error is kotlinx.coroutines.CancellationException || error is ByoStorageException) return error
            if(error is dev.bota.sdk.internal.byo.ByoException) {
                val code=if(error.reason=="http") "http_${error.status}" else error.reason
                return ByoStorageException(code,error.reason in setOf("pending","network","timeout","context_expired") ||
                    error.status in setOf(425,429) || error.status>=500, error.status.takeIf {it!=0})
            }
            if(error is java.io.IOException) return ByoStorageException("persistence",false)
            return ByoStorageException("protocol_violation",false)
        }
    }
}
