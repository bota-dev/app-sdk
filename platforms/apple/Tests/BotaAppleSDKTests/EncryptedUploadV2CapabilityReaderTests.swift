import CryptoKit
import Foundation
import XCTest
@testable import BotaAppleSDK

final class EncryptedUploadV2CapabilityReaderTests: XCTestCase {
    func testDedicatedStorageCharacteristicsUseFrozenV2Allocation() {
        XCTAssertEqual(
            BotaBluetoothUUIDs.storageTransferCapabilitiesV2,
            "B07A0004-0006-1000-8000-00805F9B34FB"
        )
        XCTAssertEqual(
            BotaBluetoothUUIDs.transferSignedBlobV2,
            "B07A0004-0007-1000-8000-00805F9B34FB"
        )
        XCTAssertEqual(
            BotaBluetoothUUIDs.transferControlV2,
            "B07A0004-0008-1000-8000-00805F9B34FB"
        )
        XCTAssertEqual(
            BotaBluetoothUUIDs.recordingTransferV2,
            "B07A0004-0009-1000-8000-00805F9B34FB"
        )
        XCTAssertEqual(
            BotaBluetoothUUIDs.transferStatusV2,
            "B07A0004-000A-1000-8000-00805F9B34FB"
        )
        XCTAssertEqual(
            BotaBluetoothUUIDs.recordingListV2,
            "B07A0004-000B-1000-8000-00805F9B34FB"
        )
    }

    func testEverySelectionReadFetchesAndHashesFreshCapabilityBytes() async throws {
        let first = Self.data("010218007f00000000040004f40010000800000010000000")
        let second = Self.data("010218007f00000000040004c80008000400000002000000")
        let probe = CapabilityReadProbe(values: [first, second])
        let mapper = try CoreModelMapper()
        let reader = EncryptedUploadV2CapabilityReader(
            read: { peripheralID, serviceUUID, characteristicUUID in
                try await probe.read(
                    peripheralID: peripheralID,
                    serviceUUID: serviceUUID,
                    characteristicUUID: characteristicUUID
                )
            },
            decode: { try mapper.decodeEncryptedUploadV2Capabilities($0) }
        )

        let firstSnapshot = try await reader.readFresh(peripheralID: "peripheral-1")
        let secondSnapshot = try await reader.readFresh(peripheralID: "peripheral-1")

        XCTAssertEqual(firstSnapshot.rawValue, first)
        XCTAssertEqual(firstSnapshot.sha256, Data(SHA256.hash(data: first)))
        XCTAssertEqual(firstSnapshot.capabilities.flags, 0x7f)
        XCTAssertEqual(firstSnapshot.capabilities.maximumSignedBlobBytes, 1024)
        XCTAssertEqual(firstSnapshot.capabilities.maximumManifestBytes, 1024)
        XCTAssertEqual(firstSnapshot.capabilities.maximumDataPayloadBytes, 244)
        XCTAssertEqual(firstSnapshot.capabilities.maximumWindowPackets, 16)
        XCTAssertEqual(firstSnapshot.capabilities.durableCheckpointIntervalBlocks, 8)
        XCTAssertEqual(firstSnapshot.capabilities.maximumMissingSequences, 16)
        XCTAssertEqual(secondSnapshot.rawValue, second)
        XCTAssertEqual(secondSnapshot.sha256, Data(SHA256.hash(data: second)))
        XCTAssertEqual(secondSnapshot.capabilities.maximumDataPayloadBytes, 200)
        XCTAssertEqual(secondSnapshot.capabilities.maximumWindowPackets, 8)
        XCTAssertEqual(secondSnapshot.capabilities.durableCheckpointIntervalBlocks, 4)
        XCTAssertEqual(secondSnapshot.capabilities.maximumMissingSequences, 2)
        let calls = await probe.calls
        XCTAssertEqual(calls, [
            .init(
                peripheralID: "peripheral-1",
                serviceUUID: BotaBluetoothUUIDs.storageService,
                characteristicUUID: BotaBluetoothUUIDs.storageTransferCapabilitiesV2
            ),
            .init(
                peripheralID: "peripheral-1",
                serviceUUID: BotaBluetoothUUIDs.storageService,
                characteristicUUID: BotaBluetoothUUIDs.storageTransferCapabilitiesV2
            ),
        ])
    }

    func testMalformedCapabilityIsRejectedBySharedCoreDecoder() async throws {
        let mapper = try CoreModelMapper()
        let reader = EncryptedUploadV2CapabilityReader(
            read: { _, _, _ in Data(repeating: 0, count: 24) },
            decode: { try mapper.decodeEncryptedUploadV2Capabilities($0) }
        )

        do {
            _ = try await reader.readFresh(peripheralID: "peripheral-1")
            XCTFail("Expected malformed capability to fail")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .unknownPacket)
        }
    }

    private static func data(_ hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)!
        })
    }
}

private struct CapabilityReadCall: Equatable {
    let peripheralID: String
    let serviceUUID: String
    let characteristicUUID: String
}

private actor CapabilityReadProbe {
    private var values: [Data]
    private(set) var calls: [CapabilityReadCall] = []

    init(values: [Data]) {
        self.values = values
    }

    func read(peripheralID: String, serviceUUID: String, characteristicUUID: String) throws -> Data {
        calls.append(.init(
            peripheralID: peripheralID,
            serviceUUID: serviceUUID,
            characteristicUUID: characteristicUUID
        ))
        guard !values.isEmpty else { throw NativeHostError.missingResource("capability value") }
        return values.removeFirst()
    }
}
