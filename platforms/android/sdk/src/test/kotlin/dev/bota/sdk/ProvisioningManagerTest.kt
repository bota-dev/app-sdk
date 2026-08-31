package dev.bota.sdk

import dev.bota.sdk.internal.DeviceConnectionRegistry
import dev.bota.sdk.internal.DeviceOperationCoordinator
import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.core.CoreWorkflowRunner
import dev.bota.sdk.internal.core.toNativePacket
import dev.bota.sdk.internal.host.PersistedFactoryResetResult
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.FactoryResetGrantRequest
import dev.bota.sdk.model.ProvisioningMaterial
import dev.bota.sdk.model.ProvisioningMaterialRequest
import java.util.UUID
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisioningManagerTest {
    @Test
    fun provisionRegistersOneOpaqueMaterialIdAndAlwaysUnregistersIt() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = ProvisioningManager()
        fixture.connect()
        manager.attach(fixture.runtime)
        var request: ProvisioningMaterialRequest? = null

        manager.provision(fixture.device) {
            request = it
            ProvisioningMaterial(byteArrayOf(1), byteArrayOf(2), mtu = 185u)
        }

        val command = fixture.runner.commands.single()
        val materialId = command.text(12)
        assertNotNull(materialId)
        assertEquals(materialId, fixture.provisioningProviders.keys.single())
        val provider = fixture.provisioningProviders.getValue(materialId!!)
        provider(
            ProvisioningMaterialRequest(
                fixture.device.serialNumber,
                byteArrayOf(3),
                byteArrayOf(4),
            ),
        )
        assertEquals(fixture.device.serialNumber, request?.serialNumber)
        assertEquals(listOf(materialId), fixture.unregisteredMaterial)
        manager.detach()
    }

    @Test
    fun noteConnectionSettingsAreNormalizedBeforeTheSharedEncoderWritesThem() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = ProvisioningManager()
        fixture.connect()
        manager.attach(fixture.runtime)
        val settings = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = true),
            heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = true),
            uploadNetworkPreference = listOf(
                DeviceConnectionSettings.ConnectionType.Cellular,
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Ble,
            ),
        )

        manager.writeConnectionSettings(settings, fixture.device)

        val encoded = fixture.encodedSettings.single()
        assertFalse(encoded.first.enabledConnections.cellular)
        assertFalse(encoded.first.heartbeatEnabledConnections.cellular)
        assertEquals(
            listOf(DeviceConnectionSettings.ConnectionType.Wifi, DeviceConnectionSettings.ConnectionType.Ble),
            encoded.first.uploadNetworkPreference,
        )
        assertEquals(DeviceType.BotaNote, encoded.second)
        assertEquals(BotaSecureUUIDs.DeviceSettings, fixture.writes.single().characteristic)
        manager.detach()
    }

    @Test
    fun readConnectionSettingsUsesTheSharedDecoder() = runTest {
        val fixture = SecureRuntimeFixture()
        fixture.readValue = byteArrayOf(0x02, 0x03)
        fixture.parsedSettings = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(true, true),
            heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
            uploadNetworkPreference = listOf(
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Ble,
                DeviceConnectionSettings.ConnectionType.Cellular,
            ),
            powerManagement = DeviceConnectionSettings.PowerManagement(0, -1),
            streamingEnabled = false,
        )
        val manager = ProvisioningManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val settings = manager.readConnectionSettings(fixture.device)

        assertEquals(DeviceConnectionSettings.EnabledConnections(true, true), settings.enabledConnections)
        assertEquals(DeviceConnectionSettings.EnabledConnections(true, false), settings.heartbeatEnabledConnections)
        assertEquals(
            listOf(
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Ble,
                DeviceConnectionSettings.ConnectionType.Cellular,
            ),
            settings.uploadNetworkPreference,
        )
        assertEquals(DeviceConnectionSettings.PowerManagement(0, -1), settings.powerManagement)
        assertFalse(settings.streamingEnabled)
        assertEquals(BotaSecureUUIDs.DeviceSettings, fixture.reads.single().characteristic)
        assertArrayEquals(fixture.readValue, fixture.decodedSettingsBytes.single())
        manager.detach()
    }

    @Test
    fun deprovisionWritesOnlyTheRemoveCommandAndStartsNoResetWorkflow() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = ProvisioningManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        manager.deprovision(fixture.device)

        assertArrayEquals(byteArrayOf(5), fixture.writes.single().value)
        assertEquals(listOf(1u.toUByte()), fixture.encodedDeviceCommands)
        assertEquals(BotaSecureUUIDs.DeviceCommand, fixture.writes.single().characteristic)
        assertTrue(fixture.runner.commands.isEmpty())
        manager.detach()
    }

    @Test
    fun provisioningRegistrationFailureReleasesFacadeOwnership() = runTest {
        val fixture = SecureRuntimeFixture()
        val manager = ProvisioningManager()
        fixture.connect()
        manager.attach(fixture.runtime)
        fixture.failProvisioningRegistration = true

        val error = runCatching {
            manager.provision(fixture.device) {
                ProvisioningMaterial(byteArrayOf(1), byteArrayOf(2), mtu = 185u)
            }
        }.exceptionOrNull()
        fixture.failProvisioningRegistration = false
        manager.writeConnectionSettings(
            DeviceConnectionSettings(
                enabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = false),
                uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
            ),
            fixture.device,
        )

        assertEquals("registration failed", error?.message)
        assertEquals(1, fixture.unregisteredMaterial.size)
        assertEquals(1, fixture.writes.size)
        manager.detach()
    }
}

internal class SecureRuntimeFixture(
    val runner: SecureWorkflowRunner = SecureWorkflowRunner(),
    pendingReset: PersistedFactoryResetResult? = null,
) {
    data class Write(val peripheralId: String, val service: UUID, val characteristic: UUID, val value: ByteArray)
    data class Read(val peripheralId: String, val service: UUID, val characteristic: UUID)

    val device = ConnectedDevice(
        id = "peripheral-1",
        serialNumber = "EVFXXW67KP",
        deviceType = DeviceType.BotaNote,
        firmwareVersion = "1.0.17",
        isProvisioned = true,
        connectionState = ConnectionState.Connected,
        mtu = 185,
    )
    val connection = DeviceConnectionRegistry()
    val operations = DeviceOperationCoordinator()
    val writes = mutableListOf<Write>()
    val reads = mutableListOf<Read>()
    val decodedSettingsBytes = mutableListOf<ByteArray>()
    var readValue = byteArrayOf()
    var parsedSettings = DeviceConnectionSettings(
        enabledConnections = DeviceConnectionSettings.EnabledConnections(true, false),
        uploadNetworkPreference = listOf(DeviceConnectionSettings.ConnectionType.Wifi),
    )
    val encodedSettings = mutableListOf<Pair<DeviceConnectionSettings, DeviceType>>()
    val encodedDeviceCommands = mutableListOf<UByte>()
    val provisioningProviders = mutableMapOf<String, suspend (ProvisioningMaterialRequest) -> ProvisioningMaterial>()
    val resetProviders = mutableMapOf<String, suspend (String, ByteArray) -> ByteArray>()
    val unregisteredMaterial = mutableListOf<String>()
    val resetGenerations = mutableMapOf<String, ULong>()
    val registeredGenerations = mutableListOf<Pair<String, ULong>>()
    val unregisteredGenerations = mutableListOf<String>()
    var failProvisioningRegistration = false
    var failResetRegistration = false
    var pendingReset: PersistedFactoryResetResult? = pendingReset
    val runtime = DeviceRuntime(
        engine = runner,
        capabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer +
            CoreCapabilities.Persistence + CoreCapabilities.HostMaterial,
        authorize = {},
        disconnect = {},
        readStatus = { error("unused") },
        statusUpdates = { error("unused") },
        stopStatusUpdates = {},
        decodeStatus = { error("unused") },
        closeResources = {},
        connection = connection,
        operations = operations,
        directWrite = { peripheralId, service, characteristic, value ->
            writes += Write(peripheralId, service, characteristic, value.copyOf())
        },
        directRead = { peripheralId, service, characteristic ->
            reads += Read(peripheralId, service, characteristic)
            readValue.copyOf()
        },
        parseConnectionSettings = {
            decodedSettingsBytes += it.copyOf()
            parsedSettings
        },
        serializeConnectionSettings = { settings, model ->
            val normalized = settings.normalized(model)
            encodedSettings += normalized to model
            byteArrayOf(0x33)
        },
        encodeDeviceCommand = {
            encodedDeviceCommands += it
            byteArrayOf(5)
        },
        registerProvisioning = { id, provider ->
            if (failProvisioningRegistration) error("registration failed")
            provisioningProviders[id] = provider
        },
        registerFactoryReset = { id, provider ->
            if (failResetRegistration) error("reset registration failed")
            resetProviders[id] = provider
        },
        unregisterMaterial = { id -> unregisteredMaterial += id },
        registerFactoryResetGeneration = { commandId, generation ->
            resetGenerations[commandId] = generation
            registeredGenerations += commandId to generation
        },
        unregisterFactoryResetGeneration = { commandId ->
            resetGenerations.remove(commandId)
            unregisteredGenerations += commandId
        },
        loadPendingFactoryReset = { this.pendingReset },
    )

    suspend fun connect() {
        connection.set(device)
    }
}

internal class SecureWorkflowRunner(
    private val keepOpen: Boolean = false,
) : CoreWorkflowRunner {
    val commands = mutableListOf<CoreCommand>()
    val cancelledIds = mutableListOf<UUID>()
    private val channels = mutableMapOf<UUID, SendChannel<CoreNotification>>()

    override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = callbackFlow {
        commands += command
        if (keepOpen) {
            channels[command.cancellationId] = channel
        } else {
            trySend(secureNotification(CoreNotificationKind.Completed, command.operation()))
            close()
        }
        awaitClose { channels.remove(command.cancellationId) }
    }

    override suspend fun cancel(cancellationId: UUID) {
        cancelledIds += cancellationId
        val operation = commands.firstOrNull { it.cancellationId == cancellationId }?.operation() ?: 12
        channels.remove(cancellationId)?.let { channel ->
            channel.trySend(secureNotification(CoreNotificationKind.Cancelled, operation))
            channel.close()
        }
    }

    override fun close() = Unit
}

internal object BotaSecureUUIDs {
    val ControlService: UUID = UUID.fromString("b07a0002-0000-1000-8000-00805f9b34fb")
    val DeviceCommand: UUID = UUID.fromString("b07a0002-0005-1000-8000-00805f9b34fb")
    val ProvisioningService: UUID = UUID.fromString("b07a0003-0000-1000-8000-00805f9b34fb")
    val DeviceSettings: UUID = UUID.fromString("b07a0003-0006-1000-8000-00805f9b34fb")
}

private fun secureNotification(kind: CoreNotificationKind, operation: Int): CoreNotification = CoreNotification(
    kind,
    emptyList<CoreField>().toNativePacket(kind.wireValue, operation = operation),
)

private fun CoreCommand.operation(): Int = when (kind) {
    0x0104 -> 7
    else -> 12
}

private fun CoreCommand.text(id: Int): String? = (fields.firstOrNull { it.id == id } as? CoreField.Text)?.value
