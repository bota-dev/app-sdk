package dev.bota.sdk.internal.byo

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class ByoBLECodecTest {
    @Test fun identityUsesFullUuidAndLittleEndianGeneration() {
        assertArrayEquals(byteArrayOf(0,17,34,51,68,85,102,119,136.toByte(),153.toByte(),170.toByte(),187.toByte(),204.toByte(),221.toByte(),238.toByte(),255.toByte(),4,3,2,1),
            byoIdentity("00112233-4455-6677-8899-aabbccddeeff",0x01020304u))
    }
    @Test(expected=IllegalArgumentException::class) fun rejectsNonCanonicalIdentity() {
        byoIdentity("1-2-3-4-5",1u)
    }
}
