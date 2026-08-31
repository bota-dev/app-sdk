package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import kotlinx.coroutines.flow.Flow

internal data class CoreHostEventPayload(
    val kind: HostEventKind,
    val fields: List<CoreField> = emptyList(),
)

internal open class NativeHostException(
    val platformCode: Int,
    message: String,
    val httpStatus: Int? = null,
) : IllegalStateException(message)

internal fun interface CoreHostPort {
    fun execute(effect: CoreEffect): Flow<CoreHostEventPayload>
}
