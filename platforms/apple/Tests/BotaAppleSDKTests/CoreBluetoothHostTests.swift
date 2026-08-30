import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class CoreBluetoothHostTests: XCTestCase {
    func testScanMergesSystemConnectedPeripheralsAndRespectsDeduplication() async throws {
        let first = CentralAdvertisement(id: "first", name: "Bota Pin", rssi: -40)
        let second = CentralAdvertisement(id: "second", name: "Bota Note", rssi: -50)
        let driver = FakeCentralDriver(connected: [first], scanned: [first, first, second])
        let host = CoreBluetoothHost(driver: driver)

        let deduplicated = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothStartScan, fields: [
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES), value: false)
            ])
        )

        XCTAssertEqual(deduplicated.count, 2)
        XCTAssertEqual(deduplicated.compactMap(\.peripheralID), ["first", "second"])

        let duplicates = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothStartScan, requestID: 2, fields: [
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES), value: true)
            ])
        )
        XCTAssertEqual(duplicates.count, 4)
    }

    func testSamePeripheralSerializesWhileDifferentPeripheralsProgressIndependently() async throws {
        let driver = FakeCentralDriver(operationDelayNanoseconds: 20_000_000)
        let host = CoreBluetoothHost(driver: driver)
        let sameRead = effect(.bluetoothRead, requestID: 1, peripheralID: "same")
        let sameWrite = effect(.bluetoothWrite, requestID: 2, peripheralID: "same")
        let otherRead = effect(.bluetoothRead, requestID: 3, peripheralID: "other")

        async let first = Self.payloads(host: host, effect: sameRead)
        async let second = Self.payloads(host: host, effect: sameWrite)
        async let third = Self.payloads(host: host, effect: otherRead)
        _ = try await (first, second, third)

        let sameMaximum = await driver.maximumConcurrentByPeripheral["same"]
        let globalMaximum = await driver.maximumGlobalConcurrency
        XCTAssertEqual(sameMaximum, 1)
        XCTAssertGreaterThanOrEqual(globalMaximum, 2)
    }

    func testServiceDiscoveryPrecedesCharacteristicDiscovery() async throws {
        let driver = FakeCentralDriver()
        let host = CoreBluetoothHost(driver: driver)

        _ = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothDiscoverServices, peripheralID: "device")
        )

        let log = await driver.log
        XCTAssertLessThan(
            try XCTUnwrap(log.firstIndex(of: "services:device")),
            try XCTUnwrap(log.firstIndex(of: "characteristics:device"))
        )
    }

    func testServiceDiscoveryTimeoutDisconnectsHalfOpenLink() async throws {
        let driver = FakeCentralDriver()
        await driver.setDiscoveryDelay(1_000_000_000)
        let host = CoreBluetoothHost(driver: driver, serviceDiscoveryTimeoutNanoseconds: 5_000_000)
        let stream = await host.execute(effect(.bluetoothDiscoverServices, peripheralID: "device"))

        do {
            for try await _ in stream {}
            XCTFail("discovery should time out")
        } catch is CancellationError {
            XCTFail("timeout should remain distinguishable from cancellation")
        } catch {}

        let disconnectCount = await driver.disconnectCount
        XCTAssertEqual(disconnectCount, 1)
    }

    func testManualSelectionPreemptsBackgroundReconnectOwner() async {
        let arbiter = RadioArbiter()
        let initialPreemption = await arbiter.acquire(peripheralID: "background", priority: .backgroundReconnect)
        XCTAssertNil(initialPreemption)

        let preempted = await arbiter.acquire(peripheralID: "manual", priority: .manualSelection)
        let owner = await arbiter.owner

        XCTAssertEqual(preempted, "background")
        XCTAssertEqual(owner?.peripheralID, "manual")
    }

    func testDisconnectFailsPendingOperationExactlyOnce() async throws {
        let driver = FakeCentralDriver()
        await driver.setReadsSuspended(true)
        let host = CoreBluetoothHost(driver: driver)
        let readEffect = effect(.bluetoothRead, peripheralID: "device")
        async let read = Self.payloads(host: host, effect: readEffect)
        try await waitUntil { await driver.pendingReadCount == 1 }

        _ = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothDisconnect, requestID: 2, peripheralID: "device")
        )

        do {
            _ = try await read
            XCTFail("the pending read should fail on disconnect")
        } catch {
            XCTAssertEqual(error as? CentralDriverError, .disconnected("device"))
        }
        let failedPendingReadCount = await driver.failedPendingReadCount
        let disconnectCount = await driver.disconnectCount
        XCTAssertEqual(failedPendingReadCount, 1)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testCharacteristicOperationUsesTheCurrentRadioOwnerWhenPeripheralFieldIsAbsent() async throws {
        let driver = FakeCentralDriver()
        let host = CoreBluetoothHost(driver: driver)
        _ = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothConnect, peripheralID: "owner")
        )

        _ = try await Self.payloads(
            host: host,
            effect: effect(.bluetoothRead, requestID: 2)
        )

        let log = await driver.log
        XCTAssertTrue(log.contains("read:start:owner"))
    }

    private static func payloads(host: CoreBluetoothHost, effect: CoreEffect) async throws -> [CoreHostEventPayload] {
        let stream = await host.execute(effect)
        var values: [CoreHostEventPayload] = []
        for try await value in stream { values.append(value) }
        return values
    }

    private func waitUntil(
        timeoutNanoseconds: UInt64 = 500_000_000,
        condition: @escaping @Sendable () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
        while !(await condition()) {
            if ContinuousClock.now >= deadline { throw CentralDriverError.bluetoothUnavailable }
            await Task.yield()
        }
    }

    private func effect(
        _ kind: EffectKind,
        requestID: UInt64 = 1,
        peripheralID: String? = nil,
        fields additionalFields: [CoreField] = []
    ) -> CoreEffect {
        var fields = additionalFields
        if let peripheralID {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID))
        }
        if [.bluetoothRead, .bluetoothWrite].contains(kind) {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERVICE_UUID), value: BotaBluetoothUUIDs.controlService))
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHARACTERISTIC_UUID), value: BotaBluetoothUUIDs.deviceStatus))
        }
        if kind == .bluetoothWrite {
            fields.append(.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: Data([1])))
            fields.append(.bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_WITH_RESPONSE), value: true))
        }
        return try! CoreEffect(packet: CorePacket(
            kind: kind.rawValue,
            operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT),
            requestID: requestID,
            cancellationHigh: 1,
            cancellationLow: 2,
            fields: fields
        ))
    }
}

private enum EffectKind: UInt32 {
    case bluetoothStartScan = 0x0310
    case bluetoothConnect = 0x0312
    case bluetoothDiscoverServices = 0x0313
    case bluetoothDisconnect = 0x0314
    case bluetoothRead = 0x0315
    case bluetoothWrite = 0x0316
}

private extension CoreHostEventPayload {
    var peripheralID: String? {
        for field in fields {
            if case let .text(id, value) = field,
               id == UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID) { return value }
        }
        return nil
    }
}

private extension FakeCentralDriver {
    func setDiscoveryDelay(_ value: UInt64) { discoveryDelayNanoseconds = value }
}
