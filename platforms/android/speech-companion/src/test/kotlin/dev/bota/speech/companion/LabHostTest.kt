package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

internal fun joinFixture(retention: String = "text_only"): String {
    val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .first { File(it, "protocol/speech-session/client-v1.json").isFile }
    val fixture = JSONObject(File(root, "protocol/speech-session/client-v1.json").readText())
    val configuration = fixture.getJSONObject("configuration")
    configuration.getJSONObject("context").put("retention", retention)
    val sources = configuration.getJSONObject("subscription").getJSONArray("sourceParticipantIds")
    sources.remove(1)
    fixture.getJSONObject("grant").put("expires_at", Instant.now().plusSeconds(60).toString())
    return JSONObject().put("role", "a").put("peer", JSONObject().put("role", "b").put("participantId", sources.getString(0)))
        .put("allowedLanguages", org.json.JSONArray(listOf("en", "zh", "ja")))
        .put("configuration", configuration).put("grant", fixture.getJSONObject("grant")).toString()
}

internal class FixtureTransport : LabTransport {
    val requests = mutableListOf<LabRequest>()
    var handler: suspend (LabRequest) -> LabResponse = { LabResponse(200, joinFixture()) }
    var closed = false
    override suspend fun send(request: LabRequest): LabResponse { requests += request; return handler(request) }
    override fun close() { closed = true }
}

@OptIn(ExperimentalCoroutinesApi::class)
class LabHostTest {
    private val code = "a".repeat(40)
    @Test fun fixedRoleJoinKeepsProjectKeysOutsideApp() = runTest {
        val transport = FixtureTransport()
        val host = LabHost("http://127.0.0.1:4173", "a", code, transport)
        val join = host.join()
        assertEquals(SpeechRetention.TEXT_ONLY, join.configuration.context.retention)
        assertEquals("b", join.peerRole)
        assertEquals("http://127.0.0.1:4173/speech-host/join", transport.requests.single().url)
        assertEquals("{}", transport.requests.single().body)
        assertEquals(setOf("Origin", "X-Speech-Role", "X-Speech-Code", "Content-Type"), transport.requests.single().headers.keys)
        host.close()
        assertTrue(runCatching { host.renewGrant() }.isFailure)
        assertEquals(1, transport.requests.size)
    }
    @Test fun foreignHostsAndUnsupportedRetentionFailBeforeMedia() = runTest {
        for (origin in listOf("https://remote.invalid", "http://localhost:4173", "http://127.0.0.1:4173/path", "http://user@127.0.0.1")) {
            assertTrue(runCatching { LabHost(origin, "a", code, FixtureTransport()) }.isFailure)
        }
        val transport = FixtureTransport().apply { handler = { LabResponse(200, joinFixture("original_audio_and_text")) } }
        val host = LabHost("http://127.0.0.1:4173", "a", code, transport)
        assertTrue(runCatching { host.join() }.isFailure)
        host.close()
    }
    @Test fun concurrentAndRetiredBootstrapCannotCreateAnotherOwner() = runTest {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val transport = FixtureTransport().apply { handler = { entered.complete(Unit); release.await(); LabResponse(200, joinFixture()) } }
        val host = LabHost("http://127.0.0.1:4173", "a", code, transport)
        val pending = async { runCatching { host.join() } }
        entered.await()
        assertTrue(runCatching { host.join() }.isFailure)
        host.close(); release.complete(Unit); runCurrent()
        assertTrue(pending.await().isFailure)
        assertEquals(1, transport.requests.size)
    }
    @Test fun finishCarriesExplicitUnknownBoundariesAndPendingResponse() = runTest {
        val transport = FixtureTransport()
        val host = LabHost("http://127.0.0.1:4173", "a", code, transport)
        val join = host.join(); val context = join.configuration.context
        transport.handler = { LabResponse(202, "{\"source\":null}") }
        assertEquals("{\"source\":null}", host.finishSource(SpeechFinishRequest(1, context.projectId, context.sessionId,
            context.participantId, context.memberGeneration, join.grant.workerGeneration, "TR_input", null, null)))
        val sent = JSONObject(transport.requests.last().body)
        assertTrue(sent.has("sourceId") && sent.isNull("sourceId"))
        assertTrue(sent.has("sourceEpoch") && sent.isNull("sourceEpoch"))
        host.close()
    }
    @Test fun deniedAndOversizedResponsesAreBoundedAndNotRetried() = runTest {
        for (response in listOf(LabResponse(403, "private provider error"), LabResponse(200, "x".repeat(524_289)))) {
            val transport = FixtureTransport().apply { handler = { response } }
            val host = LabHost("http://127.0.0.1:4173", "a", code, transport)
            val error = runCatching { host.join() }.exceptionOrNull()
            assertTrue(error is SpeechHostException)
            assertEquals(if (response.status == 403) SpeechHostFailure.UNAUTHORIZED else SpeechHostFailure.UNAVAILABLE,
                (error as SpeechHostException).reason)
            assertEquals(1, transport.requests.size)
            host.close()
        }
    }
}
