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
import kotlinx.coroutines.joinAll
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
        try {
            withContext(dispatcher) {
                core.start(command.packet, capabilities.bits)
                val owner = ActiveWorkflow(CoreCancellationId(command.cancellationId), channel)
                active = owner
                drain()
            }
        } catch (error: Throwable) {
            close(error)
        }
        awaitClose {
            scope.launch { cancelIfActive(CoreCancellationId(command.cancellationId)) }
        }
    }

    override suspend fun cancel(cancellationId: UUID) {
        cancelInternal(CoreCancellationId(cancellationId))
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        var failure: Throwable? = null
        try {
            runBlocking {
                val owner = withContext(dispatcher) { active }
                if (owner != null) {
                    try {
                        cancelInternal(owner.cancellationId)
                    } catch (error: Throwable) {
                        failure = error
                    }
                }
                try {
                    withContext(dispatcher) { core.close() }
                } catch (error: Throwable) {
                    failure = aggregate(failure, error)
                }
            }
        } finally {
            scope.coroutineContext[Job]?.cancel()
            dispatcher.close()
        }
        failure?.let { throw it }
    }

    private suspend fun cancelInternal(cancellationId: CoreCancellationId) {
        val owner = withContext(dispatcher) { active?.takeIf { it.cancellationId == cancellationId } }
            ?: return
        var primary: Throwable? = null
        var coreFailure: Throwable? = null
        try {
            withContext(dispatcher) {
                core.cancel(cancellationId.high, cancellationId.low)
            }
        } catch (error: Throwable) {
            coreFailure = error
            primary = error
        }
        try {
            effectHandler.cancel(cancellationId)
        } catch (cleanupFailure: Throwable) {
            primary = aggregate(primary, cleanupFailure)
        }
        val jobs = withContext(dispatcher) {
            effectJobs.remove(cancellationId).orEmpty().toList().also { owned ->
                owned.forEach(Job::cancel)
            }
        }
        jobs.joinAll()
        try {
            withContext(dispatcher) {
                val error = coreFailure
                if (error == null) drain() else fail(error, cancellationId)
            }
        } catch (drainFailure: Throwable) {
            primary = aggregate(primary, drainFailure)
        }
        try {
            owner.terminal.await()
        } catch (terminalFailure: Throwable) {
            primary = aggregate(primary, terminalFailure)
        }
        primary?.let { throw it }
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

    private fun aggregate(primary: Throwable?, secondary: Throwable): Throwable =
        primary?.also { if (it !== secondary) it.addSuppressed(secondary) } ?: secondary
}
