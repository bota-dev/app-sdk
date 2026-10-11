package dev.bota.sdk.internal.byo

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.json.JSONObject

class ByoBLECodecTest {
    @Test fun proofComparisonIgnoresObjectOrderButPreservesExactValues() {
        val proof = JSONObject("""{"n":4294967295,"nested":{"items":[1,null,"x"]},"ok":true}""")
        assertTrue(proof.byoEquivalent(JSONObject("""{"ok":true,"nested":{"items":[1.0,null,"x"]},"n":4294967295}""")))
        assertFalse(proof.byoEquivalent(JSONObject("""{"n":4294967294,"nested":{"items":[1,null,"x"]},"ok":true}""")))
        assertFalse(JSONObject("""{"n":9007199254740992}""").byoEquivalent(JSONObject("""{"n":9007199254740993}""")))
        assertFalse(JSONObject("""{"n":1}""").byoEquivalent(JSONObject("""{"n":true}""")))
        assertFalse(JSONObject("""{"n":1}""").byoEquivalent(JSONObject("""{"n":"1"}""")))
        assertFalse(JSONObject("""{"n":null}""").byoEquivalent(JSONObject("{}")))
        assertFalse(JSONObject("""{"a":[1,2]}""").byoEquivalent(JSONObject("""{"a":[2,1]}""")))
        assertFalse(JSONObject("""{"a":[1]}""").byoEquivalent(JSONObject("""{"a":[1,2]}""")))
    }
    @Test fun identityUsesFullUuidAndLittleEndianGeneration() {
        assertArrayEquals(byteArrayOf(0,17,34,51,68,85,102,119,136.toByte(),153.toByte(),170.toByte(),187.toByte(),204.toByte(),221.toByte(),238.toByte(),255.toByte(),4,3,2,1),
            byoIdentity("00112233-4455-6677-8899-aabbccddeeff",0x01020304u))
    }
    @Test(expected=IllegalArgumentException::class) fun rejectsNonCanonicalIdentity() {
        byoIdentity("1-2-3-4-5",1u)
    }
}
