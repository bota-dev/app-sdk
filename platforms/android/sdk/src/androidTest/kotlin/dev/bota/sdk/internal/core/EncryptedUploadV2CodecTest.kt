package dev.bota.sdk.internal.core

import java.security.MessageDigest
import java.util.UUID
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

internal class EncryptedUploadV2CodecTest {
    @Test
    fun everyCapabilitySelectionReadsAndHashesFresh0406Bytes() = runBlocking {
        val first = "010218007f00000000040004f40010000800000010000000".hexBytes()
        val second = "010218007f00000000040004c80008000400000002000000".hexBytes()
        val values = ArrayDeque(listOf(first, second))
        val reads = mutableListOf<Triple<String, UUID, UUID>>()
        CoreModelMapper().use { mapper ->
            val reader = EncryptedUploadV2CapabilityReader(
                read = { peripheralId, service, characteristic ->
                    reads += Triple(peripheralId, service, characteristic)
                    values.removeFirst()
                },
                decode = mapper::decodeEncryptedUploadV2Capabilities,
            )

            val firstSnapshot = reader.readFresh("peripheral-1")
            val secondSnapshot = reader.readFresh("peripheral-1")

            assertArrayEquals(first, firstSnapshot.rawValue)
            assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(first), firstSnapshot.sha256)
            assertEquals(0x7fu, firstSnapshot.capabilities.flags)
            assertEquals(1_024u.toUShort(), firstSnapshot.capabilities.maximumSignedBlobBytes)
            assertEquals(244u.toUShort(), firstSnapshot.capabilities.maximumDataPayloadBytes)
            assertEquals(16u.toUShort(), firstSnapshot.capabilities.maximumWindowPackets)
            assertEquals(8u, firstSnapshot.capabilities.durableCheckpointIntervalBlocks)
            assertArrayEquals(second, secondSnapshot.rawValue)
            assertEquals(200u.toUShort(), secondSnapshot.capabilities.maximumDataPayloadBytes)
            assertEquals(8u.toUShort(), secondSnapshot.capabilities.maximumWindowPackets)
            assertEquals(2u.toUShort(), secondSnapshot.capabilities.maximumMissingSequences)
        }
        assertEquals(
            listOf(
                Triple("peripheral-1", BotaBluetoothUUIDs.StorageService, BotaBluetoothUUIDs.TransferCapabilitiesV2),
                Triple("peripheral-1", BotaBluetoothUUIDs.StorageService, BotaBluetoothUUIDs.TransferCapabilitiesV2),
            ),
            reads,
        )
    }

    @Test
    fun canonicalTransferFramesAreEncodedAndDecodedOnlyByRust() {
        val prefix = "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77".hexBytes()
        CoreModelMapper().use { mapper ->
            assertEquals(
                "210200006655443322110000020000000c0000003000000000000000" +
                    "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77" +
                    "03000000020000000d0000000f000000",
                mapper.createEncryptedUploadV2WindowAcknowledgement(
                    0x0000_1122_3344_5566u,
                    2u,
                    12u,
                    48u,
                    prefix,
                    3u,
                    listOf(13u, 15u),
                ).toHex(),
            )
            assertEquals(
                "230200006655443322110000101112131415161718191a1b1c1d1e1f" +
                    "00112233445566778899aabbccddeeff0900000003000000" +
                    "f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc",
                mapper.createEncryptedUploadV2Confirm(
                    0x0000_1122_3344_5566u,
                    UUID.fromString("10111213-1415-1617-1819-1a1b1c1d1e1f"),
                    "00112233-4455-6677-8899-aabbccddeeff",
                    9u,
                    3u,
                    "f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc".hexBytes(),
                ).toHex(),
            )
            val value = mapper.decodeEncryptedUploadV2TransferPayload(
                (
                    "41020000665544332211000001000000000000000000000020000000" +
                        "424f5441454e4332020080000100000001000100070000000010000000112233"
                    ).hexBytes(),
            ) as EncryptedUploadV2TransferPayload.Data
            assertEquals(1u, value.value.sequence)
            assertEquals(0u, value.value.ciphertextOffset)
            assertEquals(32, value.value.bytes.size)
        }
    }

    @Test
    fun invalidAuthenticatedFrameInputsAreRejectedBeforeEncoding() {
        CoreModelMapper().use { mapper ->
            assertThrows(Throwable::class.java) {
                mapper.createEncryptedUploadV2Confirm(
                    1u,
                    UUID.randomUUID(),
                    "00112233-4455-6677-8899-aabbccddeeff",
                    1u,
                    1u,
                    ByteArray(31),
                )
            }
        }
    }
}

private fun String.hexBytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }
