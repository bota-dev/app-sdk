package dev.bota.sdk.model

import java.time.Instant

public enum class AudioCodec {
    Pcm16k,
    Pcm8k,
    Opus16k,
    Opus8k,
}

public data class DeviceRecording(
    public val uuid: String,
    public val startedAt: Instant,
    public val durationMs: ULong,
    public val fileSizeBytes: ULong,
    public val codec: WireValue<AudioCodec>,
    public val isEncrypted: Boolean,
)

public enum class RecordingInitiator {
    Local,
    Remote,
}

public data class RecordingState(
    public val active: Boolean,
    public val recordingId: String? = null,
    public val initiatedBy: RecordingInitiator = RecordingInitiator.Local,
)

public enum class RecordingControlError(public val wireValue: String) {
    AlreadyRecording("already_recording"),
    NotRecording("not_recording"),
    InvalidGrant("invalid_grant"),
    GrantExpired("grant_expired"),
    InvalidState("invalid_state"),
    InvalidResponse("invalid_response"),
    UnknownError("unknown_error"),
}

public data class RecordingControlResult(
    public val success: Boolean,
    public val error: RecordingControlError? = null,
)

public enum class TransferPacketType {
    Data,
    Eof,
    Paused,
    Sha256,
    E2eStart,
    EncryptedData,
    EncryptedEof,
    Error,
}

public class TransferPacket(
    public val type: TransferPacketType,
    public val sequenceNumber: UShort = 0u,
    data: ByteArray? = null,
    public val checksum: UInt? = null,
    public val bytesSent: UInt? = null,
    public val errorCode: UByte? = null,
    e2eEphemeralPublicKey: ByteArray? = null,
    e2eSalt: ByteArray? = null,
    e2eChunk: ByteArray? = null,
    sha256: ByteArray? = null,
) {
    private val storedData = data?.copyOf()
    private val storedE2eEphemeralPublicKey = e2eEphemeralPublicKey?.copyOf()
    private val storedE2eSalt = e2eSalt?.copyOf()
    private val storedE2eChunk = e2eChunk?.copyOf()
    private val storedSha256 = sha256?.copyOf()

    public val data: ByteArray? get() = storedData?.copyOf()
    public val e2eEphemeralPublicKey: ByteArray? get() = storedE2eEphemeralPublicKey?.copyOf()
    public val e2eSalt: ByteArray? get() = storedE2eSalt?.copyOf()
    public val e2eChunk: ByteArray? get() = storedE2eChunk?.copyOf()
    public val sha256: ByteArray? get() = storedSha256?.copyOf()

    override fun equals(other: Any?): Boolean = other is TransferPacket &&
        type == other.type && sequenceNumber == other.sequenceNumber &&
        storedData.contentEqualsNullable(other.storedData) && checksum == other.checksum &&
        bytesSent == other.bytesSent && errorCode == other.errorCode &&
        storedE2eEphemeralPublicKey.contentEqualsNullable(other.storedE2eEphemeralPublicKey) &&
        storedE2eSalt.contentEqualsNullable(other.storedE2eSalt) &&
        storedE2eChunk.contentEqualsNullable(other.storedE2eChunk) &&
        storedSha256.contentEqualsNullable(other.storedSha256)

    override fun hashCode(): Int {
        var result = type.hashCode()
        result = 31 * result + sequenceNumber.hashCode()
        result = 31 * result + (storedData?.contentHashCode() ?: 0)
        result = 31 * result + (checksum?.hashCode() ?: 0)
        result = 31 * result + (bytesSent?.hashCode() ?: 0)
        result = 31 * result + (errorCode?.hashCode() ?: 0)
        result = 31 * result + (storedE2eEphemeralPublicKey?.contentHashCode() ?: 0)
        result = 31 * result + (storedE2eSalt?.contentHashCode() ?: 0)
        result = 31 * result + (storedE2eChunk?.contentHashCode() ?: 0)
        return 31 * result + (storedSha256?.contentHashCode() ?: 0)
    }
}

public data class TriggerDeviceUploadResponse(
    public val accepted: Boolean,
    public val errorCode: UByte? = null,
)

public enum class AckType {
    Ack,
    Nack,
    Abort;

    public companion object
}

public sealed interface TransferCommand {
    public data object List : TransferCommand
    public data class Start(public val recordingUuid: String) : TransferCommand
    public data object TriggerDeviceUpload : TransferCommand
    public data class Confirm(public val recordingUuid: String) : TransferCommand

    public companion object
}
