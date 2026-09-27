package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativePacket
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class EncryptedUploadV2DemoCodecTest {
    @Test
    fun listEncoderUsesOnlyTheTwoCanonicalRustFields() {
        val requests = mutableListOf<NativePacket>()
        val mapper = CoreModelMapper(CodecCore(encode = { input ->
            requests += input
            listOf(CoreField.Bytes(30, byteArrayOf(7))).toNativePacket(input.kind)
        }))
        assertArrayEquals(byteArrayOf(7), mapper.createEncryptedUploadV2List(9u))
        val input = requests.single()
        assertEquals(0x0524, input.kind)
        assertArrayEquals(intArrayOf(127, 128), input.fieldIds)
        assertArrayEquals(longArrayOf(0x25, 9), input.unsignedValues)
    }

    @Test
    fun catalogMapsTypedMetadataOnlyAfterRustCompletesDigestValidation() {
        var calls = 0
        val mapper = CoreModelMapper(CodecCore(decode = { input ->
            assertEquals(0x0527, input.kind)
            if (++calls == 1) emptyList<CoreField>().toNativePacket(input.kind) else catalogFields().toNativePacket(input.kind)
        }))
        assertNull(mapper.consumeEncryptedUploadV2Catalog(9u, byteArrayOf(1)))
        val recording = mapper.consumeEncryptedUploadV2Catalog(9u, byteArrayOf(2))!!.single()
        assertEquals("00112233-4455-6677-8899-aabbccddeeff", recording.uuid)
        assertEquals(3u, recording.generation)
        assertEquals(1_700_000_000_000uL, recording.startedAtMs)
        assertEquals(3_000uL, recording.durationMs)
        assertEquals(1_024uL, recording.plaintextLength)
        assertEquals(2_048uL, recording.ciphertextLength)
        assertEquals(3.toUByte(), recording.storageFormat)
        assertArrayEquals(ByteArray(32) { 8 }, recording.ciphertextSha256)
    }

    @Test
    fun timestampOverflowAndInconsistentCatalogGroupsReject() {
        for (fields in listOf(catalogFields(timestamp = ULong.MAX_VALUE), catalogFields().dropLast(1))) {
            val mapper = CoreModelMapper(CodecCore(decode = { fields.toNativePacket(it.kind) }))
            assertThrows(Throwable::class.java) { mapper.consumeEncryptedUploadV2Catalog(9u, byteArrayOf(1)) }
        }
    }

    @Test
    fun contextCodecUsesDistinctAttemptAndSnapshotPayloadFields() {
        val mapper = CoreModelMapper(CodecCore(
            encode = { input ->
                assertEquals(0x0528, input.kind)
                assertArrayEquals(intArrayOf(199), input.fieldIds)
                assertEquals(7L, input.unsignedValues.single())
                listOf(CoreField.Bytes(30, byteArrayOf(1))).toNativePacket(input.kind)
            },
            decode = { input ->
                assertEquals(0x0529, input.kind)
                listOf(CoreField.Unsigned(199, 7u), CoreField.Unsigned(200, 1u), CoreField.Unsigned(24, 0u),
                    CoreField.Bytes(33, ByteArray(16) { 4 })).toNativePacket(input.kind)
            },
        ))
        assertArrayEquals(byteArrayOf(1), mapper.createEncryptedUploadV2ContextBegin(7u))
        val snapshot = mapper.decodeEncryptedUploadV2ContextSnapshot(byteArrayOf(9))
        assertEquals(7u, snapshot.attemptId)
        assertEquals(1.toUByte(), snapshot.state)
        assertArrayEquals(ByteArray(16) { 4 }, snapshot.payload)
    }

    private fun catalogFields(timestamp: ULong = 1_700_000_000u): List<CoreField> = listOf(
        CoreField.Unsigned(128, 9u), CoreField.Unsigned(85, 1u), CoreField.Unsigned(148, 3u), CoreField.Bytes(123, ByteArray(32)),
        CoreField.Text(13, "00112233-4455-6677-8899-aabbccddeeff"), CoreField.Unsigned(129, 3u),
        CoreField.Unsigned(147, 3u), CoreField.Unsigned(146, 1u), CoreField.Unsigned(68, timestamp),
        CoreField.Unsigned(149, 3u), CoreField.Unsigned(131, 1_024u), CoreField.Unsigned(130, 2_048u),
        CoreField.Bytes(144, ByteArray(32) { 8 }),
    )
}

internal class CodecCore(
    private val decode: (NativePacket) -> NativePacket = { error("unused") },
    private val encode: (NativePacket) -> NativePacket = { error("unused") },
) : NativeCore {
    override fun decode(packet: NativePacket): NativePacket = decode.invoke(packet)
    override fun encode(packet: NativePacket): NativePacket = encode.invoke(packet)
    override fun start(command: NativePacket, capabilityBits: ULong) = error("unused")
    override fun poll(): NativePacket? = error("unused")
    override fun dispatch(event: NativePacket) = error("unused")
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) = error("unused")
    override fun close() = Unit
}
