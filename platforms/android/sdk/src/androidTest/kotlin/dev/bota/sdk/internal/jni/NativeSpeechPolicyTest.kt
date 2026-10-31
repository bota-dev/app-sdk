package dev.bota.sdk.internal.jni

import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.Executors
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

internal class NativeSpeechPolicyTest {
    private val now = 1_793_491_200_000L

    private fun policy(retention: String = "live_only"): NativeSpeechPolicy {
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets
            .open("SpeechFixtures/client-v1.json").bufferedReader().use { JSONObject(it.readText()) }
        fixture.getJSONObject("configuration").getJSONObject("context").put("retention", retention)
        return NativeSpeechPolicy(fixture.getJSONObject("configuration").toString().toByteArray(),
            fixture.getJSONObject("grant").toString().toByteArray(), now)
    }

    private fun step(policy: NativeSpeechPolicy, command: String): JSONObject =
        JSONObject(policy.step(command.toByteArray(Charsets.UTF_8), now).toString(Charsets.UTF_8))

    @Test
    fun nativePolicyKeepsCaptureIndependentAndClosesTerminally() {
        policy().use { client ->
            assertEquals(true, step(client, """{"type":"connected"}""").getBoolean("connected"))
            assertEquals(true, step(client, """{"type":"set_microphone","enabled":true}""").getBoolean("canCapture"))
            val changing = step(client, """{"type":"begin_change"}""")
            assertEquals(true, changing.getBoolean("canCapture"))
            assertFalse(changing.getBoolean("canPlay"))
            client.close()
            client.close()
            assertThrows(IllegalStateException::class.java) { step(client, """{"type":"tick"}""") }
        }
        policy().use { client -> assertEquals(true, step(client, """{"type":"connected"}""").getBoolean("connected")) }
    }

    @Test
    fun malformedUtf8AndNegativeClockRetireTheNativeOwner() {
        policy().use { client ->
            assertEquals(1, assertThrows(NativeCoreException::class.java) { client.step(byteArrayOf(-1), now) }.code)
            assertThrows(IllegalStateException::class.java) { step(client, """{"type":"tick"}""") }
        }
        policy().use { client ->
            assertThrows(NativeCoreException::class.java) { client.step("""{"type":"tick"}""".toByteArray(), -1) }
            assertThrows(IllegalStateException::class.java) { step(client, """{"type":"tick"}""") }
        }
        val error = assertThrows(NativeCoreException::class.java) {
            NativeSpeechPolicy("{}".toByteArray(), "PRIVATE_TOKEN_CANARY".toByteArray(), now)
        }
        assertFalse(error.toString().contains("PRIVATE_TOKEN_CANARY"))
    }

    @Test
    fun concurrentCloseAndStepDoNotUseAFreedHandle() {
        policy().use { client ->
            val executor = Executors.newFixedThreadPool(4)
            try {
                val tasks = (0 until 64).map { index -> executor.submit {
                    if (index % 3 == 0) client.close()
                    else try { step(client, """{"type":"tick"}""") } catch (_: IllegalStateException) { }
                } }
                tasks.forEach { it.get() }
                assertThrows(IllegalStateException::class.java) { step(client, """{"type":"connected"}""") }
            } finally { executor.shutdownNow() }
        }
    }

    @Test
    fun captionUtf8PreservesEmojiAndEmbeddedZeroAcrossJni() {
        policy("text_only").use { client ->
            step(client, """{"type":"enable_caption_recovery"}""")
            val request = step(client, """{"type":"connected"}""").getJSONObject("recovery").getJSONObject("request")
            val source = "44444444-4444-4444-8444-444444444444"
            val text = "你好、こんにちは 🌍\u0000"
            val record = JSONObject().put("protocolVersion", 1).put("projectId", "prj_synthetic")
                .put("sessionId", request.getString("sessionId")).put("retention", "text_only")
                .put("sourceId", source).put("sourceEpoch", 1)
                .put("sourceParticipantId", "33333333-3333-4333-8333-333333333333").put("sourceMemberGeneration", 1)
                .put("unitId", "$source:1:1:1").put("sourceFirstSeq", 1).put("sourceLastSeq", 1)
                .put("startMs", 0).put("endMs", 100).put("sourceLanguage", "en").put("text", text)
            val page = JSONObject().put("protocol_version", 1).put("session_id", request.getString("sessionId"))
                .put("participant_id", request.getString("participantId")).put("member_generation", request.getInt("memberGeneration"))
                .put("subscription_revision", request.getInt("subscriptionRevision")).put("history", "retained")
                .put("records", JSONArray().put(JSONObject().put("sequence", "1").put("record", record)))
                .put("has_more", false).put("next_cursor", "cursor_1")
            val command = JSONObject().put("type", "caption_page").put("requestId", request.getInt("requestId")).put("page", page)
            val result = step(client, command.toString())
            assertEquals(text, result.getJSONArray("captions").getJSONObject(0).getJSONObject("record").getString("text"))
        }
    }
}
