package dev.bota.speech.companion

import dev.bota.sdk.speech.RecordingSpeechConnection
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** Bounded native control mailbox for React Native; no PCM or grant leaves it. */
internal class RecordingLabBridge(
    private val factory: suspend (String, (ByteArray) -> Unit, (String) -> Unit) -> RecordingSpeechConnection,
    private val tasks: CoroutineScope,
) {
    private class Entry(val id: String) {
        val events = ArrayDeque<String>(); var bytes = 0; var stopped = false; var overflow = false
        var pending: Deferred<RecordingSpeechConnection>? = null
        val created = CompletableDeferred<RecordingSpeechConnection?>()
        var owner: RecordingSpeechConnection? = null
        var cleanupFailure: RecordingCleanupFailure? = null
        var closing: Deferred<Unit>? = null
        val commands = mutableSetOf<Deferred<*>>()
    }
    private val lock = Any()
    private var current: Entry? = null
    private var previous: Deferred<Unit>? = null
    suspend fun start(id: String, activityId: String) {
        require(Regex("[a-f0-9]{32}").matches(id))
        val entry = synchronized(lock) { check(current == null && (previous == null || previous!!.isCompleted && !previous!!.isCancelled)); Entry(id).also { current = it } }
        fun emit(value: JSONObject) {
            val text = value.toString(); val size = text.toByteArray().size
            val overflow = synchronized(lock) {
                if (entry.stopped || current !== entry) return
                if (size > 32768 || entry.events.size >= 32 || entry.bytes + size > 524288) { entry.overflow = true; true }
                else { entry.events.addLast(text); entry.bytes += size; false }
            }
            if (overflow) tasks.launch { runCatching { close(id) } }
        }
        val task = tasks.async(start = CoroutineStart.LAZY) {
            var acquired: RecordingSpeechConnection? = null
            try { factory(activityId, { bytes ->
                try { require(bytes.size <= 32768); emit(JSONObject(bytes.toString(Charsets.UTF_8))) }
                finally { bytes.fill(0) }
            }, { status -> if (status in listOf("interrupted","output_skipped","archive_unavailable","capture_interrupted")) emit(JSONObject().put("type", "status").put("status", status)) }).also { acquired = it } }
            catch (error: RecordingCleanupFailure) { synchronized(lock) { entry.cleanupFailure = error }; throw error }
            finally { entry.created.complete(acquired) }
        }
        task.invokeOnCompletion { entry.created.complete(null) }
        synchronized(lock) { entry.pending = task; task.start() }
        try {
            val owner = task.await()
            synchronized(lock) { entry.owner = owner; check(!entry.stopped && !entry.overflow && current === entry) }
        } catch (error: Throwable) { withContext(NonCancellable) { close(id) }; throw error }
    }
    suspend fun <T> call(id: String, action: suspend (RecordingSpeechConnection) -> T): T {
        val (entry, task) = synchronized(lock) {
            val entry = current ?: throw LabFailure(); check(entry.id == id && !entry.stopped && !entry.overflow && entry.commands.size < 32)
            val owner = entry.owner ?: throw LabFailure()
            val task = tasks.async(start = CoroutineStart.LAZY) { action(owner) }; entry.commands.add(task); task.start(); entry to task
        }
        try { return task.await().also { synchronized(lock) { check(!entry.stopped && current === entry) } } }
        finally { synchronized(lock) { entry.commands.remove(task) } }
    }
    fun events(id: String): String = synchronized(lock) {
        val entry = current ?: throw LabFailure(); check(entry.id == id && !entry.stopped && !entry.overflow)
        JSONArray().apply { while (entry.events.isNotEmpty()) put(JSONObject(entry.events.removeFirst())) }.toString().also { entry.bytes = 0 }
    }
    suspend fun close(id: String? = null): Unit = withContext(NonCancellable) {
        val cleanup = synchronized(lock) {
            val entry = current
            if (entry == null) return@synchronized previous
            check(id == null || entry.id == id)
            entry.closing ?: run {
                entry.stopped = true; entry.events.clear(); entry.bytes = 0
                entry.commands.forEach { it.cancel() }
                val pending = entry.pending; val commands = entry.commands.toList()
                tasks.async(NonCancellable, start = CoroutineStart.LAZY) {
                    // Await even a non-cooperative admission and retire its late owner.
                    pending?.join()
                    val owner = entry.owner ?: entry.created.await()
                    try { owner?.close(); commands.joinAll(); entry.cleanupFailure?.let { throw it }; Unit }
                    finally { synchronized(lock) { if (current === entry) current = null } }
                }.also { entry.closing = it; previous = it; it.start() }
            }
        }
        cleanup?.await()
    }
}
