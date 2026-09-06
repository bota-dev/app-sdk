package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

internal fun interface EncryptedUploadV2Host {
    fun execute(effect: CoreEffect): Flow<CoreHostEventPayload>

    suspend fun confirmationAttemptedOrClaimCancellation(cancellationId: CoreCancellationId): Boolean = false

    suspend fun cancel(cancellationId: CoreCancellationId) = Unit
}

internal open class EncryptedUploadV2HostException(
    val errorCode: UInt,
    val retryable: Boolean,
    val protocolStatus: UShort? = null,
    message: String,
) : IllegalStateException(message)

internal class EncryptedUploadV2ConfirmationException(
    val writeSucceeded: Boolean,
    message: String,
    cause: Throwable,
) : EncryptedUploadV2HostException(19u, false, message = message) {
    init { addSuppressed(cause) }
}

internal class UnavailableEncryptedUploadV2Host : EncryptedUploadV2Host {
    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        throw EncryptedUploadV2HostException(
            errorCode = 7u,
            retryable = false,
            message = "encrypted upload v2 native host is not configured",
        )
    }
}
