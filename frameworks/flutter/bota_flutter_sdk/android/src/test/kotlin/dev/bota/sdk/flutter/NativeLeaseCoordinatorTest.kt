package dev.bota.sdk.flutter

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class NativeLeaseCoordinatorTest {
    @Test
    fun equivalentConfigurationCoalescesAcrossEngines() = runTest {
        val client = FakeLeaseClient(suspendConfigure = true)
        val coordinator = coordinator(client)
        val configuration = configuration()

        val first = async { coordinator.acquire("engine-a", configuration) }
        client.configureStarted.await()
        val second = async { coordinator.acquire("engine-b", configuration) }
        client.resumeConfigure.complete(Unit)
        first.await()
        second.await()

        assertEquals(1, client.configureCount)
        coordinator.release("engine-a")
        assertEquals(0, client.destroyCount)
        coordinator.release("engine-b")
        assertEquals(1, client.destroyCount)
    }

    @Test
    fun releaseDuringSuspendedConfigureCannotInstallDetachedLease() = runTest {
        supervisorScope {
        val client = FakeLeaseClient(suspendConfigure = true)
        val coordinator = coordinator(client)
        val acquire = async { coordinator.acquire("engine-a", configuration()) }
        client.configureStarted.await()

        coordinator.release("engine-a")
        client.resumeConfigure.complete(Unit)

        assertSuspendFailsWith<NativeLeaseException.AcquisitionCancelled> { acquire.await() }
        assertEquals(1, client.destroyCount)
        }
    }

    @Test
    fun conflictingConfigurationFailsWithoutReconfiguringClient() = runTest {
        val client = FakeLeaseClient()
        val coordinator = coordinator(client)
        coordinator.acquire("engine-a", configuration("first"))

        assertSuspendFailsWith<NativeLeaseException.ConfigurationConflict> {
            coordinator.acquire("engine-b", configuration("second"))
        }

        assertEquals(1, client.configureCount)
        coordinator.release("engine-a")
    }

    @Test
    fun finalReleaseDestroysSharedClientExactlyOnce() = runTest {
        val client = FakeLeaseClient()
        val coordinator = coordinator(client)
        coordinator.acquire("engine-a", configuration())
        coordinator.acquire("engine-b", configuration())

        coordinator.release("engine-a")
        coordinator.release("engine-b")
        coordinator.release("engine-b")

        assertEquals(1, client.destroyCount)
    }

    @Test
    fun ownerlessCancellationNeverInvokesNativeCancellation() = runTest {
        val coordinator = coordinator(FakeLeaseClient())
        var calls = 0

        coordinator.cancelOperation("engine-a", NativeOperationCategory.DEVICE) { calls += 1 }

        assertEquals(0, calls)
    }

    @Test
    fun failedCancellationPoisonsOwnerUntilOriginalOperationTerminates() = runTest {
        val coordinator = coordinator(FakeLeaseClient())
        coordinator.beginOperation("engine-a", NativeOperationCategory.RECORDING, "operation-a")

        assertSuspendFailsWith<IllegalStateException> {
            coordinator.cancelOperation("engine-a", NativeOperationCategory.RECORDING) {
                error("stop failed")
            }
        }
        assertSuspendFailsWith<NativeLeaseException.OperationInProgress> {
            coordinator.beginOperation("engine-b", NativeOperationCategory.RECORDING, "operation-b")
        }
        var crossEngineCalls = 0
        assertSuspendFailsWith<NativeLeaseException.OperationNotOwned> {
            coordinator.cancelOperation("engine-b", NativeOperationCategory.RECORDING) {
                crossEngineCalls += 1
            }
        }
        assertEquals(0, crossEngineCalls)

        coordinator.finishOperation("engine-a", NativeOperationCategory.RECORDING, "operation-a")
        coordinator.beginOperation("engine-b", NativeOperationCategory.RECORDING, "operation-b")
    }

    @Test
    fun terminalOperationWaitsForThrowingCancellationToReturn() = runTest {
        supervisorScope {
        val coordinator = coordinator(FakeLeaseClient())
        val cancellationStarted = CompletableDeferred<Unit>()
        val releaseCancellation = CompletableDeferred<Unit>()
        coordinator.beginOperation("engine-a", NativeOperationCategory.DEVICE, "operation-a")
        val cancellation = async {
            coordinator.cancelOperation("engine-a", NativeOperationCategory.DEVICE) {
                cancellationStarted.complete(Unit)
                releaseCancellation.await()
                error("stop failed")
            }
        }
        cancellationStarted.await()

        coordinator.finishOperation("engine-a", NativeOperationCategory.DEVICE, "operation-a")
        assertSuspendFailsWith<NativeLeaseException.OperationInProgress> {
            coordinator.beginOperation("engine-b", NativeOperationCategory.DEVICE, "operation-b")
        }
        releaseCancellation.complete(Unit)
        assertSuspendFailsWith<IllegalStateException> { cancellation.await() }
        coordinator.beginOperation("engine-b", NativeOperationCategory.DEVICE, "operation-b")
        }
    }

    @Test
    fun finalSharedClientDestructionClearsFailedCancellationOwnership() = runTest {
        val client = FakeLeaseClient()
        val coordinator = coordinator(client)
        coordinator.acquire("engine-a", configuration())
        coordinator.beginOperation("engine-a", NativeOperationCategory.DEVICE, "operation-a")
        assertSuspendFailsWith<IllegalStateException> {
            coordinator.cancelOperation("engine-a", NativeOperationCategory.DEVICE) {
                error("stop failed")
            }
        }

        coordinator.release("engine-a")
        coordinator.acquire("engine-b", configuration())
        coordinator.beginOperation("engine-b", NativeOperationCategory.DEVICE, "operation-b")

        assertEquals(1, client.destroyCount)
    }

    private fun TestScope.coordinator(client: FakeLeaseClient): NativeLeaseCoordinator =
        NativeLeaseCoordinator(client, this)

    private fun configuration(namespace: String = "namespace") = NativeLeaseConfiguration(
        namespace,
        hasProvisioningMaterialCallback = true,
        hasFactoryResetGrantCallback = true,
        hasFactoryResetResultCallback = true,
        hasFirmwareCallback = true,
    )

    private class FakeLeaseClient(
        private val suspendConfigure: Boolean = false,
    ) : NativeLeaseClient {
        var configureCount = 0
        var destroyCount = 0
        val configureStarted = CompletableDeferred<Unit>()
        val resumeConfigure = CompletableDeferred<Unit>()

        override suspend fun configure(namespace: String) {
            configureCount += 1
            configureStarted.complete(Unit)
            if (suspendConfigure) resumeConfigure.await()
        }

        override suspend fun destroy() {
            destroyCount += 1
        }
    }
}

internal suspend inline fun <reified T : Throwable> assertSuspendFailsWith(
    noinline block: suspend () -> Unit,
): T {
    val error = runCatching { block() }.exceptionOrNull()
    if (error !is T) {
        fail("Expected ${T::class.java.name}, got ${error?.javaClass?.name}: $error")
    }
    return error as T
}
