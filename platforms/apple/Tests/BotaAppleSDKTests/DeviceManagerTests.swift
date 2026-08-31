@preconcurrency import CoreBluetooth
import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class DeviceManagerTests: XCTestCase {
    func testDeniedBluetoothAuthorizationHasAStablePublicError() throws {
        XCTAssertThrowsError(try BotaConfiguration.validateBluetoothAuthorization(.denied)) { error in
            guard let error = error as? BotaSDKError else {
                return XCTFail("expected BotaSDKError")
            }
            XCTAssertEqual(error.code, .featureUnavailable)
            XCTAssertEqual(error.operation, .discover)
        }
    }

    func testClientConfiguresOnlyOnceAndDestroyReleasesObserversAndConnection() async throws {
        let runner = FakeWorkflowRunner(responses: connectionResponse)
        let factory = RuntimeFactoryRecorder(runtime: runtime(runner: runner))
        let client = BotaDeviceClient()
        let configuration = BotaConfiguration { await factory.make() }

        try await client.configure(configuration)
        try await client.configure(configuration)
        let updates = await client.devices.connectionUpdates()
        var iterator = updates.makeAsyncIterator()
        let initialUpdate = await iterator.next()
        XCTAssertNil(initialUpdate ?? nil)
        _ = try await client.devices.connect(
            serialNumber: "SERIAL-1",
            device: DiscoveredDevice(id: "first", rssi: -30)
        )
        let connectedUpdate = await iterator.next()
        XCTAssertEqual(connectedUpdate.flatMap { $0 }?.id, "first")

        await client.destroy()

        let terminalUpdate = await iterator.next()
        let makeCount = await factory.makeCount
        let disconnects = await factory.disconnects
        XCTAssertTrue(terminalUpdate == nil)
        XCTAssertEqual(makeCount, 1)
        XCTAssertEqual(disconnects, ["first"])
    }

    func testConfigurationIsRequiredAndCapabilitiesReportTheHostContract() async throws {
        let manager = DeviceManager()
        do {
            _ = try await manager.capabilities()
            XCTFail("configuration must be required")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .featureUnavailable)
        }

        let runner = FakeWorkflowRunner()
        await manager.attach(runtime(runner: runner))
        let capabilities = try await manager.capabilities()

        XCTAssertTrue(capabilities.contains(.bluetooth))
        XCTAssertTrue(capabilities.contains(.persistence))
        XCTAssertTrue(capabilities.contains(.networkTransfer))
    }

    func testScanMapsCoreDiscoveryAndCancellationStopsTheWorkflow() async throws {
        let runner = FakeWorkflowRunner(responses: { command in
            guard command.kind == UInt32(BOTA_DEVICE_SDK_V1_COMMAND_DISCOVER_DEVICES) else { return [] }
            return [
                notification(
                    UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_DISCOVERED),
                    fields: [
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: "device-1"),
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME), value: "Bota Note"),
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS), value: "aabbccddeeff"),
                        .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: -41),
                    ]
                ),
            ]
        }, keepOpen: true)
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner))
        let stream = try await manager.startScan(timeoutMilliseconds: 10_000)
        var iterator = stream.makeAsyncIterator()

        let device = try await iterator.next()
        XCTAssertEqual(device?.id, "device-1")
        XCTAssertEqual(device?.macAddress, "aabbccddeeff")

        try await manager.cancelCurrentOperation()
        let cancelled = await runner.cancelledIDs
        XCTAssertEqual(cancelled.count, 1)
    }

    func testManualConnectionCarriesSelectedIdentityAndReplacesThePreviousDevice() async throws {
        let runner = FakeWorkflowRunner(responses: connectionResponse)
        let disconnects = DisconnectRecorder()
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner) { id in await disconnects.record(id) })
        let first = DiscoveredDevice(id: "first", name: "Bota Pin", rssi: -30)
        let second = DiscoveredDevice(id: "second", name: "Bota Note", rssi: -20)

        _ = try await manager.connect(serialNumber: "SERIAL-1", device: first)
        let connected = try await manager.connect(serialNumber: "SERIAL-2", device: second)

        let commands = await runner.commands
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0].packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)), "SERIAL-1")
        XCTAssertEqual(commands[0].packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID)), "first")
        XCTAssertEqual(connected.id, "second")
        let disconnected = await disconnects.values
        XCTAssertEqual(disconnected, ["first"])
    }

    func testSelectedDeviceConnectionLearnsIdentityFromTheCore() async throws {
        let runner = FakeWorkflowRunner(responses: connectionResponse)
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner))
        let selected = DiscoveredDevice(id: "selected", name: "Bota Pin", rssi: -20)

        let connected = try await manager.connect(device: selected)

        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertNil(command.packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)))
        XCTAssertEqual(
            command.packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID)),
            "selected"
        )
        XCTAssertEqual(connected.serialNumber, "SERIAL-1")
    }

    func testReconnectForwardsExactIdentityHints() async throws {
        let runner = FakeWorkflowRunner(responses: connectionResponse)
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner))
        let hint = DeviceReconnectHint(
            storedPeripheralID: "stored-id",
            advertisedAddress: "aabbccddeeff",
            storedName: "Bota Pin",
            scanTimeoutMilliseconds: 5_000,
            connectionTimeoutMilliseconds: 8_000
        )

        _ = try await manager.reconnect(serialNumber: "SERIAL-1", hint: hint)

        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RECONNECT))
        XCTAssertEqual(
            command.packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORED_PERIPHERAL_ID)),
            "stored-id"
        )
        XCTAssertEqual(
            command.packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS)),
            "aabbccddeeff"
        )
    }

    func testStatusReadAndUpdatesUseTheConfiguredStatusHost() async throws {
        let expected = Self.status(batteryLevel: 73)
        let runner = FakeWorkflowRunner(responses: connectionResponse)
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner, status: expected))
        _ = try await manager.connect(
            serialNumber: "SERIAL-1",
            device: DiscoveredDevice(id: "first", rssi: -30)
        )

        let current = try await manager.readStatus()
        XCTAssertEqual(current, expected)
        let updates = try await manager.statusUpdates()
        var iterator = updates.makeAsyncIterator()
        let statusUpdate = try await iterator.next()
        let terminalStatus = try await iterator.next()
        XCTAssertEqual(statusUpdate, expected)
        XCTAssertNil(terminalStatus)
    }

    func testFailedNotificationBecomesStablePublicError() async throws {
        let runner = FakeWorkflowRunner(responses: { _ in [
            notification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_FAILED),
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE), value: 11),
                    .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RETRYABLE), value: false),
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL), value: "serial mismatch"),
                ]
            ),
        ] })
        let manager = DeviceManager()
        await manager.attach(runtime(runner: runner))

        do {
            _ = try await manager.connect(
                serialNumber: "SERIAL-1",
                device: DiscoveredDevice(id: "wrong", rssi: -40)
            )
            XCTFail("the failed terminal notification should throw")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch)
            XCTAssertEqual(error.operation, .connect)
            XCTAssertEqual(error.detail, "serial mismatch")
        }
    }

    private func runtime(
        runner: FakeWorkflowRunner,
        disconnect: @escaping @Sendable (String) async throws -> Void = { _ in },
        status: DeviceStatus? = nil
    ) -> DeviceRuntime {
        DeviceRuntime(
            engine: runner,
            capabilities: [.bluetooth, .timer, .persistence, .networkTransfer],
            disconnect: disconnect,
            readStatus: { _ in
                guard let status else { throw CentralDriverError.bluetoothUnavailable }
                return status
            },
            statusUpdates: { _ in
                AsyncThrowingStream { continuation in
                    if let status { continuation.yield(status) }
                    continuation.finish()
                }
            },
            stopStatusUpdates: { _ in }
        )
    }

    private static func status(batteryLevel: Int) -> DeviceStatus {
        DeviceStatus(
            batteryLevel: batteryLevel,
            storageTotalMb: 100,
            storageUsedMb: 20,
            state: .known(.idle),
            pendingRecordings: 0,
            lastTimeSyncAt: nil,
            flags: .init(
                charging: false,
                lowBattery: false,
                storageFull: false,
                wifiConnected: false,
                lteConnected: false,
                syncActive: false
            ),
            timestamp: 0,
            lteStatus: .known(.off)
        )
    }
}

private actor FakeWorkflowRunner: CoreWorkflowRunning {
    typealias Responses = @Sendable (CoreCommand) -> [CoreNotification]

    private let responses: Responses
    private let keepOpen: Bool
    private(set) var commands: [CoreCommand] = []
    private(set) var cancelledIDs: [UUID] = []
    private var continuations: [UUID: AsyncThrowingStream<CoreNotification, Error>.Continuation] = [:]

    init(responses: @escaping Responses = { _ in [] }, keepOpen: Bool = false) {
        self.responses = responses
        self.keepOpen = keepOpen
    }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        let notifications = responses(command)
        return AsyncThrowingStream { continuation in
            notifications.forEach { continuation.yield($0) }
            if keepOpen {
                continuations[command.cancellationID] = continuation
            } else {
                continuation.finish()
            }
        }
    }

    func cancel(_ id: UUID) async throws {
        cancelledIDs.append(id)
        continuations.removeValue(forKey: id)?.finish()
    }
}

private actor DisconnectRecorder {
    private(set) var values: [String] = []
    func record(_ value: String) { values.append(value) }
}

private actor RuntimeFactoryRecorder {
    private let storedRuntime: DeviceRuntime
    private(set) var makeCount = 0
    private(set) var disconnects: [String] = []

    init(runtime: DeviceRuntime) {
        storedRuntime = DeviceRuntime(
            engine: runtime.engine,
            capabilities: runtime.capabilities,
            disconnect: { _ in },
            readStatus: runtime.readStatus,
            statusUpdates: runtime.statusUpdates,
            stopStatusUpdates: runtime.stopStatusUpdates
        )
    }

    func make() -> DeviceRuntime {
        makeCount += 1
        return DeviceRuntime(
            engine: storedRuntime.engine,
            capabilities: storedRuntime.capabilities,
            disconnect: { id in await self.recordDisconnect(id) },
            readStatus: storedRuntime.readStatus,
            statusUpdates: storedRuntime.statusUpdates,
            stopStatusUpdates: storedRuntime.stopStatusUpdates
        )
    }

    private func recordDisconnect(_ id: String) { disconnects.append(id) }
}

private func connectionResponse(_ command: CoreCommand) -> [CoreNotification] {
    let fields = command.packet.fields
    return [
        notification(
            UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_CONNECTION_ESTABLISHED),
            fields: [
                .text(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER),
                    value: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)) ?? "SERIAL-1"
                ),
                .text(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID),
                    value: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID))
                        ?? fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORED_PERIPHERAL_ID))
                        ?? "reconnected"
                ),
                .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: -30),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CONNECTION_MODE), value: 1),
            ]
        ),
        notification(UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED)),
    ]
}

private func notification(_ kind: UInt32, fields: [CoreField] = []) -> CoreNotification {
    try! CoreNotification(packet: CorePacket(
        kind: kind,
        operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT),
        requestID: 1,
        cancellationHigh: 1,
        cancellationLow: 2,
        fields: fields
    ))
}

private extension Array where Element == CoreField {
    func text(_ id: UInt32) -> String? {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
