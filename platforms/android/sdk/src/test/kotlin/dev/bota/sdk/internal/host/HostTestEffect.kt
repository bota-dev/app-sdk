package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.toNativePacket

internal fun hostEffect(
    kind: CoreEffectKind,
    vararg fields: CoreField,
    requestId: ULong = 1u,
): CoreEffect = CoreEffect.fromPacket(
    fields.toList().toNativePacket(
        kind.wireValue,
        operation = 8,
        requestId = requestId,
        cancellationId = CoreCancellationId(1u, 2u),
    ),
)

internal fun CoreHostEventPayload.unsigned(id: Int): ULong? =
    fields.filterIsInstance<CoreField.Unsigned>().firstOrNull { it.id == id }?.value

internal fun CoreHostEventPayload.bytes(id: Int): ByteArray? =
    fields.filterIsInstance<CoreField.Bytes>().firstOrNull { it.id == id }?.value

