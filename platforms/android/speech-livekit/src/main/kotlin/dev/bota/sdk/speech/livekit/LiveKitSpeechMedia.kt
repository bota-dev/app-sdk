package dev.bota.sdk.speech.livekit

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean
import dev.bota.sdk.speech.SpeechErrorCode
import dev.bota.sdk.speech.SpeechGrant
import dev.bota.sdk.speech.SpeechMediaCallbacks
import dev.bota.sdk.speech.SpeechMediaPort
import dev.bota.sdk.speech.SpeechSessionException
import dev.bota.sdk.speech.SpeechTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

/** Optional LiveKit Cloud adapter. The host obtains grants and owns its selected audio source. */
public class LiveKitSpeechMedia internal constructor(
    private val room: RtcRoom,
    private val output: PcmOutput,
    private val callbacks: SpeechMediaCallbacks,
    scope: CoroutineScope,
    private val externalInput: ExternalPcmInput? = null,
    private val onCleanClose: () -> Unit = {},
) : SpeechMediaPort {
    private val scope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
    private val lock = Any()
    private val inputMutex = Mutex()
    private val outputMutex = Mutex()
    private val operations = mutableSetOf<Deferred<Unit>>()
    private var closing: Deferred<Unit>? = null
    @Volatile private var closed = false
    private var attempted = false
    private var connected = false
    @Volatile private var processor = ""
    private var held = false
    private var inputVersion = 0L
    private var playbackVersion = 0L
    private var input: RtcInput? = null
    @Volatile private var admitted = emptySet<String>()
    private var cleanupFailed = false

    init {
        externalInput?.attach { scope.launch { if (!closed) reportMediaFailure { callbacks.failed() } } }
        room.listener = object : RtcListener {
            override fun text(sender: String, json: String) {
                if (synchronized(lock) { !closed && sender == processor }) callbacks.text(sender, json)
            }
            override fun frame(sender: String, sid: String, frame: PcmFrame) {
                // Never block a native audio callback on a lock held while removing its sink.
                // The output owner independently fences selection, silence and clear epochs.
                if (!closed && sender == processor && sid in admitted) output.frame(sid, frame)
            }
            override fun removed(sid: String) {
                val version = synchronized(lock) { if (closed) return; playbackVersion }
                scope.launch {
                    try {
                        operation {
                            // Sender unpublication does not mean the device has played its buffered tail.
                            withTimeout(1_000) { output.drain(sid) }
                            if (synchronized(lock) { !closed && version == playbackVersion }) callbacks.trackRemoved(sid)
                        }
                    } catch (_: TimeoutCancellationException) {
                        reportPlaybackBlocked()
                    } catch (_: CancellationException) {
                        // Session retirement owns cleanup.
                    } catch (_: Exception) {
                        reportPlaybackBlocked()
                    }
                }
            }
            override fun disconnected() {
                reportMediaFailure { callbacks.disconnected() }
            }
            override fun failed() {
                reportMediaFailure { callbacks.failed() }
            }
        }
    }

    private fun reportMediaFailure(report: () -> Unit) {
        var failed = false
        try { silencePlayback() } catch (_: Exception) { failed = true }
        try { muteInput() } catch (_: Exception) { failed = true }
        val notify = synchronized(lock) {
            cleanupFailed = cleanupFailed || failed
            !closed
        }
        // Cleanup failure must not prevent the policy owner from retiring the session.
        if (notify) report()
    }

    private fun reportPlaybackBlocked() {
        if (closed) return
        try { silencePlayback() }
        catch (_: Exception) {
            synchronized(lock) { cleanupFailed = true }
            reportMediaFailure { callbacks.failed() }
            return
        }
        if (!closed) callbacks.playbackBlocked()
    }

    /** Own native work independently of a cancelled public waiter so close can join late acquisitions. */
    private suspend fun operation(block: suspend () -> Unit) {
        val task = synchronized(lock) {
            checkOpen()
            scope.async(start = CoroutineStart.LAZY) {
                try { block() }
                catch (error: CancellationException) { throw error }
                catch (error: SpeechSessionException) { throw error }
                catch (_: Exception) { throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED) }
            }.also { operations += it }
        }
        task.invokeOnCompletion { synchronized(lock) { operations -= task } }
        task.start()
        task.await()
    }

    private fun checkOpen() {
        if (closed) throw SpeechSessionException(SpeechErrorCode.CLOSED)
    }

    private fun releaseInput(old: RtcInput) {
        var failed = false
        try { room.unpublish(old) } catch (_: Exception) { failed = true }
        try { old.dispose() } catch (_: Exception) { failed = true }
        if (failed) {
            synchronized(lock) { cleanupFailed = true }
            throw SpeechSessionException(SpeechErrorCode.CLEANUP_FAILED)
        }
    }

    override suspend fun connect(grant: SpeechGrant): Unit = operation {
        synchronized(lock) {
            checkOpen()
            if (attempted || grant.provider != "livekit") throw SpeechSessionException(SpeechErrorCode.INVALID_INPUT)
            attempted = true
            processor = grant.processorIdentity
        }
        externalInput?.validate(grant)
        room.connect(grant)
        synchronized(lock) {
            checkOpen()
            if (room.name != grant.room || room.identity != grant.identity) {
                throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
            }
            connected = true
        }
    }

    override fun silencePlayback() {
        synchronized(lock) {
            playbackVersion++
            admitted = emptySet()
            output.silence()
            room.subscribe(emptySet())
        }
    }

    override fun muteInput() {
        synchronized(lock) {
            inputVersion++
            externalInput?.capture(false)
            room.muteInput()
            input?.enabled = false
        }
    }

    override val supportsSourceFinish: Boolean get() = true

    override fun holdInput() {
        synchronized(lock) {
            checkOpen()
            held = true
            externalInput?.capture(false)
            room.muteInput()
            input?.enabled = false
        }
    }

    override fun inputPublication(): String? = synchronized(lock) {
        checkOpen()
        input?.let { it.sid ?: throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED) }
    }

    override suspend fun clearPlayback(): Unit = operation {
        outputMutex.withLock {
            silencePlayback()
            output.clear()
        }
    }

    override suspend fun setPlayback(tracks: List<SpeechTrack>) {
        val version = synchronized(lock) { checkOpen(); playbackVersion }
        operation {
            outputMutex.withLock {
                synchronized(lock) {
                    checkOpen()
                    if (version != playbackVersion) return@withLock
                    val selected = tracks.map { it.mediaTrackSid }.toSet()
                    if (selected.size > 16) throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
                    admitted = selected
                    output.select(selected)
                    room.subscribe(selected)
                }
            }
        }
    }

    override suspend fun setInput(enabled: Boolean) {
        val requestedVersion = synchronized(lock) {
            checkOpen()
            if (!enabled) muteInput()
            inputVersion
        }
        operation {
            inputMutex.withLock {
                if (!enabled) {
                    val old = synchronized(lock) {
                        input.also { input = null }
                    }
                    if (old != null) {
                        releaseInput(old)
                    }
                    synchronized(lock) { held = false }
                    return@withLock
                }
                val version = synchronized(lock) {
                    checkOpen()
                    if (requestedVersion != inputVersion) return@withLock
                    if (!connected) throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
                    input?.let { it.enabled = !held; return@withLock }
                    inputVersion
                }
                val acquired = room.createInput()
                var owned = false
                var published = false
                try {
                    synchronized(lock) {
                        acquired.enabled = false
                        if (!closed && version == inputVersion) {
                            input = acquired
                            owned = true
                        }
                    }
                    if (!owned) return@withLock
                    room.publish(acquired)
                    published = true
                    synchronized(lock) {
                        if (!closed && version == inputVersion) {
                            if (acquired.sid.isNullOrEmpty()) throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
                            acquired.enabled = !held
                            return@withLock
                        }
                    }
                } finally {
                    val retained = synchronized(lock) { published && !closed && version == inputVersion && input === acquired && !acquired.sid.isNullOrEmpty() }
                    if (!retained) {
                        synchronized(lock) { if (input === acquired) input = null }
                        releaseInput(acquired)
                    }
                }
            }
        }
    }

    override suspend fun resumeAudio() {
        synchronized(lock) { checkOpen() }
    }

    override suspend fun close() {
        val task = synchronized(lock) {
            closing ?: run {
                closed = true
                externalInput?.retire()
                connected = false
                room.listener = null
                val pending = operations.toList()
                var failed = false
                fun attempt(action: () -> Unit) { try { action() } catch (_: Exception) { failed = true } }
                attempt { silencePlayback() }
                attempt { muteInput() }
                attempt { room.disconnect() }
                scope.async(start = CoroutineStart.LAZY) {
                    // A failed operation is not itself a cleanup failure; release still owns its native resources.
                    pending.forEach { runCatching { it.await() } }
                    val old = synchronized(lock) { input.also { input = null } }
                    if (old != null) {
                        attempt { room.unpublish(old) }
                        attempt { old.dispose() }
                    }
                    try { output.close() } catch (_: Exception) { failed = true }
                    attempt { room.disconnect() }
                    try { room.release() } catch (_: Exception) { failed = true }
                    if (failed || synchronized(lock) { cleanupFailed }) throw SpeechSessionException(SpeechErrorCode.CLEANUP_FAILED)
                }.also { task ->
                    closing = task
                    task.invokeOnCompletion { error -> if (error == null) onCleanClose() }
                }
            }
        }
        task.start()
        task.await()
    }

    public companion object {
        private val exclusiveOwner = AtomicBoolean()
        /** Reserve exclusive communication-audio ownership until close succeeds. */
        public fun create(context: Context, callbacks: SpeechMediaCallbacks): LiveKitSpeechMedia {
            return createOwned(context, callbacks, null)
        }

        /**
         * Publish one host-authorized original PCM branch without opening a microphone or changing
         * host audio focus/routing. Provision source_kind=host_external for external media or
         * host_microphone for SpeechMicrophoneCapture, and keep the original owner's
         * conference audio session active. This does not qualify simultaneous host SDK/device use.
         */
        public fun createExternal(context: Context, callbacks: SpeechMediaCallbacks, input: ExternalPcmInput): LiveKitSpeechMedia {
            input.requireAvailable()
            return createOwned(context, callbacks, input)
        }

        private fun createOwned(context: Context, callbacks: SpeechMediaCallbacks, input: ExternalPcmInput?): LiveKitSpeechMedia {
            if (!exclusiveOwner.compareAndSet(false, true)) throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            try {
                val output = AndroidPcmOutput(scope, { scope.launch { callbacks.playbackBlocked() } })
                return LiveKitSpeechMedia(VendorRtcRoom(context.applicationContext, scope, input), output, callbacks, scope, input) {
                    exclusiveOwner.set(false)
                    scope.cancel()
                }
            } catch (_: Exception) {
                input?.retire()
                scope.cancel()
                // A partially constructed native room has uncertain ownership; retain the reservation.
                throw SpeechSessionException(SpeechErrorCode.MEDIA_FAILED)
            }
        }
    }
}
