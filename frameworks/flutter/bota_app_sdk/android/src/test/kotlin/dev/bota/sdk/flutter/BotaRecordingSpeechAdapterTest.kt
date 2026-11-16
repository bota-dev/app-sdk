package dev.bota.sdk.flutter

import dev.bota.sdk.speech.RecordingSpeechConnection
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BotaRecordingSpeechAdapterTest {
    private val id = "0123456789abcdef0123456789abcdef"
    @Test fun closeDuringAdmissionJoinsAndClosesTheEventuallyCreatedOwner() = runTest {
        val admitted = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val port = RecordingPort()
        val events = mutableListOf<BotaRecordingSpeechEventMessage>()
        val adapter = BotaAndroidRecordingSpeechAdapter({ events += it }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _, status -> admitted.complete(Unit); release.await(); status("interrupted"); port }
        val starting = async { runCatching { adapter.start(id, "activity") } }
        admitted.await()
        val closing = async { adapter.close(id) }
        runCurrent()
        assertFalse(closing.isCompleted)
        release.complete(Unit)
        assertEquals("closed", (starting.await().exceptionOrNull() as FlutterError).code)
        closing.await()
        assertEquals(1, port.closes)
        assertTrue(events.isEmpty())
        adapter.destroy()
    }
    @Test fun targetAndFinishStayOnTheNativeOwnerAndLateCallbacksAreRetired() = runTest {
        val port = RecordingPort()
        var callback: ((String) -> Unit)? = null
        val events = mutableListOf<BotaRecordingSpeechEventMessage>()
        val adapter = BotaAndroidRecordingSpeechAdapter({ events += it }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { activity, _, status -> assertEquals("activity", activity); callback = status; port }
        adapter.start(id, "activity")
        adapter.changeTarget(id, "ja", "change")
        assertTrue(adapter.qualifyHeadphones(id))
        adapter.finish(id)
        assertEquals(listOf("target:ja:change", "headphones", "finish"), port.calls)
        callback!!("archive_unavailable")
        assertEquals("archive_unavailable", events.single().status)
        adapter.close(id)
        callback!!("interrupted")
        assertEquals(1, events.size)
        adapter.destroy()
    }
    @Test fun slowDartDoesNotCreateAnUnboundedCaptionQueue() = runTest {
        val port = RecordingPort()
        val blocked = CompletableDeferred<Unit>()
        var callback: ((String) -> Unit)? = null
        var delivered = 0
        val adapter = BotaAndroidRecordingSpeechAdapter({ delivered++; blocked.await() }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _, status -> callback = status; port }
        adapter.start(id, "activity")
        repeat(40) { callback!!("interrupted") }
        adapter.destroy()
        assertEquals(1, delivered)
        assertEquals(1, port.closes)
    }
    @Test fun synchronousOverflowDisposesTheOwnerAndPrivateErrorsAreRedacted() = runTest {
        val port = RecordingPort()
        val adapter = BotaAndroidRecordingSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _, status -> repeat(40) { status("interrupted") }; port }
        assertEquals("bridgeOverflow", (runCatching { adapter.start(id, "activity") }.exceptionOrNull() as FlutterError).code)
        assertEquals(1, port.closes)
        adapter.destroy()
        val failing = BotaAndroidRecordingSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        failing.setFactory { _, _, _ -> error("PRIVATE_TOKEN") }
        val error = runCatching { failing.start(id, "activity") }.exceptionOrNull() as FlutterError
        assertEquals("unavailable", error.code)
        assertEquals("unavailable", error.message)
        assertNull(error.details)
        failing.destroy()
    }
}
private class RecordingPort : RecordingSpeechConnection {
    var closes = 0
    val calls = mutableListOf<String>()
    override suspend fun changeTarget(language: String, requestId: String) { calls += "target:$language:$requestId" }
    override suspend fun qualifyHeadphones(): Boolean { calls += "headphones"; return true }
    override suspend fun finish() { calls += "finish" }
    override suspend fun close() { closes++ }
}
