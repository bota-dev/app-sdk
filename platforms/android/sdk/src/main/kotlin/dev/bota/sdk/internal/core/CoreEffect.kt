package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.jni.NativePacket

internal enum class CoreEffectKind(val wireValue: Int) {
    TimerSchedule(0x0301),
    TimerCancel(0x0302),
    PersistenceLoadCheckpoint(0x0303),
    PersistenceSaveCheckpoint(0x0304),
    PersistenceDeleteCheckpoint(0x0305),
    PersistenceSaveConnectionIdentity(0x0306),
    PersistenceSaveFactoryResetResult(0x0307),
    PersistenceDeleteFactoryResetResult(0x0308),
    SecureStorageRead(0x0309),
    SecureStorageWrite(0x030a),
    SecureStorageDelete(0x030b),
    BluetoothStartScan(0x0310),
    BluetoothStopScan(0x0311),
    BluetoothConnect(0x0312),
    BluetoothDiscoverServices(0x0313),
    BluetoothDisconnect(0x0314),
    BluetoothRead(0x0315),
    BluetoothWrite(0x0316),
    BluetoothSubscribe(0x0317),
    BluetoothUnsubscribe(0x0318),
    NetworkDownload(0x0320),
    NetworkUpload(0x0321),
    Progress(0x0328),
    PrepareProvisioning(0x0330),
    PrepareFactoryResetGrant(0x0331),
    RecordingSinkTruncate(0x0338),
    RecordingSinkAppend(0x0339),
    RecordingSinkFinalize(0x033a),
    RecordingSinkDiscard(0x033b),
    StreamingSinkAppendPlaintext(0x033c),
    StreamingSinkBeginEncrypted(0x033d),
    StreamingSinkAppendEncrypted(0x033e),
    StreamingSinkFinalize(0x033f),
    FirmwareBlobRead(0x0340),
    StreamingSinkDiscard(0x0341),
    ;

    companion object {
        fun fromWireValue(value: Int): CoreEffectKind = entries.firstOrNull { it.wireValue == value }
            ?: throw NativeCoreException(3, 0, false, -1, "packet kind $value is not a host effect")
    }
}

internal data class CoreEffect(val kind: CoreEffectKind, val packet: NativePacket) {
    val operation: Int get() = packet.operation
    val requestId: ULong get() = packet.requestId
    val cancellationId: CoreCancellationId get() = CoreCancellationId(packet.cancellationHigh, packet.cancellationLow)

    companion object {
        const val MaximumRawByteCount: Int = 1_048_576

        fun fromPacket(packet: NativePacket): CoreEffect {
            val rawByteCount = packet.dataValues.sumOf { value ->
                when (value) {
                    is ByteArray -> value.size
                    is java.nio.ByteBuffer -> value.remaining()
                    else -> 0
                }
            }
            if (rawByteCount > MaximumRawByteCount) {
                throw NativeCoreException(
                    4,
                    packet.operation,
                    false,
                    -1,
                    "host effect contains more than $MaximumRawByteCount raw bytes",
                )
            }
            return CoreEffect(CoreEffectKind.fromWireValue(packet.kind), packet)
        }
    }
}
