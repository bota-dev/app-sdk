package dev.bota.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import kotlinx.coroutines.test.runTest

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
}
