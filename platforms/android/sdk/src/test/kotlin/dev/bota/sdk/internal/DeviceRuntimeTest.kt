package dev.bota.sdk.internal

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRuntimeTest {
    @Test
    fun closeAllAttemptsEveryActionAndPreservesTheFirstFailure() {
        val calls = mutableListOf<Int>()
        val first = IllegalStateException("first")
        val second = IllegalArgumentException("second")

        val error = runCatching {
            closeAll(
                { calls += 1; throw first },
                { calls += 2 },
                { calls += 3; throw second },
            )
        }.exceptionOrNull()

        assertEquals(listOf(1, 2, 3), calls)
        assertSame(first, error)
        assertEquals(listOf(second), error?.suppressed?.toList())
    }

    @Test
    fun suspendCleanupAttemptsEveryAction() = runTest {
        val calls = mutableListOf<Int>()
        val first = IllegalStateException("first")
        val second = IllegalArgumentException("second")

        val error = runCatching {
            runCleanupActions(
                { calls += 1; throw first },
                { calls += 2 },
                { calls += 3; throw second },
            )
        }.exceptionOrNull()

        assertEquals(listOf(1, 2, 3), calls)
        assertSame(first, error)
        assertEquals(listOf(second), error?.suppressed?.toList())
    }

    @Test
    fun cleanupFailureIsSuppressedByPrimaryOperationFailure() = runTest {
        val primary = IllegalStateException("operation")
        val cleanup = IllegalArgumentException("cleanup")

        runCleanupAfter(primary, { throw cleanup })

        assertEquals(listOf(cleanup), primary.suppressed.toList())
    }

    @Test
    fun preWriteDisconnectResetSettlesConfirmationBeforeAdmittingReplacement() = runTest {
        val disconnectResetMutex = Mutex()
        val hostPublishedConfirmation = CompletableDeferred<Unit>()
        val allowConfirmationTransport = CompletableDeferred<Unit>()
        val confirmationFinished = CompletableDeferred<Unit>()
        val hostResetStarted = CompletableDeferred<Unit>()
        val transportResetFinished = CompletableDeferred<Unit>()
        val hostResetFinished = CompletableDeferred<Unit>()
        val exactSettlementObserved = AtomicBoolean(false)
        val replacementObservedSettlement = AtomicBoolean(false)
        val activeControlSession = AtomicBoolean(true)

        val confirmation = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
            runCatching {
                hostPublishedConfirmation.complete(Unit)
                allowConfirmationTransport.await()
                try {
                    disconnectResetMutex.withLock {
                        check(activeControlSession.get()) { "reset removed the pre-write control session" }
                    }
                } finally {
                    confirmationFinished.complete(Unit)
                }
            }
        }
        withTimeout(1_000) { hostPublishedConfirmation.await() }

        val resetting = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
            runCatching {
                resetEncryptedUploadV2Ownership(
                    disconnectResetMutex = disconnectResetMutex,
                    isCurrentDisconnect = { true },
                    resetControl = {
                        activeControlSession.set(false)
                        transportResetFinished.complete(Unit)
                    },
                    resetSignedWriter = {},
                    resetHost = { resetTransportOwnership ->
                        hostResetStarted.complete(Unit)
                        try {
                            if (resetTransportOwnership()) {
                                confirmationFinished.await()
                                exactSettlementObserved.set(true)
                            }
                        } finally {
                            hostResetFinished.complete(Unit)
                        }
                    },
                )
            }
        }
        withTimeout(1_000) { hostResetStarted.await() }
        withTimeout(1_000) { transportResetFinished.await() }
        val replacement = async(Dispatchers.Default) {
            hostResetFinished.await()
            replacementObservedSettlement.set(exactSettlementObserved.get())
        }
        val replacementAdmittedBeforeSettlement = replacement.isCompleted
        allowConfirmationTransport.complete(Unit)

        val settled = kotlinx.coroutines.withContext(Dispatchers.Default) {
            withTimeoutOrNull(1_000) {
                confirmation.await() to resetting.await()
            }
        }
        if (settled == null) {
            resetting.cancelAndJoin()
            withTimeout(1_000) { confirmation.await() }
        }
        withTimeout(1_000) { replacement.await() }

        assertNotNull("reset and confirmation deadlocked in the pre-write gap", settled)
        assertFalse(replacementAdmittedBeforeSettlement)
        assertTrue(replacementObservedSettlement.get())
        assertTrue(settled?.first?.isFailure == true)
        assertTrue(settled?.second?.isSuccess == true)
    }
}
