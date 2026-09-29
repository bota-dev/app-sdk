import BotaDeviceSDKC
import Foundation

@testable import BotaAppSDK

actor FakeCoreHost: CoreHost {
    typealias Handler = @Sendable (CoreEffect) -> [CoreHostEvent]

    private let handler: Handler
    private let deferTimers: Bool
    private var pendingTimer: (CoreEffect, AsyncThrowingStream<CoreHostEvent, Error>.Continuation)?
    private(set) var effects: [CoreEffect] = []

    init(handler: @escaping Handler, deferTimers: Bool = false) {
        self.handler = handler
        self.deferTimers = deferTimers
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        effects.append(effect)
        if deferTimers && effect.kind == UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE) {
            let pair = AsyncThrowingStream<CoreHostEvent, Error>.makeStream()
            pendingTimer = (effect, pair.continuation)
            return pair.stream
        }
        let events = handler(effect)
        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func fireTimer() {
        guard let (effect, continuation) = pendingTimer else { return }
        pendingTimer = nil
        for event in handler(effect) {
            continuation.yield(event)
        }
        continuation.finish()
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
