import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class HostEffectExecutorTests: XCTestCase {
    func testRoutesEveryEffectKindAndPreservesCorrelation() async throws {
        let recorder = PortRecorder()
        let progress = ProgressRecorder()
        let executor = HostEffectExecutor(
            bluetooth: ProbePort(name: "bluetooth", recorder: recorder),
            persistence: ProbePort(name: "persistence", recorder: recorder),
            network: ProbePort(name: "network", recorder: recorder),
            material: ProbePort(name: "material", recorder: recorder),
            recordingSink: ProbePort(name: "recordingSink", recorder: recorder),
            firmwareBlob: ProbePort(name: "firmwareBlob", recorder: recorder),
            progress: { completed, total in await progress.record(completed: completed, total: total) }
        )

        for vector in EffectVector.all {
            let effect = try CoreEffect(packet: vector.packet)
            let stream = await executor.execute(effect)
            var events: [CoreHostEvent] = []
            for try await event in stream {
                events.append(event)
            }

            if let port = vector.port {
                let recordedPort = await recorder.removeFirst()
                XCTAssertEqual(recordedPort, port, "kind \(vector.packet.kind)")
            }
            for event in events {
                XCTAssertEqual(event.operation, vector.packet.operation)
                XCTAssertEqual(event.requestID, vector.packet.requestID)
                XCTAssertEqual(event.cancellationHigh, vector.packet.cancellationHigh)
                XCTAssertEqual(event.cancellationLow, vector.packet.cancellationLow)
            }
        }

        let progressValues = await progress.values
        XCTAssertEqual(progressValues, [[7, 10]])
        XCTAssertEqual(EffectVector.all.count, 30)
    }

    func testMapsPortFailureToCategoryEventWithoutChangingCorrelation() async throws {
        let executor = HostEffectExecutor(
            bluetooth: FailingPort(),
            persistence: FailingPort(),
            network: FailingPort(),
            material: FailingPort(),
            recordingSink: FailingPort(),
            firmwareBlob: FailingPort()
        )

        let expected: [(EffectVector, UInt32)] = [
            (EffectVector.named("ble_connect"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_FAILED)),
            (EffectVector.named("load_checkpoint"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_PERSISTENCE_FAILED)),
            (EffectVector.named("network_download"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_FAILED)),
            (EffectVector.named("prepare_provisioning"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_HOST_MATERIAL_FAILED)),
            (EffectVector.named("sink_append"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FAILED)),
            (EffectVector.named("firmware_read"), UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FIRMWARE_BLOB_FAILED)),
        ]

        for (vector, failureKind) in expected {
            let stream = await executor.execute(try CoreEffect(packet: vector.packet))
            var events: [CoreHostEvent] = []
            for try await event in stream { events.append(event) }
            XCTAssertEqual(events.count, 1)
            XCTAssertEqual(events.first?.kind, failureKind)
            XCTAssertEqual(events.first?.requestID, vector.packet.requestID)
        }
    }

    func testRejectsUnboundedRawEffectBytes() throws {
        let packet = EffectVector.named("ble_write").packet.replacingFields([
            .bytes(
                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD),
                value: Data(repeating: 0, count: CoreEffect.maximumRawByteCount + 1)
            ),
        ])

        XCTAssertThrowsError(try CoreEffect(packet: packet)) { error in
            XCTAssertEqual((error as? CoreError)?.code, UInt32(BOTA_DEVICE_SDK_V1_ERROR_PAYLOAD_TOO_LARGE))
        }
    }

    func testCancellingASuspendedPortFinishesItsStream() async throws {
        let suspended = SuspendedPort()
        let executor = HostEffectExecutor(
            bluetooth: suspended,
            persistence: ProbePort(name: "persistence", recorder: PortRecorder()),
            network: ProbePort(name: "network", recorder: PortRecorder()),
            material: ProbePort(name: "material", recorder: PortRecorder()),
            recordingSink: ProbePort(name: "recordingSink", recorder: PortRecorder()),
            firmwareBlob: ProbePort(name: "firmwareBlob", recorder: PortRecorder())
        )
        let vector = EffectVector.named("ble_connect")
        let effect = try CoreEffect(packet: vector.packet)
        let stream = await executor.execute(effect)
        let consumer = Task {
            for try await _ in stream {}
        }
        await suspended.waitUntilStarted()

        await executor.cancel(effect.cancellationID)

        try await consumer.value
        let wasCancelled = await suspended.wasCancelled
        XCTAssertTrue(wasCancelled)
    }

    func testLateCompletionCannotCompleteANewerRequest() async throws {
        let bluetooth = ControllableBluetoothPort()
        let executor = HostEffectExecutor(
            bluetooth: bluetooth,
            persistence: ProbePort(name: "persistence", recorder: PortRecorder()),
            network: ProbePort(name: "network", recorder: PortRecorder()),
            material: ProbePort(name: "material", recorder: PortRecorder()),
            recordingSink: ProbePort(name: "recordingSink", recorder: PortRecorder()),
            firmwareBlob: ProbePort(name: "firmwareBlob", recorder: PortRecorder())
        )
        let firstPacket = EffectVector.named("ble_connect").packet
        let first = try CoreEffect(packet: firstPacket)
        let firstStream = await executor.execute(first)
        let firstConsumer = Task { for try await _ in firstStream {} }
        await bluetooth.waitForRequest(first.requestID)
        await executor.cancel(first.cancellationID)
        try await firstConsumer.value

        let secondPacket = firstPacket.replacingCorrelation(requestID: 999, high: 21, low: 22)
        let second = try CoreEffect(packet: secondPacket)
        let secondStream = await executor.execute(second)
        let secondConsumer = Task {
            var events: [CoreHostEvent] = []
            for try await event in secondStream { events.append(event) }
            return events
        }
        await bluetooth.waitForRequest(second.requestID)

        await bluetooth.complete(requestID: first.requestID)
        await bluetooth.complete(requestID: second.requestID)

        let events = try await secondConsumer.value
        XCTAssertEqual(events.map(\.requestID), [second.requestID])
        XCTAssertEqual(events.map(\.cancellationHigh), [21])
        XCTAssertEqual(events.map(\.cancellationLow), [22])
    }
}

private actor PortRecorder {
    private var values: [String] = []
    func record(_ value: String) { values.append(value) }
    func removeFirst() -> String? { values.isEmpty ? nil : values.removeFirst() }
}

private actor ProgressRecorder {
    private(set) var values: [[UInt64]] = []
    func record(completed: UInt64, total: UInt64) { values.append([completed, total]) }
}

private struct ProbePort: BluetoothHost, PersistenceHost, NetworkHost, MaterialHost, RecordingSinkHost, FirmwareBlobHost {
    let name: String
    let recorder: PortRecorder

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        await recorder.record(name)
        let payloads = EffectEventFactory.payloads(for: effect)
        return AsyncThrowingStream { continuation in
            payloads.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }
}

private struct FailingPort: BluetoothHost, PersistenceHost, NetworkHost, MaterialHost, RecordingSinkHost, FirmwareBlobHost {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: CocoaError(.fileReadUnknown))
        }
    }
}

private actor SuspendedPort: BluetoothHost {
    private var continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation?
    private(set) var wasCancelled = false

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await self.markCancelled() }
            }
        }
    }

    func waitUntilStarted() async {
        while continuation == nil { await Task.yield() }
    }

    private func markCancelled() {
        wasCancelled = true
        continuation = nil
    }
}

private actor ControllableBluetoothPort: BluetoothHost {
    private var continuations: [UInt64: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation] = [:]

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        continuations[effect.requestID] = pair.continuation
        return pair.stream
    }

    func waitForRequest(_ requestID: UInt64) async {
        while continuations[requestID] == nil { await Task.yield() }
    }

    func complete(requestID: UInt64) {
        guard let continuation = continuations.removeValue(forKey: requestID) else { return }
        continuation.yield(CoreHostEventPayload(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_CONNECTED),
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral")]
        ))
        continuation.finish()
    }
}

private enum EffectEventFactory {
    static func payloads(for effect: CoreEffect) -> [CoreHostEventPayload] {
        switch effect.kind {
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_LOADED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT),
             UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_SAVED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CONNECTION_IDENTITY_SAVED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_SAVED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_DELETED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_READ):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_LOADED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: "key")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_WRITE),
             UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_DELETE):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_STORED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: "key")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_RESULT),
                fields: [
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral"),
                    .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: -40),
                ]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_STOPPED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_CONNECT):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_CONNECTED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCOVER_SERVICES):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SERVICES_DISCOVERED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCONNECT):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_DISCONNECTED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "peripheral")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_READ):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_READ_COMPLETED), fields: [
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: Data())
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_WRITE):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_WRITE_COMPLETED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_SUBSCRIBE):
            return [.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SUBSCRIBED),
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHARACTERISTIC_UUID), value: "characteristic")]
            )]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_UNSUBSCRIBE): return []
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED), fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 1)
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_UPLOAD):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_COMPLETED), fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: 1)
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_PROVISIONING):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_PROVISIONING_MATERIAL_PREPARED), fields: [
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_API_ENDPOINT), value: Data("https://api.example".utf8)),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_TOKEN), value: Data(repeating: 1, count: 32)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MTU), value: 180),
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_GRANT_PREPARED), fields: [
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT), value: Data(repeating: 1, count: 32))
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_TRUNCATE):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_TRUNCATED))]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_APPEND):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_APPEND_COMPLETED), fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS), value: 1)
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_FINALIZE):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FINALIZED), fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS), value: 1)
            ])]
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_DISCARD): return []
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_FIRMWARE_BLOB_READ):
            return [.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FIRMWARE_CHUNK_READ), fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 1),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET), value: 0),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: Data()),
            ])]
        default: return []
        }
    }
}

private struct EffectVector {
    let name: String
    let packet: CorePacket
    let port: String?

    static func named(_ name: String) -> Self { all.first { $0.name == name }! }

    static let all: [Self] = {
        let operation = UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT)
        let cancellationHigh: UInt64 = 11
        let cancellationLow: UInt64 = 12
        var requestID: UInt64 = 1
        func make(_ name: String, _ kind: UInt32, _ port: String?, _ fields: [CoreField] = []) -> Self {
            defer { requestID += 1 }
            return Self(
                name: name,
                packet: CorePacket(
                    kind: kind,
                    operation: operation,
                    requestID: requestID,
                    cancellationHigh: cancellationHigh,
                    cancellationLow: cancellationLow,
                    fields: fields
                ),
                port: port
            )
        }
        let u: (UInt32, UInt64) -> CoreField = { .unsigned(id: $0, value: $1) }
        let t: (UInt32, String) -> CoreField = { .text(id: $0, value: $1) }
        let b: (UInt32, Data) -> CoreField = { .bytes(id: $0, value: $1) }
        return [
            make("timer_schedule", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE), nil, [u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID), 1), u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELAY_MS), 0)]),
            make("timer_cancel", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_CANCEL), nil, [u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID), 1)]),
            make("load_checkpoint", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT), "persistence"),
            make("save_checkpoint", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT), "persistence", [b(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT), Data([1]))]),
            make("delete_checkpoint", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT), "persistence"),
            make("save_identity", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), "EVFXXW67KP")]),
            make("save_reset", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), "command")]),
            make("delete_reset", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), "command")]),
            make("secret_read", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_READ), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), "key")]),
            make("secret_write", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_WRITE), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), "key"), b(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), Data([1]))]),
            make("secret_delete", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_DELETE), "persistence", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), "key")]),
            make("ble_start_scan", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN), "bluetooth"),
            make("ble_stop_scan", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN), "bluetooth"),
            make("ble_connect", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_CONNECT), "bluetooth", [t(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), "peripheral")]),
            make("ble_discover", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCOVER_SERVICES), "bluetooth"),
            make("ble_disconnect", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_DISCONNECT), "bluetooth"),
            make("ble_read", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_READ), "bluetooth"),
            make("ble_write", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_WRITE), "bluetooth", [b(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), Data([1]))]),
            make("ble_subscribe", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_SUBSCRIBE), "bluetooth"),
            make("ble_unsubscribe", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_UNSUBSCRIBE), "bluetooth"),
            make("network_download", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD), "network", [u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), 1)]),
            make("network_upload", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_UPLOAD), "network", [u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), 1)]),
            make("progress", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PROGRESS), nil, [u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), 7), u(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), 10)]),
            make("prepare_provisioning", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_PROVISIONING), "material"),
            make("prepare_reset", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT), "material"),
            make("sink_truncate", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_TRUNCATE), "recordingSink"),
            make("sink_append", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_APPEND), "recordingSink"),
            make("sink_finalize", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_FINALIZE), "recordingSink"),
            make("sink_discard", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_DISCARD), "recordingSink"),
            make("firmware_read", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_FIRMWARE_BLOB_READ), "firmwareBlob"),
        ]
    }()
}

private extension CorePacket {
    func replacingFields(_ fields: [CoreField]) -> Self {
        Self(
            kind: kind,
            operation: operation,
            requestID: requestID,
            cancellationHigh: cancellationHigh,
            cancellationLow: cancellationLow,
            fields: fields
        )
    }

    func replacingCorrelation(requestID: UInt64, high: UInt64, low: UInt64) -> Self {
        Self(
            kind: kind,
            operation: operation,
            requestID: requestID,
            cancellationHigh: high,
            cancellationLow: low,
            fields: fields
        )
    }
}
