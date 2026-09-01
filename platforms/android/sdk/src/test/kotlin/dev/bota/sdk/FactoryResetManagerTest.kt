package dev.bota.sdk

import dev.bota.sdk.internal.host.PersistedFactoryResetResult
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.FactoryResetCompletion
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FactoryResetManagerTest {
    @Test
    fun resetBindsOpaqueGrantToCommandAndBindingGeneration() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = FactoryResetManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val completion = manager.factoryReset(
            fixture.device,
            commandId = "reset-command-1",
            bindingGeneration = 9u,
        ) { request ->
            assertEquals("reset-command-1", request.commandId)
            assertEquals(9uL, request.bindingGeneration)
            byteArrayOf(0x44)
        }

        val command = fixture.runner.commands.single()
        val grantId = command.textField(23)
        fixture.resetProviders.getValue(requireNotNull(grantId))(fixture.device.serialNumber, byteArrayOf(3))
        assertEquals("reset-command-1", command.textField(22))
        assertEquals(setOf(grantId), fixture.resetProviders.keys)
        assertEquals(listOf("reset-command-1" to 9uL), fixture.registeredGenerations)
        assertEquals(FactoryResetCompletion("reset-command-1", 9u), completion)
        assertEquals(listOf(grantId), fixture.unregisteredMaterial)
        assertEquals(listOf("reset-command-1"), fixture.unregisteredGenerations)
        manager.detach()
    }

    @Test
    fun resumeUsesOnlyTheExactDurableResultAndNoGrant() = runTest {
        val fixture = SecureRuntimeFixture(
            pendingReset = PersistedFactoryResetResult("reset-command-1", 0u, 7u, 9u),
        )
        val manager = FactoryResetManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val completion = manager.resumePendingFactoryReset(fixture.device, currentBindingGeneration = 9u)

        val command = fixture.runner.commands.single()
        assertEquals(0x010a, command.kind)
        assertEquals("reset-command-1", command.textField(22))
        assertNull(command.textField(23))
        assertEquals(FactoryResetCompletion("reset-command-1", 9u), completion)
        manager.detach()
    }

    @Test
    fun resumeAfterReinstallWaitsForFirmwareReplayWithoutGrantOrResetOpcode() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = FactoryResetManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val completion = manager.resumeUnjournaledFactoryReset(
            fixture.device,
            commandId = "reset-after-reinstall",
            bindingGeneration = 0u,
        ) {}

        val command = fixture.runner.commands.single()
        assertEquals(0x010a, command.kind)
        assertEquals("reset-after-reinstall", command.textField(22))
        assertNull(command.fields.firstOrNull { it.id == 24 })
        assertNull(command.fields.firstOrNull { it.id == 25 })
        assertNull(command.textField(23))
        assertEquals(FactoryResetCompletion("reset-after-reinstall", 0u), completion)
        manager.detach()
    }

    @Test
    fun staleBindingGenerationFailsBeforeRustStarts() = runTest {
        val fixture = SecureRuntimeFixture(
            pendingReset = PersistedFactoryResetResult("old-reset", 0u, 7u, 8u),
        )
        val manager = FactoryResetManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val error = runCatching {
            manager.resumePendingFactoryReset(fixture.device, currentBindingGeneration = 9u)
        }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.IdentityMismatch, error.code)
        assertTrue(fixture.runner.commands.isEmpty())
        manager.detach()
    }

    @Test
    fun cancellationUnregistersMaterialWithoutDeletingDurableResult() = runTest {
        val runner = SecureWorkflowRunner(keepOpen = true)
        val saved = PersistedFactoryResetResult("reset-command-1", 0u, 3u, 9u)
        val fixture = SecureRuntimeFixture(runner = runner, pendingReset = saved)
        val manager = FactoryResetManager()
        fixture.connect()
        manager.attach(fixture.runtime)
        val error = supervisorScope {
            val reset = async {
                manager.factoryReset(fixture.device, "reset-command-2", 10u) { byteArrayOf(1) }
            }
            withTimeout(1_000) {
                while (runner.commands.isEmpty()) yield()
            }
            manager.cancelCurrentOperation()
            runCatching { reset.await() }.exceptionOrNull() as BotaSDKError.Core
        }

        assertEquals(BotaErrorCode.Cancelled, error.code)
        assertEquals(1, fixture.unregisteredMaterial.size)
        assertEquals(saved, fixture.pendingReset)
        manager.detach()
    }

    @Test
    fun grantRegistrationFailureReleasesGenerationAndFacadeOwnership() = runTest {
        val fixture = SecureRuntimeFixture()
        val reset = FactoryResetManager()
        val provisioning = ProvisioningManager()
        fixture.connect()
        reset.attach(fixture.runtime)
        provisioning.attach(fixture.runtime)
        fixture.failResetRegistration = true

        val error = runCatching {
            reset.factoryReset(fixture.device, "reset-command-1", 9u) { byteArrayOf(1) }
        }.exceptionOrNull()
        fixture.failResetRegistration = false
        provisioning.writeConnectionSettings(
            DeviceConnectionSettings(
                enabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = false),
                uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
            ),
            fixture.device,
        )

        assertEquals("reset registration failed", error?.message)
        assertEquals(listOf("reset-command-1"), fixture.unregisteredGenerations)
        assertEquals(1, fixture.unregisteredMaterial.size)
        assertEquals(1, fixture.writes.size)
        reset.detach()
        provisioning.detach()
    }
}

private fun dev.bota.sdk.internal.core.CoreCommand.textField(id: Int): String? =
    (fields.firstOrNull { it.id == id } as? dev.bota.sdk.internal.core.CoreField.Text)?.value
