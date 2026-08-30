public enum BotaDeviceSDKErrorCode: Equatable, Sendable {
    case invalidInput
    case truncatedPacket
    case unknownPacket
    case payloadTooLarge
    case unsupportedCapability
    case unsupportedOperation
    case featureUnavailable
    case operationInProgress
    case unexpectedEvent
    case deviceNotFound
    case identityMismatch
    case connectionFailed
    case persistenceFailed
    case notConnected
    case timeout
    case cancelled
    case protocolRejected
    case integrityFailed
    case uploadOwnershipUnknown
    case downloadFailed
    case `internal`
    case unknown(UInt32)
}

public enum BotaOperation: Equatable, Sendable {
    case validate
    case decode
    case encode
    case discover
    case connect
    case reconnect
    case provision
    case transferRecording
    case upload
    case updateFirmware
    case readDeviceLogs
    case factoryReset
    case unknown(UInt32)
}

public struct BotaDeviceSDKError: Error, Equatable, Sendable {
    public let code: BotaDeviceSDKErrorCode
    public let operation: BotaOperation
    public let retryable: Bool
    public let protocolStatus: UInt16?
    public let detail: String

    public init(
        code: BotaDeviceSDKErrorCode,
        operation: BotaOperation,
        retryable: Bool,
        protocolStatus: UInt16? = nil,
        detail: String
    ) {
        self.code = code
        self.operation = operation
        self.retryable = retryable
        self.protocolStatus = protocolStatus
        self.detail = detail
    }
}
