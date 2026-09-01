import Foundation
import XCTest

@testable import BotaAppleSDK

final class ProtocolCodecTests: XCTestCase {
    func testEveryApplicableEncodeFixtureMatchesFrozenBytes() throws {
        var matched = 0
        for fixtureCase in try Self.fixtureCases() {
            let operation = try XCTUnwrap(fixtureCase["operation"] as? String)
            guard Self.encodeOperations.contains(operation) else { continue }
            matched += 1
            let expectsError = fixtureCase["expectedError"] != nil
            do {
                guard let actual = try encode(fixtureCase, operation: operation) else {
                    XCTFail("missing encoder for \(operation)")
                    continue
                }
                XCTAssertFalse(expectsError, fixtureCase["name"] as? String ?? operation)
                XCTAssertEqual(Self.hex(actual), fixtureCase["expectedHex"] as? String, fixtureCase["name"] as? String ?? operation)
            } catch {
                XCTAssertTrue(expectsError, "\(fixtureCase["name"] ?? operation): \(error)")
            }
        }
        XCTAssertEqual(matched, 24)
    }

    func testEveryDecodeFixtureUsesSharedCodec() throws {
        var matched = 0
        for fixtureCase in try Self.fixtureCases() {
            let operation = try XCTUnwrap(fixtureCase["operation"] as? String)
            guard Self.decodeOperations.contains(operation) else { continue }
            matched += 1
            let expectsError = fixtureCase["expectedError"] != nil

            do {
                try decode(fixtureCase, operation: operation)
                XCTAssertFalse(expectsError, fixtureCase["name"] as? String ?? operation)
            } catch {
                XCTAssertTrue(expectsError, "\(fixtureCase["name"] ?? operation): \(error)")
            }
        }
        XCTAssertEqual(matched, 39)
    }

    func testEncryptedRecordingAndTransferMetadataRemainOpaque() throws {
        let mapper = try CoreModelMapper()
        let recordings = try mapper.parseRecordingList(Self.data("a1b2c3d401000000000000000000000000f153650c000400"))
        let transfer = try mapper.parseTransferPacket(Self.data("05000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1faabbccdd"))

        XCTAssertEqual(recordings.first?.isEncrypted, true)
        XCTAssertEqual(recordings.first?.codec, .known(.opus16k))
        XCTAssertEqual(transfer.type, .e2eStart)
        XCTAssertEqual(transfer.e2eEphemeralPublicKey, Data(0..<32))
        XCTAssertEqual(transfer.e2eSalt, Data([0xAA, 0xBB, 0xCC, 0xDD]))
    }

    func testFirmwareWiFiAndFragmentedLogsUseSharedDecoder() throws {
        let mapper = try CoreModelMapper()

        XCTAssertEqual(
            try mapper.parseFirmwareStatus(Data([8, 2])),
            FirmwareStatus(command: 8, result: 2, sequenceNumber: nil)
        )
        XCTAssertEqual(try mapper.parseWiFiConfigResult(Data([2])), .grantExpired)
        XCTAssertEqual(try mapper.decodeDeviceLogs(Self.data("000000626f6f74207061")), [])
        XCTAssertEqual(
            try mapper.decodeDeviceLogs(Self.data("01000073730a")),
            [DeviceLogLine(message: "boot pass", isBacklog: false)]
        )
    }

    private func encode(_ fixtureCase: [String: Any], operation: String) throws -> Data? {
        let mapper = try CoreModelMapper()
        let input = fixtureCase["input"] as? [String: Any] ?? [:]
        switch operation {
        case "serializeConnectionSettings":
            return try mapper.serializeConnectionSettings(Self.settings(input), model: .botaPin4G)
        case "firmwareUploadStart":
            return try mapper.firmwareUploadStart(size: UInt32(input["size"] as! Int))
        case "firmwareDataPacket":
            return try mapper.firmwareDataPacket(
                sequenceNumber: UInt16(input["sequenceNumber"] as! Int),
                payload: Self.data(input["payloadHex"] as! String)
            )
        case "firmwareWindowAck":
            return try mapper.firmwareWindowAck(sequenceNumber: UInt16(input["sequenceNumber"] as! Int))
        case "firmwareUploadVerify":
            return try mapper.firmwareUploadVerify(crc32: UInt32(input["crc32"] as! Int))
        case "firmwareStatus":
            return try mapper.encodeFirmwareStatus(
                FirmwareStatus(
                    command: UInt8(input["command"] as! Int),
                    result: UInt8(input["result"] as! Int),
                    sequenceNumber: nil
                )
            )
        case "constantByte":
            return Data([try BotaProtocolConstants.byte(named: fixtureCase["constant"] as! String)])
        case "createWiFiGrantPacket":
            return try mapper.createWiFiGrantPacket(input["grantBlob"] as! String)
        case "createWiFiScanCommand":
            return try mapper.createWiFiScanCommand()
        case "createWiFiCredentialPacket":
            return try mapper.createWiFiCredentialPacket(
                ssid: input["ssid"] as! String,
                password: input["password"] as! String
            )
        case "identityBytes":
            return try mapper.encodeBoundedPayload(Self.data(fixtureCase["inputHex"] as! String))
        case "createAckPacket":
            return try mapper.createAckPacket(
                type: AckType(fixtureName: input["ackType"] as! String),
                sequenceNumber: UInt16(input["sequenceNumber"] as! Int)
            )
        case "createTransferCommand":
            let command = input["command"] as! String
            let uuid = input["recordingUuid"] as? String
            return try mapper.createTransferCommand(TransferCommand(fixtureName: command, recordingUUID: uuid))
        default:
            return nil
        }
    }

    private func decode(_ fixtureCase: [String: Any], operation: String) throws {
        let mapper = try CoreModelMapper()
        switch operation {
        case "parseDeviceStatus":
            _ = try mapper.parseDeviceStatus(Self.data(fixtureCase["inputHex"] as! String))
        case "parseRecordingList":
            _ = try mapper.parseRecordingList(Self.data(fixtureCase["inputHex"] as! String))
        case "parseRecordingState":
            _ = try mapper.parseRecordingState(Self.data(fixtureCase["inputHex"] as! String))
        case "parseRecordingControlResult":
            _ = try mapper.parseRecordingControlResult(Self.data(fixtureCase["inputHex"] as! String))
        case "parseTransferPacket":
            _ = try mapper.parseTransferPacket(Self.data(fixtureCase["inputHex"] as! String))
        case "parseTriggerDeviceUploadResponse":
            _ = try mapper.parseTriggerDeviceUploadResponse(Self.data(fixtureCase["inputHex"] as! String))
        case "parseConnectionSettings":
            _ = try mapper.parseConnectionSettings(Self.data(fixtureCase["inputHex"] as! String))
        case "parseWiFiConfigResult":
            _ = try mapper.parseWiFiConfigResult(Self.data(fixtureCase["inputHex"] as! String))
        case "parseWiFiStatusInfo":
            _ = try mapper.parseWiFiStatusInfo(Self.data(fixtureCase["inputHex"] as! String))
        case "parseWiFiScanResult":
            _ = try mapper.parseWiFiScanResult(Self.data(fixtureCase["inputHex"] as! String))
        case "decodeDeviceLogs":
            for value in fixtureCase["inputsHex"] as! [String] {
                _ = try mapper.decodeDeviceLogs(Self.data(value))
            }
        default:
            break
        }
    }

    private static let decodeOperations: Set<String> = [
        "parseDeviceStatus",
        "parseRecordingList",
        "parseRecordingState",
        "parseRecordingControlResult",
        "parseTransferPacket",
        "parseTriggerDeviceUploadResponse",
        "parseConnectionSettings",
        "parseWiFiConfigResult",
        "parseWiFiStatusInfo",
        "parseWiFiScanResult",
        "decodeDeviceLogs",
    ]

    private static let encodeOperations: Set<String> = [
        "serializeConnectionSettings",
        "firmwareUploadStart",
        "firmwareDataPacket",
        "firmwareWindowAck",
        "firmwareUploadVerify",
        "firmwareStatus",
        "constantByte",
        "createWiFiGrantPacket",
        "createWiFiScanCommand",
        "createWiFiCredentialPacket",
        "identityBytes",
        "createAckPacket",
        "createTransferCommand",
    ]

    private static func fixtureCases() throws -> [[String: Any]] {
        let names = [
            "connection-settings",
            "device-logs",
            "device-status",
            "ota",
            "provisioning",
            "recording-list",
            "recording-control",
            "transfer-control",
        ]
        return try names.flatMap { name in
            let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "ProtocolFixtures"))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            return try XCTUnwrap(object["cases"] as? [[String: Any]])
        }
    }

    private static func settings(_ input: [String: Any]) -> DeviceConnectionSettings {
        let enabled = input["enabled_connections"] as! [String: Bool]
        let heartbeat = input["heartbeat_enabled_connections"] as? [String: Bool]
        let power = input["power_management"] as? [String: Int]
        return DeviceConnectionSettings(
            enabledConnections: .init(wifi: enabled["wifi"]!, cellular: enabled["cellular"]!),
            heartbeatEnabledConnections: .init(
                wifi: heartbeat?["wifi"] ?? true,
                cellular: heartbeat?["cellular"] ?? true
            ),
            uploadNetworkPreference: (input["upload_network_preference"] as! [String]).map(ConnectionType.init(fixtureName:)),
            powerManagement: .init(
                wifiIdleTimeoutSeconds: power?["wifi_idle_timeout_seconds"] ?? 180,
                cellularIdleTimeoutSeconds: power?["cellular_idle_timeout_seconds"] ?? 180
            ),
            streamingEnabled: input["streaming_enabled"] as? Bool ?? true,
            streamingFlushIntervalSeconds: input["streaming_flush_interval_seconds"] as? Int ?? 60
        )
    }

    private static func data(_ value: String) -> Data {
        Data(stride(from: 0, to: value.count, by: 2).map { index in
            let start = value.index(value.startIndex, offsetBy: index)
            let end = value.index(start, offsetBy: 2)
            return UInt8(value[start..<end], radix: 16)!
        })
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

private extension AckType {
    init(fixtureName: String) {
        switch fixtureName {
        case "ack": self = .ack
        case "nack": self = .nack
        case "abort": self = .abort
        default: fatalError("unknown fixture ACK type \(fixtureName)")
        }
    }
}

private extension TransferCommand {
    init(fixtureName: String, recordingUUID: String?) {
        switch fixtureName {
        case "list": self = .list
        case "start": self = .start(recordingUUID: recordingUUID!)
        case "triggerDeviceUpload": self = .triggerDeviceUpload
        case "confirm": self = .confirm(recordingUUID: recordingUUID!)
        default: fatalError("unknown fixture transfer command \(fixtureName)")
        }
    }
}

private extension ConnectionType {
    init(fixtureName: String) {
        switch fixtureName {
        case "wifi": self = .wifi
        case "ble": self = .ble
        case "cellular": self = .cellular
        default: fatalError("unknown fixture connection type \(fixtureName)")
        }
    }
}
