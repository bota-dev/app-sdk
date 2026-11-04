package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import java.time.Instant
import java.util.concurrent.Executors
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [26])
class ReactNativeLabOwnerTest {
    private fun uiTest(body: suspend CoroutineScope.(CoroutineDispatcher) -> Unit) = runBlocking {
        Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { ui -> withTimeout(15_000) { body(ui) } }
    }
    @Test fun closingRtcPreservesOriginalUntilExplicitStopAndOwnerClose() = uiTest { ui ->
        val port = ModelMedia(); var originalClosed = false
        val original = object : LabOriginalOwner {
            override var capturing = false
            override var finished = false
            override val rtcLost = true
            override fun media(callbacks: SpeechMediaCallbacks) = port
            override suspend fun start() { capturing = true }
            override suspend fun finish() { capturing = false; finished = true }
            override suspend fun close() { finish(); originalClosed = true }
        }
        val transport = FixtureTransport().apply { handler = { LabResponse(200, joinFixture("original_audio_and_text")) } }
        withContext(ui) {
            val owner = ReactNativeLabOwner(RuntimeEnvironment.getApplication(), "http://127.0.0.1:4173", "a", "a".repeat(40),
                transport, ui, { error("Opened another microphone") }, { _, _, _ -> original })
            val join = JSONObject(owner.prepare()); val session = join.getJSONObject("grant").getString("session_id")
            assertThrows(LabFailure::class.java) { owner.createMedia("wrong") }
            val handle = owner.createMedia(session)
            owner.command(handle, "input", "true"); owner.startOriginal(); assertTrue(original.capturing)
            owner.closeMedia(handle); assertTrue(port.closed); assertTrue(original.capturing); assertFalse(originalClosed)
            assertTrue(owner.fence(handle, "mute")); assertFalse(owner.fence("wrong", "mute"))
            owner.finishOriginal(); assertTrue(original.finished)
            owner.close(); assertTrue(originalClosed); assertTrue(transport.closed)
        }
    }
    @Test fun nativeGrantExpiryStopsMediaWithoutJsPollingOrCommands() = uiTest { ui ->
        val port = ModelMedia(); val transport = FixtureTransport().apply { handler = {
            val value = JSONObject(joinFixture())
            value.getJSONObject("grant").put("expires_at", Instant.now().plusMillis(350).toString())
            LabResponse(200, value.toString())
        } }
        withContext(ui) {
            val owner = ReactNativeLabOwner(RuntimeEnvironment.getApplication(), "http://127.0.0.1:4173", "a", "a".repeat(40), transport, ui, { port })
            val join = JSONObject(owner.prepare())
            val handle = owner.createMedia(join.getJSONObject("grant").getString("session_id"))
            owner.command(handle, "input", "true"); assertTrue(port.capture)
            withTimeout(5000) { while (!port.closed) delay(20) }
            assertFalse(port.capture); assertTrue(runCatching { owner.command(handle, "input", "true") }.isFailure)
            owner.close()
        }
    }
    @Test fun failedMediaCleanupRemainsFailedOnRepeatedClose() = uiTest { ui ->
        val port = ModelMedia().apply { closeFails = true }
        withContext(ui) {
            val owner = ReactNativeLabOwner(RuntimeEnvironment.getApplication(), "http://127.0.0.1:4173", "a", "a".repeat(40), modelTransport(), ui, { port })
            val join = JSONObject(owner.prepare())
            val handle = owner.createMedia(join.getJSONObject("grant").getString("session_id"))
            assertTrue(runCatching { owner.closeMedia(handle) }.isFailure)
            assertTrue(runCatching { owner.closeMedia(handle) }.isFailure)
            assertTrue(runCatching { owner.close() }.isFailure)
            assertTrue(runCatching { owner.close() }.isFailure)
        }
    }
}
