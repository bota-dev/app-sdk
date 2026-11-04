package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal data class CaptionPair(val id: String, val speaker: String, val original: String = "", val translation: String = "",
    val originalFinal: Boolean = false, val translationFinal: Boolean = false) {
    override fun toString() = "CaptionPair(content redacted)"
}
internal data class CompanionState(val connected: Boolean = false, val joining: Boolean = false,
    val closing: Boolean = false, val cleanupFailed: Boolean = false, val input: Boolean = false,
    val listening: Boolean = false, val canPlay: Boolean = false, val language: String = "zh",
    val mode: SpeechListeningMode = SpeechListeningMode.TRANSLATED, val languages: List<String> = listOf("en", "zh", "ja"),
    val pairs: List<CaptionPair> = emptyList(), val busy: Set<String> = emptySet(),
    val original: OriginalView = OriginalView(),
    val notice: String = "Choose a role and join your local session.")
private sealed interface UiEvent {
    data class State(val value: SpeechState) : UiEvent
    data class Caption(val value: SpeechCaption) : UiEvent
    data class Error(val value: SpeechSessionException) : UiEvent
}

/** UI lifetime only. The native SDK and Rust retain media, authorization and protocol policy. */
internal class CompanionModel(private val mediaFactory: (SpeechMediaCallbacks) -> SpeechMediaPort,
    private val canRecord: () -> Boolean, private val transport: () -> LabTransport = { NativeLabTransport() },
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val originalFactory: (suspend (LabHost, LabJoin, (OriginalView) -> Unit) -> LabOriginalOwner)? = null) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val mutable = MutableStateFlow(CompanionState())
    val state: StateFlow<CompanionState> = mutable.asStateFlow()
    var owner: UUID = UUID.randomUUID()
        private set
    private var session: SpeechSession? = null
    private var host: LabHost? = null
    private var original: LabOriginalOwner? = null
    private var initial: LabJoin? = null
    private var bootstrap: Deferred<LabJoin>? = null
    private var retirement: Deferred<Unit>? = null
    private var events: Channel<UiEvent>? = null
    private var pump: Job? = null
    private var retiredCaptionRevision = 0

    suspend fun join(origin: String, role: String, code: String): Unit = withContext(dispatcher) {
        if (state.value.let { it.connected || it.joining || it.closing || it.cleanupFailed } || session != null) return@withContext
        owner = UUID.randomUUID(); val current = owner
        update { copy(joining = true, notice = "Joining…") }
        try {
            val host = LabHost(origin, role, code, transport(), originalCapable = originalFactory != null); this@CompanionModel.host = host
            val pending = scope.async { host.join() }; bootstrap = pending
            val joined = pending.await()
            if (current != owner) return@withContext
            bootstrap = null; initial = joined; retiredCaptionRevision = 0
            if (joined.configuration.context.retention == SpeechRetention.ORIGINAL_AUDIO_AND_TEXT) {
                val acquired = (originalFactory ?: throw LabFailure())(host, joined) { value ->
                    if (current == owner) update { copy(original = value, input = value.capturing) }
                }
                if (current != owner) { acquired.close(); return@withContext }
                original = acquired
            }
            update { copy(language = joined.configuration.subscription.selection.targetLanguage,
                mode = joined.configuration.subscription.selection.mode, languages = joined.languages) }
            val queue = Channel<UiEvent>(32); events = queue
            fun offer(event: UiEvent) { if (queue.trySend(event).isFailure) queue.close(LabFailure()) }
            pump = scope.launch {
                try {
                    for (event in queue) {
                        if (current != owner) return@launch
                        receive(event)
                    }
                } catch (_: LabFailure) { if (current == owner) leave("The display could not keep up. Join again.") }
            }
            val selectedMedia = original?.let { retained -> { callbacks: SpeechMediaCallbacks -> retained.media(callbacks) } } ?: mediaFactory
            val native = SpeechSession.create(joined.configuration, joined.grant, selectedMedia, host, object : SpeechObserver {
                override fun stateChanged(state: SpeechState) = offer(UiEvent.State(state))
                override fun caption(caption: SpeechCaption) = offer(UiEvent.Caption(caption))
                override fun error(error: SpeechSessionException) = offer(UiEvent.Error(error))
            })
            session = native; native.ready.await()
            if (current != owner) return@withContext
            update { copy(connected = true, joining = false, notice = "Connected. Choose when to speak and listen.") }
        } catch (error: Exception) {
            if (current == owner) {
                leave("Could not join. Check the role, code and active session.")
                if (error is CancellationException) throw error
            }
        }
    }
    suspend fun leave(reason: String = "Left the session."): Unit = withContext(dispatcher + NonCancellable) {
        retirement?.let { runCatching { it.await() }; return@withContext }
        owner = UUID.randomUUID()
        val pending = bootstrap; val native = session; val host = host; val original = original
        bootstrap = null; session = null; this@CompanionModel.host = null; this@CompanionModel.original = null; initial = null
        pending?.cancel(); events?.close(); events = null; pump?.cancel(); pump = null
        update { copy(connected = false, joining = false, closing = true, input = false, listening = false,
            canPlay = false, pairs = emptyList(), original = OriginalView(), busy = emptySet(), notice = reason) }
        val task = scope.async(start = CoroutineStart.LAZY) {
            var failed = false
            host?.close()
            try { original?.finish() } catch (_: Exception) { failed = true }
            try { pending?.join(); native?.close() } catch (_: Exception) { failed = true }
            try { original?.close() } catch (_: Exception) { failed = true }
            if (failed) throw LabFailure()
            Unit
        }
        retirement = task; task.start()
        try { task.await() }
        catch (_: Exception) { update { copy(cleanupFailed = true, notice = "Audio cleanup failed. Close and reopen this App before joining again.") } }
        finally { retirement = null; update { copy(closing = false) } }
    }
    suspend fun setInput(enabled: Boolean, permissionOwner: UUID = owner): Unit = withContext(dispatcher) {
        if (permissionOwner != owner || "finish" in state.value.busy) return@withContext
        if (!enabled && original != null) {
            original?.finish()
            if (!state.value.connected) return@withContext
        }
        if (enabled && original?.finished == true) return@withContext
        if (enabled && !canRecord()) { update { copy(notice = "Microphone permission is required. Enable it in system settings, then try again.") }; return@withContext }
        if (run("input") { it.setInput(enabled); if (enabled) original?.start() }) update { copy(input = enabled && (this@CompanionModel.original?.capturing ?: true)) }
    }
    suspend fun setListening(enabled: Boolean): Unit = withContext(dispatcher) {
        if (run("listen") { it.setListening(enabled) }) update { copy(listening = enabled) }
    }
    suspend fun select(language: String, mode: SpeechListeningMode): Unit = withContext(dispatcher) {
        val joined = initial ?: return@withContext; val native = session ?: return@withContext
        if ("selection" in state.value.busy || language !in state.value.languages) return@withContext
        val previous = state.value
        retiredCaptionRevision = native.state.value.subscriptionRevision
        update { copy(language = language, mode = mode, pairs = emptyList()) }
        if (!run("selection") { it.changeSubscription(SpeechSelection(language, mode, listOf(joined.peerId))) } && state.value.connected) {
            update { copy(language = previous.language, mode = previous.mode, notice = "Preference update failed. Leave and join again to refresh it.") }
        }
    }
    suspend fun finish(): Unit = withContext(dispatcher) {
        if ("input" in state.value.busy) return@withContext
        original?.finish()
        if (!state.value.connected) return@withContext
        update { copy(input = false) }
        var result = "unavailable"
        if (run("finish") { result = it.finishInput().status }) {
            update { copy(notice = when (result) {
                "completed" -> "Input finished. Listening remains available."
                "no_source" -> "No input was started."
                else -> "Input finish was interrupted. Listening remains available."
            }) }
        }
    }
    suspend fun resumeAudio(): Unit = withContext(dispatcher) { run("resume") { it.resumeAudio() }; Unit }
    suspend fun recoverCaptions(): Unit = withContext(dispatcher) {
        var result = "unavailable"
        if (run("recovery") { result = it.recoverCaptions().status } && result == "unavailable") {
            update { copy(notice = "This session does not retain caption history.") }
        }
    }
    suspend fun dispose() { leave(); scope.cancel() }
    private suspend fun run(operation: String, action: suspend (SpeechSession) -> Unit): Boolean {
        val native = session ?: return false
        if (!state.value.connected || operation in state.value.busy) return false
        val current = owner; update { copy(busy = busy + operation) }
        try {
            action(native)
            return current == owner
        } catch (error: Exception) {
            if (current == owner) {
                if (native.state.value.disconnect && original?.rtcLost == true) rtcEnded()
                else if (native.state.value.disconnect || error is CancellationException) leave("The session ended. Join again with current authorization.")
                else update { copy(notice = "The action could not finish. Try again or leave the session.") }
            }
            if (error is CancellationException) throw error
            return false
        } finally { if (current == owner) update { copy(busy = busy - operation) } }
    }
    private suspend fun receive(event: UiEvent) {
        when (event) {
            is UiEvent.State -> {
                val state = session?.state?.value ?: event.value
                update { copy(input = this@CompanionModel.original?.capturing ?: (input && state.canCapture), canPlay = state.canPlay) }
                if (state.disconnect) {
                    if (original?.rtcLost == true) rtcEnded() else leave("The session ended. Join again with current authorization.")
                }
            }
            is UiEvent.Error -> when (event.value.code) {
                SpeechErrorCode.AUTHORIZATION_UNAVAILABLE -> leave("Authorization ended. Join again.")
                SpeechErrorCode.PLAYBACK_BLOCKED -> update { copy(notice = "Audio is paused. Select Resume audio.") }
                else -> update { copy(notice = "A session action could not finish.") }
            }
            is UiEvent.Caption -> {
                val caption = event.value; val joined = initial ?: return; val native = session ?: return
                if (caption.subscriptionRevision <= retiredCaptionRevision || caption.subscriptionRevision != native.state.value.subscriptionRevision ||
                    (caption.targetLanguage != null && caption.targetLanguage != state.value.language)) return
                val key = "${caption.sourceId}/${caption.sourceEpoch}/${caption.unitId}"
                val pairs = state.value.pairs.toMutableList()
                var index = pairs.indexOfFirst { it.id == key }
                if (index < 0) {
                    if (pairs.size == 100) pairs.removeAt(0)
                    pairs += CaptionPair(key, "Speaker " + (if (caption.sourceParticipantId == joined.peerId) joined.peerRole else joined.role).uppercase())
                    index = pairs.lastIndex
                }
                val pair = pairs[index]
                if (caption.targetLanguage == null) {
                    if (pair.originalFinal && !caption.isFinal) return
                    pairs[index] = pair.copy(original = caption.text, originalFinal = caption.isFinal)
                } else {
                    if (pair.translationFinal && !caption.isFinal) return
                    pairs[index] = pair.copy(translation = caption.text, translationFinal = caption.isFinal)
                }
                update { copy(pairs = pairs.toList()) }
            }
        }
    }
    private fun rtcEnded() {
        update { copy(connected = false, listening = false, canPlay = false, input = this@CompanionModel.original?.capturing == true,
            notice = "Realtime audio disconnected. Your original capture remains independent; stop it when ready.") }
    }
    private fun update(change: CompanionState.() -> CompanionState) { mutable.value = mutable.value.change() }
}
