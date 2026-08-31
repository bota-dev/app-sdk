package dev.bota.sdk.internal.bluetooth

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal enum class RadioPriority { BackgroundReconnect, ManualSelection }

internal data class RadioOwner(val peripheralId: String, val priority: RadioPriority)

internal class RadioArbiter {
    private val mutex = Mutex()
    private var currentOwner: RadioOwner? = null

    suspend fun owner(): RadioOwner? = mutex.withLock { currentOwner }

    suspend fun acquire(peripheralId: String, priority: RadioPriority): String? = mutex.withLock {
        val owner = currentOwner
        when {
            owner == null -> {
                currentOwner = RadioOwner(peripheralId, priority)
                null
            }
            owner.peripheralId == peripheralId -> {
                currentOwner = RadioOwner(
                    peripheralId,
                    if (priority.ordinal > owner.priority.ordinal) priority else owner.priority,
                )
                null
            }
            priority.ordinal > owner.priority.ordinal -> {
                currentOwner = RadioOwner(peripheralId, priority)
                owner.peripheralId
            }
            else -> peripheralId
        }
    }

    suspend fun release(peripheralId: String) = mutex.withLock {
        if (currentOwner?.peripheralId == peripheralId) currentOwner = null
    }
}
