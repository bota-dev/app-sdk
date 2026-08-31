import Foundation
import XCTest

@testable import BotaAppleSDK

final class WiFiManagerTests: XCTestCase {
    func testConfigureWritesGrantBeforeSubscribingAndCredentialsAfterSubscription() async throws {
        let fixture = await WiFiRuntimeFixture(
            notifications: [BotaBluetoothUUIDs.wifiStatus: [Data([0x00])]]
        )
        let manager = WiFiManager()
        await manager.attach(fixture.runtime)

        let result = try await manager.configure(
            fixture.device,
            ssid: "Bota",
            password: "secret",
            grantBlob: "grant.test"
        )

        XCTAssertEqual(result, .success)
        let actions = await fixture.recorder.actions
        let expected: [WiFiActionRecorder.Action] = [
            .write(BotaBluetoothUUIDs.wifiGrant, Data("grant.test".utf8)),
            .subscribe(BotaBluetoothUUIDs.wifiStatus),
            .write(BotaBluetoothUUIDs.wifiCredential, Data([0x04]) + Data("Bota".utf8) + Data([0x06]) + Data("secret".utf8)),
            .unsubscribe(BotaBluetoothUUIDs.wifiStatus),
        ]
        XCTAssertEqual(actions, expected)
    }

    func testDisconnectSubscribesBeforeWritingForgetPacket() async throws {
        let fixture = await WiFiRuntimeFixture(
            notifications: [BotaBluetoothUUIDs.wifiStatus: [Data([0x00])]]
        )
        let manager = WiFiManager()
        await manager.attach(fixture.runtime)

        let result = try await manager.disconnect(fixture.device)

        XCTAssertEqual(result, .success)
        let actions = await fixture.recorder.actions
        let expected: [WiFiActionRecorder.Action] = [
            .subscribe(BotaBluetoothUUIDs.wifiStatus),
            .write(BotaBluetoothUUIDs.wifiCredential, Data([0x00])),
            .unsubscribe(BotaBluetoothUUIDs.wifiStatus),
        ]
        XCTAssertEqual(actions, expected)
    }

    func testReadStatusUsesWiFiStatusCharacteristicAndSharedDecoder() async throws {
        let fixture = await WiFiRuntimeFixture(
            reads: [BotaBluetoothUUIDs.wifiStatus: Data([0x02, 0x57, 0x04]) + Data("Bota".utf8)]
        )
        let manager = WiFiManager()
        await manager.attach(fixture.runtime)

        let status = try await manager.readStatus(fixture.device)

        XCTAssertEqual(status, WiFiStatusInfo(status: .connected, signalStrength: 87, ssid: "Bota"))
        let actions = await fixture.recorder.actions
        XCTAssertEqual(actions, [.read(BotaBluetoothUUIDs.wifiStatus)])
    }

    func testScanSubscribesBeforeCommandAndIgnoresPendingUpdates() async throws {
        let fixture = await WiFiRuntimeFixture(
            notifications: [
                BotaBluetoothUUIDs.wifiScan: [
                    Data([0x01]),
                    Data([0x02, 0x02, 0x04]) + Data("Bota".utf8) + Data([0x64, 0x03, 0x05]) + Data("Guest".utf8) + Data([0x32, 0x02]),
                ],
            ]
        )
        let manager = WiFiManager()
        await manager.attach(fixture.runtime)

        let result = try await manager.scanNetworks(fixture.device)

        XCTAssertEqual(result.currentSSID, "Bota")
        XCTAssertEqual(result.networks.map(\.ssid), ["Bota", "Guest"])
        let actions = await fixture.recorder.actions
        let expected: [WiFiActionRecorder.Action] = [
            .subscribe(BotaBluetoothUUIDs.wifiScan),
            .write(BotaBluetoothUUIDs.wifiScan, Data([0x01])),
            .unsubscribe(BotaBluetoothUUIDs.wifiScan),
        ]
        XCTAssertEqual(actions, expected)
    }

    func testDetachStopsActiveStatusObservationExactlyOnce() async throws {
        let fixture = await WiFiRuntimeFixture(openSubscriptions: [BotaBluetoothUUIDs.wifiStatus])
        let manager = WiFiManager()
        await manager.attach(fixture.runtime)

        _ = try await manager.statusUpdates(fixture.device)
        await fixture.recorder.waitForAction(.subscribe(BotaBluetoothUUIDs.wifiStatus))
        await manager.detach()

        let actions = await fixture.recorder.actions
        XCTAssertEqual(
            actions.filter { $0 == .unsubscribe(BotaBluetoothUUIDs.wifiStatus) }.count,
            1
        )
    }
}

private actor WiFiActionRecorder {
    enum Action: Equatable, Sendable {
        case read(String)
        case write(String, Data)
        case subscribe(String)
        case unsubscribe(String)
    }

    private(set) var actions: [Action] = []

    func append(_ action: Action) { actions.append(action) }

    func waitForAction(_ action: Action) async {
        while !actions.contains(action) { await Task.yield() }
    }
}

private struct WiFiRuntimeFixture: Sendable {
    let device: ConnectedDevice
    let recorder: WiFiActionRecorder
    let runtime: DeviceRuntime

    init(
        reads: [String: Data] = [:],
        notifications: [String: [Data]] = [:],
        openSubscriptions: Set<String> = []
    ) async {
        let device = secureDevice()
        let recorder = WiFiActionRecorder()
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
                let values = notifications[characteristic] ?? []
                let pair = AsyncThrowingStream<Data, Error>.makeStream()
                for value in values { pair.continuation.yield(value) }
                if !openSubscriptions.contains(characteristic) { pair.continuation.finish() }
                return pair.stream
            },
            directUnsubscribe: { _, _, characteristic in
                await recorder.append(.unsubscribe(characteristic))
            },
            parseWiFiConfigResult: { try mapper.parseWiFiConfigResult($0) },
            parseWiFiStatusInfo: { try mapper.parseWiFiStatusInfo($0) },
            parseWiFiScanResult: { try mapper.parseWiFiScanResult($0) },
            createWiFiGrantPacket: { try mapper.createWiFiGrantPacket($0) },
            createWiFiCredentialPacket: { try mapper.createWiFiCredentialPacket(ssid: $0, password: $1) },
            createWiFiScanCommand: { try mapper.createWiFiScanCommand() }
        )
    }
}
