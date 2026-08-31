package dev.bota.sdk

public sealed interface BotaErrorCode {
    public data object InvalidInput : BotaErrorCode
    public data object TruncatedPacket : BotaErrorCode
    public data object UnknownPacket : BotaErrorCode
    public data object PayloadTooLarge : BotaErrorCode
    public data object UnsupportedCapability : BotaErrorCode
    public data object UnsupportedOperation : BotaErrorCode
    public data object FeatureUnavailable : BotaErrorCode
    public data object OperationInProgress : BotaErrorCode
    public data object UnexpectedEvent : BotaErrorCode
    public data object DeviceNotFound : BotaErrorCode
    public data object IdentityMismatch : BotaErrorCode
    public data object ConnectionFailed : BotaErrorCode
    public data object PersistenceFailed : BotaErrorCode
    public data object NotConnected : BotaErrorCode
    public data object Timeout : BotaErrorCode
    public data object Cancelled : BotaErrorCode
    public data object ProtocolRejected : BotaErrorCode
    public data object IntegrityFailed : BotaErrorCode
    public data object UploadOwnershipUnknown : BotaErrorCode
    public data object DownloadFailed : BotaErrorCode
    public data object Internal : BotaErrorCode
    public data class Unknown(public val rawValue: UInt) : BotaErrorCode
}

public sealed interface BotaOperation {
    public data object Validate : BotaOperation
    public data object Decode : BotaOperation
    public data object Encode : BotaOperation
    public data object Discover : BotaOperation
    public data object Connect : BotaOperation
    public data object Reconnect : BotaOperation
    public data object Provision : BotaOperation
    public data object TransferRecording : BotaOperation
    public data object Upload : BotaOperation
    public data object UpdateFirmware : BotaOperation
    public data object ReadDeviceLogs : BotaOperation
    public data object FactoryReset : BotaOperation
    public data class Unknown(public val rawValue: UInt) : BotaOperation
}

public sealed class BotaSDKError(
    public open val operation: BotaOperation,
    public open val retryable: Boolean,
    message: String,
) : Exception(message) {
    public data class AuthorizationRequired(
        public val permissions: Set<String>,
        override val operation: BotaOperation,
    ) : BotaSDKError(operation, false, "Required Bluetooth permission is missing")

    public data class Core(
        public val code: BotaErrorCode,
        override val operation: BotaOperation,
        override val retryable: Boolean,
        public val protocolStatus: UShort?,
        public val detail: String,
    ) : BotaSDKError(operation, retryable, detail)
}
