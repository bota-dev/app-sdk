package dev.bota.sdk.internal.host

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.bluetooth.BluetoothTransportException
import dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferReceiverException
import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreHostEvent
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.internal.jni.NativePacket
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostEffectExecutorTest {
    @Test
    fun routesEveryEffectIncludingAllTwelveV2EffectsAndPreservesCorrelation() = runTest {
        val calls = mutableListOf<Pair<String, CoreEffectKind>>()
        val progress = mutableListOf<Pair<ULong, ULong>>()
        val ports = ports(calls) { effect -> successPayload(effect.kind)?.let(::flowOf) ?: emptyFlow() }
        val executor = HostEffectExecutor(
            ports.bluetooth,
            ports.persistence,
            ports.secureStorage,
            ports.network,
            ports.material,
            ports.recordingSink,
            ports.firmwareBlob,
            ports.encryptedUploadV2,
        ) { completed, total -> progress += completed to total }

        CoreEffectKind.entries.forEachIndexed { index, kind ->
            val effect = effect(kind, requestId = (index + 1).toULong())
            val events = executor.execute(effect).toList()
            val expected = successPayload(kind)
            if (expected == null) {
                assertTrue(kind.name, events.isEmpty())
            } else {
                assertEquals(kind.name, listOf(expected.kind), events.map { it.kind })
                assertEquals(kind.name, 77, events.single().operation)
                assertEquals(kind.name, (index + 1).toULong(), events.single().requestId)
                assertEquals(kind.name, Cancellation, events.single().cancellationId)
            }
        }

        assertEquals(CoreEffectKind.entries.filter(::isPortEffect).size, calls.size)
        assertEquals(listOf(4uL to 10uL), progress)
    }

    @Test
    fun permitsOnlyDeclaredMultiEventStreams() = runTest {
        val scan = effect(CoreEffectKind.BluetoothStartScan)
        val ports = ports(mutableListOf()) {
            flowOf(
                CoreHostEventPayload(HostEventKind.BleScanResult),
                CoreHostEventPayload(HostEventKind.BleScanResult),
            )
        }
        val executor = executor(ports)

        assertEquals(2, executor.execute(scan).toList().size)

        val connect = effect(CoreEffectKind.BluetoothConnect)
        val invalidPorts = ports(mutableListOf()) {
            flowOf(
                CoreHostEventPayload(HostEventKind.BleConnected),
                CoreHostEventPayload(HostEventKind.BleConnected),
            )
        }
        val events = executor(invalidPorts).execute(connect).toList()
        assertEquals(listOf(HostEventKind.BleConnected, HostEventKind.BleFailed), events.map { it.kind })
    }

    @Test
    fun mapsPlatformFailuresAndRejectsMismatchedOrOversizedEvents() = runTest {
        val effect = effect(CoreEffectKind.BluetoothConnect)
        val failed = ports(mutableListOf()) { flow { throw NativeHostException(73, "failed") } }
        val failure = executor(failed).execute(effect).toList().single()
        assertEquals(HostEventKind.BleFailed, failure.kind)
        assertEquals(-73L, failure.packet.requiredSigned(52))

        val mismatched = ports(mutableListOf()) {
            flowOf(CoreHostEventPayload(HostEventKind.CheckpointLoaded))
        }
        assertEquals(
            HostEventKind.BleFailed,
            executor(mismatched).execute(effect).toList().single().kind,
        )

        val oversized = ports(mutableListOf()) {
            flowOf(
                CoreHostEventPayload(
                    HostEventKind.BleConnected,
                    listOf(CoreField.Bytes(33, ByteArray(CoreEffect.MaximumRawByteCount + 1))),
                ),
            )
        }
        assertEquals(
            HostEventKind.BleFailed,
            executor(oversized).execute(effect).toList().single().kind,
        )
    }

    @Test
    fun timerCancellationCompletesTheOwnedTimerWithoutFiring() = runTest {
        val executor = executor(ports(mutableListOf()) { emptyFlow() })
        val scheduled = async { executor.execute(effect(CoreEffectKind.TimerSchedule, delayMs = 60_000u)).toList() }
        delay(1)

        assertTrue(executor.execute(effect(CoreEffectKind.TimerCancel)).toList().isEmpty())
        assertTrue(scheduled.await().isEmpty())
    }

    @Test
    fun mapsEveryCoreV2FailureToItsStableExistingAbiCategory() = runTest {
        val categories = listOf(
            BotaErrorCode.InvalidInput to 1uL,
            BotaErrorCode.TruncatedPacket to 2uL,
            BotaErrorCode.UnknownPacket to 3uL,
            BotaErrorCode.PayloadTooLarge to 4uL,
            BotaErrorCode.UnsupportedCapability to 5uL,
            BotaErrorCode.UnsupportedOperation to 6uL,
            BotaErrorCode.FeatureUnavailable to 7uL,
            BotaErrorCode.OperationInProgress to 8uL,
            BotaErrorCode.UnexpectedEvent to 9uL,
            BotaErrorCode.DeviceNotFound to 10uL,
            BotaErrorCode.IdentityMismatch to 11uL,
            BotaErrorCode.ConnectionFailed to 12uL,
            BotaErrorCode.PersistenceFailed to 13uL,
            BotaErrorCode.NotConnected to 14uL,
            BotaErrorCode.Timeout to 15uL,
            BotaErrorCode.Cancelled to 16uL,
            BotaErrorCode.ProtocolRejected to 17uL,
            BotaErrorCode.IntegrityFailed to 18uL,
            BotaErrorCode.UploadOwnershipUnknown to 19uL,
            BotaErrorCode.DownloadFailed to 20uL,
            BotaErrorCode.Internal to 21uL,
            BotaErrorCode.Unknown(99u) to 21uL,
        )

        for ((code, expected) in categories) {
            val failure = BotaSDKError.Core(code, BotaOperation.Decode, false, 42u.toUShort(), "deterministic")
            val event = v2Failure(failure)
            assertEquals(code.toString(), expected, event.packet.requiredUnsigned(47))
            assertEquals(code.toString(), false, event.packet.requiredBoolean(48))
            assertEquals(code.toString(), 42uL, event.packet.requiredUnsigned(49))
        }
    }

    @Test
    fun mapsDeterministicAndTransportV2FailuresWithoutRetryabilityDrift() = runTest {
        val cases = listOf(
            EncryptedUploadV2TransferReceiverException("prefix mismatch") to (18uL to false),
            EncryptedUploadV2MaterialRegistryException("invalid receipt", 18u) to (18uL to false),
            IllegalArgumentException("malformed framing") to (1uL to false),
            BluetoothTransportException(133, "GATT failed") to (12uL to true),
            IllegalStateException("unclassified") to (21uL to false),
        )

        for ((failure, expected) in cases) {
            val event = v2Failure(failure)
            assertEquals(failure::class.java.name, expected.first, event.packet.requiredUnsigned(47))
            assertEquals(failure::class.java.name, expected.second, event.packet.requiredBoolean(48))
        }
    }
}

private suspend fun v2Failure(failure: Throwable): CoreHostEvent {
    val ports = ports(mutableListOf()) { flow { throw failure } }
    return executor(ports).execute(effect(CoreEffectKind.EncryptedUploadV2StartTransfer)).toList().single()
}

private data class Ports(
    val bluetooth: BluetoothHost,
    val persistence: PersistenceHost,
    val secureStorage: SecureStorageHost,
    val network: NetworkHost,
    val material: MaterialHost,
    val recordingSink: RecordingSinkHost,
    val firmwareBlob: FirmwareBlobHost,
    val encryptedUploadV2: EncryptedUploadV2Host,
)

private fun ports(
    calls: MutableList<Pair<String, CoreEffectKind>>,
    output: (CoreEffect) -> Flow<CoreHostEventPayload>,
) = Ports(
    BluetoothHost { effect -> calls += "bluetooth" to effect.kind; output(effect) },
    PersistenceHost { effect -> calls += "persistence" to effect.kind; output(effect) },
    SecureStorageHost { effect -> calls += "secure" to effect.kind; output(effect) },
    NetworkHost { effect -> calls += "network" to effect.kind; output(effect) },
    MaterialHost { effect -> calls += "material" to effect.kind; output(effect) },
    RecordingSinkHost { effect -> calls += "sink" to effect.kind; output(effect) },
    FirmwareBlobHost { effect -> calls += "firmware" to effect.kind; output(effect) },
    EncryptedUploadV2Host { effect -> calls += "encrypted-v2" to effect.kind; output(effect) },
)

private fun executor(ports: Ports) = HostEffectExecutor(
    ports.bluetooth,
    ports.persistence,
    ports.secureStorage,
    ports.network,
    ports.material,
    ports.recordingSink,
    ports.firmwareBlob,
    ports.encryptedUploadV2,
)

private fun effect(
    kind: CoreEffectKind,
    requestId: ULong = 9u,
    delayMs: ULong = 0u,
): CoreEffect {
    val fields = when (kind) {
        CoreEffectKind.TimerSchedule -> nativeFields(26 to 41uL, 27 to delayMs)
        CoreEffectKind.TimerCancel -> nativeFields(26 to 41uL)
        CoreEffectKind.Progress -> nativeFields(36 to 4uL, 15 to 10uL)
        else -> NativeFields.Empty
    }
    return CoreEffect.fromPacket(
        NativePacket(
            kind = kind.wireValue,
            operation = 77,
            requestIdBits = requestId.toLong(),
            cancellationHighBits = Cancellation.high.toLong(),
            cancellationLowBits = Cancellation.low.toLong(),
            fieldIds = fields.ids,
            fieldTypes = fields.types,
            unsignedValues = fields.values,
            signedValues = LongArray(fields.ids.size),
            dataValues = arrayOfNulls(fields.ids.size),
        ),
    )
}

private data class NativeFields(val ids: IntArray, val types: IntArray, val values: LongArray) {
    companion object {
        val Empty = NativeFields(intArrayOf(), intArrayOf(), longArrayOf())
    }
}

private fun nativeFields(vararg values: Pair<Int, ULong>) = NativeFields(
    values.map(Pair<Int, ULong>::first).toIntArray(),
    IntArray(values.size) { NativePacket.FIELD_TYPE_UNSIGNED },
    values.map { it.second.toLong() }.toLongArray(),
)

private fun successPayload(kind: CoreEffectKind): CoreHostEventPayload? = when (kind) {
    CoreEffectKind.TimerSchedule -> CoreHostEventPayload(HostEventKind.TimerFired)
    CoreEffectKind.TimerCancel, CoreEffectKind.Progress, CoreEffectKind.BluetoothUnsubscribe,
    CoreEffectKind.RecordingSinkDiscard, CoreEffectKind.StreamingSinkDiscard -> null
    CoreEffectKind.PersistenceLoadCheckpoint -> CoreHostEventPayload(HostEventKind.CheckpointLoaded)
    CoreEffectKind.PersistenceSaveCheckpoint, CoreEffectKind.PersistenceDeleteCheckpoint ->
        CoreHostEventPayload(HostEventKind.CheckpointSaved)
    CoreEffectKind.PersistenceSaveConnectionIdentity -> CoreHostEventPayload(HostEventKind.ConnectionIdentitySaved)
    CoreEffectKind.PersistenceSaveFactoryResetResult -> CoreHostEventPayload(HostEventKind.FactoryResetResultSaved)
    CoreEffectKind.PersistenceDeleteFactoryResetResult -> CoreHostEventPayload(HostEventKind.FactoryResetResultDeleted)
    CoreEffectKind.SecureStorageRead -> CoreHostEventPayload(HostEventKind.SecretLoaded)
    CoreEffectKind.SecureStorageWrite, CoreEffectKind.SecureStorageDelete -> CoreHostEventPayload(HostEventKind.SecretStored)
    CoreEffectKind.BluetoothStartScan -> CoreHostEventPayload(HostEventKind.BleScanResult)
    CoreEffectKind.BluetoothStopScan -> CoreHostEventPayload(HostEventKind.BleScanStopped)
    CoreEffectKind.BluetoothConnect -> CoreHostEventPayload(HostEventKind.BleConnected)
    CoreEffectKind.BluetoothDiscoverServices -> CoreHostEventPayload(HostEventKind.BleServicesDiscovered)
    CoreEffectKind.BluetoothDisconnect -> CoreHostEventPayload(HostEventKind.BleDisconnected)
    CoreEffectKind.BluetoothRead -> CoreHostEventPayload(HostEventKind.BleReadCompleted)
    CoreEffectKind.BluetoothWrite -> CoreHostEventPayload(HostEventKind.BleWriteCompleted)
    CoreEffectKind.BluetoothSubscribe -> CoreHostEventPayload(HostEventKind.BleSubscribed)
    CoreEffectKind.NetworkDownload -> CoreHostEventPayload(HostEventKind.NetworkDownloadCompleted)
    CoreEffectKind.NetworkUpload -> CoreHostEventPayload(HostEventKind.NetworkUploadCompleted)
    CoreEffectKind.PrepareProvisioning -> CoreHostEventPayload(HostEventKind.ProvisioningMaterialPrepared)
    CoreEffectKind.PrepareFactoryResetGrant -> CoreHostEventPayload(HostEventKind.FactoryResetGrantPrepared)
    CoreEffectKind.RecordingSinkTruncate -> CoreHostEventPayload(HostEventKind.RecordingSinkTruncated)
    CoreEffectKind.RecordingSinkAppend -> CoreHostEventPayload(HostEventKind.RecordingSinkAppendCompleted)
    CoreEffectKind.RecordingSinkFinalize -> CoreHostEventPayload(HostEventKind.RecordingSinkFinalized)
    CoreEffectKind.StreamingSinkAppendPlaintext,
    CoreEffectKind.StreamingSinkBeginEncrypted,
    CoreEffectKind.StreamingSinkAppendEncrypted -> CoreHostEventPayload(HostEventKind.StreamingSinkAccepted)
    CoreEffectKind.StreamingSinkFinalize -> CoreHostEventPayload(HostEventKind.StreamingSinkFinalized)
    CoreEffectKind.FirmwareBlobRead -> CoreHostEventPayload(HostEventKind.FirmwareChunkRead)
    CoreEffectKind.EncryptedUploadV2LoadCheckpoint ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2CheckpointLoaded)
    CoreEffectKind.EncryptedUploadV2DeleteCheckpoint,
    CoreEffectKind.EncryptedUploadV2Abort -> null
    CoreEffectKind.EncryptedUploadV2TruncateSink ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2SinkTruncated)
    CoreEffectKind.EncryptedUploadV2PrepareSession ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2SessionPrepared)
    CoreEffectKind.EncryptedUploadV2StartTransfer ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2TransferStarted)
    CoreEffectKind.EncryptedUploadV2RepairWindow ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2WindowStaged)
    CoreEffectKind.EncryptedUploadV2SaveCheckpoint ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2CheckpointSaved)
    CoreEffectKind.EncryptedUploadV2AcknowledgeWindow ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2WindowAcknowledged)
    CoreEffectKind.EncryptedUploadV2StageArtifacts ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2ArtifactsStaged)
    CoreEffectKind.EncryptedUploadV2AwaitReceipt ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2ReceiptAccepted)
    CoreEffectKind.EncryptedUploadV2ConfirmWithReceipt ->
        CoreHostEventPayload(HostEventKind.EncryptedUploadV2RecordingConfirmed)
}

private fun isPortEffect(kind: CoreEffectKind): Boolean =
    kind != CoreEffectKind.TimerSchedule && kind != CoreEffectKind.TimerCancel && kind != CoreEffectKind.Progress

private val Cancellation = CoreCancellationId(0x0011223344556677u, 0x8899aabbccddeeffu)
