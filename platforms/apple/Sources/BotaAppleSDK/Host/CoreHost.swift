import BotaDeviceSDKC
import Foundation

enum CoreEffect: Equatable, Sendable {
    static let maximumRawByteCount = 1_048_576

    case timerSchedule(CorePacket)
    case timerCancel(CorePacket)
    case persistenceLoadCheckpoint(CorePacket)
    case persistenceSaveCheckpoint(CorePacket)
    case persistenceDeleteCheckpoint(CorePacket)
    case persistenceSaveConnectionIdentity(CorePacket)
    case persistenceSaveFactoryResetResult(CorePacket)
    case persistenceDeleteFactoryResetResult(CorePacket)
    case secureStorageRead(CorePacket)
    case secureStorageWrite(CorePacket)
    case secureStorageDelete(CorePacket)
    case bluetoothStartScan(CorePacket)
    case bluetoothStopScan(CorePacket)
    case bluetoothConnect(CorePacket)
    case bluetoothDiscoverServices(CorePacket)
    case bluetoothDisconnect(CorePacket)
    case bluetoothRead(CorePacket)
    case bluetoothWrite(CorePacket)
    case bluetoothSubscribe(CorePacket)
    case bluetoothUnsubscribe(CorePacket)
    case networkDownload(CorePacket)
    case networkUpload(CorePacket)
    case progress(CorePacket)
    case prepareProvisioning(CorePacket)
    case prepareFactoryResetGrant(CorePacket)
    case recordingSinkTruncate(CorePacket)
    case recordingSinkAppend(CorePacket)
    case recordingSinkFinalize(CorePacket)
    case recordingSinkDiscard(CorePacket)
    case streamingSinkAppendPlaintext(CorePacket)
    case streamingSinkBeginEncrypted(CorePacket)
    case streamingSinkAppendEncrypted(CorePacket)
    case streamingSinkFinalize(CorePacket)
    case streamingSinkDiscard(CorePacket)
    case firmwareBlobRead(CorePacket)

    init(packet: CorePacket) throws {
        let rawByteCount = packet.fields.reduce(into: 0) { count, field in
            switch field {
            case let .text(_, value): count += value.utf8.count
            case let .bytes(_, value): count += value.count
            case .unsigned, .signed, .bool: break
            }
        }
        guard rawByteCount <= Self.maximumRawByteCount else {
            throw CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_PAYLOAD_TOO_LARGE),
                operation: packet.operation,
                retryable: false,
                protocolStatus: nil,
                detail: "host effect contains more than \(Self.maximumRawByteCount) raw bytes"
            )
        }

        switch packet.kind {
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE): self = .timerSchedule(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_CANCEL): self = .timerCancel(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT): self = .persistenceLoadCheckpoint(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT): self = .persistenceSaveCheckpoint(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT): self = .persistenceDeleteCheckpoint(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY): self = .persistenceSaveConnectionIdentity(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT): self = .persistenceSaveFactoryResetResult(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT): self = .persistenceDeleteFactoryResetResult(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_READ): self = .secureStorageRead(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_WRITE): self = .secureStorageWrite(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_DELETE): self = .secureStorageDelete(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN): self = .bluetoothStartScan(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN): self = .bluetoothStopScan(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_CONNECT): self = .bluetoothConnect(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCOVER_SERVICES): self = .bluetoothDiscoverServices(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCONNECT): self = .bluetoothDisconnect(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_READ): self = .bluetoothRead(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_WRITE): self = .bluetoothWrite(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_SUBSCRIBE): self = .bluetoothSubscribe(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_UNSUBSCRIBE): self = .bluetoothUnsubscribe(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD): self = .networkDownload(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_UPLOAD): self = .networkUpload(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PROGRESS): self = .progress(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_PROVISIONING): self = .prepareProvisioning(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT): self = .prepareFactoryResetGrant(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_TRUNCATE): self = .recordingSinkTruncate(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_APPEND): self = .recordingSinkAppend(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_FINALIZE): self = .recordingSinkFinalize(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_DISCARD): self = .recordingSinkDiscard(packet)
        case 0x033c: self = .streamingSinkAppendPlaintext(packet)
        case 0x033d: self = .streamingSinkBeginEncrypted(packet)
        case 0x033e: self = .streamingSinkAppendEncrypted(packet)
        case 0x033f: self = .streamingSinkFinalize(packet)
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_FIRMWARE_BLOB_READ): self = .firmwareBlobRead(packet)
        case 0x0341: self = .streamingSinkDiscard(packet)
        default:
            throw CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNKNOWN_PACKET),
                operation: packet.operation,
                retryable: false,
                protocolStatus: nil,
                detail: "packet kind \(packet.kind) is not a host effect"
            )
        }
    }

    var packet: CorePacket {
        switch self {
        case let .timerSchedule(packet), let .timerCancel(packet),
             let .persistenceLoadCheckpoint(packet), let .persistenceSaveCheckpoint(packet),
             let .persistenceDeleteCheckpoint(packet), let .persistenceSaveConnectionIdentity(packet),
             let .persistenceSaveFactoryResetResult(packet), let .persistenceDeleteFactoryResetResult(packet),
             let .secureStorageRead(packet), let .secureStorageWrite(packet), let .secureStorageDelete(packet),
             let .bluetoothStartScan(packet), let .bluetoothStopScan(packet), let .bluetoothConnect(packet),
             let .bluetoothDiscoverServices(packet), let .bluetoothDisconnect(packet), let .bluetoothRead(packet),
             let .bluetoothWrite(packet), let .bluetoothSubscribe(packet), let .bluetoothUnsubscribe(packet),
             let .networkDownload(packet), let .networkUpload(packet), let .progress(packet),
             let .prepareProvisioning(packet), let .prepareFactoryResetGrant(packet),
             let .recordingSinkTruncate(packet), let .recordingSinkAppend(packet),
             let .recordingSinkFinalize(packet), let .recordingSinkDiscard(packet),
             let .streamingSinkAppendPlaintext(packet), let .streamingSinkBeginEncrypted(packet),
             let .streamingSinkAppendEncrypted(packet), let .streamingSinkFinalize(packet),
             let .streamingSinkDiscard(packet),
             let .firmwareBlobRead(packet):
            return packet
        }
    }

    var kind: UInt32 { packet.kind }
    var operation: UInt32 { packet.operation }
    var requestID: UInt64 { packet.requestID }
    var cancellationID: CoreCancellationID {
        CoreCancellationID(high: packet.cancellationHigh, low: packet.cancellationLow)
    }
}

extension CoreCancellationID {
    init(high: UInt64, low: UInt64) {
        self.high = high
        self.low = low
    }
}

struct CoreHostEventPayload: Equatable, Sendable {
    let kind: UInt32
    let fields: [CoreField]

    init(kind: UInt32, fields: [CoreField] = []) {
        self.kind = kind
        self.fields = fields
    }
}

struct CoreHostEvent: Equatable, Sendable {
    let kind: UInt32
    let operation: UInt32
    let requestID: UInt64
    let cancellationHigh: UInt64
    let cancellationLow: UInt64
    let fields: [CoreField]

    init(effect: CoreEffect, kind: UInt32, fields: [CoreField] = []) {
        self.kind = kind
        operation = effect.operation
        requestID = effect.requestID
        cancellationHigh = effect.packet.cancellationHigh
        cancellationLow = effect.packet.cancellationLow
        self.fields = fields
    }

    init(effect: CoreEffect, payload: CoreHostEventPayload) {
        self.init(effect: effect, kind: payload.kind, fields: payload.fields)
    }

    var packet: CorePacket {
        CorePacket(
            kind: kind,
            operation: operation,
            requestID: requestID,
            cancellationHigh: cancellationHigh,
            cancellationLow: cancellationLow,
            fields: fields
        )
    }

    func withRequestID(_ requestID: UInt64) -> Self {
        Self(
            kind: kind,
            operation: operation,
            requestID: requestID,
            cancellationHigh: cancellationHigh,
            cancellationLow: cancellationLow,
            fields: fields
        )
    }

    private init(
        kind: UInt32,
        operation: UInt32,
        requestID: UInt64,
        cancellationHigh: UInt64,
        cancellationLow: UInt64,
        fields: [CoreField]
    ) {
        self.kind = kind
        self.operation = operation
        self.requestID = requestID
        self.cancellationHigh = cancellationHigh
        self.cancellationLow = cancellationLow
        self.fields = fields
    }
}

protocol CoreHost: Sendable {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error>
    func cancel(_ cancellationID: CoreCancellationID) async
}

extension CoreHost {
    func cancel(_ cancellationID: CoreCancellationID) async {}
}

extension Array where Element == CoreField {
    func unsigned(_ id: UInt32) -> UInt64? {
        for field in self {
            if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
