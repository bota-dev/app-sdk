package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
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
    fun routesAllThirtyEffectsAndPreservesCorrelation() = runTest {
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
}

private data class Ports(
    val bluetooth: BluetoothHost,
    val persistence: PersistenceHost,
    val secureStorage: SecureStorageHost,
    val network: NetworkHost,
    val material: MaterialHost,
    val recordingSink: RecordingSinkHost,
    val firmwareBlob: FirmwareBlobHost,
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
)

private fun executor(ports: Ports) = HostEffectExecutor(
    ports.bluetooth,
    ports.persistence,
    ports.secureStorage,
    ports.network,
    ports.material,
    ports.recordingSink,
    ports.firmwareBlob,
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
    CoreEffectKind.RecordingSinkDiscard -> null
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
    CoreEffectKind.FirmwareBlobRead -> CoreHostEventPayload(HostEventKind.FirmwareChunkRead)
}

private fun isPortEffect(kind: CoreEffectKind): Boolean =
    kind != CoreEffectKind.TimerSchedule && kind != CoreEffectKind.TimerCancel && kind != CoreEffectKind.Progress

private val Cancellation = CoreCancellationId(0x0011223344556677u, 0x8899aabbccddeeffu)
