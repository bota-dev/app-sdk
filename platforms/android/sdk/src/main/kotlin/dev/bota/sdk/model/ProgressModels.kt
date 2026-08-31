package dev.bota.sdk.model

public enum class FirmwareUpdatePhase {
    Downloading,
    AwaitingDevice,
    Transferring,
    Verifying,
    Rebooting,
    Reconnecting,
    Complete,
}

public data class FirmwareUpdateProgress(
    public val phase: FirmwareUpdatePhase,
    public val completedBytes: ULong,
    public val totalBytes: ULong,
)

public data class RecordingTransferProgress(
    public val completedBytes: ULong,
    public val totalBytes: ULong,
)

public data class FirmwareStatus(
    public val command: UByte,
    public val result: UByte,
    public val sequenceNumber: UShort? = null,
)

public data class DeviceLogLine(
    public val message: String,
    public val isBacklog: Boolean,
)

public data class FactoryResetResult(
    public val resultCode: UByte,
    public val deletedRecordingCount: UShort,
)
