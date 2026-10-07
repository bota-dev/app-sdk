package dev.bota.sdk

import dev.bota.sdk.internal.DeviceConnectionRegistry
import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.model.RecordingControlError
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingInitiator
import dev.bota.sdk.model.RecordingState
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceControlRecordingTest {
    @Test
    fun unrelatedActivityDoesNotCompleteARecordingCommand() = runTest {
        for (command in listOf(RecordingControlCommand.Start, RecordingControlCommand.Stop)) {
            val expectedActive = command == RecordingControlCommand.Start
            val unrelated = ByteArray(18).apply { this[0] = if (expectedActive) 0 else 1 }
            val matching = ByteArray(18).apply { this[0] = if (expectedActive) 1 else 0 }
            val fixture = RecordingControlRuntimeFixture(
                notifications = mapOf(BotaBluetoothUUIDs.RecordingStatus to listOf(unrelated, matching)),
                recordingStateDecoder = { RecordingState(it[0].toInt() == 1) },
            )
            val controls = DeviceControlManager()
            fixture.connect()
            controls.attach(fixture.runtime)
            val grant = Base64.getEncoder().encodeToString(byteArrayOf(1))
            val result = if (expectedActive) {
                controls.requestStartRecording(fixture.device, grant)
            } else {
                controls.requestStopRecording(fixture.device, grant)
            }
            assertEquals(RecordingControlResult(true), result)
            assertEquals(listOf(matching.toList()), fixture.decodedResults)
        }
    }

    @Test
    fun inactiveSnapshotDoesNotHideAnExplicitStartRejection() = runTest {
        val rejection = byteArrayOf(0, 0, 0, 0, 0, 2)
        val fixture = RecordingControlRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.RecordingStatus to listOf(ByteArray(18), rejection)),
            recordingResult = RecordingControlResult(false, RecordingControlError.AlreadyRecording),
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)
        assertEquals(
            RecordingControlResult(false, RecordingControlError.AlreadyRecording),
            controls.requestStartRecording(fixture.device, Base64.getEncoder().encodeToString(byteArrayOf(1))),
        )
        assertEquals(listOf(rejection.toList()), fixture.decodedResults)
    }

    @Test
    fun startRecordingSubscribesBeforeWritingTheSharedOpcode() = runTest {
        val fixture = RecordingControlRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.RecordingStatus to listOf(byteArrayOf(1, 1, 0, 0, 0, 0))),
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)

        val result = controls.requestStartRecording(
            fixture.device,
            Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)),
        )

        assertEquals(RecordingControlResult(success = true), result)
        assertEquals(
            listOf(
                RecordingControlAction.Write(BotaBluetoothUUIDs.DeviceCommand, listOf(1, 2, 3)),
                RecordingControlAction.Subscribe(BotaBluetoothUUIDs.RecordingStatus),
                RecordingControlAction.Write(BotaBluetoothUUIDs.RecordingControl, listOf(0x10)),
                RecordingControlAction.Unsubscribe(BotaBluetoothUUIDs.RecordingStatus),
            ),
            fixture.actions,
        )
    }

    @Test
    fun stopRecordingPreservesPacingAroundTheResultSubscription() = runTest {
        val fixture = RecordingControlRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.RecordingStatus to listOf(byteArrayOf(0, 1, 0, 0, 0, 0))),
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)

        val result = controls.requestStopRecording(
            fixture.device,
            Base64.getEncoder().encodeToString(byteArrayOf(4, 5, 6)),
        )

        assertEquals(RecordingControlResult(success = true), result)
        assertEquals(
            listOf(
                RecordingControlAction.Write(BotaBluetoothUUIDs.DeviceCommand, listOf(4, 5, 6)),
                RecordingControlAction.Delay(50),
                RecordingControlAction.Subscribe(BotaBluetoothUUIDs.RecordingStatus),
                RecordingControlAction.Delay(50),
                RecordingControlAction.Write(BotaBluetoothUUIDs.RecordingControl, listOf(0x11)),
                RecordingControlAction.Unsubscribe(BotaBluetoothUUIDs.RecordingStatus),
            ),
            fixture.actions,
        )
    }

    @Test
    fun readRecordingStateUsesTheConfiguredSharedDecoder() = runTest {
        val bytes = byteArrayOf(1, 1) + ByteArray(16) { it.toByte() }
        val expected = RecordingState(
            active = true,
            recordingId = "00010203-0405-0607-0809-0a0b0c0d0e0f",
            initiatedBy = RecordingInitiator.Remote,
        )
        val fixture = RecordingControlRuntimeFixture(
            reads = mapOf(BotaBluetoothUUIDs.RecordingStatus to bytes),
            recordingState = expected,
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)

        assertEquals(expected, controls.readRecordingState(fixture.device))
        assertEquals(listOf(RecordingControlAction.Read(BotaBluetoothUUIDs.RecordingStatus)), fixture.actions)
    }

    @Test
    fun failedResultAndEndedSubscriptionAreUnsubscribed() = runTest {
        val fixture = RecordingControlRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.RecordingStatus to listOf(byteArrayOf(0, 0, 0, 0, 0, 4))),
            recordingResult = RecordingControlResult(false, RecordingControlError.InvalidGrant),
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)

        val result = controls.requestStartRecording(
            fixture.device,
            Base64.getEncoder().encodeToString(byteArrayOf(1)),
        )

        assertEquals(RecordingControlResult(false, RecordingControlError.InvalidGrant), result)
        assertEquals(
            1,
            fixture.actions.count { it == RecordingControlAction.Unsubscribe(BotaBluetoothUUIDs.RecordingStatus) },
        )
    }

    @Test
    fun detachStopsActiveRecordingStateObservationExactlyOnce() = runTest {
        val fixture = RecordingControlRuntimeFixture(
            openSubscriptions = setOf(BotaBluetoothUUIDs.RecordingStatus),
        )
        val controls = DeviceControlManager()
        fixture.connect()
        controls.attach(fixture.runtime)

        val collector = launch { controls.recordingStateUpdates(fixture.device).collect {} }
        fixture.waitFor(RecordingControlAction.Subscribe(BotaBluetoothUUIDs.RecordingStatus))
        controls.detach()
        collector.join()

        assertEquals(
            1,
            fixture.actions.count { it == RecordingControlAction.Unsubscribe(BotaBluetoothUUIDs.RecordingStatus) },
        )
    }
}

private sealed interface RecordingControlAction {
    data class Read(val characteristic: UUID) : RecordingControlAction
    data class Write(val characteristic: UUID, val value: List<Byte>) : RecordingControlAction
    data class Subscribe(val characteristic: UUID) : RecordingControlAction
    data class Unsubscribe(val characteristic: UUID) : RecordingControlAction
    data class Delay(val milliseconds: Long) : RecordingControlAction
}

private class RecordingControlRuntimeFixture(
    private val reads: Map<UUID, ByteArray> = emptyMap(),
    private val notifications: Map<UUID, List<ByteArray>> = emptyMap(),
    private val openSubscriptions: Set<UUID> = emptySet(),
    private val recordingState: RecordingState = RecordingState(false),
    private val recordingResult: RecordingControlResult = RecordingControlResult(true),
    private val recordingStateDecoder: (ByteArray) -> RecordingState = { recordingState },
) {
    val device = SecureRuntimeFixture().device
    val connection = DeviceConnectionRegistry()
    val actions = mutableListOf<RecordingControlAction>()
    val decodedResults = mutableListOf<List<Byte>>()
    val runtime = DeviceRuntime(
        engine = SecureWorkflowRunner(),
        capabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
        authorize = {},
        disconnect = {},
        readStatus = { error("unused") },
        statusUpdates = { error("unused") },
        stopStatusUpdates = {},
        decodeStatus = { error("unused") },
        closeResources = {},
        connection = connection,
        directRead = { _, _, characteristic ->
            actions += RecordingControlAction.Read(characteristic)
            reads[characteristic]?.copyOf() ?: byteArrayOf()
        },
        directWrite = { _, _, characteristic, value ->
            actions += RecordingControlAction.Write(characteristic, value.toList())
        },
        directSubscribe = { _, _, characteristic ->
            actions += RecordingControlAction.Subscribe(characteristic)
            flow {
                notifications[characteristic].orEmpty().forEach { emit(it.copyOf()) }
                if (characteristic in openSubscriptions) awaitCancellation()
            }
        },
        directUnsubscribe = { _, _, characteristic ->
            actions += RecordingControlAction.Unsubscribe(characteristic)
        },
        delay = { actions += RecordingControlAction.Delay(it) },
        parseRecordingState = recordingStateDecoder,
        parseRecordingControlResult = { decodedResults += it.toList(); recordingResult },
        createRecordingControlCommand = { command ->
            byteArrayOf(if (command == RecordingControlCommand.Start) 0x10 else 0x11)
        },
    )

    fun connect() = connection.set(device)

    suspend fun waitFor(action: RecordingControlAction) {
        while (action !in actions) kotlinx.coroutines.yield()
    }
}
