package dev.bota.sdk.speech.livekit

import dev.bota.sdk.speech.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [26])
class LiveKitSpeechMediaTest {
    private class Input : RtcInput {
        @Volatile override var enabled = false
        override var sid: String? = "TR_input"
        var disposed = false
        var disposeFails = false
        override fun dispose() { disposed = true; enabled = false; check(!disposeFails) }
    }
    private class Room : RtcRoom {
        override var listener: RtcListener? = null
        override var identity = "listener"
        override var name = "room"
        val input = Input()
        val calls = CopyOnWriteArrayList<String>()
        var acquire: suspend () -> RtcInput = { input }
        var publish: suspend () -> Unit = {}
        var connect: suspend () -> Unit = {}
        override suspend fun connect(grant: SpeechGrant) { calls += "connect"; identity = grant.identity; name = grant.room; connect() }
        override suspend fun createInput(): RtcInput = acquire()
        override suspend fun publish(input: RtcInput) { publish() }
        override fun unpublish(input: RtcInput) { calls += "unpublish" }
        override fun subscribe(sids: Set<String>) { calls += "subscribe:${sids.sorted()}" }
        override fun muteInput() { calls += "mute"; input.enabled = false }
        override fun disconnect() { calls += "disconnect" }
        override suspend fun release() { calls += "release" }
    }
    private class Output : PcmOutput {
        @Volatile var allowed = emptySet<String>()
        val audible = CompletableDeferred<Unit>()
        var clearing: suspend () -> Unit = {}
        var closing: suspend () -> Unit = {}
        var draining: suspend () -> Unit = {}
        override fun silence() { allowed = emptySet() }
        override fun select(sids: Set<String>) { allowed = sids; if (sids.isNotEmpty()) audible.complete(Unit) }
        override fun frame(sid: String, frame: PcmFrame) {}
        override suspend fun clear() { clearing() }
        override suspend fun close() { closing() }
        override suspend fun drain(sid: String) { draining() }
    }
    private class Callbacks : SpeechMediaCallbacks {
        val texts = mutableListOf<String>()
        var failures = 0
        var blocked = 0
        val removed = mutableListOf<String>()
        override fun text(sender: String, json: String) { texts += json }
        override fun trackRemoved(mediaTrackSid: String) { removed += mediaTrackSid }
        override fun disconnected() {}
        override fun failed() { failures++ }
        override fun playbackBlocked() { blocked++ }
    }
    private val grant = SpeechGrant(1, "livekit", "wss://example.invalid", "room", "listener", "secret",
        "2099-01-01T00:00:00Z", "session", "participant", 1, 1, "processor")
    private val track = SpeechTrack("TR_output", "source", 1, "speaker", "generated", "output")

    @Test fun connectDoesNotCaptureAndOnlyAdmitsCurrentProcessorAudio() = runTest {
        val room = Room(); val output = Output(); val callbacks = Callbacks()
        val media = LiveKitSpeechMedia(room, output, callbacks, backgroundScope)
        media.connect(grant)
        assertFalse(room.input.enabled)
        media.setPlayback(listOf(track))
        room.listener!!.text("foreign", "discard")
        room.listener!!.text("processor", "accepted")
        assertEquals(listOf("accepted"), callbacks.texts)
        assertEquals(setOf("TR_output"), output.allowed)
        media.close()
    }

    @Test fun holdSurvivesLateInputAcquisitionAndListeningStaysIndependent() = runTest {
        val room = Room(); val output = Output()
        val pending = CompletableDeferred<RtcInput>(); room.acquire = { pending.await() }
        val media = LiveKitSpeechMedia(room, output, Callbacks(), backgroundScope)
        media.connect(grant); media.setPlayback(listOf(track))
        val start = async { media.setInput(true) }; runCurrent()
        media.holdInput(); pending.complete(room.input); start.await()
        assertFalse(room.input.enabled)
        assertEquals("TR_input", media.inputPublication())
        assertEquals(setOf("TR_output"), output.allowed)
        media.setInput(false); media.close()
    }

    @Test fun closeJoinsLateAcquisitionAndDisposesBeforeReleasingRoom() = runTest {
        val room = Room(); val output = Output()
        val pending = CompletableDeferred<RtcInput>(); room.acquire = { pending.await() }
        val media = LiveKitSpeechMedia(room, output, Callbacks(), backgroundScope)
        media.connect(grant)
        val start = async { runCatching { media.setInput(true) } }; runCurrent()
        val close = async { media.close() }; runCurrent()
        assertFalse(close.isCompleted)
        pending.complete(room.input); start.await(); close.await()
        assertTrue(room.input.disposed)
        assertEquals("release", room.calls.last())
    }

    @Test fun languageClearCannotBeAcknowledgedBeforeOutputFlush() = runTest {
        val room = Room(); val output = Output()
        val flushed = CompletableDeferred<Unit>(); output.clearing = { flushed.await() }
        val media = LiveKitSpeechMedia(room, output, Callbacks(), backgroundScope)
        media.connect(grant); media.setInput(true); media.setPlayback(listOf(track))
        val clear = async { media.clearPlayback() }; runCurrent()
        assertTrue(room.input.enabled)
        assertTrue(output.allowed.isEmpty()); assertFalse(clear.isCompleted)
        flushed.complete(Unit); clear.await(); media.close()
    }

    @Test fun failedPublishCannotRetainAnInputWithAnAssignedSid() = runTest {
        val room = Room(); room.publish = { error("publish failed after registration") }
        val media = LiveKitSpeechMedia(room, Output(), Callbacks(), backgroundScope)
        media.connect(grant)
        assertTrue(runCatching { media.setInput(true) }.isFailure)
        assertTrue(room.input.disposed)
        assertNull(media.inputPublication())
        media.close()
    }

    @Test fun synchronousMuteRetiresAnAlreadySubmittedInputStart() = runTest {
        val room = Room(); val media = LiveKitSpeechMedia(room, Output(), Callbacks(), backgroundScope)
        media.connect(grant)
        val start = async(start = CoroutineStart.UNDISPATCHED) { media.setInput(true) }
        media.muteInput(); runCurrent(); start.await()
        assertFalse(room.input.enabled)
        media.close()
    }

    @Test fun synchronousSilenceRetiresAnAlreadySubmittedPlaybackStart() = runTest {
        val room = Room(); val output = Output()
        val media = LiveKitSpeechMedia(room, output, Callbacks(), backgroundScope)
        media.connect(grant)
        val play = async(start = CoroutineStart.UNDISPATCHED) { media.setPlayback(listOf(track)) }
        media.silencePlayback(); runCurrent(); play.await()
        assertTrue(output.allowed.isEmpty())
        media.close()
    }

    @Test fun failedInputCleanupRemainsAFailureForEveryCloseWaiter() = runTest {
        val room = Room(); val media = LiveKitSpeechMedia(room, Output(), Callbacks(), backgroundScope)
        media.connect(grant); media.setInput(true)
        room.input.disposeFails = true
        assertEquals(SpeechErrorCode.CLEANUP_FAILED,
            (runCatching { media.setInput(false) }.exceptionOrNull() as SpeechSessionException).code)
        repeat(2) {
            assertEquals(SpeechErrorCode.CLEANUP_FAILED,
                (runCatching { media.close() }.exceptionOrNull() as SpeechSessionException).code)
        }
    }

    @Test fun cancellingOneCloseWaiterDoesNotCancelSharedOutputCleanup() = runTest {
        val room = Room(); val output = Output(); val released = CompletableDeferred<Unit>()
        output.closing = { released.await() }
        val media = LiveKitSpeechMedia(room, output, Callbacks(), backgroundScope)
        media.connect(grant)
        val first = async { media.close() }; runCurrent(); first.cancel()
        val second = async { media.close() }; runCurrent()
        assertFalse(second.isCompleted)
        released.complete(Unit); second.await()
        assertEquals(1, room.calls.count { it == "release" })
    }

    @Test fun unpublishPreservesAudibleTailUntilNativeDrainCompletes() = runTest {
        val room = Room(); val output = Output(); val callbacks = Callbacks()
        val tail = CompletableDeferred<Unit>(); output.draining = { tail.await() }
        val media = LiveKitSpeechMedia(room, output, callbacks, backgroundScope)
        media.connect(grant); media.setPlayback(listOf(track))
        room.listener!!.removed("TR_output"); runCurrent()
        assertTrue(callbacks.removed.isEmpty())
        assertEquals(setOf("TR_output"), output.allowed)
        tail.complete(Unit); runCurrent()
        assertEquals(listOf("TR_output"), callbacks.removed)
        media.close()
    }

    @Test fun aRetiredTailCannotRemoveATrackFromANewerPlaybackSelection() = runTest {
        val room = Room(); val output = Output(); val callbacks = Callbacks()
        val tail = CompletableDeferred<Unit>(); output.draining = { tail.await() }
        val media = LiveKitSpeechMedia(room, output, callbacks, backgroundScope)
        media.connect(grant); media.setPlayback(listOf(track))
        room.listener!!.removed("TR_output"); runCurrent()
        media.clearPlayback(); media.setPlayback(listOf(track))
        tail.complete(Unit); runCurrent()
        assertTrue(callbacks.removed.isEmpty())
        assertEquals(setOf("TR_output"), output.allowed)
        media.close()
    }

    @Test fun aStalledPlaybackHeadIsSilencedAtTheDrainDeadline() = runTest {
        val room = Room(); val output = Output(); val callbacks = Callbacks()
        output.draining = { CompletableDeferred<Unit>().await() }
        val media = LiveKitSpeechMedia(room, output, callbacks, backgroundScope)
        media.connect(grant); media.setPlayback(listOf(track))
        room.listener!!.removed("TR_output"); runCurrent()
        advanceTimeBy(1_000); runCurrent()
        assertTrue(callbacks.removed.isEmpty())
        assertEquals(1, callbacks.blocked)
        assertTrue(output.allowed.isEmpty())
        media.close()
    }

    @Test fun publicSessionExecutesActualRustPolicyThroughTheMediaAdapter() = runBlocking {
        withTimeout(5_000) {
            val fixture = JSONObject(generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
                .map { File(it, "protocol/speech-session/client-v1.json") }.first { it.isFile }.readText())
            val c = fixture.getJSONObject("configuration").getJSONObject("context")
            val g = fixture.getJSONObject("grant")
            val configuration = SpeechConfiguration(SpeechContext(c.getString("projectId"), c.getString("sessionId"),
                c.getString("participantId"), c.getInt("memberGeneration"), SpeechRetention.LIVE_ONLY, true, true),
                SpeechSubscription(1, SpeechSelection("zh", SpeechListeningMode.TRANSLATED,
                    listOf("33333333-3333-4333-8333-333333333333"))))
            val authority = SpeechGrant(1, "livekit", g.getString("url"), g.getString("room"), g.getString("identity"),
                g.getString("token"), Instant.now().plusSeconds(60).toString(), g.getString("session_id"),
                g.getString("participant_id"), g.getInt("member_generation"), g.getInt("worker_generation"), g.getString("processor_identity"))
            val room = Room(); val output = Output()
            val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val session = SpeechSession.create(configuration, authority,
                { callbacks -> LiveKitSpeechMedia(room, output, callbacks, owner) }, object : SpeechHostCallbacks {
                    override suspend fun renewGrant(): SpeechGrant = authority
                    override suspend fun changeSubscription(selection: SpeechSelection): SpeechSubscription = SpeechSubscription(2, selection)
                })
            try {
                session.ready.await(); session.setInput(true); session.setListening(true)
                assertTrue(room.input.enabled)
                val applied = JSONObject().put("protocolVersion", 1).put("projectId", configuration.context.projectId)
                    .put("sessionId", authority.sessionId).put("retention", "live_only")
                    .put("type", "subscription_applied").put("workerGeneration", authority.workerGeneration)
                    .put("participantId", authority.participantId).put("memberGeneration", authority.memberGeneration)
                    .put("subscriptionRevision", 1).put("targetLanguage", "zh").put("mode", "translated")
                room.listener!!.text(authority.processorIdentity, applied.toString())
                val audio = JSONObject(applied.toString()).apply {
                    remove("mode")
                    put("type", "audio_start"); put("eventSequence", 1)
                    put("sourceId", "44444444-4444-4444-8444-444444444444"); put("sourceEpoch", 1)
                    put("sourceParticipantId", configuration.subscription.selection.sourceParticipantIds.single())
                    put("sourceMemberGeneration", 1); put("unitId", "unit_1"); put("outputId", "output_1")
                    put("transport", "webrtc"); put("codec", "opus"); put("sourceSampleRate", 24000)
                    put("channels", 1); put("origin", "generated"); put("voice", "neutral"); put("mediaTrackSid", "TR_output")
                }
                room.listener!!.text(authority.processorIdentity, audio.toString())
                output.audible.await()
                assertEquals(setOf("TR_output"), output.allowed)
                session.setListening(false)
                assertTrue(room.input.enabled); assertTrue(output.allowed.isEmpty())
                session.setInput(false); assertTrue(room.input.disposed)
            } finally { session.close(); owner.cancel() }
            assertEquals("release", room.calls.last())
        }
    }
}
