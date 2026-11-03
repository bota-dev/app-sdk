package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import kotlinx.coroutines.*
import java.util.concurrent.Executors
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

internal class ModelMedia : SpeechMediaPort {
    var capture = false
    var closed = false
    var closeFails = false
    override suspend fun connect(grant: SpeechGrant) {}
    override fun silencePlayback() {}
    override fun muteInput() { capture = false }
    override suspend fun clearPlayback() {}
    override suspend fun setPlayback(tracks: List<SpeechTrack>) {}
    override suspend fun setInput(enabled: Boolean) { capture = enabled }
    override val supportsSourceFinish = true
    override fun holdInput() { capture = false }
    override fun inputPublication() = "TR_input"
    override suspend fun close() { capture = false; closed = true; check(!closeFails) }
}

internal fun modelTransport() = FixtureTransport().apply {
    handler = { request ->
        if (request.url.endsWith("/captions")) {
            val join = JSONObject(joinFixture()); val grant = join.getJSONObject("grant")
            LabResponse(200, JSONObject().put("protocol_version", 1).put("session_id", grant.getString("session_id"))
                .put("participant_id", grant.getString("participant_id")).put("member_generation", grant.getInt("member_generation"))
                .put("subscription_revision", JSONObject(request.body).getInt("subscriptionRevision")).put("history", "retained")
                .put("records", org.json.JSONArray()).put("has_more", false).put("next_cursor", "cursor_0").toString())
        } else LabResponse(200, joinFixture())
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [26])
class CompanionModelTest {
    // Native operations use real dispatchers. A virtual caller clock would time
    // out while its real IO task is still being scheduled.
    private fun uiTest(action: suspend CoroutineScope.(CoroutineDispatcher) -> Unit): Unit = runBlocking {
        Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { dispatcher ->
            withTimeout(15_000) { action(dispatcher) }
        }
    }

    @Test fun realPolicyJoinsSilentAndKeepsCaptureIndependentFromListening() = uiTest { ui ->
        val media = ModelMedia(); val transport = modelTransport()
        val model = CompanionModel({ media }, { true }, { transport }, ui)
        model.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        assertTrue(model.state.value.connected)
        assertFalse(media.capture)
        model.setInput(true); assertTrue(media.capture)
        model.setListening(true); assertTrue(media.capture); assertTrue(model.state.value.listening)
        model.setListening(false); assertTrue(media.capture); assertFalse(model.state.value.listening)
        model.leave()
        assertFalse(model.state.value.connected); assertTrue(media.closed)
        assertTrue(model.state.value.pairs.isEmpty()); assertTrue(transport.closed)
        model.dispose()
    }
    @Test fun permissionDenialAndRetiredApprovalCannotCapture() = uiTest { ui ->
        var media = ModelMedia(); var granted = false
        val model = CompanionModel({ media }, { granted }, { modelTransport() }, ui)
        model.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        val oldOwner = model.owner
        model.setInput(true)
        assertFalse(media.capture); assertTrue(model.state.value.notice.contains("permission"))
        model.leave()
        media = ModelMedia(); granted = true
        model.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        model.setInput(true, oldOwner)
        assertFalse(media.capture)
        model.setInput(true); assertTrue(media.capture); model.dispose()
    }
    @Test fun leaveJoinsBootstrapAndFailedCleanupPreventsReentry() = uiTest { ui ->
        val entered = CompletableDeferred<Unit>(); val released = CompletableDeferred<Unit>()
        val transport = FixtureTransport().apply { handler = { entered.complete(Unit); released.await(); LabResponse(200, joinFixture()) } }
        val model = CompanionModel({ error("Retired bootstrap created media") }, { true }, { transport }, ui)
        val joining = async { model.join("http://127.0.0.1:4173", "a", "a".repeat(40)) }
        entered.await(); model.leave(); released.complete(Unit); joining.await(); withContext(ui) {}
        assertFalse(model.state.value.connected); assertFalse(model.state.value.joining); model.dispose()

        val media = ModelMedia().apply { closeFails = true }; val readyTransport = modelTransport()
        val failing = CompanionModel({ media }, { true }, { readyTransport }, ui)
        failing.join("http://127.0.0.1:4173", "a", "a".repeat(40)); failing.leave()
        assertTrue(failing.state.value.cleanupFailed)
        val count = readyTransport.requests.size
        failing.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        assertEquals(count, readyTransport.requests.size); failing.dispose()
    }
    @Test fun sourceFinishKeepsTheCurrentListenerAlive() = uiTest { ui ->
        val media = ModelMedia(); val transport = modelTransport()
        val normal = transport.handler
        transport.handler = { request ->
            if (request.url.endsWith("/finish")) {
                val grant = JSONObject(joinFixture()).getJSONObject("grant")
                LabResponse(202, JSONObject().put("source", JSONObject().put("id", "44444444-4444-4444-8444-444444444444")
                    .put("epoch", 1).put("participant_id", grant.getString("participant_id")).put("member_generation", grant.getInt("member_generation"))
                    .put("track_sid", "TR_input").put("state", "ended").put("finish", JSONObject().put("state", "completed")
                        .put("worker_generation", grant.getInt("worker_generation")).put("sequence", "2").put("samples", "3200"))).toString())
            } else normal(request)
        }
        val model = CompanionModel({ media }, { true }, { transport }, ui)
        model.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        model.setInput(true); model.setListening(true); model.finish(); withContext(ui) {}
        assertTrue(model.state.value.connected); assertTrue(model.state.value.listening)
        assertFalse(model.state.value.input); assertFalse(media.capture)
        assertEquals("Input finished. Listening remains available.", model.state.value.notice)
        model.dispose()
    }
    @Test fun actualPolicyPairsCaptionsAndRetiresQueuedOldLanguage() = uiTest { ui ->
        val media = ModelMedia(); val transport = modelTransport(); var callbacks: SpeechMediaCallbacks? = null
        val normal = transport.handler
        val join = JSONObject(joinFixture()); val config = join.getJSONObject("configuration")
        val context = config.getJSONObject("context"); val grant = join.getJSONObject("grant"); val peer = join.getJSONObject("peer").getString("participantId")
        transport.handler = { request ->
            if (request.url.endsWith("/subscription")) LabResponse(200, JSONObject().put("revision", 2).put("targetLanguage", "ja")
                .put("mode", "translated").put("sourceParticipantIds", org.json.JSONArray(listOf(peer))).toString()) else normal(request)
        }
        val model = CompanionModel({ callbacks = it; media }, { true }, { transport }, ui)
        model.join("http://127.0.0.1:4173", "a", "a".repeat(40))
        fun emit(fields: JSONObject) {
            val common = JSONObject().put("protocolVersion", 1).put("projectId", context.getString("projectId"))
                .put("sessionId", grant.getString("session_id")).put("retention", "text_only")
                .put("participantId", grant.getString("participant_id")).put("memberGeneration", grant.getInt("member_generation"))
                .put("workerGeneration", grant.getInt("worker_generation")).put("subscriptionRevision", 1)
            fields.keys().forEach { common.put(it, fields.get(it)) }
            callbacks!!.text(grant.getString("processor_identity"), common.toString())
        }
        emit(JSONObject().put("type", "subscription_applied").put("targetLanguage", "zh").put("mode", "translated"))
        val source = "44444444-4444-4444-8444-444444444444"
        val record = JSONObject().put("protocolVersion", 1).put("projectId", context.getString("projectId"))
            .put("sessionId", grant.getString("session_id")).put("retention", "text_only").put("sourceId", source)
            .put("sourceEpoch", 1).put("sourceParticipantId", peer).put("sourceMemberGeneration", 1)
            .put("unitId", "$source:1:1:1").put("sourceFirstSeq", 1).put("sourceLastSeq", 1)
            .put("startMs", 0).put("endMs", 100).put("sourceLanguage", "en").put("text", "Hello")
        fun caption(sequence: Int) = emit(JSONObject().put("type", "caption").put("eventSequence", sequence).put("sourceId", source)
            .put("sourceEpoch", 1).put("sourceParticipantId", peer).put("sourceMemberGeneration", 1).put("final", true).put("record", record))
        caption(1); record.put("targetLanguage", "zh").put("text", "Translated"); caption(2); withContext(ui) {}
        assertEquals("Hello", model.state.value.pairs.single().original)
        assertEquals("Translated", model.state.value.pairs.single().translation)
        record.remove("targetLanguage"); record.put("text", "Late old language").put("unitId", "$source:1:2:2").put("sourceFirstSeq", 2).put("sourceLastSeq", 2)
        caption(3)
        model.select("ja", SpeechListeningMode.TRANSLATED); withContext(ui) {}
        assertTrue(model.state.value.connected); assertEquals("ja", model.state.value.language)
        assertTrue(model.state.value.pairs.isEmpty()); model.dispose()
    }
}
