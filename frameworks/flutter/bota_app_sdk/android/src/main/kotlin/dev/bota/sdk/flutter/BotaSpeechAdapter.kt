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

/** The native App prepares the initial scoped grant before Dart starts. This
 * factory must promptly create a fresh owner with the supplied observer. HTTP
 * callbacks, credentials and media ports remain native. Invoke on the main thread. */
public fun interface BotaFlutterSpeechFactory {
    public fun create(sessionId: String, observer: SpeechObserver): SpeechSession
}

/** Native display metadata only; audio, scoped keys and retry cursors stay native. */
public data class BotaFlutterSpeechOriginalView(public val enabled: Boolean = false, public val capturing: Boolean = false,
    public val finished: Boolean = false, public val rtcAvailable: Boolean = true, public val status: String = "",
    public val passages: List<String> = emptyList()) {
    override fun toString(): String = "BotaFlutterSpeechOriginalView(content redacted)"
}
public fun interface BotaFlutterSpeechConnectionFactory {
    public fun create(sessionId: String, observer: SpeechObserver): BotaFlutterSpeechConnection
}
/** A native App may compose RTC with an independent original owner. close must
 * join both; original controls remain callable after RTC media failure. */
public interface BotaFlutterSpeechConnection {
    public val state: SpeechState
    public suspend fun ready()
    public suspend fun setInput(enabled: Boolean)
    public suspend fun setListening(enabled: Boolean)
    public suspend fun changeSubscription(selection: SpeechSelection)
    public suspend fun resumeAudio()
    public suspend fun recoverCaptions(): SpeechCaptionRecovery
    public suspend fun finishInput(): SpeechSourceFinish
    public suspend fun originalView(): BotaFlutterSpeechOriginalView = BotaFlutterSpeechOriginalView()
    public suspend fun finishOriginal(): Unit = throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_UNAVAILABLE)
    public suspend fun close()
}
internal typealias FlutterSpeechSession = BotaFlutterSpeechConnection

internal class NativeFlutterSpeechSession(private val session: SpeechSession) : FlutterSpeechSession {
    override val state: SpeechState get() = session.state.value
    override suspend fun ready() { session.ready.await() }
    override suspend fun setInput(enabled: Boolean) = session.setInput(enabled)
    override suspend fun setListening(enabled: Boolean) = session.setListening(enabled)
    override suspend fun changeSubscription(selection: SpeechSelection) = session.changeSubscription(selection)
    override suspend fun resumeAudio() = session.resumeAudio()
    override suspend fun recoverCaptions(): SpeechCaptionRecovery = session.recoverCaptions()
    override suspend fun finishInput(): SpeechSourceFinish = session.finishInput()
    override suspend fun close() = session.close()
}

internal class BotaAndroidSpeechAdapter(
    private val emit: suspend (BotaSpeechEventMessage) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val terminal: (BotaSpeechEventMessage) -> Unit = {},
) : BotaSpeechHostApi {
    private class Slot(val id: String) {
        var port: FlutterSpeechSession? = null
        val retired = AtomicBoolean(false)
        val events = Channel<BotaSpeechEventMessage>(32)
        var pump: Job? = null
        var constructing = true
        val calls = mutableSetOf<CompletableDeferred<Unit>>()
    }
    private data class Closed(val id: String, val task: Deferred<Unit>)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var factory: ((String, SpeechObserver) -> FlutterSpeechSession)? = null
    private var current: Slot? = null
    private var closed: Closed? = null
    private var failedOwner: Slot? = null
    private var destroyed = false
    private var shutdown: Deferred<Unit>? = null

    fun setFactory(factory: (String, SpeechObserver) -> FlutterSpeechSession) {
        if (destroyed) throw failure("closed")
        if (current != null || closed != null) throw failure("busy")
        this.factory = factory
    }

    override suspend fun start(connectionId: String, sessionId: String): BotaSpeechStateMessage = withContext(dispatcher) {
        if (destroyed) throw failure("closed")
        if (!connectionId.matches(Regex("^[0-9a-f]{32}$")) || sessionId.isEmpty() || sessionId.toByteArray().size > 256) {
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
            slot.port = create(sessionId, observer(slot))
            slot.constructing = false
            if (slot.retired.get()) throw failure("bridgeOverflow")
            slot.pump = scope.launch {
                try {
                    for (event in slot.events) {
                        if (current !== slot || slot.retired.get()) break
                        emit(event)
                    }
                } catch (_: Throwable) { if (current === slot) failClosed(slot, "bridgeUnavailable") }
            }
            call(connectionId) { it.ready(); state(it.state) }
        } catch (error: Throwable) {
            slot.constructing = false
            if (current === slot) beginClose(slot).await()
            throw mapped(error)
        }
    }

    override suspend fun setInput(connectionId: String, enabled: Boolean): Unit = call(connectionId) { it.setInput(enabled) }
    override suspend fun setListening(connectionId: String, enabled: Boolean): Unit = call(connectionId) { it.setListening(enabled) }
    override suspend fun changeSubscription(connectionId: String, selection: BotaSpeechSelectionMessage): Unit {
        val value = SpeechSelection(selection.targetLanguage, when (selection.mode) {
            "translated" -> SpeechListeningMode.TRANSLATED
            "original" -> SpeechListeningMode.ORIGINAL
            "captions_only" -> SpeechListeningMode.CAPTIONS_ONLY
            else -> throw failure("invalidInput")
        }, selection.sourceParticipantIds.toList())
        call(connectionId) { it.changeSubscription(value) }
    }
    override suspend fun resumeAudio(connectionId: String): Unit = call(connectionId) { it.resumeAudio() }
    override suspend fun recoverCaptions(connectionId: String): BotaSpeechRecoveryMessage = call(connectionId) { recovery(it.recoverCaptions()) }
    override suspend fun finishInput(connectionId: String): BotaSpeechFinishMessage = call(connectionId) { finish(it.finishInput()) }
    override suspend fun originalView(connectionId: String): BotaSpeechOriginalMessage = call(connectionId) {
        val value = it.originalView()
        if (value.status.toByteArray().size > 1024 || value.passages.size > 64 || value.passages.sumOf { text -> text.toByteArray().size } > 327680) throw failure("unavailable")
        BotaSpeechOriginalMessage(value.enabled, value.capturing, value.finished, value.rtcAvailable, value.status, value.passages.toList())
    }
    override suspend fun finishOriginal(connectionId: String): Unit = call(connectionId) { it.finishOriginal() }
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

    private suspend fun <T> call(id: String, body: suspend (FlutterSpeechSession) -> T): T = withContext(dispatcher) {
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
            try { slot.port?.close() }
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

    private fun offer(slot: Slot, event: BotaSpeechEventMessage) {
        if (slot.retired.get()) return
        if (slot.events.trySend(event).isFailure && slot.retired.compareAndSet(false, true)) {
            slot.events.cancel()
            scope.launch { if (current === slot && !slot.constructing) failClosed(slot, "bridgeOverflow") }
        }
    }
    private fun failClosed(slot: Slot, code: String) {
        beginClose(slot)
        try { terminal(BotaSpeechEventMessage(slot.id, errorCode = code)) } catch (_: Throwable) { /* Cleanup remains owned. */ }
    }
    private fun observer(slot: Slot) = object : SpeechObserver {
        override fun stateChanged(state: SpeechState) = offer(slot, BotaSpeechEventMessage(slot.id, state = Companion.state(state)))
        override fun caption(caption: SpeechCaption) = offer(slot, BotaSpeechEventMessage(slot.id, caption = Companion.caption(caption)))
        override fun error(error: SpeechSessionException) = offer(slot, BotaSpeechEventMessage(slot.id, errorCode = code(error.code)))
    }

    private companion object {
        fun code(value: SpeechErrorCode): String = value.name.lowercase().split('_').let { words ->
            words.first() + words.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercase) }
        }
        val allowed = SpeechErrorCode.entries.map(::code).toSet() + setOf("busy", "unavailable", "bridgeOverflow", "bridgeUnavailable")
        fun failure(code: String): FlutterError = FlutterError(code, code, null)
        fun mapped(error: Throwable): FlutterError = when (error) {
            is SpeechSessionException -> failure(code(error.code))
            is CancellationException -> failure("closed")
            is FlutterError -> failure(error.code.takeIf { it in allowed } ?: "unavailable")
            else -> failure("unavailable")
        }
        fun recovery(value: SpeechCaptionRecovery) = BotaSpeechRecoveryMessage(value.status, value.hasMore)
        fun finish(value: SpeechSourceFinish) = BotaSpeechFinishMessage(value.status, value.holdPublication, value.trackSid,
            value.source?.let { BotaSpeechFinishedSourceMessage(it.id, it.epoch.toString(), it.participantId,
                it.memberGeneration.toLong(), it.trackSid, it.state, it.finish.state,
                it.finish.workerGeneration.toLong(), it.finish.sequence, it.finish.samples) })
        fun state(value: SpeechState) = BotaSpeechStateMessage(value.connected, value.disconnect, value.canCapture,
            value.canPlay, value.subscriptionRevision.toLong(), value.changeId.toLong(), value.clearGeneration.toLong(),
            value.clearPlayback, value.expiresAtMs, value.gap, value.tracks.map {
                BotaSpeechTrackMessage(it.mediaTrackSid, it.sourceId, it.sourceEpoch.toString(), it.sourceParticipantId, it.origin, it.outputId)
            }, recovery(value.recovery), finish(value.sourceFinish))
        fun caption(value: SpeechCaption) = BotaSpeechCaptionMessage(value.key, value.origin, value.isFinal,
            value.subscriptionRevision.toLong(), value.sequence, value.sourceId, value.sourceEpoch.toString(),
            value.sourceParticipantId, value.sourceMemberGeneration.toLong(), value.unitId,
            value.sourceFirstSeq.toString(), value.sourceLastSeq.toString(), value.startMs, value.endMs,
            value.sourceLanguage, value.targetLanguage, value.text)
    }
}

internal suspend fun deliverSpeechEvent(api: BotaSpeechFlutterApi, event: BotaSpeechEventMessage): Unit = withTimeout(5_000) {
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
