import Foundation
import XCTest

@testable import BotaAppleSDK

final class DeviceControlRecordingTests: XCTestCase {
    func testStartRecordingSubscribesBeforeWritingTheSharedOpcode() async throws {
        let fixture = await RecordingControlRuntimeFixture(
            notifications: [BotaBluetoothUUIDs.recordingStatus: [Data([1, 1, 0, 0, 0, 0])]]
        )
        let controls = DeviceControlManager()
        await controls.attach(fixture.runtime)

        let result = try await controls.requestStartRecording(
            fixture.device,
            grantBlob: Data([1, 2, 3]).base64EncodedString()
        )

        XCTAssertEqual(result, RecordingControlResult(success: true))
        let actions = await fixture.recorder.actions
        XCTAssertEqual(actions, [
            .write(BotaBluetoothUUIDs.deviceCommand, Data([1, 2, 3])),
            .subscribe(BotaBluetoothUUIDs.recordingStatus),
            .write(BotaBluetoothUUIDs.recordingControl, Data([0x10])),
            .unsubscribe(BotaBluetoothUUIDs.recordingStatus),
        ])
    }

    func testStopRecordingPreservesPacingAroundTheResultSubscription() async throws {
        let fixture = await RecordingControlRuntimeFixture(
            notifications: [BotaBluetoothUUIDs.recordingStatus: [Data([0, 1, 0, 0, 0, 0])]]
        )
        let controls = DeviceControlManager()
        await controls.attach(fixture.runtime)

        let result = try await controls.requestStopRecording(
            fixture.device,
            grantBlob: Data([4, 5, 6]).base64EncodedString()
        )

        XCTAssertEqual(result, RecordingControlResult(success: true))
        let actions = await fixture.recorder.actions
        XCTAssertEqual(actions, [
            .write(BotaBluetoothUUIDs.deviceCommand, Data([4, 5, 6])),
            .delay(50),
            .subscribe(BotaBluetoothUUIDs.recordingStatus),
            .delay(50),
            .write(BotaBluetoothUUIDs.recordingControl, Data([0x11])),
            .unsubscribe(BotaBluetoothUUIDs.recordingStatus),
        ])
    }

    func testReadRecordingStateUsesTheSharedDecoder() async throws {
        let bytes = Data([0x01, 0x01]) + Data([
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        ])
        let fixture = await RecordingControlRuntimeFixture(
            reads: [BotaBluetoothUUIDs.recordingStatus: bytes]
        )
        let controls = DeviceControlManager()
        await controls.attach(fixture.runtime)

        let state = try await controls.readRecordingState(from: fixture.device)

        XCTAssertEqual(state, RecordingState(
            active: true,
            recordingID: "00112233-4455-6677-8899-aabbccddeeff",
            initiatedBy: .remote
        ))
        let actions = await fixture.recorder.actions
        XCTAssertEqual(actions, [.read(BotaBluetoothUUIDs.recordingStatus)])
    }

    func testFailedResultAndEndedSubscriptionAreUnsubscribed() async throws {
        let fixture = await RecordingControlRuntimeFixture(
            notifications: [BotaBluetoothUUIDs.recordingStatus: [Data([0, 0, 0, 0, 0, 4])]]
        )
        let controls = DeviceControlManager()
        await controls.attach(fixture.runtime)

        let result = try await controls.requestStartRecording(
            fixture.device,
            grantBlob: Data([1]).base64EncodedString()
        )

        XCTAssertEqual(result, RecordingControlResult(success: false, error: .invalidGrant))
        let actions = await fixture.recorder.actions
        XCTAssertEqual(
            actions.filter { $0 == .unsubscribe(BotaBluetoothUUIDs.recordingStatus) }.count,
            1
        )
    }

    func testDetachStopsActiveRecordingStateObservationExactlyOnce() async throws {
        let fixture = await RecordingControlRuntimeFixture(
            openSubscriptions: [BotaBluetoothUUIDs.recordingStatus]
        )
        let controls = DeviceControlManager()
        await controls.attach(fixture.runtime)

        let updates = try await controls.recordingStateUpdates(for: fixture.device)
        let collector = Task { for try await _ in updates {} }
        await fixture.recorder.waitForAction(.subscribe(BotaBluetoothUUIDs.recordingStatus))
        await controls.detach()
        _ = try await collector.value

        let actions = await fixture.recorder.actions
        XCTAssertEqual(
            actions.filter { $0 == .unsubscribe(BotaBluetoothUUIDs.recordingStatus) }.count,
            1
        )
    }
}

private actor RecordingControlActionRecorder {
    enum Action: Equatable, Sendable {
        case read(String)
        case write(String, Data)
        case subscribe(String)
        case unsubscribe(String)
        case delay(UInt64)
    }

    private(set) var actions: [Action] = []

    func append(_ action: Action) { actions.append(action) }

    func waitForAction(_ action: Action) async {
        while !actions.contains(action) { await Task.yield() }
    }
}

private struct RecordingControlRuntimeFixture: Sendable {
    let device: ConnectedDevice
    let recorder: RecordingControlActionRecorder
    let runtime: DeviceRuntime

    init(
        reads: [String: Data] = [:],
        notifications: [String: [Data]] = [:],
        openSubscriptions: Set<String> = []
    ) async {
        let device = secureDevice()
        let recorder = RecordingControlActionRecorder()
        let mapper = try! CoreModelMapper()
        let connection = DeviceConnectionRegistry()
        await connection.set(device)
        self.device = device
        self.recorder = recorder
        runtime = DeviceRuntime(
            engine: SecureWorkflowRunner(),
            capabilities: [.bluetooth, .timer],
            connection: connection,
            disconnect: { _ in },
            directRead: { _, _, characteristic in
                await recorder.append(.read(characteristic))
                return reads[characteristic] ?? Data()
            },
            directWrite: { _, _, characteristic, data in
                await recorder.append(.write(characteristic, data))
            },
            directSubscribe: { _, _, characteristic in
                await recorder.append(.subscribe(characteristic))
                let pair = AsyncThrowingStream<Data, Error>.makeStream()
                for value in notifications[characteristic] ?? [] {
                    pair.continuation.yield(value)
                }
                if !openSubscriptions.contains(characteristic) { pair.continuation.finish() }
                return pair.stream
            },
            directUnsubscribe: { _, _, characteristic in
                await recorder.append(.unsubscribe(characteristic))
            },
            delay: { milliseconds in await recorder.append(.delay(milliseconds)) },
            parseRecordingState: { try mapper.parseRecordingState($0) },
            parseRecordingControlResult: { try mapper.parseRecordingControlResult($0) },
            createRecordingControlCommand: { try mapper.createRecordingControlCommand($0) }
        )
    }
}
