package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import java.util.concurrent.Executors
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [26])
class FlutterLabOwnerTest {
    private fun uiTest(body: suspend CoroutineScope.(CoroutineDispatcher) -> Unit) = runBlocking {
        Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { ui -> withTimeout(15_000) { body(ui) } }
    }
    @Test fun nativePreparationIsConsumedOnceByTheExactEngineAndSession() = uiTest { ui ->
        val media = ModelMedia(); val transport = modelTransport()
        val owner = FlutterLabOwner({ media }, { transport }, ui)
        withContext(ui) {
            owner.bindEngine("engine-a")
            val display = owner.prepare("engine-a", "http://127.0.0.1:4173", "a", "a".repeat(40))
            assertEquals(setOf("sessionId", "role", "peerRole", "peerId", "languages", "language", "mode"), display.keys)
            assertFalse(display.toString().contains("token"))
            assertThrows(LabFailure::class.java) { owner.create("retired-engine", display["sessionId"] as String, object : SpeechObserver {}) }
            assertThrows(LabFailure::class.java) { owner.create("engine-a", "wrong-session", object : SpeechObserver {}) }
            val session = owner.create("engine-a", display["sessionId"] as String, object : SpeechObserver {})
            session.ready.await(); session.setInput(true); assertTrue(media.capture)
            assertThrows(LabFailure::class.java) { owner.create("engine-a", display["sessionId"] as String, object : SpeechObserver {}) }
            owner.leave("engine-a").await()
            assertTrue(media.closed); assertTrue(transport.closed)
        }
    }
    @Test fun engineReplacementJoinsLateBootstrapBeforePreparingAnotherGrant() = uiTest { ui ->
        val entered = CompletableDeferred<Unit>(); val released = CompletableDeferred<Unit>()
        val first = FixtureTransport().apply { handler = {
            entered.complete(Unit)
            withContext(NonCancellable) { released.await() }
            LabResponse(200, joinFixture())
        } }
        var count = 0
        val owner = FlutterLabOwner({ ModelMedia() }, { if (count++ == 0) first else modelTransport() }, ui)
        withContext(ui) { owner.bindEngine("old") }
        val pending = async(ui) { runCatching { owner.prepare("old", "http://127.0.0.1:4173", "a", "a".repeat(40)) } }
        entered.await()
        withContext(ui) { owner.bindEngine("new") }
        val replacement = async(ui) { owner.prepare("new", "http://127.0.0.1:4173", "a", "a".repeat(40)) }
        withContext(ui) { assertFalse(replacement.isCompleted); assertEquals(1, count) }
        released.complete(Unit); assertTrue(pending.await().isFailure); replacement.await()
        withContext(ui) {
            owner.leave("old").await()
            assertTrue(owner.isCurrent("new"))
            owner.leave("new").await()
        }
    }
    @Test fun failedNativeCleanupPoisonsFutureEngines() = uiTest { ui ->
        val media = ModelMedia().apply { closeFails = true }; var calls = 0
        val owner = FlutterLabOwner({ media }, { calls++; modelTransport() }, ui)
        withContext(ui) {
            owner.bindEngine("first")
            val display = owner.prepare("first", "http://127.0.0.1:4173", "a", "a".repeat(40))
            owner.create("first", display["sessionId"] as String, object : SpeechObserver {}).ready.await()
            assertTrue(runCatching { owner.leave("first").await() }.isFailure)
            owner.bindEngine("second")
            assertTrue(runCatching { owner.prepare("second", "http://127.0.0.1:4173", "a", "a".repeat(40)) }.isFailure)
            assertEquals(1, calls)
        }
    }
}
