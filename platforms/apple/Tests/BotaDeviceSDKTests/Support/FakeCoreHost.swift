import BotaDeviceSDKC
import Foundation

@testable import BotaDeviceSDK

actor FakeCoreHost: CoreHost {
    typealias Handler = @Sendable (CoreEffect) -> [CoreHostEvent]

    private let handler: Handler
    private(set) var effects: [CoreEffect] = []

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        effects.append(effect)
        let events = handler(effect)
        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    static func discoveryHandler(staleFirst: Bool = false) -> Handler {
        { effect in
            switch effect.kind {
            case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN):
                let valid = CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_RESULT),
                    fields: [
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral-1"),
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME), value: "Bota Pin"),
                        .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: -42),
                    ]
                )
                guard staleFirst else { return [valid] }
                return [valid.withRequestID(valid.requestID + 10_000), valid]
            case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE):
                return [CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_TIMER_FIRED),
                    fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID), value: 1)]
                )]
            case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN):
                return [CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_STOPPED)
                )]
            default:
                return []
            }
        }
    }
}

extension FakeCoreHost {
    func waitForEffects(_ count: Int) async {
        while effects.count < count {
            await Task.yield()
        }
    }
}
