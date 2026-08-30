public enum FirmwareUpdatePhase: Equatable, Sendable {
    case downloading
    case awaitingDevice
    case transferring
    case verifying
    case rebooting
    case reconnecting
    case complete
}

public struct FirmwareUpdateProgress: Equatable, Sendable {
    public let phase: FirmwareUpdatePhase
    public let completedBytes: UInt64
    public let totalBytes: UInt64

    public init(phase: FirmwareUpdatePhase, completedBytes: UInt64, totalBytes: UInt64) {
        self.phase = phase
        self.completedBytes = completedBytes
        self.totalBytes = totalBytes
    }
}

public struct RecordingTransferProgress: Equatable, Sendable {
    public let completedBytes: UInt64
    public let totalBytes: UInt64

    public init(completedBytes: UInt64, totalBytes: UInt64) {
        self.completedBytes = completedBytes
        self.totalBytes = totalBytes
    }
}

public struct FirmwareStatus: Equatable, Sendable {
    public let command: UInt8
    public let result: UInt8
    public let sequenceNumber: UInt16?

    public init(command: UInt8, result: UInt8, sequenceNumber: UInt16?) {
        self.command = command
        self.result = result
        self.sequenceNumber = sequenceNumber
    }
}

public struct DeviceLogLine: Equatable, Sendable {
    public let message: String
    public let isBacklog: Bool

    public init(message: String, isBacklog: Bool) {
        self.message = message
        self.isBacklog = isBacklog
    }
}

public struct FactoryResetResult: Equatable, Sendable {
    public let resultCode: UInt8
    public let deletedRecordingCount: UInt16

    public init(resultCode: UInt8, deletedRecordingCount: UInt16) {
        self.resultCode = resultCode
        self.deletedRecordingCount = deletedRecordingCount
    }
}
