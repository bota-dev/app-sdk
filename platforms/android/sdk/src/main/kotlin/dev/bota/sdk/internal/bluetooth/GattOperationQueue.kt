package dev.bota.sdk.internal.bluetooth

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class GattOperationQueue {
    private data class DeviceState(
        val mutex: Mutex = Mutex(),
        val jobs: MutableSet<Job> = mutableSetOf(),
    )

    private val lock = Any()
    private val states = mutableMapOf<String, DeviceState>()

    suspend fun <T> run(peripheralId: String, operation: suspend () -> T): T {
        val job = currentCoroutineContext()[Job]
            ?: throw CancellationException("GATT operation has no coroutine job")
        val state = synchronized(lock) { states.getOrPut(peripheralId, ::DeviceState).also { it.jobs += job } }
        return try {
            state.mutex.withLock { operation() }
        } finally {
            synchronized(lock) {
                state.jobs -= job
                if (state.jobs.isEmpty() && !state.mutex.isLocked) states.remove(peripheralId, state)
            }
        }
    }

    fun cancel(peripheralId: String) {
        val jobs = synchronized(lock) { states.remove(peripheralId)?.jobs?.toList().orEmpty() }
        jobs.forEach { it.cancel(CancellationException("device disconnected")) }
    }
}
