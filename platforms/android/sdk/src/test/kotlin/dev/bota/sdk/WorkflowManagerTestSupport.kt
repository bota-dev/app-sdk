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
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.TransferCommand
import java.nio.file.Path
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import okhttp3.Request

internal class ManagerWorkflowRunner(
    private val responses: (CoreCommand) -> List<CoreNotification> = { emptyList() },
    private val keepOpen: (CoreCommand) -> Boolean = { false },
) : CoreWorkflowRunner {
    val commands = mutableListOf<CoreCommand>()
    val cancelledIds = mutableListOf<UUID>()

    override fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification> = flow {
        commands += command
        responses(command).forEach { emit(it) }
        if (keepOpen(command)) awaitCancellation()
    }

    override suspend fun cancel(cancellationId: UUID) {
        cancelledIds += cancellationId
    }

    override fun close() = Unit
}

internal class ManagerRuntimeFixture(
    val runner: ManagerWorkflowRunner,
    private val holdRecordingList: Boolean = false,
) {
    val device = ConnectedDevice(
        id = "peripheral-1",
        serialNumber = "EVFXXW67KP",
        deviceType = DeviceType.BotaNote,
        firmwareVersion = "1.0.17",
        isProvisioned = true,
        connectionState = ConnectionState.Connected,
        mtu = 185,
    )
    val recording = DeviceRecording(
        uuid = "00112233445566778899aabbccddeeff",
        startedAt = Instant.ofEpochSecond(1_700_000_000),
        durationMs = 2_000u,
        fileSizeBytes = 4_096u,
        codec = dev.bota.sdk.model.WireValue.Known(dev.bota.sdk.model.AudioCodec.Opus16k),
        isEncrypted = true,
    )
    val actions = mutableListOf<String>()
    val sinkPaths = mutableMapOf<String, Path>()
    val removedSinks = mutableListOf<String>()
    val streamingSinks = mutableListOf<String>()
    val removedStreamingSinks = mutableListOf<String>()
    val firmwarePaths = mutableMapOf<ULong, Path>()
    val removedFirmware = mutableListOf<ULong>()
    var recordingList = listOf(recording)

    val runtime = DeviceRuntime(
        engine = runner,
        capabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer +
            CoreCapabilities.RecordingSink + CoreCapabilities.NetworkTransfer +
            CoreCapabilities.FirmwareBlob,
        authorize = {},
        disconnect = {},
        readStatus = { error("unused") },
        statusUpdates = { error("unused") },
        stopStatusUpdates = {},
        decodeStatus = { error("unused") },
        closeResources = {},
        directWrite = { _, _, _, _ -> actions += "write" },
        directSubscribe = { _, _, _ ->
            actions += "subscribe"
            flow {
                actions += "collect"
                if (holdRecordingList) awaitCancellation()
                emit(byteArrayOf(1))
            }
        },
        directUnsubscribe = { _, _, _ -> actions += "unsubscribe" },
        parseRecordingList = { recordingList },
        createTransferCommand = { command ->
            actions += "encode-${command::class.simpleName}"
            byteArrayOf(2)
        },
        registerRecordingSink = { sinkId ->
            Path.of("/tmp/bota-test-$sinkId.recording").also { sinkPaths[sinkId] = it }
        },
        unregisterRecordingSink = { sinkId -> removedSinks += sinkId },
        registerStreamingSink = { sinkId, _, _, _, _ -> streamingSinks += sinkId },
        unregisterStreamingSink = { sinkId -> removedStreamingSinks += sinkId },
        registerFirmwareDownload = { id, _: Request ->
            Path.of("/tmp/bota-test-$id.firmware").also { firmwarePaths[id] = it }
        },
        unregisterFirmwareDownload = { id -> removedFirmware += id },
    )

    init {
        runtime.connection.set(device)
    }
}

internal fun managerNotification(
    kind: CoreNotificationKind,
    operation: Int,
    fields: List<CoreField> = emptyList(),
): CoreNotification = CoreNotification(kind, fields.toNativePacket(kind.wireValue, operation = operation))

internal fun progressNotification(completed: ULong, total: ULong): CoreNotification = managerNotification(
    CoreNotificationKind.Progress,
    operation = 8,
    fields = listOf(CoreField.Unsigned(36, completed), CoreField.Unsigned(15, total)),
)

internal fun firmwareProgressNotification(phase: ULong, completed: ULong, total: ULong): CoreNotification =
    managerNotification(
        CoreNotificationKind.FirmwareProgress,
        operation = 10,
        fields = listOf(
            CoreField.Unsigned(45, phase),
            CoreField.Unsigned(36, completed),
            CoreField.Unsigned(15, total),
        ),
    )

internal fun completedNotification(operation: Int): CoreNotification =
    managerNotification(CoreNotificationKind.Completed, operation)
