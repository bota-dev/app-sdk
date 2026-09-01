package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.BotaOperation
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import dev.bota.sdk.internal.host.BluetoothHost
import dev.bota.sdk.internal.host.CoreHostEventPayload
import dev.bota.sdk.internal.host.NativeHostException
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow

internal class BluetoothGattHost(
    private val driver: BluetoothDriver,
    private val permissions: BluetoothPermissionChecker,
    private val radioArbiter: RadioArbiter = RadioArbiter(),
) : BluetoothHost {
    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        when (effect.kind) {
            CoreEffectKind.BluetoothStartScan -> scan(effect) { emit(it) }
            CoreEffectKind.BluetoothStopScan -> {
                permissions.requireScan(effect.operation.toBotaOperation())
                driver.stopScan()
                emit(CoreHostEventPayload(HostEventKind.BleScanStopped))
            }
            CoreEffectKind.BluetoothConnect -> connect(effect) { emit(it) }
            CoreEffectKind.BluetoothDiscoverServices -> {
                val peripheralId = requiredPeripheral(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                driver.discoverServices(peripheralId)
                emit(peripheralPayload(HostEventKind.BleServicesDiscovered, peripheralId))
            }
            CoreEffectKind.BluetoothDisconnect -> {
                val peripheralId = requiredPeripheral(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                driver.disconnect(peripheralId)
                radioArbiter.release(peripheralId)
                emit(peripheralPayload(HostEventKind.BleDisconnected, peripheralId))
            }
            CoreEffectKind.BluetoothRead -> {
                val characteristic = characteristic(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                val value = driver.read(characteristic.peripheralId, characteristic.service, characteristic.characteristic)
                emit(CoreHostEventPayload(HostEventKind.BleReadCompleted, listOf(CoreField.Bytes(30, value))))
            }
            CoreEffectKind.BluetoothWrite -> {
                val characteristic = characteristic(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                driver.write(
                    characteristic.peripheralId,
                    characteristic.service,
                    characteristic.characteristic,
                    effect.packet.bytes(33) ?: invalid("Bluetooth write payload is missing"),
                    effect.packet.booleans(34).firstOrNull() ?: invalid("Bluetooth write response mode is missing"),
                )
                emit(CoreHostEventPayload(HostEventKind.BleWriteCompleted))
            }
            CoreEffectKind.BluetoothSubscribe -> {
                val characteristic = characteristic(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                val notifications = driver.subscribe(
                    characteristic.peripheralId,
                    characteristic.service,
                    characteristic.characteristic,
                )
                emit(
                    CoreHostEventPayload(
                        HostEventKind.BleSubscribed,
                        listOf(CoreField.Text(32, characteristic.characteristic.toString())),
                    ),
                )
                notifications.collect { notification ->
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.BleNotification,
                            listOf(
                                CoreField.Text(32, characteristic.characteristic.toString()),
                                CoreField.Bytes(30, notification.value),
                            ),
                        ),
                    )
                }
            }
            CoreEffectKind.BluetoothUnsubscribe -> {
                val characteristic = characteristic(effect)
                permissions.requireConnect(effect.operation.toBotaOperation())
                driver.unsubscribe(
                    characteristic.peripheralId,
                    characteristic.service,
                    characteristic.characteristic,
                )
            }
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
            CoreEffectKind.NetworkDownload,
            CoreEffectKind.NetworkUpload,
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
            CoreEffectKind.FirmwareBlobRead -> invalid("non-Bluetooth effect reached BluetoothGattHost")
        }
    }

    private suspend fun scan(effect: CoreEffect, emit: suspend (CoreHostEventPayload) -> Unit) {
        permissions.requireScan(effect.operation.toBotaOperation())
        val allowDuplicates = effect.packet.booleans(2).firstOrNull()
            ?: invalid("Bluetooth scan duplicate mode is missing")
        val seen = mutableSetOf<String>()
        suspend fun emitAdvertisement(value: BluetoothAdvertisement) {
            if (allowDuplicates || seen.add(value.peripheralId)) emit(value.payload())
        }
        driver.connectedAdvertisements().forEach { emitAdvertisement(it) }
        driver.scan(allowDuplicates).collect { emitAdvertisement(it) }
    }

    private suspend fun connect(effect: CoreEffect, emit: suspend (CoreHostEventPayload) -> Unit) {
        permissions.requireConnect(effect.operation.toBotaOperation())
        val peripheralId = requiredPeripheral(effect)
        val priority = if (effect.operation == 5) RadioPriority.ManualSelection else RadioPriority.BackgroundReconnect
        val preempted = radioArbiter.acquire(peripheralId, priority)
        if (preempted == peripheralId) invalid("Bluetooth radio is owned by a higher-priority connection")
        if (preempted != null) runCatching { driver.disconnect(preempted) }
        try {
            driver.connect(peripheralId)
        } catch (error: Throwable) {
            radioArbiter.release(peripheralId)
            throw error
        }
        emit(peripheralPayload(HostEventKind.BleConnected, peripheralId))
    }

    private suspend fun requiredPeripheral(effect: CoreEffect): String =
        effect.packet.texts(4).firstOrNull()
            ?: radioArbiter.owner()?.peripheralId
            ?: invalid("Bluetooth operation has no current peripheral")

    private suspend fun characteristic(effect: CoreEffect): CharacteristicFields = CharacteristicFields(
        requiredPeripheral(effect),
        uuid(effect.packet.texts(31).firstOrNull(), "service"),
        uuid(effect.packet.texts(32).firstOrNull(), "characteristic"),
    )

    private fun uuid(value: String?, label: String): UUID = try {
        UUID.fromString(value ?: invalid("Bluetooth $label UUID is missing"))
    } catch (_: IllegalArgumentException) {
        invalid("Bluetooth $label UUID is invalid")
    }

    private fun BluetoothAdvertisement.payload(): CoreHostEventPayload = CoreHostEventPayload(
        HostEventKind.BleScanResult,
        buildList {
            add(CoreField.Text(4, peripheralId))
            name?.let { add(CoreField.Text(5, it)) }
            advertisedAddress?.let { add(CoreField.Text(6, it)) }
            add(CoreField.Signed(7, rssi.toLong()))
        },
    )

    private fun peripheralPayload(kind: HostEventKind, peripheralId: String): CoreHostEventPayload =
        CoreHostEventPayload(kind, listOf(CoreField.Text(4, peripheralId)))

    private fun invalid(detail: String): Nothing = throw NativeHostException(1, detail)

    private data class CharacteristicFields(
        val peripheralId: String,
        val service: UUID,
        val characteristic: UUID,
    )
}

private fun Int.toBotaOperation(): BotaOperation = when (this) {
    4 -> BotaOperation.Discover
    5 -> BotaOperation.Connect
    6 -> BotaOperation.Reconnect
    7 -> BotaOperation.Provision
    8 -> BotaOperation.TransferRecording
    9 -> BotaOperation.Upload
    10 -> BotaOperation.UpdateFirmware
    11 -> BotaOperation.ReadDeviceLogs
    12 -> BotaOperation.FactoryReset
    else -> BotaOperation.Unknown(toUInt())
}
