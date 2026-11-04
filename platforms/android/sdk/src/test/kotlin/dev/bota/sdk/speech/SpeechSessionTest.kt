package dev.bota.sdk.speech

import java.io.File
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Executes the actual Rust/JNI policy with controlled OS/HTTP ports. No second reducer. */
@OptIn(ExperimentalCoroutinesApi::class)
class SpeechSessionTest {
    private class Media : SpeechMediaPort {
        val calls = mutableListOf<String>()
        var callbacks: SpeechMediaCallbacks? = null
        var connect: suspend () -> Unit = {}
        var clear: suspend () -> Unit = {}
        var capture: suspend (Boolean) -> Unit = {}
        var cleanup: suspend () -> Unit = {}
        var resume: suspend () -> Unit = {}
        var publication: String? = null
        var held = false
        var closed = false
        var muted = true
        var audible = emptyList<SpeechTrack>()
        override val supportsSourceFinish = true
        override suspend fun connect(grant: SpeechGrant) { calls += "connect"; connect() }
        override fun silencePlayback() { calls += "silence"; audible = emptyList() }
        override fun muteInput() { calls += "mute"; muted = true }
        override suspend fun clearPlayback() { calls += "clear"; clear(); audible = emptyList() }
        override suspend fun setPlayback(tracks: List<SpeechTrack>) { calls += "play"; audible = tracks }
        override suspend fun setInput(enabled: Boolean) {
            calls += "input:$enabled"
            capture(enabled)
            if (!enabled) held = false
            muted = !enabled || held || closed
        }
        override fun holdInput() { calls += "hold"; held = true; muted = true }
        override fun inputPublication(): String? { calls += "publication"; return publication }
        override suspend fun close() { calls += "close"; closed = true; cleanup() }
        override suspend fun resumeAudio() { calls += "resume"; resume() }
    }

    private class Host : SpeechHostCallbacks {
        var change: suspend (SpeechSelection) -> SpeechSubscription = { SpeechSubscription(2, it) }
        var renew: suspend () -> SpeechGrant = { throw SpeechHostException(SpeechHostFailure.UNAVAILABLE) }
        var captions: (suspend (SpeechCaptionRequest) -> String)? = null
        var finish: (suspend (SpeechFinishRequest) -> String)? = null
        override val supportsCaptionRecovery get() = captions != null
        override val supportsSourceFinish get() = finish != null
        override suspend fun changeSubscription(selection: SpeechSelection) = change(selection)
        override suspend fun renewGrant() = renew()
        override suspend fun readCaptions(request: SpeechCaptionRequest) = requireNotNull(captions)(request)
        override suspend fun finishSource(request: SpeechFinishRequest) = requireNotNull(finish)(request)
    }

    private class Fixture(val scope: TestScope, retention: SpeechRetention = SpeechRetention.LIVE_ONLY) {
        private val raw = JSONObject(generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "protocol/speech-session/client-v1.json") }.first { it.isFile }.readText())
        private val c = raw.getJSONObject("configuration").getJSONObject("context")
        private val g = raw.getJSONObject("grant")
        val configuration = SpeechConfiguration(SpeechContext(c.getString("projectId"), c.getString("sessionId"),
            c.getString("participantId"), c.getInt("memberGeneration"), retention, true, true),
            SpeechSubscription(1, SpeechSelection("zh", SpeechListeningMode.TRANSLATED,
                listOf("33333333-3333-4333-8333-333333333333", c.getString("participantId")))))
        val grant = SpeechGrant(g.getInt("protocol_version"), g.getString("provider"), g.getString("url"),
            g.getString("room"), g.getString("identity"), g.getString("token"), g.getString("expires_at"),
            g.getString("session_id"), g.getString("participant_id"), g.getInt("member_generation"),
            g.getInt("worker_generation"), g.getString("processor_identity"))
        val media = Media()
        val host = Host()
        val captions = mutableListOf<SpeechCaption>()
        val errors = mutableListOf<SpeechErrorCode>()
        lateinit var session: SpeechSession
        var onCaption: (SpeechCaption) -> Unit = { captions += it }
        fun open(): SpeechSession {
            session = SpeechSession.createInternal(configuration, grant, { media.callbacks = it; media }, host,
                object : SpeechObserver {
                    override fun caption(caption: SpeechCaption) = onCaption(caption)
                    override fun error(error: SpeechSessionException) { errors += error.code }
                }, SpeechClock { raw.getLong("nowMs") + scope.testScheduler.currentTime },
                StandardTestDispatcher(scope.testScheduler))
            return session
        }
        fun applied(revision: Int = 1, language: String = "zh") = JSONObject()
            .put("protocolVersion", 1).put("projectId", configuration.context.projectId)
            .put("sessionId", grant.sessionId).put("retention", configuration.context.retention.wire)
            .put("type", "subscription_applied").put("workerGeneration", grant.workerGeneration)
            .put("participantId", grant.participantId).put("memberGeneration", grant.memberGeneration)
            .put("subscriptionRevision", revision).put("targetLanguage", language).put("mode", "translated")
        fun audio(revision: Int = 1, language: String = "zh") = applied(revision, language).apply {
            remove("mode")
            put("type", "audio_start"); put("eventSequence", 1)
            put("sourceId", SOURCE); put("sourceEpoch", 1)
            put("sourceParticipantId", configuration.subscription.selection.sourceParticipantIds.first())
            put("sourceMemberGeneration", 1); put("unitId", "unit_1"); put("outputId", "output_1")
            put("transport", "webrtc"); put("codec", "opus"); put("sourceSampleRate", 24000)
            put("channels", 1); put("origin", "generated"); put("voice", "neutral"); put("mediaTrackSid", "TR_output")
        }
        fun event(event: JSONObject, sender: String = grant.processorIdentity) = media.callbacks!!.text(sender, event.toString())
        fun page(request: SpeechCaptionRequest, text: String = "Hello 🌍\u0000", more: Boolean = false, sequence: String = "1"): String {
            val record = JSONObject().put("protocolVersion", 1).put("projectId", configuration.context.projectId)
                .put("sessionId", grant.sessionId).put("retention", configuration.context.retention.wire)
                .put("sourceId", SOURCE).put("sourceEpoch", 1)
                .put("sourceParticipantId", configuration.subscription.selection.sourceParticipantIds.first())
                .put("sourceMemberGeneration", 1).put("unitId", "$SOURCE:1:$sequence:$sequence")
                .put("sourceFirstSeq", sequence.toInt()).put("sourceLastSeq", sequence.toInt())
                .put("startMs", 0).put("endMs", 100).put("sourceLanguage", "en").put("text", text)
            return JSONObject().put("protocol_version", 1).put("session_id", grant.sessionId)
                .put("participant_id", grant.participantId).put("member_generation", grant.memberGeneration)
                .put("subscription_revision", request.subscriptionRevision).put("history", "retained")
                .put("records", JSONArray().put(JSONObject().put("sequence", sequence).put("record", record)))
                .put("has_more", more).put("next_cursor", "cursor_$sequence").toString()
        }
        fun finished(state: String): String {
            val boundary = state in listOf("draining", "completed")
            return JSONObject().put("source", JSONObject().put("id", SOURCE).put("epoch", 1)
                .put("participant_id", grant.participantId).put("member_generation", grant.memberGeneration)
                .put("track_sid", "TR_original").put("state", if (state == "completed") "ended" else "active")
                .put("finish", JSONObject().put("state", state).put("worker_generation", grant.workerGeneration)
                    .put("sequence", if (boundary) "2" else JSONObject.NULL)
                    .put("samples", if (boundary) "3200" else JSONObject.NULL))).toString()
        }
    }

    @Test fun duplexAndLanguageSwitchRequireWorkerAndBufferAcknowledgement() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val s = f.open()
        try {
            s.ready.await(); s.setInput(true); s.setListening(true)
            f.event(f.applied()); runCurrent(); f.event(f.audio()); runCurrent()
            assertTrue(s.state.value.canCapture); assertEquals("TR_output", f.media.audible.single().mediaTrackSid)
            val http = CompletableDeferred<SpeechSubscription>(); f.host.change = { http.await() }
            val clear = CompletableDeferred<Unit>(); f.media.clear = { clear.await() }
            val selection = f.configuration.subscription.selection.copy(targetLanguage = "ja")
            val changing = async { s.changeSubscription(selection) }; runCurrent()
            assertTrue(f.media.audible.isEmpty()); assertTrue(s.state.value.canCapture)
            assertFalse(f.media.muted); assertFalse(s.state.value.canPlay)
            f.event(f.applied(2, "ja")); http.complete(SpeechSubscription(2, selection)); changing.await()
            assertFalse(s.state.value.canPlay)
            clear.complete(Unit); runCurrent()
            f.event(f.audio()); runCurrent(); assertTrue(f.media.audible.isEmpty())
            f.event(f.audio(2, "ja")); runCurrent(); assertEquals(1, f.media.audible.size)
            s.setListening(false); assertFalse(f.media.muted); assertTrue(s.state.value.canCapture)
        } finally { s.close() }
    }

    @Test fun subscriptionTimeoutIsUnavailableAndDoesNotStopCapture() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.host.change = { CompletableDeferred<SpeechSubscription>().await() }
        val s = f.open()
        try {
            s.ready.await(); s.setInput(true)
            val result = async { runCatching { s.changeSubscription(f.configuration.subscription.selection) } }
            runCurrent(); advanceTimeBy(10_000); runCurrent()
            assertEquals(SpeechErrorCode.SUBSCRIPTION_UNAVAILABLE, (result.await().exceptionOrNull() as SpeechSessionException).code)
            assertTrue(s.state.value.canCapture); assertFalse(f.media.muted)
        } finally { s.close() }
    }

    @Test fun httpBeforeWorkerStillWaitsForTheCurrentBufferClear() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val s = f.open()
        val oldClear = CompletableDeferred<Unit>(); val currentClear = CompletableDeferred<Unit>()
        val currentEntered = CompletableDeferred<Unit>(); var clears = 0
        try {
            s.ready.await(); s.setInput(true); s.setListening(true); f.event(f.applied()); runCurrent()
            f.media.clear = {
                if (++clears == 1) withContext(NonCancellable) { oldClear.await() }
                else { currentEntered.complete(Unit); currentClear.await() }
            }
            f.host.change = { SpeechSubscription(if (it.targetLanguage == "ja") 2 else 3, it) }
            s.changeSubscription(f.configuration.subscription.selection.copy(targetLanguage = "ja")); runCurrent()
            assertFalse(s.state.value.canPlay)
            s.changeSubscription(f.configuration.subscription.selection.copy(targetLanguage = "fr")); runCurrent()
            f.event(f.applied(2, "ja")); f.event(f.applied(3, "fr"))
            oldClear.complete(Unit); currentEntered.await()
            assertFalse(s.state.value.canPlay); assertTrue(s.state.value.canCapture)
            currentClear.complete(Unit); runCurrent(); f.event(f.audio(3, "fr")); runCurrent()
            assertTrue(s.state.value.canPlay); assertEquals(1, f.media.audible.size)
        } finally { oldClear.complete(Unit); currentClear.complete(Unit); s.close() }
    }

    @Test fun supersededHttpResponseCannotReopenAnOlderLanguage() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val gate = CompletableDeferred<Unit>()
        f.host.change = { if (it.targetLanguage == "ja") withContext(NonCancellable) { gate.await(); SpeechSubscription(2, it) }
            else SpeechSubscription(3, it) }
        val s = f.open()
        try {
            s.ready.await()
            val old = async { runCatching { s.changeSubscription(f.configuration.subscription.selection.copy(targetLanguage = "ja")) } }
            runCurrent(); s.changeSubscription(f.configuration.subscription.selection.copy(targetLanguage = "fr"))
            gate.complete(Unit); runCurrent()
            assertEquals(SpeechErrorCode.SUPERSEDED, (old.await().exceptionOrNull() as SpeechSessionException).code)
            assertEquals(3, s.state.value.subscriptionRevision); assertFalse(s.state.value.disconnect)
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun cancellingCaptureRetiresSessionAndJoinsMediaCleanup() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val entered = CompletableDeferred<Unit>(); val gate = CompletableDeferred<Unit>()
        val stopped = CompletableDeferred<Unit>(); val cleaned = CompletableDeferred<Unit>()
        f.media.capture = { enabled -> if (enabled) {
            entered.complete(Unit)
            try { withContext(NonCancellable) { gate.await() } } finally { stopped.complete(Unit) }
        } }
        f.media.cleanup = { stopped.await(); cleaned.complete(Unit) }
        val s = f.open()
        try {
            s.ready.await()
            val capture = async { s.setInput(true) }; entered.await()
            capture.cancel(); runCurrent()
            assertTrue(s.state.value.disconnect); assertTrue(f.media.muted)
            val closing = async { s.close() }; runCurrent(); assertFalse(closing.isCompleted)
            gate.complete(Unit); closing.await(); assertTrue(cleaned.isCompleted)
            assertTrue(f.media.muted)
            f.event(f.applied()); assertTrue(s.state.value.disconnect)
            assertEquals(1, f.media.calls.count { it == "close" })
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun finishHoldsPendingPublicationThenDrainsWithoutStoppingListening() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val acquired = CompletableDeferred<Unit>(); val gate = CompletableDeferred<Unit>()
        f.media.capture = { enabled -> if (enabled) { acquired.complete(Unit); gate.await(); f.media.publication = "TR_original" } }
        val requests = mutableListOf<SpeechFinishRequest>()
        f.host.finish = { requests += it; f.finished(if (requests.size == 1) "draining" else "completed") }
        val s = f.open()
        try {
            s.ready.await(); s.setListening(true); f.event(f.applied()); runCurrent()
            val capture = async { s.setInput(true) }; acquired.await()
            val ending = async { s.finishInput() }; runCurrent()
            assertTrue(f.media.held); assertTrue(f.media.muted); assertTrue(requests.isEmpty())
            gate.complete(Unit); capture.await(); runCurrent()
            assertEquals("TR_original", requests.single().trackSid)
            assertEquals("draining", s.state.value.sourceFinish.status)
            assertTrue(s.state.value.canPlay); assertFalse(ending.isCompleted)
            advanceTimeBy(1_000); runCurrent()
            assertEquals("completed", ending.await().status); assertEquals(SOURCE, requests.last().sourceId)
            assertEquals("completed", s.finishInput().status); assertEquals(2, requests.size)
            assertFalse(s.state.value.disconnect); s.setInput(true); assertEquals("idle", s.state.value.sourceFinish.status)
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun noPublicationFinishDoesNotClaimAsrCompletionOrCallBackend() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.host.finish = { error("No source must not call HTTP") }
        val s = f.open()
        try {
            s.ready.await(); assertEquals("no_source", s.finishInput().status)
            assertEquals("no_source", s.finishInput().status); assertFalse(s.state.value.disconnect)
        } finally { s.close() }
    }

    @Test fun captionPagesPreserveUnicodeAndAdvanceWithoutCancellingTheirWaiter() = runTest(timeout = 5.seconds) {
        val f = Fixture(this, SpeechRetention.TEXT_ONLY); val requests = mutableListOf<SpeechCaptionRequest>()
        val gate = CompletableDeferred<Unit>()
        f.host.captions = { requests += it; gate.await(); f.page(it, more = requests.size == 1, sequence = requests.size.toString()) }
        val s = f.open()
        try {
            s.ready.await(); val recovery = async { s.recoverCaptions() }; runCurrent()
            gate.complete(Unit); val result = recovery.await()
            assertTrue(result.hasMore); assertEquals("cursor_1", result.cursor)
            advanceTimeBy(250); runCurrent()
            assertEquals(2, requests.size); assertEquals("cursor_1", requests.last().cursor)
            assertEquals("cursor_2", s.state.value.recovery.cursor); assertEquals(2, f.captions.size)
            assertEquals("Hello 🌍\u0000", f.captions.first().text); assertTrue(f.captions.all { it.isFinal })
            assertFalse(f.captions.first().toString().contains("Hello")); assertFalse(s.state.value.toString().contains("Hello"))
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun revokedCaptionAuthorizationStopsCaptureAndPlayback() = runTest(timeout = 5.seconds) {
        val f = Fixture(this, SpeechRetention.TEXT_ONLY); val gate = CompletableDeferred<Unit>()
        f.host.captions = { gate.await(); throw SpeechHostException(SpeechHostFailure.UNAUTHORIZED) }
        val s = f.open()
        try {
            s.ready.await(); s.setInput(true); gate.complete(Unit); runCurrent()
            assertTrue(s.state.value.disconnect); assertTrue(f.media.muted); assertTrue(f.media.audible.isEmpty())
            assertTrue(f.errors.contains(SpeechErrorCode.AUTHORIZATION_UNAVAILABLE))
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun malformedCaptionResponseIsValidatedByRustAndClosesOwner() = runTest(timeout = 5.seconds) {
        val f = Fixture(this, SpeechRetention.TEXT_ONLY); val gate = CompletableDeferred<Unit>()
        f.host.captions = { gate.await(); JSONObject(f.page(it)).put("unexpected", "PRIVATE_TOKEN_CANARY").toString() }
        val s = f.open()
        try {
            s.ready.await(); gate.complete(Unit); runCurrent()
            assertTrue(s.state.value.disconnect); assertTrue(f.captions.isEmpty())
            assertTrue(f.errors.contains(SpeechErrorCode.INVALID_INPUT))
            assertFalse(f.errors.toString().contains("PRIVATE_TOKEN_CANARY"))
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun observerFailureDoesNotRetireMediaAndForeignEventsDoNotReachPlayback() = runTest(timeout = 5.seconds) {
        val f = Fixture(this, SpeechRetention.TEXT_ONLY)
        f.onCaption = { throw IllegalStateException("host UI") }; f.host.captions = { f.page(it) }
        val s = f.open()
        try {
            s.ready.await(); runCurrent(); s.setListening(true)
            f.event(f.applied()); runCurrent(); f.event(f.audio(), "foreign-worker"); runCurrent()
            assertFalse(s.state.value.disconnect); assertTrue(f.media.audible.isEmpty())
            f.event(f.audio()); runCurrent(); assertEquals(1, f.media.audible.size)
        } finally { s.close() }
    }

    @Test fun failedConnectPreservesErrorAndClosesOnce() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.media.connect = { throw IllegalStateException("PRIVATE_TOKEN_CANARY") }
        val s = f.open()
        val error = runCatching { s.ready.await() }.exceptionOrNull() as SpeechSessionException
        assertEquals(SpeechErrorCode.MEDIA_FAILED, error.code); assertFalse(error.toString().contains("PRIVATE_TOKEN_CANARY"))
        s.close(); s.close(); assertEquals(1, f.media.calls.count { it == "close" })
    }

    @Test fun failedCleanupIsRetainedForEveryCloseCaller() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.media.cleanup = { throw IllegalStateException("uncertain native ownership") }
        val s = f.open(); s.ready.await()
        repeat(2) {
            assertEquals(SpeechErrorCode.CLEANUP_FAILED, (runCatching { s.close() }.exceptionOrNull() as SpeechSessionException).code)
        }
        assertTrue(s.state.value.disconnect); assertEquals(1, f.media.calls.count { it == "close" })
    }

    @Test fun hungConnectTimesOutAndRetiresLateCallbacks() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.media.connect = { CompletableDeferred<Unit>().await() }
        val s = f.open()
        val result = async { runCatching { s.ready.await() } }; runCurrent()
        advanceTimeBy(10_000); runCurrent()
        assertEquals(SpeechErrorCode.MEDIA_TIMEOUT, (result.await().exceptionOrNull() as SpeechSessionException).code)
        s.close(); f.event(f.applied()); assertTrue(s.state.value.disconnect)
        assertEquals(1, f.media.calls.count { it == "close" })
    }

    @Test fun closeCancelsPendingPlaybackResumeBeforeWaitingForCleanup() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val resumed = CompletableDeferred<Unit>(); val stopped = CompletableDeferred<Unit>()
        val cleanup = CompletableDeferred<Unit>()
        f.media.resume = { resumed.complete(Unit); try { CompletableDeferred<Unit>().await() } finally { stopped.complete(Unit) } }
        f.media.cleanup = { cleanup.await() }
        val s = f.open()
        try {
            s.ready.await(); val resume = async { runCatching { s.resumeAudio() } }; resumed.await()
            val close = async { s.close() }; stopped.await()
            assertFalse(close.isCompleted)
            assertEquals(SpeechErrorCode.CLOSED, (resume.await().exceptionOrNull() as SpeechSessionException).code)
            cleanup.complete(Unit); close.await()
        } finally { cleanup.complete(Unit); s.close() }
    }

    @Test fun expiryClosesSessionWhenRenewalNeverSucceeds() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); var attempts = 0
        f.host.renew = { attempts++; throw SpeechHostException(SpeechHostFailure.UNAVAILABLE) }
        val s = f.open()
        try {
            s.ready.await(); s.setInput(true)
            advanceTimeBy(60_000); runCurrent()
            assertTrue(attempts > 0); assertTrue(s.state.value.disconnect); assertTrue(f.media.muted)
            assertTrue(f.errors.contains(SpeechErrorCode.AUTHORIZATION_UNAVAILABLE))
        } finally { s.close() }
    }

    @Test fun concurrentFinishSharesRequestAndRejectsReenablingHeldCapture() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); val gate = CompletableDeferred<Unit>(); var requests = 0
        f.media.publication = "TR_original"
        f.host.finish = { requests++; gate.await(); f.finished("completed") }
        val s = f.open()
        try {
            s.ready.await(); s.setInput(true)
            val first = async { s.finishInput() }; runCurrent()
            val second = async { s.finishInput() }; runCurrent()
            assertEquals(SpeechErrorCode.SOURCE_FINISH_PENDING,
                (runCatching { s.setInput(true) }.exceptionOrNull() as SpeechSessionException).code)
            assertTrue(f.media.muted); gate.complete(Unit)
            assertEquals(first.await(), second.await()); assertEquals(1, requests)
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun staleSourceFinishIsTerminalForThatPublicationWhileListeningContinues() = runTest(timeout = 5.seconds) {
        val f = Fixture(this); f.media.publication = "TR_original"
        f.host.finish = { throw SpeechHostException(SpeechHostFailure.STALE_SOURCE) }
        val s = f.open()
        try {
            s.ready.await(); s.setInput(true); s.setListening(true); f.event(f.applied()); runCurrent()
            repeat(2) {
                assertEquals(SpeechErrorCode.SOURCE_FINISH_STALE,
                    (runCatching { s.finishInput() }.exceptionOrNull() as SpeechSessionException).code)
            }
            assertFalse(s.state.value.disconnect); assertTrue(s.state.value.canPlay); assertTrue(f.media.muted)
        } finally { s.close() }
    }

    @Test fun retiredCaptionPageCannotCrossLanguageRevision() = runTest(timeout = 5.seconds) {
        val f = Fixture(this, SpeechRetention.TEXT_ONLY); val gate = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        f.host.captions = { request ->
            if (request.subscriptionRevision == 1) withContext(NonCancellable) {
                entered.complete(Unit); gate.await(); f.page(request, "old-language")
            } else f.page(request, "new-language")
        }
        val s = f.open()
        try {
            s.ready.await(); entered.await()
            s.changeSubscription(f.configuration.subscription.selection.copy(targetLanguage = "ja"))
            gate.complete(Unit); runCurrent()
            assertEquals(listOf("new-language"), f.captions.map { it.text })
            assertEquals(2, f.captions.single().subscriptionRevision)
        } finally { gate.complete(Unit); s.close() }
    }

    @Test fun invalidConfigurationFailsBeforeCreatingMediaOwner() {
        val scope = TestScope(); val f = Fixture(scope); var created = false
        val bad = f.configuration.copy(context = f.configuration.context.copy(sessionId = "invalid"))
        val error = assertThrows(SpeechSessionException::class.java) {
            SpeechSession.createInternal(bad, f.grant, { created = true; f.media }, f.host,
                object : SpeechObserver {}, SpeechClock { 1_793_491_200_000L }, StandardTestDispatcher(scope.testScheduler))
        }
        assertEquals(SpeechErrorCode.INVALID_INPUT, error.code); assertFalse(created)
    }

    private companion object { const val SOURCE = "44444444-4444-4444-8444-444444444444" }
}
