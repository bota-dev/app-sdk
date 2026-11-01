package dev.bota.sdk.speech

import android.os.SystemClock
import dev.bota.sdk.internal.jni.NativeSpeechPolicy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

internal fun interface SpeechClock { fun nowMs(): Long }

private class SystemSpeechClock : SpeechClock {
    private val epoch = System.currentTimeMillis()
    private val monotonic = SystemClock.elapsedRealtime()
    override fun nowMs(): Long = maxOf(System.currentTimeMillis(), epoch + SystemClock.elapsedRealtime() - monotonic)
}

/**
 * Optional native speech session. Rust owns all protocol/authorization decisions;
 * this owner executes platform IO and retires late callbacks. Audio stays in the
 * supplied media port. Source preview: a qualified platform adapter is required.
 *
 * Cancelling a public suspend call retires this session, preventing abandoned
 * capture acquisition. close joins bounded media cleanup; CLEANUP_FAILED means
 * the host must retain/reconcile uncertain audio ownership, not reuse its lease.
 */
public class SpeechSession private constructor(
    private val policy: NativeSpeechPolicy,
    grant: SpeechGrant,
    mediaFactory: (SpeechMediaCallbacks) -> SpeechMediaPort,
    private val host: SpeechHostCallbacks,
    private val observer: SpeechObserver,
    private val clock: SpeechClock,
    dispatcher: CoroutineDispatcher,
) {
    private class Slot {
        var version = 0L
        var dirty = false
        var task: Deferred<Unit>? = null
        var operation: Deferred<*>? = null
    }
    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var ended = false
    private var connected = false
    private var bootstrapFailure = false
    private lateinit var media: SpeechMediaPort
    private var initialGrant: SpeechGrant? = grant
    private var latest = readPolicy(SpeechJson.command("tick")).state
    private val mutableState = MutableStateFlow(latest)
    public val state: StateFlow<SpeechState> = mutableState.asStateFlow()
    private val capture = Slot()
    private val playback = Slot()
    private var captureMode = ""
    private var playbackKey: List<Any> = emptyList()
    private var timer: Job? = null
    private var connecting: Deferred<Unit>? = null
    private var changing: Deferred<SpeechSubscription>? = null
    private var renewing: Deferred<SpeechGrant>? = null
    private val resuming = mutableSetOf<Deferred<Unit>>()
    private var recovery: Deferred<Unit>? = null
    private var recoveryId: Int? = null
    private var finishing: Deferred<Unit>? = null
    private var finishId: Int? = null
    private var finishWaiter: Deferred<SpeechSourceFinish>? = null
    private var lastRenewal = 0L
    private var closeTask: CompletableDeferred<Unit>? = null
    public val ready: Deferred<Unit>

    init {
        try {
            if (host.supportsCaptionRecovery) latest = readPolicy(SpeechJson.command("enable_caption_recovery")).state
            mutableState.value = latest
            media = mediaFactory(object : SpeechMediaCallbacks {
                override fun text(sender: String, json: String) = receive(SpeechJson.command("event", "sender" to sender, "json" to json))
                override fun trackRemoved(mediaTrackSid: String) = receive(SpeechJson.command("track_removed", "mediaTrackSid" to mediaTrackSid))
                override fun disconnected() = mediaFailure()
                override fun failed() = mediaFailure()
                override fun playbackBlocked() = synchronized(lock) {
                    if (!ended) report(SpeechErrorCode.PLAYBACK_BLOCKED)
                }
            })
        } catch (_: Throwable) {
            policy.close()
            scope.cancel()
            throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
        }
        ready = scope.async(start = CoroutineStart.LAZY) {
            try {
                val credential = synchronized(lock) { active(); initialGrant.also { initialGrant = null }!! }
                val operation = scope.async(start = CoroutineStart.LAZY) { media.connect(credential) }
                synchronized(lock) { active(); connecting = operation; operation.start() }
                awaitBounded(operation, 10_000, SpeechErrorCode.MEDIA_TIMEOUT)
                synchronized(lock) { active(); connected = true; command(SpeechJson.command("connected")) }
                waitSlot(capture)
                waitSlot(playback)
                synchronized(lock) {
                    active()
                    timer = scope.launch { while (isActive) { delay(250); tick() } }
                }
            } catch (error: Throwable) {
                val code = synchronized(lock) {
                    val code = if (ended) SpeechErrorCode.CLOSED else errorCode(error, SpeechErrorCode.MEDIA_FAILED)
                    if (!ended) fail(code)
                    code
                }
                throw SpeechSessionException(code)
            } finally { synchronized(lock) { initialGrant = null; connecting = null } }
        }
        ready.invokeOnCompletion { error -> if (error != null) synchronized(lock) { beginClose() } }
        if (bootstrapFailure) synchronized(lock) { fail(SpeechErrorCode.MEDIA_FAILED) }
        ready.start()
    }

    public suspend fun setInput(enabled: Boolean): Unit = ownedCall {
        synchronized(lock) {
            active()
            if (enabled && finishWaiter != null) throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_PENDING)
            val update = command(SpeechJson.command("set_microphone", "enabled" to enabled))
            if (enabled && update.sourceFinish.holdPublication) throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_PENDING)
        }
        waitSlot(capture)
    }
    public suspend fun setMicrophone(enabled: Boolean): Unit = setInput(enabled)
    public suspend fun setListening(enabled: Boolean): Unit = ownedCall {
        synchronized(lock) { command(SpeechJson.command("set_listening", "enabled" to enabled)) }
        waitSlot(playback)
    }

    public suspend fun changeSubscription(selection: SpeechSelection): Unit = ownedCall {
        val request = selection.snapshot()
        val pair = synchronized(lock) {
            active()
            changing?.cancel()
            val id = command(SpeechJson.command("begin_change")).changeId
            val operation = scope.async(start = CoroutineStart.LAZY) { host.changeSubscription(request) }
            changing = operation
            operation.start()
            id to operation
        }
        try {
            val desired = awaitBounded(pair.second, 10_000, SpeechErrorCode.SUBSCRIPTION_UNAVAILABLE)
            synchronized(lock) {
                active()
                if (changing !== pair.second) throw SpeechSessionException(SpeechErrorCode.SUPERSEDED)
                command(SpeechJson.command("apply_desired", "changeId" to pair.first,
                    "subscription" to SpeechJson.subscription(desired)))
            }
        } catch (error: Throwable) {
            if (error is CancellationException && !currentCoroutineContext().isActive) throw error
            synchronized(lock) {
                active()
                if (changing !== pair.second) throw SpeechSessionException(SpeechErrorCode.SUPERSEDED)
                if (error is SpeechHostException && error.reason == SpeechHostFailure.UNAUTHORIZED) fail(SpeechErrorCode.AUTHORIZATION_UNAVAILABLE)
                report(SpeechErrorCode.SUBSCRIPTION_UNAVAILABLE)
            }
            throw SpeechSessionException(SpeechErrorCode.SUBSCRIPTION_UNAVAILABLE)
        } finally { synchronized(lock) { pair.second.cancel(); if (changing === pair.second) changing = null } }
    }

    public suspend fun resumeAudio(): Unit = ownedCall {
        val operation = synchronized(lock) {
            active()
            scope.async(start = CoroutineStart.LAZY) { media.resumeAudio() }.also { resuming += it; it.start() }
        }
        try { awaitBounded(operation, 10_000, SpeechErrorCode.PLAYBACK_BLOCKED) }
        catch (error: Throwable) {
            if (error is CancellationException && !currentCoroutineContext().isActive) throw error
            synchronized(lock) { active(); report(SpeechErrorCode.PLAYBACK_BLOCKED) }
            throw SpeechSessionException(SpeechErrorCode.PLAYBACK_BLOCKED)
        } finally { synchronized(lock) { operation.cancel(); resuming -= operation } }
    }

    public suspend fun recoverCaptions(): SpeechCaptionRecovery = ownedCall {
        val change = synchronized(lock) {
            active()
            if (!host.supportsCaptionRecovery) throw SpeechSessionException(SpeechErrorCode.CAPTION_RECOVERY_UNAVAILABLE)
            latest.changeId
        }
        ready.await()
        synchronized(lock) { unchanged(change); command(SpeechJson.command("recover_captions")) }
        while (true) {
            val task = synchronized(lock) { unchanged(change); recovery } ?: break
            try { task.await() } catch (error: CancellationException) {
                if (!currentCoroutineContext().isActive) throw error
                synchronized(lock) { unchanged(change) }
            }
        }
        synchronized(lock) {
            unchanged(change)
            when (latest.recovery.status) {
                "retrying" -> throw SpeechSessionException(SpeechErrorCode.CAPTION_RECOVERY_UNAVAILABLE)
                "stale" -> throw SpeechSessionException(SpeechErrorCode.CAPTION_RECOVERY_STALE)
            }
            latest.recovery
        }
    }

    public suspend fun finishInput(): SpeechSourceFinish = ownedCall {
        synchronized(lock) {
            active()
            if (finishWaiter == null) {
                if (latest.sourceFinish.status in listOf("completed", "interrupted", "no_source")) return@ownedCall latest.sourceFinish
                if (latest.sourceFinish.status == "stale") throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_STALE)
            }
        }
        val task = synchronized(lock) {
            active()
            if (!host.supportsSourceFinish || !media.supportsSourceFinish) throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_UNAVAILABLE)
            finishWaiter ?: scope.async(start = CoroutineStart.LAZY) {
                ready.await()
                waitSlot(capture)
                state.first { it.disconnect || !it.sourceFinish.holdPublication || it.sourceFinish.status == "unavailable" }
                synchronized(lock) {
                    active()
                    when (latest.sourceFinish.status) {
                        "unavailable" -> throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_UNAVAILABLE)
                        "stale" -> throw SpeechSessionException(SpeechErrorCode.SOURCE_FINISH_STALE)
                    }
                }
                waitSlot(capture)
                synchronized(lock) { active(); latest.sourceFinish }
            }.also { owned ->
                finishWaiter = owned
                owned.invokeOnCompletion { synchronized(lock) { if (finishWaiter === owned) finishWaiter = null } }
                command(SpeechJson.command("begin_source_finish"))
                owned.start()
            }
        }
        task.await()
    }
    public suspend fun finishMicrophone(): SpeechSourceFinish = finishInput()
    public suspend fun close() { synchronized(lock) { beginClose() }.await() }

    private suspend fun <T> ownedCall(block: suspend () -> T): T = try { block() }
    catch (error: CancellationException) {
        if (!currentCoroutineContext().isActive) synchronized(lock) { beginClose() }
        throw error
    }

    private fun readPolicy(json: String): SpeechPolicyUpdate {
        val input = json.toByteArray(Charsets.UTF_8)
        val output = try { policy.step(input, clock.nowMs()) } finally { input.fill(0) }
        return try { SpeechJson.update(output) } finally { output.fill(0) }
    }
    private fun active() { if (ended) throw SpeechSessionException(SpeechErrorCode.CLOSED) }
    private fun unchanged(change: Int) { active(); if (latest.changeId != change) throw SpeechSessionException(SpeechErrorCode.SUPERSEDED) }
    private fun report(code: SpeechErrorCode) { runCatching { observer.error(SpeechSessionException(code)) } }
    private fun fail(code: SpeechErrorCode) { if (!ended) { beginClose(); report(code) } }

    private fun command(json: String): SpeechState {
        active()
        val result = try { readPolicy(json) } catch (_: Throwable) {
            fail(SpeechErrorCode.INVALID_INPUT)
            throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT)
        }
        latest = result.state
        if (latest.disconnect) { beginClose(); return latest }
        reconcile()
        reconcileRequests()
        mutableState.value = latest
        runCatching { observer.stateChanged(latest) }
        fun current(): Boolean = !ended && latest.changeId == result.state.changeId && latest.subscriptionRevision == result.state.subscriptionRevision
        for (caption in result.captions) { if (!current()) break; runCatching { observer.caption(caption) } }
        if (current()) result.event?.let { runCatching { observer.event(it) } }
        return latest
    }
    private fun receive(json: String) = synchronized(lock) {
        if (!::media.isInitialized) { bootstrapFailure = true; return@synchronized }
        if (!ended) runCatching { command(json) }
    }
    private fun mediaFailure() = synchronized(lock) {
        if (!::media.isInitialized) bootstrapFailure = true else fail(SpeechErrorCode.MEDIA_FAILED)
    }

    private fun reconcile() {
        if (ended || !connected) return
        val mode = if (latest.sourceFinish.holdPublication) "hold" else if (latest.canCapture) "on" else "off"
        if (captureMode != mode) {
            captureMode = mode; capture.version++; capture.dirty = true
            try {
                if (mode == "hold") media.holdInput() else capture.operation?.cancel()
                if (mode == "off") media.muteInput()
            } catch (_: Throwable) { fail(SpeechErrorCode.MEDIA_FAILED); return }
            startCapture()
        }
        val key = listOf(latest.canPlay, latest.clearGeneration, latest.clearPlayback, latest.tracks.map { it.mediaTrackSid }.sorted())
        if (playbackKey != key) {
            playbackKey = key; playback.version++; playback.dirty = true; playback.operation?.cancel()
            if (!latest.canPlay || latest.clearPlayback) try { media.silencePlayback() }
            catch (_: Throwable) { fail(SpeechErrorCode.MEDIA_FAILED); return }
            startPlayback()
        }
    }
    private fun startCapture(): Unit = startSlot(capture, ::startCapture) { version, snapshot ->
        if (snapshot.sourceFinish.holdPublication) {
            synchronized(lock) {
                if (!ended && capture.version == version && latest.sourceFinish.status == "preparing")
                    command(SpeechJson.command("source_publication", "trackSid" to media.inputPublication()))
            }
        } else perform(capture, version) { media.setInput(snapshot.canCapture) }
    }
    private fun startPlayback(): Unit = startSlot(playback, ::startPlayback) { version, snapshot ->
        if (snapshot.clearPlayback) {
            perform(playback, version) { media.clearPlayback() }
            synchronized(lock) {
                if (!ended && playback.version == version) command(SpeechJson.command("buffers_cleared", "generation" to snapshot.clearGeneration))
            }
        } else perform(playback, version) { media.setPlayback(if (snapshot.canPlay) snapshot.tracks else emptyList()) }
    }
    private fun startSlot(slot: Slot, restart: () -> Unit, execute: suspend (Long, SpeechState) -> Unit) {
        if (ended || slot.task != null) return
        val task = scope.async(start = CoroutineStart.LAZY) {
            while (true) {
                val work = synchronized(lock) {
                    if (ended || !slot.dirty) null else { slot.dirty = false; slot.version to latest }
                } ?: break
                try { execute(work.first, work.second) }
                catch (error: Throwable) {
                    synchronized(lock) {
                        if (ended || slot.version != work.first) return@synchronized
                        fail(errorCode(error, SpeechErrorCode.MEDIA_FAILED))
                        throw SpeechSessionException(errorCode(error, SpeechErrorCode.MEDIA_FAILED))
                    }
                }
            }
        }
        slot.task = task
        task.invokeOnCompletion {
            synchronized(lock) { if (slot.task === task) slot.task = null; if (!ended && slot.dirty) restart() }
        }
        task.start()
    }
    private suspend fun perform(slot: Slot, version: Long, action: suspend () -> Unit) {
        val operation = synchronized(lock) {
            active()
            if (slot.version != version) throw SpeechSessionException(SpeechErrorCode.SUPERSEDED)
            scope.async(start = CoroutineStart.LAZY) { action() }.also { slot.operation = it; it.start() }
        }
        try { awaitBounded(operation, 10_000, SpeechErrorCode.MEDIA_TIMEOUT) }
        finally { synchronized(lock) { if (slot.operation === operation) slot.operation = null } }
    }
    private suspend fun waitSlot(slot: Slot) {
        while (true) {
            val task = synchronized(lock) { active(); slot.task } ?: return
            try { task.await() } catch (error: CancellationException) {
                if (!currentCoroutineContext().isActive) throw error
                synchronized(lock) { active() }
            }
        }
    }
    private suspend fun <T> awaitBounded(operation: Deferred<T>, timeout: Long, code: SpeechErrorCode): T =
        try { withTimeout(timeout) { operation.await() } }
        catch (_: TimeoutCancellationException) { operation.cancel(); throw SpeechSessionException(code) }

    private fun reconcileRequests() {
        if (ended || !connected) return
        val caption = latest.recovery.request
        if (caption?.requestId != recoveryId) recovery?.cancel()
        if (host.supportsCaptionRecovery && caption != null && recovery == null) {
            recoveryId = caption.requestId
            val task = requestTask({ host.readCaptions(caption) }, { body ->
                if (latest.recovery.request?.requestId == caption.requestId) {
                    // Retire this request before command schedules the next page. Do not
                    // cancel the coroutine that is currently delivering its own result.
                    recovery = null; recoveryId = null
                    command(SpeechJson.response("caption_page", caption.requestId, "page", body))
                }
            }, { reason ->
                if (latest.recovery.request?.requestId != caption.requestId) return@requestTask
                recovery = null; recoveryId = null
                command(SpeechJson.command("caption_failure", "requestId" to caption.requestId, "reason" to reason.wire))
                report(when (reason) {
                    SpeechHostFailure.UNAUTHORIZED -> SpeechErrorCode.AUTHORIZATION_UNAVAILABLE
                    SpeechHostFailure.STALE_SUBSCRIPTION -> SpeechErrorCode.CAPTION_RECOVERY_STALE
                    else -> SpeechErrorCode.CAPTION_RECOVERY_UNAVAILABLE
                })
            })
            recovery = task
            task.invokeOnCompletion { synchronized(lock) { if (recovery === task) { recovery = null; recoveryId = null }; reconcileRequests() } }
            task.start()
        }
        val finish = latest.sourceFinish.request
        if (finish?.requestId != finishId) finishing?.cancel()
        if (host.supportsSourceFinish && finish != null && finishing == null) {
            finishId = finish.requestId
            val task = requestTask({ host.finishSource(finish) }, { body ->
                if (latest.sourceFinish.request?.requestId == finish.requestId) {
                    finishing = null; finishId = null
                    command(SpeechJson.response("source_finish_result", finish.requestId, "body", body))
                }
            }, { reason ->
                if (latest.sourceFinish.request?.requestId != finish.requestId) return@requestTask
                finishing = null; finishId = null
                command(SpeechJson.command("source_finish_failure", "requestId" to finish.requestId, "reason" to reason.wire))
                if (reason != SpeechHostFailure.UNAVAILABLE) report(if (reason == SpeechHostFailure.UNAUTHORIZED)
                    SpeechErrorCode.AUTHORIZATION_UNAVAILABLE else SpeechErrorCode.SOURCE_FINISH_STALE)
            })
            finishing = task
            task.invokeOnCompletion { synchronized(lock) { if (finishing === task) { finishing = null; finishId = null }; reconcileRequests() } }
            task.start()
        }
    }
    private fun requestTask(call: suspend () -> String, success: (String) -> Unit, failure: (SpeechHostFailure) -> Unit): Deferred<Unit> =
        scope.async(start = CoroutineStart.LAZY) {
            val context = currentCoroutineContext()
            val operation = scope.async { call() }
            try {
                val body = awaitBounded(operation, 5_000, SpeechErrorCode.MEDIA_TIMEOUT)
                synchronized(lock) { if (!ended && context.isActive) success(body) }
            } catch (error: Throwable) {
                if (error !is CancellationException) synchronized(lock) {
                    if (!ended && context.isActive) failure((error as? SpeechHostException)?.reason ?: SpeechHostFailure.UNAVAILABLE)
                }
            } finally { operation.cancel() }
        }

    internal fun tick() = synchronized(lock) {
        if (ended) return@synchronized
        try {
            command(SpeechJson.command("tick"))
            val now = clock.nowMs()
            if (ended || renewing != null || latest.expiresAtMs - now > 30_000 || now - lastRenewal < 5_000) return@synchronized
            lastRenewal = now
            val operation = scope.async(start = CoroutineStart.LAZY) { host.renewGrant() }
            renewing = operation
            operation.start()
            scope.launch {
                try {
                    val grant = awaitBounded(operation, 5_000, SpeechErrorCode.AUTHORIZATION_UNAVAILABLE)
                    synchronized(lock) { if (!ended && renewing === operation) command(SpeechJson.command("renew", "grantJson" to SpeechJson.grant(grant))) }
                } catch (error: Throwable) {
                    synchronized(lock) {
                        if (!ended) {
                            if (error is SpeechHostException && error.reason == SpeechHostFailure.UNAUTHORIZED) fail(SpeechErrorCode.AUTHORIZATION_UNAVAILABLE)
                            else report(SpeechErrorCode.AUTHORIZATION_UNAVAILABLE)
                        }
                    }
                } finally { synchronized(lock) { operation.cancel(); if (renewing === operation) renewing = null } }
            }
        } catch (_: Throwable) { /* command already retires invalid/expired policy. */ }
    }

    private fun beginClose(): CompletableDeferred<Unit> {
        closeTask?.let { return it }
        val completion = CompletableDeferred<Unit>()
        closeTask = completion
        ended = true; connected = false; initialGrant = null
        timer?.cancel(); connecting?.cancel(); changing?.cancel(); renewing?.cancel(); recovery?.cancel(); finishing?.cancel()
        resuming.toList().forEach { it.cancel() }; resuming.clear()
        capture.operation?.cancel(); playback.operation?.cancel(); capture.task?.cancel(); playback.task?.cancel()
        var failed = false
        try { media.silencePlayback() } catch (_: Throwable) { failed = true }
        try { media.muteInput() } catch (_: Throwable) { failed = true }
        try { latest = readPolicy(SpeechJson.command("closed")).state } catch (_: Throwable) { }
        latest = latest.copy(connected = false, disconnect = true, canCapture = false, canPlay = false,
            tracks = emptyList(), recovery = latest.recovery.copy(status = "closed", request = null),
            sourceFinish = latest.sourceFinish.copy(status = "closed", holdPublication = false, request = null))
        try { policy.close() } catch (_: Throwable) { failed = true }
        mutableState.value = latest
        runCatching { observer.stateChanged(latest) }
        scope.launch {
            val cleanup = scope.async { media.close() }
            try { awaitBounded(cleanup, 10_000, SpeechErrorCode.CLEANUP_FAILED) }
            catch (_: Throwable) { failed = true }
            if (failed) {
                report(SpeechErrorCode.CLEANUP_FAILED)
                completion.completeExceptionally(SpeechSessionException(SpeechErrorCode.CLEANUP_FAILED))
            } else completion.complete(Unit)
            scope.cancel()
        }
        return completion
    }

    private fun errorCode(error: Throwable, fallback: SpeechErrorCode): SpeechErrorCode = (error as? SpeechSessionException)?.code ?: fallback

    public companion object {
        public fun create(configuration: SpeechConfiguration, grant: SpeechGrant,
            mediaFactory: (SpeechMediaCallbacks) -> SpeechMediaPort, host: SpeechHostCallbacks,
            observer: SpeechObserver = object : SpeechObserver {}): SpeechSession =
            createInternal(configuration, grant, mediaFactory, host, observer, SystemSpeechClock(), Dispatchers.Default)

        internal fun createInternal(configuration: SpeechConfiguration, grant: SpeechGrant,
            mediaFactory: (SpeechMediaCallbacks) -> SpeechMediaPort, host: SpeechHostCallbacks,
            observer: SpeechObserver, clock: SpeechClock, dispatcher: CoroutineDispatcher): SpeechSession {
            val credential = SpeechJson.grant(grant).toByteArray(Charsets.UTF_8)
            val policy = try { NativeSpeechPolicy(SpeechJson.configuration(configuration), credential, clock.nowMs()) }
            catch (_: Throwable) { throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT) }
            finally { credential.fill(0) }
            return try { SpeechSession(policy, grant, mediaFactory, host, observer, clock, dispatcher) }
            catch (error: Throwable) { policy.close(); throw error }
        }
    }
}
