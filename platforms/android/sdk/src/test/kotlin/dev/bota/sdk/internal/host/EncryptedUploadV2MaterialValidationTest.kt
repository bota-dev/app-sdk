package dev.bota.sdk.internal.host

import dev.bota.sdk.*
import dev.bota.sdk.internal.core.EncryptedUploadV2AuthorizationIdentity
import java.util.UUID
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2MaterialValidationTest {
    private val session = UUID.fromString("10111213-1415-1617-1819-1a1b1c1d1e1f")
    private val oldSession = UUID.fromString("20212223-2425-2627-2829-2a2b2c2d2e2f")
    private val recording = EncryptedUploadV2Recording("00112233-4455-6677-8899-aabbccddeeff", 3u, 2_048u, ByteArray(32) { 1 })
    private val auth = EncryptedUploadV2AuthorizationIdentity(
        3u, 3u, 2u, 1u, 9u, 2u, 3u, 2_048u, 2_048u, session, recording.uuid, recording.ciphertextSha256,
    )
    private fun material() = EncryptedUploadV2Material("m", "r", session, 2u,
        EncryptedUploadV2SecurityPolicy.V2Required, ByteArray(408),
        { error("unused") }, { _, _ -> }, {}, { ByteArray(336) })
    private fun checkpoint(id: UUID = oldSession, owner: UInt = 1u, identity: Boolean = true) = EncryptedUploadV2Checkpoint(
        id, owner, 1u, 512u, ByteArray(32), 0u, 9u, UUID.randomUUID().toString(), 1u, 128u,
        ciphertextLength = if (identity) recording.ciphertextLength else null,
        ciphertextSha256 = if (identity) recording.ciphertextSha256 else null,
        checkpointIntervalBlocks = if (identity) 1u else null,
    )

    @Test
    fun onlySignedHigherOwnerWithFullIdentityMayReplaceCheckpoint() {
        assertTrue(validateEncryptedUploadV2Material(material(), recording, checkpoint(), auth))
        assertThrows(EncryptedUploadV2MaterialRegistryException::class.java) {
            validateEncryptedUploadV2Material(material(), recording, checkpoint(), auth.copy(flags = 1u))
        }
        for (checkpoint in listOf(checkpoint(owner = 2u), checkpoint(id = session), checkpoint(identity = false))) {
            assertThrows(EncryptedUploadV2MaterialRegistryException::class.java) {
                validateEncryptedUploadV2Material(material(), recording, checkpoint, auth)
            }
        }
    }

    @Test
    fun historicalCheckpointCanStillResumeOnlyExactOwner() {
        assertFalse(validateEncryptedUploadV2Material(material(), recording,
            checkpoint(id = session, owner = 2u, identity = false), auth.copy(flags = 1u)))
    }

    @Test
    fun signedIdentityCannotBeOverriddenByProviderMetadata() {
        for (bad in listOf(
            auth.copy(policy = 1u), auth.copy(profile = 2u), auth.copy(storageFormat = 2u),
            auth.copy(channels = 2u), auth.copy(flags = 8u), auth.copy(flags = 17u),
            auth.copy(ownerRevision = 3u), auth.copy(recordingGeneration = 4u),
            auth.copy(uploadSessionId = oldSession), auth.copy(recordingUuid = oldSession.toString()),
            auth.copy(minimumCiphertextLength = 1u), auth.copy(maximumCiphertextLength = 4096u),
            auth.copy(ciphertextSha256 = ByteArray(32)),
        )) assertThrows(EncryptedUploadV2MaterialRegistryException::class.java) {
            validateEncryptedUploadV2Material(material(), recording, null, bad)
        }
    }
}
