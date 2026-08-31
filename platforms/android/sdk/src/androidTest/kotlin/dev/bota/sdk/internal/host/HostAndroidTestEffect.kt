package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.toNativePacket
import java.io.File
import org.junit.Assert.assertFalse

internal fun androidHostEffect(kind: CoreEffectKind, vararg fields: CoreField): CoreEffect =
    CoreEffect.fromPacket(
        fields.toList().toNativePacket(
            kind.wireValue,
            operation = 8,
            requestId = 1u,
            cancellationId = CoreCancellationId(1u, 2u),
        ),
    )

internal fun CoreHostEventPayload.androidBytes(id: Int): ByteArray? =
    fields.filterIsInstance<CoreField.Bytes>().firstOrNull { it.id == id }?.value

internal fun assertNoPersistedCredentialMaterial(root: File) {
    val disk = root.walkTopDown()
        .filter(File::isFile)
        .flatMap { it.readBytes().asIterable() }
        .toList()
        .toByteArray()
        .decodeToString()
    listOf("https://", "Authorization:", "dtok_", "sk_live_", "sk_test_", "/storage/").forEach {
        assertFalse(it, disk.contains(it))
    }
}
