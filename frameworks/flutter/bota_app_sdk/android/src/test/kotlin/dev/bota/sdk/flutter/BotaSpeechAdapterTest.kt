package dev.bota.sdk.flutter

import dev.bota.sdk.speech.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BotaSpeechAdapterTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private val nextId = "abcdef0123456789abcdef0123456789"

    @Test fun closeDuringReadyRetiresCallbacksAndJoinsNativeOwner() = runTest {
        val port = TestSpeechPort(readyNow = false, closeNow = false)
        val events = mutableListOf<BotaSpeechEventMessage>()
        lateinit var observer: SpeechObserver
        val adapter = BotaAndroidSpeechAdapter({ events += it }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, sink -> observer = sink; port }
        val starting = async(start = CoroutineStart.UNDISPATCHED) { runCatching { adapter.start(id, "session") } }
        port.readyEntered.await()
        val closing = async(start = CoroutineStart.UNDISPATCHED) { adapter.close(id) }
        port.closeEntered.await()
        observer.stateChanged(port.state)
        assertTrue(events.isEmpty())
        port.closeGate.complete(Unit)
        assertFalse(closing.isCompleted)
        port.readyGate.complete(Unit)
        assertEquals("closed", (starting.await().exceptionOrNull() as FlutterError).code)
        closing.await()
        adapter.close(id)
        assertEquals(1, port.closeCalls)
        adapter.destroy()
    }

    @Test fun independentControlsFinishRecoveryAndReplacementUseOnlyCurrentSession() = runTest {
        val ports = mutableListOf<TestSpeechPort>()
        val observers = mutableListOf<SpeechObserver>()
        val events = mutableListOf<BotaSpeechEventMessage>()
        val adapter = BotaAndroidSpeechAdapter({ events += it }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, observer -> observers += observer; TestSpeechPort().also { ports += it } }
        adapter.start(id, "first")
        adapter.setInput(id, true)
        adapter.setListening(id, false)
        adapter.changeSubscription(id, BotaSpeechSelectionMessage("ja", "translated", listOf("other")))
        assertEquals(listOf("input:true", "listening:false", "selection:ja:TRANSLATED:other"), ports[0].controls)
        assertEquals("completed", adapter.finishInput(id).status)
        assertEquals("complete", adapter.recoverCaptions(id).status)
        adapter.close(id)
        adapter.start(nextId, "second")
        observers[0].stateChanged(ports[0].state)
        assertTrue(events.isEmpty())
        observers[1].stateChanged(ports[1].state)
        assertEquals(nextId, events.single().connectionId)
        adapter.close(id)
        assertEquals(0, ports[1].closeCalls)
        adapter.destroy()
        assertEquals(1, ports[1].closeCalls)
        assertEquals("closed", (runCatching { adapter.start(id, "third") }.exceptionOrNull() as FlutterError).code)
    }

    @Test fun cleanupFailureIsStableAndPreventsReuse() = runTest {
        val port = TestSpeechPort().also { it.closeError = IllegalStateException("PRIVATE_TOKEN") }
        val adapter = BotaAndroidSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _ -> port }
        adapter.start(id, "session")
        repeat(2) {
            val error = runCatching { adapter.close(id) }.exceptionOrNull() as FlutterError
            assertEquals("cleanupFailed", error.code)
            assertFalse(error.toString().contains("PRIVATE_TOKEN"))
        }
        assertEquals("cleanupFailed", (runCatching { adapter.start(nextId, "other") }.exceptionOrNull() as FlutterError).code)
        assertEquals(1, port.closeCalls)
        runCatching { adapter.destroy() }
    }

    @Test fun slowDartConsumerIsBoundedAndEngineDestroyDoesNotWaitForItsReply() = runTest {
        val blocked = CompletableDeferred<Unit>()
        val sent = CompletableDeferred<Unit>()
        val port = TestSpeechPort()
        lateinit var observer: SpeechObserver
        var deliveries = 0
        val adapter = BotaAndroidSpeechAdapter({ deliveries++; sent.complete(Unit); blocked.await() }, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, sink -> observer = sink; port }
        adapter.start(id, "session")
        observer.stateChanged(port.state)
        sent.await()
        repeat(40) { observer.stateChanged(port.state) }
        port.closeEntered.await()
        adapter.destroy()
        assertEquals(1, deliveries)
        assertEquals(1, port.closeCalls)
        observer.stateChanged(port.state)
        assertEquals(1, deliveries)
    }

    @Test fun missingFactoryAndInvalidIdsFailBeforeAnySession() = runTest {
        val adapter = BotaAndroidSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        assertEquals("unavailable", (runCatching { adapter.start(id, "session") }.exceptionOrNull() as FlutterError).code)
        var created = 0
        adapter.setFactory { _, _ -> created++; TestSpeechPort() }
        assertEquals("invalidInput", (runCatching { adapter.start("invalid", "session") }.exceptionOrNull() as FlutterError).code)
        assertEquals(0, created)
        adapter.destroy()
    }

    @Test fun synchronousFactoryOverflowStillDisposesItsReturnedOwner() = runTest {
        val port = TestSpeechPort()
        val adapter = BotaAndroidSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, observer -> repeat(40) { observer.stateChanged(port.state) }; port }
        assertEquals("bridgeOverflow", (runCatching { adapter.start(id, "session") }.exceptionOrNull() as FlutterError).code)
        assertEquals(1, port.closeCalls)
        adapter.destroy()
    }

    @Test fun cancellingCloseWaiterDoesNotCancelCleanup() = runTest {
        val port = TestSpeechPort(closeNow = false)
        val adapter = BotaAndroidSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _ -> port }
        adapter.start(id, "session")
        val cancelled = async(start = CoroutineStart.UNDISPATCHED) { adapter.close(id) }
        port.closeEntered.await()
        cancelled.cancelAndJoin()
        val joined = async(start = CoroutineStart.UNDISPATCHED) { adapter.destroy() }
        assertFalse(joined.isCompleted)
        port.closeGate.complete(Unit)
        joined.await()
        assertEquals(1, port.closeCalls)
    }

    @Test fun nativeFactoryErrorDetailsAreRedacted() = runTest {
        val adapter = BotaAndroidSpeechAdapter({}, UnconfinedTestDispatcher(testScheduler))
        adapter.setFactory { _, _ -> throw FlutterError("PRIVATE_TOKEN", "PRIVATE_TOKEN", "PRIVATE_TOKEN") }
        val error = runCatching { adapter.start(id, "session") }.exceptionOrNull() as FlutterError
        assertEquals("unavailable", error.code)
        assertEquals("unavailable", error.message)
        assertNull(error.details)
        adapter.destroy()
    }
}

private class TestSpeechPort(readyNow: Boolean = true, closeNow: Boolean = true) : FlutterSpeechSession {
    val readyGate = CompletableDeferred<Unit>().also { if (readyNow) it.complete(Unit) }
    val closeGate = CompletableDeferred<Unit>().also { if (closeNow) it.complete(Unit) }
    val readyEntered = CompletableDeferred<Unit>()
    val closeEntered = CompletableDeferred<Unit>()
    var closeCalls = 0
    var closeError: Throwable? = null
    val controls = mutableListOf<String>()
    override val state = SpeechState(true, false, false, false, 1, 0, 0, false, 5000, false,
        emptyList(), SpeechCaptionRecovery("idle", null, false, null), SpeechSourceFinish("idle", false, null, null, null))
    override suspend fun ready() { readyEntered.complete(Unit); readyGate.await() }
    override suspend fun setInput(enabled: Boolean) { controls += "input:$enabled" }
    override suspend fun setListening(enabled: Boolean) { controls += "listening:$enabled" }
    override suspend fun changeSubscription(selection: SpeechSelection) {
        controls += "selection:${selection.targetLanguage}:${selection.mode}:${selection.sourceParticipantIds.joinToString(",")}" }
    override suspend fun resumeAudio() {}
    override suspend fun finishInput() = SpeechSourceFinish("completed", false, "track", null, null)
    override suspend fun recoverCaptions() = SpeechCaptionRecovery("complete", "PRIVATE_CURSOR", false, null)
    override suspend fun close() { closeCalls++; closeEntered.complete(Unit); closeGate.await(); closeError?.let { throw it } }
}
