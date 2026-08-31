package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

internal interface CoreWorkflowRunner : AutoCloseable {
    fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification>
    suspend fun cancel(cancellationId: UUID)
    override fun close()
}

internal fun interface CoreEffectHandler {
    fun execute(effect: CoreEffect): Flow<CoreHostEvent>

    suspend fun cancel(cancellationId: CoreCancellationId) = Unit
}

internal class CoreEngineRuntime(
    private val core: NativeCore,
    private val effectHandler: CoreEffectHandler,
) : CoreWorkflowRunner {
    private data class ActiveWorkflow(
        val cancellationId: CoreCancellationId,
        val output: SendChannel<CoreNotification>,
        val terminal: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    private val dispatcher: ExecutorCoroutineDispatcher =
        Executors.newSingleThreadExecutor { task -> Thread(task, "bota-core") }.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val effectJobs = mutableMapOf<CoreCancellationId, MutableSet<Job>>()
    private var active: ActiveWorkflow? = null
    private var isDraining = false
    private var drainRequested = false
    private val closed = AtomicBoolean(false)

    override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = callbackFlow {
        check(!closed.get()) { "native core is closed" }
        val collectorClosed = AtomicBoolean(false)
        scope.launch {
            if (collectorClosed.get()) return@launch
            try {
                core.start(command.packet, capabilities.bits)
                val owner = ActiveWorkflow(CoreCancellationId(command.cancellationId), channel)
                active = owner
                drain()
            } catch (error: Throwable) {
                close(error)
            }
        }
        awaitClose {
            collectorClosed.set(true)
            scope.launch { cancelIfActive(CoreCancellationId(command.cancellationId)) }
        }
    }

    override suspend fun cancel(cancellationId: UUID) {
        cancelInternal(CoreCancellationId(cancellationId))
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runBlocking {
            val owner = withContext(dispatcher) { active }
            if (owner != null) cancelInternal(owner.cancellationId)
            withContext(dispatcher) { core.close() }
        }
        scope.coroutineContext[Job]?.cancel()
        dispatcher.close()
    }

    private suspend fun cancelInternal(cancellationId: CoreCancellationId) {
        val owner = withContext(dispatcher) { active?.takeIf { it.cancellationId == cancellationId } }
            ?: return
        effectHandler.cancel(cancellationId)
        withContext(dispatcher) {
            effectJobs.remove(cancellationId)?.forEach(Job::cancel)
            core.cancel(cancellationId.high, cancellationId.low)
            drain()
        }
        owner.terminal.await()
    }

    private suspend fun cancelIfActive(cancellationId: CoreCancellationId) {
        try {
            cancelInternal(cancellationId)
        } catch (error: Throwable) {
            withContext(dispatcher) { fail(error, cancellationId) }
        }
    }

    private fun drain() {
        if (isDraining) {
            drainRequested = true
            return
        }
        isDraining = true
        try {
            do {
                drainRequested = false
                while (true) {
                    val packet = core.poll() ?: break
                    if (packet.kind > 0x0400) {
                        val notification = CoreNotification.fromPacket(packet)
                        active?.output?.trySend(notification)
                        if (notification.isTerminal) finishActive()
                    } else {
                        consume(CoreEffect.fromPacket(packet))
                    }
                }
            } while (drainRequested)
        } catch (error: Throwable) {
            fail(error, active?.cancellationId)
        } finally {
            isDraining = false
        }
    }

    private fun consume(effect: CoreEffect) {
        val cancellationId = effect.cancellationId
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                effectHandler.execute(effect).collect { event -> receive(event) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                fail(error, cancellationId)
            }
        }
        effectJobs.getOrPut(cancellationId, ::mutableSetOf).add(job)
        job.invokeOnCompletion {
            scope.launch {
                effectJobs[cancellationId]?.let { jobs ->
                    jobs.remove(job)
                    if (jobs.isEmpty()) effectJobs.remove(cancellationId)
                }
            }
        }
    }

    private fun receive(event: CoreHostEvent) {
        try {
            core.dispatch(event.packet)
        } catch (error: NativeCoreException) {
            if (error.code == 9) return
            fail(error, event.cancellationId)
            return
        } catch (error: Throwable) {
            fail(error, event.cancellationId)
            return
        }
        drain()
    }

    private fun finishActive() {
        val owner = active ?: return
        active = null
        owner.output.close()
        owner.terminal.complete(Unit)
    }

    private fun fail(error: Throwable, cancellationId: CoreCancellationId?) {
        val owner = active ?: return
        if (cancellationId != null && owner.cancellationId != cancellationId) return
        active = null
        owner.output.close(error)
        owner.terminal.completeExceptionally(error)
    }
}
