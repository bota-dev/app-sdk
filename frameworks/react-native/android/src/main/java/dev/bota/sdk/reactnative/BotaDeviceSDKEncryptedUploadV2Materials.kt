package dev.bota.sdk.reactnative

import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Holds v2 application material in native memory and exposes only opaque IDs to JavaScript. */
public object BotaDeviceSDKEncryptedUploadV2Materials {
    private val materials = ConcurrentHashMap<String, EncryptedUploadV2Material>()

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
