package dev.bota.sdk.internal.core

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.workflowError
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal interface CoreWorkflowRunner : AutoCloseable {
    fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification>
    suspend fun cancel(cancellationId: UUID)
    suspend fun cancelAndReportExactSettlement(cancellationId: UUID): Boolean {
        cancel(cancellationId)
        return false
    }
    override fun close()
}

internal fun interface CoreEffectHandler {
    fun execute(effect: CoreEffect): Flow<CoreHostEvent>

    /** Atomically claims cancellation before CONFIRM, or reports that an actual CONFIRM write was attempted. */
    suspend fun confirmationAttemptedOrClaimCancellation(cancellationId: CoreCancellationId): Boolean = false

    suspend fun cancel(cancellationId: CoreCancellationId) = Unit
}

internal class CoreEngineRuntime(
    private val core: NativeCore,
    private val effectHandler: CoreEffectHandler,
) : CoreWorkflowRunner {
    private data class ActiveWorkflow(
        val cancellationId: CoreCancellationId,
        val output: SendChannel<CoreNotification>,
        val terminal: CompletableDeferred<CoreNotification> = CompletableDeferred(),
    )

    private val dispatcher: ExecutorCoroutineDispatcher =
        Executors.newSingleThreadExecutor { task -> Thread(task, "bota-core") }.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val effectJobs = mutableMapOf<CoreCancellationId, MutableSet<Job>>()
    private val exactSettlements = mutableMapOf<CoreCancellationId, CompletableDeferred<CoreNotification>>()
    private val completedTerminals = mutableMapOf<CoreCancellationId, CompletableDeferred<CoreNotification>>()
    private val cancellationMutex = Mutex()
    private var active: ActiveWorkflow? = null
    private var isDraining = false
    private var drainRequested = false
    private val closed = AtomicBoolean(false)

    override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = callbackFlow {
        check(!closed.get()) { "native core is closed" }
        try {
            withContext(dispatcher) {
                exactSettlements.entries.removeAll { it.value.isCompleted }
                completedTerminals.clear()
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

    override suspend fun cancelAndReportExactSettlement(cancellationId: UUID): Boolean =
        cancelInternal(CoreCancellationId(cancellationId))

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

    private suspend fun cancelInternal(
        cancellationId: CoreCancellationId,
        consumeExactSettlement: Boolean = true,
    ): Boolean = cancellationMutex.withLock {
        performCancellation(cancellationId, consumeExactSettlement)
    }

    private suspend fun performCancellation(
        cancellationId: CoreCancellationId,
        consumeExactSettlement: Boolean,
    ): Boolean {
        val confirmationAttempted = effectHandler.confirmationAttemptedOrClaimCancellation(cancellationId)
        val snapshot = withContext(dispatcher) {
            Triple(
                active?.takeIf { it.cancellationId == cancellationId },
                exactSettlements[cancellationId] ?: completedTerminals[cancellationId],
                exactSettlements.containsKey(cancellationId),
            )
        }
        if (confirmationAttempted) {
            val terminal = snapshot.first?.terminal ?: snapshot.second ?: throw BotaSDKError.Core(
                BotaErrorCode.UploadOwnershipUnknown,
                BotaOperation.TransferRecording,
                retryable = false,
                protocolStatus = null,
                detail = "CONFIRM was attempted but its terminal settlement is unavailable",
            )
            withContext(dispatcher) { exactSettlements.putIfAbsent(cancellationId, terminal) }
            return awaitExactSettlement(cancellationId, terminal, consumeExactSettlement)
        }
        val owner = snapshot.first
            ?: return snapshot.second?.let {
                // Collector teardown and explicit stop can cancel the same ordinary workflow.
                if (!snapshot.third && it.await().kind == CoreNotificationKind.Cancelled) false
                else awaitExactSettlement(cancellationId, it, consumeExactSettlement)
            } ?: false
        var primary: Throwable? = null
        var coreFailure: Throwable? = null
        var cancellationDeferred = false
        val runningJobs = withContext(dispatcher) { effectJobs[cancellationId].orEmpty().toSet() }
        try {
            withContext(dispatcher) {
                core.cancel(cancellationId.high, cancellationId.low)
                drain()
                cancellationDeferred = active === owner
            }
        } catch (error: Throwable) {
            coreFailure = error
            primary = error
        }
        if (cancellationDeferred) {
            withContext(dispatcher) {
                exactSettlements.putIfAbsent(cancellationId, owner.terminal)
            }
            return awaitExactSettlement(cancellationId, owner.terminal, consumeExactSettlement)
        }
        try {
            effectHandler.cancel(cancellationId)
        } catch (cleanupFailure: Throwable) {
            primary = aggregate(primary, cleanupFailure)
        }
        val jobs = withContext(dispatcher) {
            effectJobs.remove(cancellationId).orEmpty().toList().also { owned ->
                // STOP/unsubscribe emitted by core.cancel must settle, not be cancelled.
                owned.filter { it in runningJobs }.forEach(Job::cancel)
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
        return false
    }

    private suspend fun cancelIfActive(cancellationId: CoreCancellationId) {
        try {
            cancelInternal(cancellationId, consumeExactSettlement = false)
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
                        if (notification.isTerminal) finishActive(notification)
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

    private fun finishActive(notification: CoreNotification) {
        val owner = active ?: return
        active = null
        owner.output.close()
        owner.terminal.complete(notification)
        completedTerminals[owner.cancellationId] = owner.terminal
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

    private suspend fun awaitExactSettlement(
        cancellationId: CoreCancellationId,
        terminal: CompletableDeferred<CoreNotification>,
        consume: Boolean,
    ): Boolean {
        try {
            val notification = terminal.await()
            return when (notification.kind) {
                CoreNotificationKind.Completed -> true
                CoreNotificationKind.Failed -> throw notification.workflowError()
                else -> throw BotaSDKError.Core(
                    BotaErrorCode.UploadOwnershipUnknown,
                    BotaOperation.TransferRecording,
                    retryable = false,
                    protocolStatus = null,
                    detail = "confirmation settlement did not produce an exact completion",
                )
            }
        } finally {
            if (consume) {
                withContext(dispatcher) {
                    if (exactSettlements[cancellationId] === terminal) exactSettlements.remove(cancellationId)
                }
            }
        }
    }
}
