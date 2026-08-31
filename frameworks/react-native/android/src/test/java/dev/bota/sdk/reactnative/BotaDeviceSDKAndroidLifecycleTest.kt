package dev.bota.sdk.reactnative

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidLifecycleTest {
    @Test
    fun initialStateAndCapabilitiesDescribeAndroidAdapter() = runTest {
        val lifecycle = BotaDeviceSDKAndroidLifecycle(FakeClient())

        assertEquals("uninitialized", lifecycle.state())
        assertEquals(
            BotaDeviceSDKAndroidCapabilities(
                backgroundReconnect = false,
                backgroundScan = false,
                bluetooth = true,
                nativeFileTransfer = true,
                platform = "android",
            ),
            lifecycle.capabilities(),
        )
    }

    @Test
    fun configureForwardsExactStorageDirectoryAndBecomesReady() = runTest {
        val client = FakeClient()
        val lifecycle = BotaDeviceSDKAndroidLifecycle(client)
        val directory = File("/tmp/bota-rn-android-lifecycle")

        lifecycle.configure(directory)

        assertEquals(listOf(directory), client.configuredDirectories)
        assertEquals("ready", lifecycle.state())
    }

    @Test
    fun concurrentConfigureCallsShareOneAndroidConfiguration() = runTest {
        val client = FakeClient(blockConfigure = true)
        val lifecycle = BotaDeviceSDKAndroidLifecycle(client)

        val first = async { lifecycle.configure(null) }
        client.configureStarted.await()
        val second = async { lifecycle.configure(null) }

        assertEquals("initializing", lifecycle.state())
        client.allowConfigure.complete(Unit)
        first.await()
        second.await()

        assertEquals(1, client.configureCalls)
        assertEquals("ready", lifecycle.state())
    }

    @Test
    fun configureFailureIsRecoverable() = runTest {
        val client = FakeClient(failConfigure = true)
        val lifecycle = BotaDeviceSDKAndroidLifecycle(client)

        val first = runCatching { lifecycle.configure(null) }

        assertTrue(first.isFailure)
        assertEquals("error", lifecycle.state())
        client.failConfigure = false
        lifecycle.configure(null)
        assertEquals(2, client.configureCalls)
        assertEquals("ready", lifecycle.state())
    }

    @Test
    fun destroyWaitsForConfigurationAndReturnsToUninitialized() = runTest {
        val client = FakeClient(blockConfigure = true)
        val lifecycle = BotaDeviceSDKAndroidLifecycle(client)

        val configure = launch { lifecycle.configure(null) }
        client.configureStarted.await()
        val destroy = launch { lifecycle.destroy() }

        assertFalse(client.destroyed.isCompleted)
        client.allowConfigure.complete(Unit)
        configure.join()
        destroy.join()

        assertEquals(1, client.destroyCalls)
        assertTrue(client.destroyed.isCompleted)
        assertEquals("uninitialized", lifecycle.state())
    }

    @Test
    fun destroyIsIdempotent() = runTest {
        val client = FakeClient()
        val lifecycle = BotaDeviceSDKAndroidLifecycle(client)

        lifecycle.configure(null)
        lifecycle.destroy()
        lifecycle.destroy()

        assertEquals(1, client.destroyCalls)
        assertEquals("uninitialized", lifecycle.state())
    }

    private class FakeClient(
        private val blockConfigure: Boolean = false,
        var failConfigure: Boolean = false,
    ) : BotaDeviceSDKAndroidClient {
        val allowConfigure = CompletableDeferred<Unit>()
        val configureStarted = CompletableDeferred<Unit>()
        val configuredDirectories = mutableListOf<File?>()
        val destroyed = CompletableDeferred<Unit>()
        var configureCalls = 0
        var destroyCalls = 0

        override suspend fun configure(storageDirectory: File?) {
            configureCalls += 1
            configuredDirectories += storageDirectory
            configureStarted.complete(Unit)
            if (blockConfigure) allowConfigure.await()
            if (failConfigure) error("configure failed")
        }

        override suspend fun destroy() {
            destroyCalls += 1
            destroyed.complete(Unit)
        }
    }
}
