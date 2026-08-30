import BotaDeviceSDKC
import Foundation

struct CoreEffect: Equatable, Sendable {
    let packet: CorePacket

    var kind: UInt32 { packet.kind }
    var operation: UInt32 { packet.operation }
    var requestID: UInt64 { packet.requestID }
    var cancellationID: CoreCancellationID {
        CoreCancellationID(high: packet.cancellationHigh, low: packet.cancellationLow)
    }

    init(packet: CorePacket) throws {
        guard packet.kind > UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RANGE_START),
              packet.kind < UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_RANGE_START)
        else {
            throw CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNKNOWN_PACKET),
                operation: packet.operation,
                retryable: false,
                protocolStatus: nil,
                detail: "packet is not a host effect"
            )
        }
        self.packet = packet
    }
}

extension CoreCancellationID {
    init(high: UInt64, low: UInt64) {
        self.high = high
        self.low = low
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
}
