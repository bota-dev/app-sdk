package dev.bota.sdk.internal.core

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2CommandTest {
    @Test
    fun commandCarriesTheReviewedProfileCapabilitiesAndExactResumeBounds() {
        val uploadSession = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")
        val request = EncryptedUploadV2CommandRequest(
            serialNumber = "EVFXXW67KP",
            recordingUuid = "00112233445566778899aabbccddeeff",
            recordingGeneration = 7u,
            storageFormat = 3u,
            uploadSessionId = uploadSession,
            ownerRevision = 9u,
            transportSessionId = 11u,
            materialId = "material-1",
            sinkId = "11111111-2222-3333-4444-555555555555",
            securityPolicy = 3u,
            capabilities = EncryptedUploadV2CapabilitiesValue(1u, 408u, 580u, 157u, 18u, 4u, 18u),
            windowPackets = 18u,
            dataPayloadBytes = 157u,
            ciphertextLength = 4096u,
            ciphertextSha256 = ByteArray(32) { 0x5a },
        )

        val command = CoreCommand.transferEncryptedRecording(request)

        assertEquals(0x010c, command.kind)
        assertTrue(command.fields.contains(CoreField.Unsigned(166, 3u)))
        assertTrue(command.fields.contains(CoreField.Unsigned(167, 3u)))
        assertTrue(command.fields.contains(CoreField.Unsigned(128, 11u)))
        assertTrue(command.fields.contains(CoreField.Unsigned(134, 18u)))
        assertTrue(command.fields.contains(CoreField.Unsigned(135, 157u)))
        assertTrue(command.fields.contains(CoreField.Bytes(132, uploadSession.toNetworkBytes())))
        assertTrue(command.fields.contains(CoreField.Bytes(144, ByteArray(32) { 0x5a })))
    }
}
