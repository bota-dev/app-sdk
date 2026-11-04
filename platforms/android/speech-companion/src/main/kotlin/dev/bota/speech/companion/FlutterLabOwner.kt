package dev.bota.speech.companion

import dev.bota.sdk.speech.*
import java.util.UUID
import kotlinx.coroutines.*

/** Process-owned preparation for a Flutter engine. Call on the UI dispatcher.
 * Only display metadata leaves this owner; grants and HTTP stay native. */
internal class FlutterLabOwner(
    private val media: (SpeechMediaCallbacks) -> SpeechMediaPort,
    private val transport: () -> LabTransport = { NativeLabTransport() },
    dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var engine: String? = null
    private var revision = UUID.randomUUID()
    private var host: LabHost? = null
    private var joined: LabJoin? = null
    private var session: SpeechSession? = null
    private var bootstrap: Deferred<LabJoin>? = null
    private var retirement: Deferred<Unit>? = null
    private var failed = false

    fun bindEngine(id: String) {
        if (engine == id) return
        engine = id
        retire()
    }
    fun isCurrent(id: String): Boolean = engine == id && !failed && joined != null
    fun permissionOwner(id: String): UUID? = if (isCurrent(id)) revision else null
    fun acceptsPermission(id: String, owner: UUID): Boolean = isCurrent(id) && revision == owner

    suspend fun prepare(id: String, origin: String, role: String, code: String): Map<String, Any> {
        if (id != engine || failed) throw LabFailure()
        retirement?.await()
        if (id != engine || failed || host != null || bootstrap != null) throw LabFailure()
        val owner = UUID.randomUUID(); revision = owner
        try {
            val host = LabHost(origin, role, code, transport()); this.host = host
            val task = scope.async(start = CoroutineStart.LAZY) { host.join() }
            bootstrap = task; task.start()
            val value = task.await()
            if (id != engine || owner != revision) throw LabFailure()
            bootstrap = null; joined = value
            val selection = value.configuration.subscription.selection
            return mapOf("sessionId" to value.configuration.context.sessionId,
                "role" to value.role, "peerRole" to value.peerRole, "peerId" to value.peerId,
                "languages" to value.languages, "language" to selection.targetLanguage,
                "mode" to when (selection.mode) {
                    SpeechListeningMode.TRANSLATED -> "translated"
                    SpeechListeningMode.ORIGINAL -> "original"
                    SpeechListeningMode.CAPTIONS_ONLY -> "captionsOnly"
                })
        } catch (error: Exception) {
            if (id == engine && owner == revision) withContext(NonCancellable) { retire().await() }
            throw error
        }
    }
    fun create(id: String, sessionId: String, observer: SpeechObserver): SpeechSession {
        val value = joined ?: throw LabFailure()
        if (id != engine || failed || retirement?.isCompleted == false || session != null ||
            value.configuration.context.sessionId != sessionId) throw LabFailure()
        return SpeechSession.create(value.configuration, value.grant, media, host ?: throw LabFailure(), observer).also { session = it }
    }
    fun leave(id: String): Deferred<Unit> = if (id == engine) retire() else CompletableDeferred(Unit)

    private fun retire(): Deferred<Unit> {
        retirement?.let { if (!it.isCompleted || failed) return it }
        revision = UUID.randomUUID()
        val pending = bootstrap; val native = session; val host = host
        bootstrap = null; session = null; this.host = null; joined = null
        pending?.cancel(); host?.close()
        val task = scope.async(start = CoroutineStart.LAZY) {
            try { pending?.join(); native?.close(); Unit }
            catch (error: Exception) { failed = true; throw error }
        }
        retirement = task; task.start()
        return task
    }
}
