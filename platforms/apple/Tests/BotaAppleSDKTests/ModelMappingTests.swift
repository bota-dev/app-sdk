import Foundation
import XCTest

@testable import BotaAppleSDK

final class ModelMappingTests: XCTestCase {
    func testUnknownDeviceStatusValuesRemainObservable() throws {
        let mapper = try CoreModelMapper()

        let status = try mapper.parseDeviceStatus(Self.hex("40fffe00000000000000000000ffff"))

        XCTAssertEqual(status.state, .unknown(0xFE))
        XCTAssertEqual(status.lteStatus, .unknown(0xFF))
        XCTAssertEqual(status.wifiStatus, .unknown(0xFF))
    }

    func testConnectionSettingsPreserveImmediateAndAlwaysOnTimeouts() throws {
        let mapper = try CoreModelMapper()

        let parsed = try mapper.parseConnectionSettings(Self.hex("0203010203ff00003c810000"))

        XCTAssertTrue(parsed.supportedVersion)
        XCTAssertEqual(parsed.settings.powerManagement.cellularIdleTimeoutSeconds, -1)
        XCTAssertEqual(parsed.settings.powerManagement.wifiIdleTimeoutSeconds, 0)
        XCTAssertEqual(parsed.settings.heartbeatEnabledConnections, .init(wifi: true, cellular: false))
    }

    func testBotaNoteNormalizationRemovesCellularEverywhere() {
        let settings = DeviceConnectionSettings(
            enabledConnections: .init(wifi: true, cellular: true),
            heartbeatEnabledConnections: .init(wifi: true, cellular: true),
            uploadNetworkPreference: [.wifi, .cellular, .ble],
            powerManagement: .init(wifiIdleTimeoutSeconds: 180, cellularIdleTimeoutSeconds: 180),
            streamingEnabled: false,
            streamingFlushIntervalSeconds: 60
        )

        let normalized = settings.normalized(for: .botaNote)

        XCTAssertFalse(normalized.enabledConnections.cellular)
        XCTAssertFalse(normalized.heartbeatEnabledConnections.cellular)
        XCTAssertEqual(normalized.uploadNetworkPreference, [.wifi, .ble])
    }

    func testMalformedProtocolErrorUsesStableFields() throws {
        let mapper = try CoreModelMapper()

        XCTAssertThrowsError(try mapper.parseDeviceStatus(Data([0, 1]))) { error in
            let sdkError = error as? BotaSDKError
            XCTAssertEqual(sdkError?.code, .truncatedPacket)
            XCTAssertEqual(sdkError?.operation, .decode)
            XCTAssertFalse(sdkError?.retryable ?? true)
        }
    }

    private static func hex(_ value: String) -> Data {
        Data(stride(from: 0, to: value.count, by: 2).map { index in
            let start = value.index(value.startIndex, offsetBy: index)
            let end = value.index(start, offsetBy: 2)
            return UInt8(value[start..<end], radix: 16)!
        })
    }
}
