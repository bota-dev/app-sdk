package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreCommand
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.core.CoreNotificationKind
import dev.bota.sdk.internal.core.CoreWorkflowRunner
import dev.bota.sdk.internal.core.toNativePacket
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.WireValue
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceManagerTest {
    @Test
    fun authorizationFailsBeforeCoreStarts() = runTest {
        val runner = FakeWorkflowRunner()
        var granted = false
        val manager = DeviceManager()
        manager.attach(
            RuntimeFixture(
                runner = runner,
                authorize = {
                    if (!granted) throw BotaSDKError.AuthorizationRequired(setOf("scan"), it)
                },
            ).runtime,
        )

        val error = runCatching { manager.startScan().toList() }.exceptionOrNull()

        assertTrue(error is BotaSDKError.AuthorizationRequired)
        assertTrue(runner.commands.isEmpty())
        granted = true

        manager.startScan().toList()

        assertEquals(1, runner.commands.size)
        manager.detach()
    }

    @Test
    fun uncollectedScanDoesNotBlockConnection() = runTest {
        val runner = FakeWorkflowRunner(connectionResponses())
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)

        manager.startScan()
        val connected = manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))

        assertEquals("SERIAL-1", connected.serialNumber)
        assertEquals(1, runner.commands.size)
        manager.detach()
    }

    @Test
    fun eachScanCollectionOwnsAFreshCommand() = runTest {
        val runner = FakeWorkflowRunner()
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)
        val scan = manager.startScan()

        scan.toList()
        scan.toList()

        assertEquals(2, runner.commands.size)
        assertTrue(runner.commands[0].cancellationId != runner.commands[1].cancellationId)
        manager.detach()
    }

    @Test
    fun cancellingActiveScanCompletesItsCollector() = runTest {
        val runner = FakeWorkflowRunner(keepOpen = true)
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)
        val collecting = async { manager.startScan().toList() }
        withTimeout(1_000) {
            while (runner.commands.isEmpty()) delay(1)
        }

        manager.cancelCurrentOperation()

        withTimeout(1_000) { collecting.await() }
        assertEquals(runner.commands.single().cancellationId, runner.cancelledIds.single())
        manager.detach()
    }

    @Test
    fun scanMapsDiscoveryAndCollectorCancellationCancelsTheOriginalCommand() = runTest {
        val runner = FakeWorkflowRunner(
            responses = listOf(
                notification(
                    CoreNotificationKind.DeviceDiscovered,
                    fields = listOf(
                        CoreField.Text(4, "peripheral-1"),
                        CoreField.Text(5, "Bota Note"),
                        CoreField.Text(6, "aabbccddeeff"),
                        CoreField.Signed(7, -41),
                    ),
                ),
            ),
            keepOpen = true,
        )
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)

        val devices = manager.startScan(timeoutMilliseconds = 10_000u).take(1).toList()
        withTimeout(1_000) {
            while (runner.cancelledIds.isEmpty()) delay(1)
        }

        assertEquals("peripheral-1", devices.single().id)
        assertEquals("aabbccddeeff", devices.single().macAddress)
        assertEquals(runner.commands.single().cancellationId, runner.cancelledIds.single())
        manager.detach()
    }

    @Test
    fun connectRequiresSerialAndForwardsOnlyTheSelectedIdentity() = runTest {
        val runner = FakeWorkflowRunner(connectionResponses())
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)
        val selected = DiscoveredDevice(
            id = "peripheral-1",
            name = "Bota Note",
            deviceType = DeviceType.BotaNote,
            firmwareVersion = "1.0.11",
            macAddress = "aabbccddeeff",
            rssi = -30,
        )

        val invalid = runCatching { manager.connect("", selected) }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.InvalidInput, invalid.code)
        assertTrue(runner.commands.isEmpty())

        val connected = manager.connect("SERIAL-1", selected)
        val command = runner.commands.single()

        assertEquals("SERIAL-1", command.text(3))
        assertEquals("peripheral-1", command.text(4))
        assertEquals("aabbccddeeff", command.text(6))
        assertEquals("SERIAL-1", connected.serialNumber)
        assertEquals(DeviceType.BotaNote, connected.deviceType)
        manager.detach()
    }

    @Test
    fun selectedDeviceConnectLearnsIdentityFromTheCore() = runTest {
        val runner = FakeWorkflowRunner(connectionResponses())
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)
        val selected = DiscoveredDevice(id = "selected", name = "Bota Pin", rssi = -20)

        val connected = manager.connect(selected)
        val command = runner.commands.single()

        assertEquals(null, command.text(3))
        assertEquals("selected", command.text(4))
        assertEquals("SERIAL-1", connected.serialNumber)
        manager.detach()
    }

    @Test
    fun reconnectForwardsSavedIdentityHintsToRust() = runTest {
        val runner = FakeWorkflowRunner(connectionResponses(peripheralId = "stored-id"))
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)

        manager.reconnect(
            "SERIAL-1",
            DeviceReconnectHint(
                storedPeripheralId = "stored-id",
                advertisedAddress = "aabbccddeeff",
                storedName = "Bota Pin",
                scanTimeoutMilliseconds = 5_000u,
                connectionTimeoutMilliseconds = 8_000u,
            ),
        )

        val command = runner.commands.single()
        assertEquals(0x0103, command.kind)
        assertEquals("stored-id", command.text(8))
        assertEquals("aabbccddeeff", command.text(6))
        assertEquals("Bota Pin", command.text(9))
        assertEquals(5_000uL, command.unsigned(10))
        assertEquals(8_000uL, command.unsigned(11))
        manager.detach()
    }

    @Test
    fun staleConnectionCompletionCannotRestoreStateAfterRuntimeReplacement() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val runner = FakeWorkflowRunner(
            responses = connectionResponses(),
            beforeResponses = {
                started.complete(Unit)
                release.await()
            },
        )
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)
        val connecting = async {
            runCatching {
                manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))
            }
        }
        started.await()

        manager.detach()
        manager.attach(RuntimeFixture().runtime)
        release.complete(Unit)

        val error = connecting.await().exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.Cancelled, error.code)
        val statusError = runCatching { manager.readStatus() }.exceptionOrNull() as BotaSDKError.Core
        assertEquals(BotaErrorCode.NotConnected, statusError.code)
        manager.detach()
    }

    @Test
    fun rejectedConcurrentConnectDoesNotDisconnectTheVerifiedDevice() = runTest {
        val runner = FakeWorkflowRunner(
            responses = connectionResponses(),
            keepOpenForCommand = { it.kind == 0x0101 },
        )
        val fixture = RuntimeFixture(runner = runner)
        val manager = DeviceManager()
        manager.attach(fixture.runtime)
        manager.connect("SERIAL-1", DiscoveredDevice(id = "first", rssi = -30))
        val scanning = launch { manager.startScan().collect() }
        withTimeout(1_000) {
            while (runner.commands.size < 2) delay(1)
        }

        val error = runCatching {
            manager.connect("SERIAL-2", DiscoveredDevice(id = "second", rssi = -25))
        }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.OperationInProgress, error.code)
        assertTrue(fixture.disconnects.isEmpty())
        manager.cancelCurrentOperation()
        scanning.join()
        manager.detach()
    }

    @Test
    fun statusReadAndUpdatesUseTheSharedDecoder() = runTest {
        val currentBytes = byteArrayOf(1, 2, 3)
        val updateBytes = byteArrayOf(4, 5, 6)
        val decoded = mutableListOf<ByteArray>()
        val manager = DeviceManager()
        val fixture = RuntimeFixture(
            runner = FakeWorkflowRunner(connectionResponses()),
            readStatus = { currentBytes },
            statusUpdates = { flowOf(updateBytes) },
            decodeStatus = { bytes ->
                decoded += bytes.copyOf()
                status(bytes.first().toInt())
            },
        )
        manager.attach(fixture.runtime)
        manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))

        val current = manager.readStatus()
        val updates = manager.statusUpdates().toList()

        assertEquals(1, current.batteryLevel)
        assertEquals(4, updates.single().batteryLevel)
        assertArrayEquals(currentBytes, decoded[0])
        assertArrayEquals(updateBytes, decoded[1])
        assertEquals(listOf("peripheral-1"), fixture.stoppedStatusUpdates)
        manager.detach()
    }

    @Test
    fun statusTransportFailuresAreStablePublicErrors() = runTest {
        val manager = DeviceManager()
        val fixture = RuntimeFixture(
            runner = FakeWorkflowRunner(connectionResponses()),
            readStatus = { error("read failed") },
            statusUpdates = { flow { error("notify failed") } },
        )
        manager.attach(fixture.runtime)
        manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))

        val readError = runCatching { manager.readStatus() }.exceptionOrNull() as BotaSDKError.Core
        val updateError = runCatching { manager.statusUpdates().toList() }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.Internal, readError.code)
        assertEquals(BotaOperation.ReadStatus, readError.operation)
        assertEquals(BotaErrorCode.Internal, updateError.code)
        assertEquals(BotaOperation.ReadStatus, updateError.operation)
        manager.detach()
    }

    @Test
    fun statusSubscriptionStopsOnlyAfterTheLastCollectorLeaves() = runTest {
        val subscriptions = Channel<Unit>(Channel.UNLIMITED)
        val manager = DeviceManager()
        val fixture = RuntimeFixture(
            runner = FakeWorkflowRunner(connectionResponses()),
            statusUpdates = {
                flow {
                    subscriptions.send(Unit)
                    awaitCancellation()
                }
            },
        )
        manager.attach(fixture.runtime)
        manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))
        val first = launch { manager.statusUpdates().collect() }
        subscriptions.receive()
        val second = launch { manager.statusUpdates().collect() }
        subscriptions.receive()

        first.cancelAndJoin()
        delay(10)
        assertTrue(fixture.stoppedStatusUpdates.isEmpty())

        second.cancelAndJoin()
        withTimeout(1_000) {
            while (fixture.stoppedStatusUpdates.isEmpty()) delay(1)
        }
        assertEquals(listOf("peripheral-1"), fixture.stoppedStatusUpdates)
        manager.detach()
    }

    @Test
    fun rejectedDisconnectDoesNotTearDownStatusObservers() = runTest {
        val subscriptions = Channel<Unit>(Channel.UNLIMITED)
        var rejectDisconnect = false
        val manager = DeviceManager()
        val fixture = RuntimeFixture(
            runner = FakeWorkflowRunner(connectionResponses()),
            authorize = {
                if (rejectDisconnect && it == BotaOperation.Connect) {
                    throw BotaSDKError.AuthorizationRequired(setOf("connect"), it)
                }
            },
            statusUpdates = {
                flow {
                    subscriptions.send(Unit)
                    awaitCancellation()
                }
            },
        )
        manager.attach(fixture.runtime)
        manager.connect("SERIAL-1", DiscoveredDevice(id = "peripheral-1", rssi = -30))
        val status = launch { manager.statusUpdates().collect() }
        subscriptions.receive()
        rejectDisconnect = true

        val error = runCatching { manager.disconnect() }.exceptionOrNull()

        assertTrue(error is BotaSDKError.AuthorizationRequired)
        assertTrue(fixture.stoppedStatusUpdates.isEmpty())
        status.cancelAndJoin()
        manager.detach()
    }

    @Test
    fun connectionUpdatesRequiresConfigurationAtFlowCreation() {
        val manager = DeviceManager()

        val error = runCatching { manager.connectionUpdates() }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.FeatureUnavailable, error.code)
    }

    @Test
    fun failedNotificationBecomesStablePublicError() = runTest {
        val runner = FakeWorkflowRunner(
            listOf(
                notification(
                    CoreNotificationKind.Failed,
                    operation = 5,
                    fields = listOf(
                        CoreField.Unsigned(47, 11u),
                        CoreField.BooleanValue(48, false),
                        CoreField.Text(50, "serial mismatch"),
                    ),
                ),
            ),
        )
        val manager = DeviceManager()
        manager.attach(RuntimeFixture(runner = runner).runtime)

        val error = runCatching {
            manager.connect("SERIAL-1", DiscoveredDevice(id = "wrong", rssi = -30))
        }.exceptionOrNull() as BotaSDKError.Core

        assertEquals(BotaErrorCode.IdentityMismatch, error.code)
        assertEquals(BotaOperation.Connect, error.operation)
        assertEquals("serial mismatch", error.detail)
        manager.detach()
    }
}

internal class FakeWorkflowRunner(
    private val responses: List<CoreNotification> = emptyList(),
    private val keepOpen: Boolean = false,
    private val beforeResponses: suspend () -> Unit = {},
    private val keepOpenForCommand: (CoreCommand) -> Boolean = { keepOpen },
) : CoreWorkflowRunner {
    val commands = mutableListOf<CoreCommand>()
    val cancelledIds = mutableListOf<UUID>()
    var closeCount = 0

    override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = flow {
        commands += command
        beforeResponses()
        responses.forEach { emit(it) }
        if (keepOpenForCommand(command)) awaitCancellation()
    }

    override suspend fun cancel(cancellationId: UUID) {
        cancelledIds += cancellationId
    }

    override fun close() {
        closeCount += 1
    }
}

internal class RuntimeFixture(
    runner: FakeWorkflowRunner = FakeWorkflowRunner(),
    capabilities: CoreCapabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
    authorize: (BotaOperation) -> Unit = {},
    readStatus: suspend (String) -> ByteArray = { error("status unavailable") },
    statusUpdates: suspend (String) -> Flow<ByteArray> = { flowOf() },
    decodeStatus: (ByteArray) -> DeviceStatus = { error("decoder unavailable") },
) {
    var closeCount = 0
    val disconnects = mutableListOf<String>()
    val stoppedStatusUpdates = mutableListOf<String>()
    val runtime = DeviceRuntime(
        engine = runner,
        capabilities = capabilities,
        authorize = authorize,
        disconnect = { disconnects += it },
        readStatus = readStatus,
        statusUpdates = statusUpdates,
        stopStatusUpdates = { stoppedStatusUpdates += it },
        decodeStatus = decodeStatus,
        closeResources = { closeCount += 1 },
    )
}

internal fun connectionResponses(
    serialNumber: String = "SERIAL-1",
    peripheralId: String = "peripheral-1",
): List<CoreNotification> = listOf(
    notification(
        CoreNotificationKind.ConnectionEstablished,
        operation = 5,
        fields = listOf(
            CoreField.Text(3, serialNumber),
            CoreField.Text(4, peripheralId),
            CoreField.Signed(7, -30),
            CoreField.Unsigned(44, 1u),
        ),
    ),
    notification(CoreNotificationKind.Completed, operation = 5),
)

private fun notification(
    kind: CoreNotificationKind,
    operation: Int = 4,
    fields: List<CoreField> = emptyList(),
): CoreNotification = CoreNotification(
    kind,
    fields.toNativePacket(kind.wireValue, operation = operation),
)

private fun CoreCommand.text(id: Int): String? = (fields.firstOrNull { it.id == id } as? CoreField.Text)?.value

private fun CoreCommand.unsigned(id: Int): ULong? =
    (fields.firstOrNull { it.id == id } as? CoreField.Unsigned)?.value

private fun status(battery: Int): DeviceStatus = DeviceStatus(
    batteryLevel = battery,
    storageTotalMb = 100,
    storageUsedMb = 20,
    state = WireValue.Known(DeviceState.Idle),
    pendingRecordings = 0,
    lastTimeSyncAt = null,
    flags = DeviceFlags(
        charging = false,
        lowBattery = false,
        storageFull = false,
        wifiConnected = false,
        lteConnected = false,
        syncActive = false,
    ),
    timestamp = 0u,
    lteStatus = WireValue.Known(LteStatus.Off),
)
