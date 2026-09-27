package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2Checkpoint
import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import dev.bota.sdk.internal.core.EncryptedUploadV2AuthorizationIdentity

internal fun validateEncryptedUploadV2Material(
    material: EncryptedUploadV2Material,
    recording: EncryptedUploadV2Recording,
    checkpoint: EncryptedUploadV2Checkpoint?,
    auth: EncryptedUploadV2AuthorizationIdentity,
): Boolean {
    val policy = when (material.policy) {
        EncryptedUploadV2SecurityPolicy.LegacyAllowed -> 0.toUByte()
        EncryptedUploadV2SecurityPolicy.V2Preferred -> 1.toUByte()
        EncryptedUploadV2SecurityPolicy.V2Required -> 2.toUByte()
    }
    fun invalid(): Nothing = throw EncryptedUploadV2MaterialRegistryException("encrypted upload material identity mismatch", 18u)
    if (material.ownerRevision == 0u || material.ownerRevision > Int.MAX_VALUE.toUInt() ||
        auth.ownerRevision != material.ownerRevision || auth.profile != 3.toUByte() ||
        recording.storageFormat != 3.toUByte() || auth.storageFormat != recording.storageFormat ||
        auth.policy != policy || auth.channels.toInt() and 1 == 0 || auth.flags and 0xfffffff0u != 0u || auth.flags and 1u == 0u ||
        auth.uploadSessionId != material.uploadSessionId ||
        auth.recordingUuid.replace("-", "").lowercase() != recording.uuid.replace("-", "").lowercase() ||
        auth.recordingGeneration != recording.generation || auth.minimumCiphertextLength != recording.ciphertextLength ||
        auth.maximumCiphertextLength != recording.ciphertextLength || !auth.ciphertextSha256.contentEquals(recording.ciphertextSha256)
    ) invalid()
    if (checkpoint == null) return false
    val changed = checkpoint.uploadSessionId != material.uploadSessionId || checkpoint.ownerRevision != material.ownerRevision
    val hasCiphertext = checkpoint.ciphertextLength != null && checkpoint.ciphertextSha256 != null
    if (hasCiphertext && (checkpoint.ciphertextLength != recording.ciphertextLength ||
            !checkpoint.ciphertextSha256.contentEquals(recording.ciphertextSha256))) invalid()
    if (changed && (!hasCiphertext || auth.flags and 8u == 0u ||
            checkpoint.ownerRevision >= material.ownerRevision || checkpoint.uploadSessionId == material.uploadSessionId)) invalid()
    return changed
}
