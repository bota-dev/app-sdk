package dev.bota.sdk.reactnative

import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2ProviderContext
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Holds v2 application material in native memory and exposes only opaque IDs to JavaScript. */
public object BotaDeviceSDKEncryptedUploadV2Materials {
    private val materials = ConcurrentHashMap<String, EncryptedUploadV2Material>()
    private data class Context(val lease: UUID, val value: EncryptedUploadV2ProviderContext)
    private val contexts = ConcurrentHashMap<String, Context>()

    public suspend fun readAuthNonce(operationId: String): ByteArray {
        val context = contexts[operationId]
            ?: error("encrypted upload v2 provider context is unavailable")
        val nonce = context.value.readAuthNonce()
        check(contexts[operationId]?.lease == context.lease) {
            "encrypted upload v2 provider context is unavailable"
        }
        return nonce.copyOf()
    }

    public suspend fun release(registrationId: String) {
        materials.remove(registrationId)?.cancelPreparation()
    }

    internal fun registerContext(operationId: String, context: EncryptedUploadV2ProviderContext) {
        check(contexts.putIfAbsent(operationId, Context(UUID.randomUUID(), context)) == null) {
            "encrypted upload v2 provider context is already active"
        }
    }

    internal fun removeContext(operationId: String) {
        contexts.remove(operationId)
    }

    public fun register(material: EncryptedUploadV2Material): String =
        UUID.randomUUID().toString().also { materials[it] = material }

    public fun remove(registrationId: String): EncryptedUploadV2Material? =
        materials.remove(registrationId)

    internal fun consume(
        registrationId: String,
        recording: EncryptedUploadV2Recording,
        uploadSessionId: UUID,
        ownerRevision: UInt,
        securityPolicy: String,
    ): EncryptedUploadV2Material {
        val material = materials[registrationId]
            ?: error("encrypted upload v2 material registration is unavailable")
        require(
            material.recordingId == recording.uuid &&
                material.uploadSessionId == uploadSessionId &&
                material.ownerRevision == ownerRevision &&
                material.policy == securityPolicy.toNativePolicy(),
        ) { "encrypted upload v2 material does not match the selected profile" }
        check(materials.remove(registrationId, material)) {
            "encrypted upload v2 material registration is unavailable"
        }
        return material
    }
}

private fun String.toNativePolicy(): EncryptedUploadV2SecurityPolicy = when (this) {
    "legacy_allowed" -> EncryptedUploadV2SecurityPolicy.LegacyAllowed
    "v2_preferred" -> EncryptedUploadV2SecurityPolicy.V2Preferred
    "v2_required" -> EncryptedUploadV2SecurityPolicy.V2Required
    else -> error("encrypted upload v2 security policy is unsupported")
}
