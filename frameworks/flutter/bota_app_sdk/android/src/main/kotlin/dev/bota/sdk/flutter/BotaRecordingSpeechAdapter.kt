package dev.bota.sdk.flutter

import dev.bota.sdk.speech.*
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

import org.json.JSONObject

/** Native HTTP admission and grant acquisition remain in the host. The factory
 * starts a fresh direct owner; callbacks contain validated caption/status only. */
public fun interface BotaFlutterRecordingSpeechFactory {
    public suspend fun create(activityId: String, onCaption: (ByteArray) -> Unit,
        onStatus: (String) -> Unit): RecordingSpeechConnection
}

internal class BotaAndroidRecordingSpeechAdapter(
    private val emit: suspend (BotaRecordingSpeechEventMessage) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val terminal: (BotaRecordingSpeechEventMessage) -> Unit = {},
) : BotaRecordingSpeechHostApi {
    private class Slot(val id: String) {
        var port: RecordingSpeechConnection? = null
        val retired = AtomicBoolean(false)
        val events = Channel<BotaRecordingSpeechEventMessage>(32)
        var pump: Job? = null
        var constructing = true
        val created = CompletableDeferred<Unit>()
        val calls = mutableSetOf<CompletableDeferred<Unit>>()
    }
    private data class Closed(val id: String, val task: Deferred<Unit>)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var factory: BotaFlutterRecordingSpeechFactory? = null
    private var current: Slot? = null
    private var closed: Closed? = null
    private var failedOwner: Slot? = null
    private var destroyed = false
    private var shutdown: Deferred<Unit>? = null

    fun setFactory(factory: BotaFlutterRecordingSpeechFactory) {
        if (destroyed) throw failure("closed")
        if (current != null || closed != null) throw failure("busy")
        this.factory = factory
    }

    override suspend fun start(connectionId: String, activityId: String): Unit = withContext(dispatcher) {
        if (destroyed) throw failure("closed")
        if (!connectionId.matches(Regex("^[0-9a-f]{32}$")) || activityId.isEmpty() || activityId.toByteArray().size > 256) {
            throw failure("invalidInput")
        }
        if (current != null) throw failure("busy")
        closed?.task?.await()
        if (destroyed) throw failure("closed")
        if (current != null) throw failure("busy")
        val create = factory ?: throw failure("unavailable")
        val slot = Slot(connectionId)
        current = slot
        try {
            try {
                slot.port = create.create(activityId,
                    { bytes -> caption(slot, bytes) },
                    { code -> offer(slot, BotaRecordingSpeechEventMessage(slot.id, status = status(code))) })
            } finally { slot.constructing = false; slot.created.complete(Unit) }
            if (current !== slot || destroyed) throw failure("closed")
            if (slot.retired.get()) throw failure("bridgeOverflow")
            slot.pump = scope.launch {
                try {
                    for (event in slot.events) {
                        if (current !== slot || slot.retired.get()) break
                        emit(event)
                    }
                } catch (_: Throwable) { if (current === slot) failClosed(slot, "bridgeUnavailable") }
            }
            if (current !== slot || destroyed) throw failure("closed")
        } catch (error: Throwable) {
            slot.constructing = false
            if (current === slot) beginClose(slot).await()
            throw mapped(error)
        }
    }

    override suspend fun changeTarget(connectionId: String, language: String, requestId: String): Unit = call(connectionId) { it.changeTarget(language, requestId) }
    override suspend fun qualifyHeadphones(connectionId: String): Boolean = call(connectionId) { it.qualifyHeadphones() }
    override suspend fun finish(connectionId: String): Unit = call(connectionId) { it.finish() }
    override suspend fun close(connectionId: String): Unit = withContext(dispatcher) {
        val slot = current
        if (slot != null && slot.id == connectionId) beginClose(slot).await()
        else closed?.takeIf { it.id == connectionId }?.task?.await()
    }
    override suspend fun destroy(): Unit = withContext(dispatcher) { retire().await() }

    /** Called synchronously on the main thread when the Flutter engine detaches. */
    fun retire(): Deferred<Unit> {
        shutdown?.let { return it }
        destroyed = true; factory = null
        val cleanup = current?.let(::beginClose) ?: closed?.task
        return scope.async(start = CoroutineStart.LAZY) { cleanup?.await(); Unit }.also { shutdown = it; it.start() }
    }

    private suspend fun <T> call(id: String, body: suspend (RecordingSpeechConnection) -> T): T = withContext(dispatcher) {
        val slot = current?.takeIf { it.id == id && !it.retired.get() }
        val port = slot?.port
        if (destroyed || slot == null || port == null) throw failure("closed")
        if (slot.calls.size >= 32) throw failure("busy")
        val done = CompletableDeferred<Unit>(); slot.calls += done
        try {
            val result = body(port)
            if (current !== slot || destroyed || slot.retired.get()) throw failure("closed")
            result
        } catch (error: Throwable) {
            if (error is CancellationException && current === slot) beginClose(slot)
            throw mapped(error)
        } finally { slot.calls -= done; done.complete(Unit) }
    }

    private fun beginClose(slot: Slot): Deferred<Unit> {
        if (current !== slot) return closed!!.task
        current = null; slot.retired.set(true); slot.events.cancel(); slot.pump?.cancel()
        val calls = slot.calls.toList()
        val task = scope.async(start = CoroutineStart.LAZY) {
            try { slot.created.await(); slot.port?.close() }
            catch (_: Throwable) {
                failedOwner = slot
                slot.pump?.join()
                throw failure("cleanupFailed")
            }
            calls.forEach { it.await() }
            slot.pump?.join()
            Unit
        }
        closed = Closed(slot.id, task); task.start(); return task
    }

    private fun offer(slot: Slot, event: BotaRecordingSpeechEventMessage) {
        if (slot.retired.get()) return
        if (slot.events.trySend(event).isFailure && slot.retired.compareAndSet(false, true)) {
            slot.events.cancel()
            scope.launch { if (current === slot && !slot.constructing) failClosed(slot, "bridgeOverflow") }
        }
    }
    private fun failClosed(slot: Slot, code: String) {
        beginClose(slot)
        try { terminal(BotaRecordingSpeechEventMessage(slot.id, status = code)) } catch (_: Throwable) { /* Cleanup remains owned. */ }
    }
    private fun caption(slot: Slot, bytes: ByteArray) {
        try {
            require(bytes.size <= 32768)
            val event = JSONObject(bytes.toString(Charsets.UTF_8))
            val c = event.getJSONObject("caption")
            val value = BotaRecordingSpeechCaptionMessage(c.getString("unitId"), c.getString("sourceId"),
                c.getLong("sourceEpoch"), c.getLong("revision"), c.getLong("startSample"), c.getLong("endSample"),
                c.getString("sourceLanguage"), if (c.has("targetLanguage")) c.getString("targetLanguage") else null,
                c.getString("text"), event.getBoolean("final"))
            offer(slot, BotaRecordingSpeechEventMessage(slot.id, caption = value))
        } catch (_: Throwable) {
            scope.launch { if (current === slot && !slot.constructing) failClosed(slot, "invalidInput") }
        } finally { bytes.fill(0) }
    }
    private companion object {
        val allowed = setOf("invalidInput", "closed", "busy", "unavailable", "cleanupFailed", "bridgeOverflow", "bridgeUnavailable")
        val statuses = setOf("interrupted", "output_skipped", "archive_unavailable", "capture_interrupted")
        fun status(code: String): String = code.takeIf { it in statuses } ?: "interrupted"
        fun failure(code: String): FlutterError = FlutterError(code, code, null)
        fun mapped(error: Throwable): FlutterError = when (error) {
            is CancellationException -> failure("closed")
            is FlutterError -> failure(error.code.takeIf { it in allowed } ?: "unavailable")
            else -> failure("unavailable")
        }
    }
}

internal suspend fun deliverRecordingSpeechEvent(api: BotaRecordingSpeechFlutterApi, event: BotaRecordingSpeechEventMessage): Unit = withTimeout(5_000) {
    suspendCancellableCoroutine { continuation ->
        val replied = AtomicBoolean(false)
        api.onEvent(event) { result ->
            if (replied.compareAndSet(false, true)) continuation.resumeWith(result.fold(
                onSuccess = { Result.success(Unit) },
                onFailure = { Result.failure(IllegalStateException("bridgeUnavailable")) },
            ))
        }
    }
}
