package dev.bota.speech.companion

import dev.bota.sdk.speech.RecordingSpeechConnection
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.json.JSONArray

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [26])
class RecordingLabBridgeTest {
    private class Owner : RecordingSpeechConnection {
        var closed = 0; var finished = false; var target = ""; var failClose = false
        override suspend fun changeTarget(language: String, requestId: String) { target = language }
        override suspend fun qualifyHeadphones() = true
        override suspend fun finish() { finished = true }
        override suspend fun close() { closed++; if (failClose) throw LabFailure() }
    }
    @Test fun typedControlsAndBoundedTextAreTheOnlyBridgeOutputs() = runBlocking {
        val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Default); val native = Owner()
        var report: ((String) -> Unit)? = null
        val bridge = RecordingLabBridge({ _, _, status -> report = status; native }, tasks)
        val id = "a".repeat(32)
        try {
            bridge.start(id, "activity"); report!!("interrupted")
            assertEquals("interrupted", JSONArray(bridge.events(id)).getJSONObject(0).getString("status"))
            bridge.call(id) { it.changeTarget("ja", "change-1") }; assertEquals("ja", native.target)
            assertTrue(bridge.call(id) { it.qualifyHeadphones() }); bridge.call(id) { it.finish() }; assertTrue(native.finished)
            bridge.close(id); assertEquals(1, native.closed)
        } finally { tasks.cancel() }
    }
    @Test fun closeJoinsNonCooperativeAdmissionAndClosesItsLateOwner() = runBlocking {
        val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Default); val native = Owner()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val bridge = RecordingLabBridge({ _, _, _ -> entered.complete(Unit); withContext(NonCancellable) { release.await(); native } }, tasks)
        val id = "b".repeat(32)
        val starting = tasks.async { runCatching { bridge.start(id, "activity") } }
        withTimeout(5000) { entered.await() }; val closing = tasks.async(start = CoroutineStart.UNDISPATCHED) { bridge.close(id) }; assertFalse(closing.isCompleted)
        release.complete(Unit); withTimeout(5000) { closing.await(); starting.await() }
        assertEquals(1, native.closed); tasks.cancel()
    }
    @Test fun cleanupFailureBlocksAReplacementOwner() = runBlocking {
        val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Default); val native = Owner().apply { failClose = true }
        val bridge = RecordingLabBridge({ _, _, _ -> native }, tasks); val id = "c".repeat(32)
        bridge.start(id, "activity"); assertTrue(runCatching { bridge.close(id) }.isFailure)
        assertTrue(runCatching { bridge.start("d".repeat(32), "other") }.isFailure); assertEquals(1, native.closed); tasks.cancel()
    }
    @Test fun failedPartialCreationCannotHideCleanupFailure() = runBlocking {
        val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var calls = 0
        val bridge = RecordingLabBridge({ _, _, _ -> calls++; throw RecordingCleanupFailure() }, tasks)
        try {
            assertTrue(runCatching { bridge.start("e".repeat(32), "activity") }.isFailure)
            assertTrue(runCatching { bridge.close() }.isFailure)
            assertTrue(runCatching { bridge.start("f".repeat(32), "other") }.isFailure)
            assertEquals(1, calls)
        } finally { tasks.cancel() }
    }
}
