package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreCancellationId
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectHandler
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreHostEvent
import dev.bota.sdk.internal.core.HostEventKind
import kotlin.math.absoluteValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch

internal class HostEffectExecutor(
    private val bluetooth: BluetoothHost,
    private val persistence: PersistenceHost,
    private val secureStorage: SecureStorageHost,
    private val network: NetworkHost,
    private val material: MaterialHost,
    private val recordingSink: RecordingSinkHost,
    private val firmwareBlob: FirmwareBlobHost,
    private val progress: suspend (completed: ULong, total: ULong) -> Unit = { _, _ -> },
) : CoreEffectHandler {
    private data class TimerOwner(
        val cancellationId: CoreCancellationId,
        val requestId: ULong,
        val job: Job,
    )

    private val timerLock = Any()
    private val timers = mutableMapOf<ULong, TimerOwner>()

    override fun execute(effect: CoreEffect): Flow<CoreHostEvent> = when (effect.kind) {
        CoreEffectKind.TimerSchedule -> scheduleTimer(effect)
        CoreEffectKind.TimerCancel -> cancelTimer(effect)
        CoreEffectKind.PersistenceLoadCheckpoint,
        CoreEffectKind.PersistenceSaveCheckpoint,
        CoreEffectKind.PersistenceDeleteCheckpoint,
        CoreEffectKind.PersistenceSaveConnectionIdentity,
        CoreEffectKind.PersistenceSaveFactoryResetResult,
        CoreEffectKind.PersistenceDeleteFactoryResetResult ->
            route(effect, persistence.execute(effect), HostEventKind.PersistenceFailed)
        CoreEffectKind.SecureStorageRead,
        CoreEffectKind.SecureStorageWrite,
        CoreEffectKind.SecureStorageDelete ->
            route(effect, secureStorage.execute(effect), HostEventKind.PersistenceFailed)
        CoreEffectKind.BluetoothStartScan,
        CoreEffectKind.BluetoothStopScan,
        CoreEffectKind.BluetoothConnect,
        CoreEffectKind.BluetoothDiscoverServices,
        CoreEffectKind.BluetoothDisconnect,
        CoreEffectKind.BluetoothRead,
        CoreEffectKind.BluetoothWrite,
        CoreEffectKind.BluetoothSubscribe,
        CoreEffectKind.BluetoothUnsubscribe ->
            route(effect, bluetooth.execute(effect), HostEventKind.BleFailed)
        CoreEffectKind.NetworkDownload,
        CoreEffectKind.NetworkUpload ->
            route(effect, network.execute(effect), HostEventKind.NetworkFailed)
        CoreEffectKind.Progress -> reportProgress(effect)
        CoreEffectKind.PrepareProvisioning,
        CoreEffectKind.PrepareFactoryResetGrant ->
            route(effect, material.execute(effect), HostEventKind.HostMaterialFailed)
        CoreEffectKind.RecordingSinkTruncate,
        CoreEffectKind.RecordingSinkAppend,
        CoreEffectKind.RecordingSinkFinalize,
        CoreEffectKind.RecordingSinkDiscard,
        CoreEffectKind.StreamingSinkAppendPlaintext,
        CoreEffectKind.StreamingSinkBeginEncrypted,
        CoreEffectKind.StreamingSinkAppendEncrypted,
        CoreEffectKind.StreamingSinkFinalize,
        CoreEffectKind.StreamingSinkDiscard ->
            route(
                effect,
                recordingSink.execute(effect),
                if (effect.kind.isStreamingSink) HostEventKind.StreamingSinkFailed
                else HostEventKind.RecordingSinkFailed,
            )
        CoreEffectKind.FirmwareBlobRead ->
            route(effect, firmwareBlob.execute(effect), HostEventKind.FirmwareBlobFailed)
    }

    override suspend fun cancel(cancellationId: CoreCancellationId) {
        val jobs = synchronized(timerLock) {
            val owned = timers.filterValues { it.cancellationId == cancellationId }.values.map(TimerOwner::job)
            timers.entries.removeAll { it.value.cancellationId == cancellationId }
            owned
        }
        jobs.forEach(Job::cancel)
    }

    private fun route(
        effect: CoreEffect,
        upstream: Flow<CoreHostEventPayload>,
        failureKind: HostEventKind,
    ): Flow<CoreHostEvent> = flow {
        var eventCount = 0
        try {
            upstream.collect { payload ->
                eventCount += 1
                if (payload.kind !in expectedEventKinds(effect.kind) ||
                    (!allowsMultipleEvents(effect.kind) && eventCount > 1)
                ) {
                    throw NativeHostException(1, "host returned an event that does not match ${effect.kind}")
                }
                if (payload.fields.rawByteCount() > CoreEffect.MaximumRawByteCount) {
                    throw NativeHostException(4, "host event contains too many raw bytes")
                }
                emit(CoreHostEvent.fromEffect(effect, payload.kind, payload.fields))
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            emit(failureEvent(effect, failureKind, error))
        }
    }

    private fun scheduleTimer(effect: CoreEffect): Flow<CoreHostEvent> {
        val timerId = effect.packet.unsigneds(26).firstOrNull()
            ?: return failedFlow("timer schedule ID is missing")
        val delayMs = effect.packet.unsigneds(27).firstOrNull()
            ?: return failedFlow("timer schedule delay is missing")
        return callbackFlow {
            val timerJob = launch {
                try {
                    delay(delayMs.coerceAtMost(Long.MAX_VALUE.toULong()).toLong())
                    send(
                        CoreHostEvent.fromEffect(
                            effect,
                            HostEventKind.TimerFired,
                            listOf(CoreField.Unsigned(26, timerId)),
                        ),
                    )
                } finally {
                    close()
                }
            }
            synchronized(timerLock) {
                timers.remove(timerId)?.job?.cancel()
                timers[timerId] = TimerOwner(effect.cancellationId, effect.requestId, timerJob)
            }
            awaitClose {
                timerJob.cancel()
                synchronized(timerLock) {
                    if (timers[timerId]?.requestId == effect.requestId) timers.remove(timerId)
                }
            }
        }
    }

    private fun cancelTimer(effect: CoreEffect): Flow<CoreHostEvent> {
        val timerId = effect.packet.unsigneds(26).firstOrNull()
            ?: return failedFlow("timer cancellation ID is missing")
        synchronized(timerLock) { timers.remove(timerId) }?.job?.cancel()
        return emptyFlow()
    }

    private fun reportProgress(effect: CoreEffect): Flow<CoreHostEvent> {
        val completed = effect.packet.unsigneds(36).firstOrNull()
            ?: return failedFlow("progress completed units are missing")
        val total = effect.packet.unsigneds(15).firstOrNull()
            ?: return failedFlow("progress total units are missing")
        return flow { progress(completed, total) }
    }

    private fun failureEvent(
        effect: CoreEffect,
        kind: HostEventKind,
        error: Throwable,
    ): CoreHostEvent {
        val hostError = error as? NativeHostException
        val fields = if (kind == HostEventKind.NetworkFailed) {
            buildList<CoreField> {
                val transferId = effect.packet.unsigneds(59).firstOrNull()
                    ?: effect.packet.unsigneds(21).firstOrNull()
                    ?: 0u
                add(CoreField.Unsigned(59, transferId))
                hostError?.httpStatus?.let { add(CoreField.Unsigned(60, it.toULong())) }
            }
        } else {
            val platformCode = -(hostError?.platformCode ?: 1).toLong().absoluteValue
            listOf(CoreField.Signed(52, platformCode))
        }
        return CoreHostEvent.fromEffect(effect, kind, fields)
    }

    private fun failedFlow(detail: String): Flow<CoreHostEvent> = flow {
        throw NativeHostException(1, detail)
    }
}

private fun List<CoreField>.rawByteCount(): Int = sumOf { field ->
    when (field) {
        is CoreField.Text -> field.value.encodeToByteArray().size
        is CoreField.Bytes -> field.value.size
        is CoreField.Unsigned, is CoreField.Signed, is CoreField.BooleanValue -> 0
    }
}

private fun allowsMultipleEvents(kind: CoreEffectKind): Boolean = when (kind) {
    CoreEffectKind.BluetoothStartScan,
    CoreEffectKind.BluetoothSubscribe,
    CoreEffectKind.NetworkDownload,
    CoreEffectKind.NetworkUpload -> true
    CoreEffectKind.TimerSchedule,
    CoreEffectKind.TimerCancel,
    CoreEffectKind.PersistenceLoadCheckpoint,
    CoreEffectKind.PersistenceSaveCheckpoint,
    CoreEffectKind.PersistenceDeleteCheckpoint,
    CoreEffectKind.PersistenceSaveConnectionIdentity,
    CoreEffectKind.PersistenceSaveFactoryResetResult,
    CoreEffectKind.PersistenceDeleteFactoryResetResult,
    CoreEffectKind.SecureStorageRead,
    CoreEffectKind.SecureStorageWrite,
    CoreEffectKind.SecureStorageDelete,
    CoreEffectKind.BluetoothStopScan,
    CoreEffectKind.BluetoothConnect,
    CoreEffectKind.BluetoothDiscoverServices,
    CoreEffectKind.BluetoothDisconnect,
    CoreEffectKind.BluetoothRead,
    CoreEffectKind.BluetoothWrite,
    CoreEffectKind.BluetoothUnsubscribe,
    CoreEffectKind.Progress,
    CoreEffectKind.PrepareProvisioning,
    CoreEffectKind.PrepareFactoryResetGrant,
    CoreEffectKind.RecordingSinkTruncate,
    CoreEffectKind.RecordingSinkAppend,
    CoreEffectKind.RecordingSinkFinalize,
    CoreEffectKind.RecordingSinkDiscard,
    CoreEffectKind.StreamingSinkAppendPlaintext,
    CoreEffectKind.StreamingSinkBeginEncrypted,
    CoreEffectKind.StreamingSinkAppendEncrypted,
    CoreEffectKind.StreamingSinkFinalize,
    CoreEffectKind.StreamingSinkDiscard,
    CoreEffectKind.FirmwareBlobRead -> false
}

private fun expectedEventKinds(kind: CoreEffectKind): Set<HostEventKind> = when (kind) {
    CoreEffectKind.TimerSchedule -> setOf(HostEventKind.TimerFired)
    CoreEffectKind.TimerCancel,
    CoreEffectKind.Progress,
    CoreEffectKind.BluetoothUnsubscribe,
    CoreEffectKind.RecordingSinkDiscard -> emptySet()
    CoreEffectKind.PersistenceLoadCheckpoint -> setOf(HostEventKind.CheckpointLoaded)
    CoreEffectKind.PersistenceSaveCheckpoint,
    CoreEffectKind.PersistenceDeleteCheckpoint -> setOf(HostEventKind.CheckpointSaved)
    CoreEffectKind.PersistenceSaveConnectionIdentity -> setOf(HostEventKind.ConnectionIdentitySaved)
    CoreEffectKind.PersistenceSaveFactoryResetResult -> setOf(HostEventKind.FactoryResetResultSaved)
    CoreEffectKind.PersistenceDeleteFactoryResetResult -> setOf(HostEventKind.FactoryResetResultDeleted)
    CoreEffectKind.SecureStorageRead -> setOf(HostEventKind.SecretLoaded)
    CoreEffectKind.SecureStorageWrite,
    CoreEffectKind.SecureStorageDelete -> setOf(HostEventKind.SecretStored)
    CoreEffectKind.BluetoothStartScan -> setOf(HostEventKind.BleScanResult)
    CoreEffectKind.BluetoothStopScan -> setOf(HostEventKind.BleScanStopped)
    CoreEffectKind.BluetoothConnect -> setOf(HostEventKind.BleConnected)
    CoreEffectKind.BluetoothDiscoverServices -> setOf(HostEventKind.BleServicesDiscovered)
    CoreEffectKind.BluetoothDisconnect -> setOf(HostEventKind.BleDisconnected)
    CoreEffectKind.BluetoothRead -> setOf(HostEventKind.BleReadCompleted)
    CoreEffectKind.BluetoothWrite -> setOf(HostEventKind.BleWriteCompleted)
    CoreEffectKind.BluetoothSubscribe -> setOf(
        HostEventKind.BleSubscribed,
        HostEventKind.BleNotification,
        HostEventKind.BleDisconnected,
    )
    CoreEffectKind.NetworkDownload -> setOf(
        HostEventKind.NetworkDownloadProgress,
        HostEventKind.NetworkDownloadCompleted,
    )
    CoreEffectKind.NetworkUpload -> setOf(
        HostEventKind.NetworkUploadProgress,
        HostEventKind.NetworkUploadCompleted,
    )
    CoreEffectKind.PrepareProvisioning -> setOf(HostEventKind.ProvisioningMaterialPrepared)
    CoreEffectKind.PrepareFactoryResetGrant -> setOf(HostEventKind.FactoryResetGrantPrepared)
    CoreEffectKind.RecordingSinkTruncate -> setOf(HostEventKind.RecordingSinkTruncated)
    CoreEffectKind.RecordingSinkAppend -> setOf(HostEventKind.RecordingSinkAppendCompleted)
    CoreEffectKind.RecordingSinkFinalize -> setOf(
        HostEventKind.RecordingSinkFinalized,
        HostEventKind.RecordingSinkIntegrityFailed,
    )
    CoreEffectKind.StreamingSinkAppendPlaintext,
    CoreEffectKind.StreamingSinkBeginEncrypted,
    CoreEffectKind.StreamingSinkAppendEncrypted -> setOf(HostEventKind.StreamingSinkAccepted)
    CoreEffectKind.StreamingSinkFinalize -> setOf(HostEventKind.StreamingSinkFinalized)
    CoreEffectKind.StreamingSinkDiscard -> emptySet()
    CoreEffectKind.FirmwareBlobRead -> setOf(HostEventKind.FirmwareChunkRead)
}

private val CoreEffectKind.isStreamingSink: Boolean
    get() = this == CoreEffectKind.StreamingSinkAppendPlaintext ||
        this == CoreEffectKind.StreamingSinkBeginEncrypted ||
        this == CoreEffectKind.StreamingSinkAppendEncrypted ||
        this == CoreEffectKind.StreamingSinkFinalize ||
        this == CoreEffectKind.StreamingSinkDiscard
