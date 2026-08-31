package dev.bota.sdk.internal

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.core.CoreNotification
import dev.bota.sdk.internal.jni.NativeCoreException

internal fun CoreNotification.workflowError(): BotaSDKError.Core = BotaSDKError.Core(
    code = botaErrorCode(packet.unsigneds(47).firstOrNull()?.toUInt() ?: 21u),
    operation = botaOperation(packet.operation),
    retryable = packet.booleans(48).firstOrNull() ?: false,
    protocolStatus = packet.unsigneds(49).firstOrNull()?.takeIf { it <= UShort.MAX_VALUE.toULong() }?.toUShort(),
    detail = packet.texts(50).firstOrNull() ?: "device workflow failed",
)

internal fun NativeCoreException.toPublicError(): BotaSDKError.Core = BotaSDKError.Core(
    code = botaErrorCode(code.toUInt()),
    operation = botaOperation(operation),
    retryable = retryable,
    protocolStatus = protocolStatus.takeIf { it >= 0 }?.toUShort(),
    detail = detail,
)

internal fun botaErrorCode(raw: UInt): BotaErrorCode = when (raw.toInt()) {
    1 -> BotaErrorCode.InvalidInput
    2 -> BotaErrorCode.TruncatedPacket
    3 -> BotaErrorCode.UnknownPacket
    4 -> BotaErrorCode.PayloadTooLarge
    5 -> BotaErrorCode.UnsupportedCapability
    6 -> BotaErrorCode.UnsupportedOperation
    7 -> BotaErrorCode.FeatureUnavailable
    8 -> BotaErrorCode.OperationInProgress
    9 -> BotaErrorCode.UnexpectedEvent
    10 -> BotaErrorCode.DeviceNotFound
    11 -> BotaErrorCode.IdentityMismatch
    12 -> BotaErrorCode.ConnectionFailed
    13 -> BotaErrorCode.PersistenceFailed
    14 -> BotaErrorCode.NotConnected
    15 -> BotaErrorCode.Timeout
    16 -> BotaErrorCode.Cancelled
    17 -> BotaErrorCode.ProtocolRejected
    18 -> BotaErrorCode.IntegrityFailed
    19 -> BotaErrorCode.UploadOwnershipUnknown
    20 -> BotaErrorCode.DownloadFailed
    21 -> BotaErrorCode.Internal
    else -> BotaErrorCode.Unknown(raw)
}

internal fun botaOperation(raw: Int): BotaOperation = when (raw) {
    1 -> BotaOperation.Validate
    2 -> BotaOperation.Decode
    3 -> BotaOperation.Encode
    4 -> BotaOperation.Discover
    5 -> BotaOperation.Connect
    6 -> BotaOperation.Reconnect
    7 -> BotaOperation.Provision
    8 -> BotaOperation.TransferRecording
    9 -> BotaOperation.Upload
    10 -> BotaOperation.UpdateFirmware
    11 -> BotaOperation.ReadDeviceLogs
    12 -> BotaOperation.FactoryReset
    else -> BotaOperation.Unknown(raw.toUInt())
}
