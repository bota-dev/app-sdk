package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.model.DiscoveredDevice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BotaDeviceClientTest {
    @Test
    fun configureIsIdempotentUntilDestroyAndCanConfigureAgainAfterDestroy() = runTest {
        val first = RuntimeFixture()
        val second = RuntimeFixture()
        val runtimes = ArrayDeque(listOf(first.runtime, second.runtime))
        var factoryCalls = 0
        val client = BotaDeviceClient()
        val configuration = BotaConfiguration {
            factoryCalls += 1
            runtimes.removeFirst()
        }

        client.configure(configuration)
        client.configure(configuration)
        client.destroy()
        client.destroy()
        client.configure(configuration)
        client.destroy()

        assertEquals(2, factoryCalls)
        assertEquals(1, first.closeCount)
        assertEquals(1, second.closeCount)
    }

    @Test
    fun operationsRequireConfigurationAndCapabilitiesReflectInstalledHosts() = runTest {
        val client = BotaDeviceClient()

        val error = runCatching { client.devices.capabilities() }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.FeatureUnavailable, error.code)

        val fixture = RuntimeFixture(
            capabilities = CoreCapabilities.Bluetooth +
                CoreCapabilities.Persistence +
                CoreCapabilities.NetworkTransfer,
        )
        client.configure(BotaConfiguration { fixture.runtime })

        val capabilities = client.devices.capabilities()
        assertEquals(true, capabilities.contains(DeviceCapability.Bluetooth))
        assertEquals(true, capabilities.contains(DeviceCapability.Persistence))
        assertEquals(true, capabilities.contains(DeviceCapability.NetworkTransfer))
        assertEquals(false, capabilities.contains(DeviceCapability.SecureStorage))
        client.destroy()
    }

    @Test
    fun destroyDisconnectsAndCompletesConnectionObservation() = runTest {
        val runner = FakeWorkflowRunner(connectionResponses())
        val fixture = RuntimeFixture(runner = runner)
        val client = BotaDeviceClient()
        client.configure(BotaConfiguration { fixture.runtime })
        val observing = CompletableDeferred<Unit>()
        val updates = async {
            client.devices.connectionUpdates()
                .onEach { observing.complete(Unit) }
                .toList()
        }
        observing.await()

        client.devices.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -35))
        client.destroy()

        val values = updates.await()
        assertNull(values.first())
        assertEquals("peripheral-1", values[1]?.id)
        assertEquals(listOf("peripheral-1"), fixture.disconnects)
        assertEquals(1, fixture.closeCount)
    }
}
