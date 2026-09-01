import BotaDeviceSDKC

enum CoreNotificationKind: Equatable, Sendable {
    case started
    case deviceDiscovered
    case connectionEstablished
    case progress
    case retrying
    case deviceUploadPreserved
    case bleFallbackReady
    case firmwareProgress
    case deviceLog
    case streamingPaused
    case streamingResumed
    case streamingCompleted
    case completed
    case cancelled
    case failed
}

struct CoreNotification: Equatable, Sendable {
    let kind: CoreNotificationKind
    let packet: CorePacket

    var isTerminal: Bool {
        kind == .completed || kind == .cancelled || kind == .failed
    }

    init(packet: CorePacket) throws {
        let kind: CoreNotificationKind
        switch packet.kind {
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_STARTED): kind = .started
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_DISCOVERED): kind = .deviceDiscovered
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_CONNECTION_ESTABLISHED): kind = .connectionEstablished
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_PROGRESS): kind = .progress
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_RETRYING): kind = .retrying
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_UPLOAD_PRESERVED): kind = .deviceUploadPreserved
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_BLE_FALLBACK_READY): kind = .bleFallbackReady
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_FIRMWARE_PROGRESS): kind = .firmwareProgress
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_LOG): kind = .deviceLog
        case 0x040d: kind = .streamingPaused
        case 0x040e: kind = .streamingResumed
        case 0x040f: kind = .streamingCompleted
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED): kind = .completed
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_CANCELLED): kind = .cancelled
        case UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_FAILED): kind = .failed
        default:
            throw CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNKNOWN_PACKET),
                operation: packet.operation,
                retryable: false,
                protocolStatus: nil,
                detail: "unknown notification kind \(packet.kind)"
            )
        }
        self.kind = kind
        self.packet = packet
    }
}
