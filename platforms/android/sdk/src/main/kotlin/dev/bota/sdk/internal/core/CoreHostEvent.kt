package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativePacket

internal enum class HostEventKind(val wireValue: Int) {
    BleScanResult(0x0201),
    BleScanStopped(0x0202),
    BleConnected(0x0203),
    BleServicesDiscovered(0x0204),
    BleSubscribed(0x0205),
    BleDisconnected(0x0206),
    BleReadCompleted(0x0207),
    BleWriteCompleted(0x0208),
    BleNotification(0x0209),
    BleFailed(0x020a),
    TimerFired(0x0210),
    CheckpointLoaded(0x0211),
    CheckpointSaved(0x0212),
    ConnectionIdentitySaved(0x0213),
    FactoryResetResultSaved(0x0214),
    FactoryResetResultDeleted(0x0215),
    PersistenceFailed(0x0216),
    ProvisioningMaterialPrepared(0x0217),
    FactoryResetGrantPrepared(0x0218),
    HostMaterialFailed(0x0219),
    RecordingSinkTruncated(0x021a),
    RecordingSinkAppendCompleted(0x021b),
    RecordingSinkFinalized(0x021c),
    RecordingSinkIntegrityFailed(0x021d),
    RecordingSinkFailed(0x021e),
    FirmwareChunkRead(0x021f),
    FirmwareBlobFailed(0x0220),
    SecretLoaded(0x0221),
    SecretStored(0x0222),
    NetworkDownloadProgress(0x0223),
    NetworkDownloadCompleted(0x0224),
    NetworkUploadProgress(0x0225),
    NetworkUploadCompleted(0x0226),
    NetworkFailed(0x0227),
}

internal data class CoreHostEvent(
    val kind: HostEventKind,
    val operation: Int,
    val requestId: ULong,
    val cancellationId: CoreCancellationId,
    val fields: List<CoreField>,
) {
    val packet: NativePacket
        get() = fields.toNativePacket(
            kind = kind.wireValue,
            operation = operation,
            requestId = requestId,
            cancellationId = cancellationId,
        )

    companion object {
        fun fromEffect(
            effect: CoreEffect,
            kind: HostEventKind,
            fields: List<CoreField> = emptyList(),
        ) = CoreHostEvent(kind, effect.operation, effect.requestId, effect.cancellationId, fields)
    }
}
