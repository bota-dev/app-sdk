import Foundation

public enum BotaSDKErrorCode: Equatable, Sendable {
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
    case readStatus
    case provision
    case transferRecording
    case upload
    case updateFirmware
    case readDeviceLogs
    case factoryReset
    case unknown(UInt32)
}

public struct BotaSDKError: Error, CustomNSError, LocalizedError, Equatable, Sendable {
    public static let errorDomain = "BotaAppSDK.BotaSDKError"

    public let code: BotaSDKErrorCode
    public let operation: BotaOperation
    public let retryable: Bool
    public let protocolStatus: UInt16?
    public let detail: String

    public init(
        code: BotaSDKErrorCode,
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

    public var errorCode: Int { Int(code.bridgeMetadata.number) }

    public var errorDescription: String? { bridgeDescription }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [
            NSLocalizedDescriptionKey: bridgeDescription,
            "botaErrorCode": code.bridgeMetadata.name,
            "botaOperation": operation.bridgeName,
            "retryable": retryable,
        ]
        if let protocolStatus { info["protocolStatus"] = protocolStatus }
        return info
    }

    private var bridgeDescription: String {
        detail.isEmpty ? "\(code.bridgeMetadata.name) during \(operation.bridgeName)" : detail
    }
}

private extension BotaSDKErrorCode {
    var bridgeMetadata: (number: UInt32, name: String) {
        switch self {
        case .invalidInput: (1, "invalid_input")
        case .truncatedPacket: (2, "truncated_packet")
        case .unknownPacket: (3, "unknown_packet")
        case .payloadTooLarge: (4, "payload_too_large")
        case .unsupportedCapability: (5, "unsupported_capability")
        case .unsupportedOperation: (6, "unsupported_operation")
        case .featureUnavailable: (7, "feature_unavailable")
        case .operationInProgress: (8, "operation_in_progress")
        case .unexpectedEvent: (9, "unexpected_event")
        case .deviceNotFound: (10, "device_not_found")
        case .identityMismatch: (11, "identity_mismatch")
        case .connectionFailed: (12, "connection_failed")
        case .persistenceFailed: (13, "persistence_failed")
        case .notConnected: (14, "not_connected")
        case .timeout: (15, "timeout")
        case .cancelled: (16, "cancelled")
        case .protocolRejected: (17, "protocol_rejected")
        case .integrityFailed: (18, "integrity_failed")
        case .uploadOwnershipUnknown: (19, "upload_ownership_unknown")
        case .downloadFailed: (20, "download_failed")
        case .internal: (21, "internal")
        case .unknown(let raw): (raw, "unknown")
        }
    }
}

private extension BotaOperation {
    var bridgeName: String {
        switch self {
        case .validate: "validate"
        case .decode: "decode"
        case .encode: "encode"
        case .discover: "discover"
        case .connect: "connect"
        case .reconnect: "reconnect"
        case .readStatus: "read_status"
        case .provision: "provision"
        case .transferRecording: "transfer_recording"
        case .upload: "upload"
        case .updateFirmware: "update_firmware"
        case .readDeviceLogs: "read_device_logs"
        case .factoryReset: "factory_reset"
        case .unknown: "unknown"
        }
    }
}
