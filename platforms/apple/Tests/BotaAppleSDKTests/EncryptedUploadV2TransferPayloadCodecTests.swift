import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2TransferPayloadCodecTests: XCTestCase {
    func testWindowAcknowledgementsAndConfirmMatchFrozenWireBytes() throws {
        let mapper = try CoreModelMapper()
        let prefix = Self.data(
            "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
        )

        XCTAssertEqual(
            Self.hex(try mapper.createEncryptedUploadV2WindowAcknowledgement(
                transportSessionID: 0x0000_1122_3344_5566,
                windowIndex: 2,
                highestContiguousSequence: 16,
                nextCiphertextOffset: 64,
                prefixSHA256: prefix,
                checkpointRevision: 4,
                missingSequences: []
            )),
            "21020000665544332211000002000000100000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c770400000000000000"
        )

        XCTAssertEqual(
            Self.hex(try mapper.createEncryptedUploadV2WindowAcknowledgement(
                transportSessionID: 0x0000_1122_3344_5566,
                windowIndex: 2,
                highestContiguousSequence: 12,
                nextCiphertextOffset: 48,
                prefixSHA256: prefix,
                checkpointRevision: 3,
                missingSequences: [13, 15]
            )),
            "210200006655443322110000020000000c0000003000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c7703000000020000000d0000000f000000"
        )

        XCTAssertEqual(
            Self.hex(try mapper.createEncryptedUploadV2Confirm(
                transportSessionID: 0x0000_1122_3344_5566,
                uploadSessionID: try XCTUnwrap(
                    UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")
                ),
                recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
                recordingGeneration: 9,
                ownerRevision: 3,
                receiptSHA256: Self.data(
                    "f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc"
                )
            )),
            "230200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff0900000003000000f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc"
        )
    }

    func testDataAndWindowEndDecodeToTypedValues() throws {
        let mapper = try CoreModelMapper()
        let data = try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
            "41020000665544332211000001000000000000000000000020000000424f5441454e4332020080000100000001000100070000000010000000112233"
        ))
        XCTAssertEqual(
            data,
            .data(EncryptedUploadV2DataValue(
                transportSessionID: 0x0000_1122_3344_5566,
                sequence: 1,
                ciphertextOffset: 0,
                bytes: Self.data(
                    "424f5441454e4332020080000100000001000100070000000010000000112233"
                )
            ))
        )

        let windowEnd = try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
            "4202000066554433221100000200000001000000100000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c7704000000"
        ))
        XCTAssertEqual(
            windowEnd,
            .windowEnd(EncryptedUploadV2WindowEndValue(
                transportSessionID: 0x0000_1122_3344_5566,
                windowIndex: 2,
                firstSequence: 1,
                lastSequence: 16,
                nextCiphertextOffset: 64,
                prefixSHA256: Self.data(
                    "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
                ),
                checkpointRevision: 4
            ))
        )
    }

    func testManifestAndEofDecodeToTypedValues() throws {
        let mapper = try CoreModelMapper()
        let manifest = try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
            "43020000665544332211000044020000400000009e1e402d5adca3aafed9279638e79cce67fd568594754ccb298e6f9f4f192e43424f54414d4e46320200440203030201010020000100030001000100030000000700000009000000001000000100000003000000101112131415161718191a1b"
        ))
        XCTAssertEqual(
            manifest,
            .manifestChunk(EncryptedUploadV2ManifestChunkValue(
                transportSessionID: 0x0000_1122_3344_5566,
                totalManifestLength: 580,
                chunkOffset: 0,
                manifestSHA256: Self.data(
                    "9e1e402d5adca3aafed9279638e79cce67fd568594754ccb298e6f9f4f192e43"
                ),
                bytes: Self.data(
                    "424f54414d4e46320200440203030201010020000100030001000100030000000700000009000000001000000100000003000000101112131415161718191a1b"
                )
            ))
        )

        let eof = try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
            "44020000665544332211000011000000010000004a01000000000000287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b9e1e402d5adca3aafed9279638e79cce67fd568594754ccb298e6f9f4f192e43"
        ))
        XCTAssertEqual(
            eof,
            .eof(EncryptedUploadV2EOFValue(
                transportSessionID: 0x0000_1122_3344_5566,
                finalSequence: 17,
                blockCount: 1,
                ciphertextLength: 330,
                ciphertextSHA256: Self.data(
                    "287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b"
                ),
                manifestSHA256: Self.data(
                    "9e1e402d5adca3aafed9279638e79cce67fd568594754ccb298e6f9f4f192e43"
                )
            ))
        )
    }

    func testPayloadDecoderRejectsControlAndEncodersRejectInvalidDigestLengths() throws {
        let mapper = try CoreModelMapper()
        XCTAssertEqual(
            try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
                "4f02000066554433221100000f00210004000000"
            )),
            .error(EncryptedUploadV2TransferErrorValue(
                transportSessionID: 0x0000_1122_3344_5566,
                result: 15,
                failedMessageType: 0x21,
                checkpointRevision: 4
            ))
        )
        XCTAssertThrowsError(try mapper.decodeEncryptedUploadV2TransferPayload(Self.data(
            "400200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff090000004a01000000000000287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b1000f40008000000000000000000000000000000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )))
        XCTAssertThrowsError(try mapper.createEncryptedUploadV2WindowAcknowledgement(
            transportSessionID: 1,
            windowIndex: 1,
            highestContiguousSequence: 1,
            nextCiphertextOffset: 1,
            prefixSHA256: Data(repeating: 0, count: 31),
            checkpointRevision: 1,
            missingSequences: []
        ))
        XCTAssertThrowsError(try mapper.createEncryptedUploadV2Confirm(
            transportSessionID: 1,
            uploadSessionID: UUID(),
            recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
            recordingGeneration: 1,
            ownerRevision: 1,
            receiptSHA256: Data(repeating: 0, count: 31)
        ))
    }

    private static func data(_ hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { index in
            let start = hex.index(hex.startIndex, offsetBy: index)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)!
        })
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
