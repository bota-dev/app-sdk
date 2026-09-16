import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2TransferControlCodecTests: XCTestCase {
    func testStartAndResumeRequestsMatchFrozenWireBytes() throws {
        let mapper = try CoreModelMapper()
        let uploadSessionID = try XCTUnwrap(
            UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")
        )

        let start = try mapper.createEncryptedUploadV2Start(
            transportSessionID: 0x0000_1122_3344_5566,
            uploadSessionID: uploadSessionID,
            recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
            recordingGeneration: 9,
            authorizationSHA256: Self.data(
                "d1d0f59c9251cb91f193aeca65c0340dce4bfc536faaba3f24dc89fa24d9eb44"
            ),
            checkpointRevision: 0,
            nextCiphertextOffset: 0,
            prefixSHA256: Self.data(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            ),
            windowPackets: 16,
            dataPayloadBytes: 244
        )
        XCTAssertEqual(
            Self.hex(start),
            "200200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000d1d0f59c9251cb91f193aeca65c0340dce4bfc536faaba3f24dc89fa24d9eb44000000000000000000000000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8551000f400"
        )

        let resume = try mapper.createEncryptedUploadV2ResumeRequest(
            transportSessionID: 0x0000_1122_3344_5566,
            uploadSessionID: uploadSessionID,
            recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
            recordingGeneration: 9,
            checkpointRevision: 3,
            nextCiphertextOffset: 64,
            prefixSHA256: Self.data(
                "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
            ),
            windowPackets: 16,
            dataPayloadBytes: 244
        )
        XCTAssertEqual(
            Self.hex(resume),
            "220200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c771000f400"
        )

        XCTAssertEqual(
            Self.hex(try mapper.createEncryptedUploadV2Abort(
                transportSessionID: 0x0000_1122_3344_5566,
                reason: 0x000E
            )),
            "2402000066554433221100000e000000"
        )
    }

    func testStartAcknowledgementDecodesToTypedValue() throws {
        let mapper = try CoreModelMapper()
        let value = try mapper.decodeEncryptedUploadV2TransferControl(Self.data(
            "400200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff090000004a01000000000000287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b1000f40008000000000000000000000000000000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ))

        XCTAssertEqual(
            value,
            .startAccepted(EncryptedUploadV2StartAcknowledgementValue(
                transportSessionID: 0x0000_1122_3344_5566,
                uploadSessionID: try XCTUnwrap(
                    UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")
                ),
                recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
                recordingGeneration: 9,
                ciphertextLength: 330,
                ciphertextSHA256: Self.data(
                    "287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b"
                ),
                windowPackets: 16,
                dataPayloadBytes: 244,
                checkpointIntervalBlocks: 8,
                checkpointRevision: 0,
                nextCiphertextOffset: 0,
                prefixSHA256: Self.data(
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                )
            ))
        )
    }

    func testResumeRepliesDecodeToTypedValues() throws {
        let mapper = try CoreModelMapper()
        let accepted = try mapper.decodeEncryptedUploadV2TransferControl(Self.data(
            "450200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c771000f400"
        ))
        XCTAssertEqual(
            accepted,
            .resumeAccepted(EncryptedUploadV2ResumeValue(
                transportSessionID: 0x0000_1122_3344_5566,
                uploadSessionID: try XCTUnwrap(
                    UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")
                ),
                recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
                recordingGeneration: 9,
                checkpointRevision: 3,
                nextCiphertextOffset: 64,
                prefixSHA256: Self.data(
                    "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
                ),
                windowPackets: 16,
                dataPayloadBytes: 244
            ))
        )

        let rejected = try mapper.decodeEncryptedUploadV2TransferControl(Self.data(
            "4602000066554433221100000f000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
        ))
        XCTAssertEqual(
            rejected,
            .resumeRejected(EncryptedUploadV2ResumeRejectionValue(
                transportSessionID: 0x0000_1122_3344_5566,
                reason: 15,
                checkpointRevision: 3,
                nextCiphertextOffset: 64,
                prefixSHA256: Self.data(
                    "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
                )
            ))
        )
    }

    func testErrorDecodesAndNonControlPacketIsRejected() throws {
        let mapper = try CoreModelMapper()
        let error = try mapper.decodeEncryptedUploadV2TransferControl(Self.data(
            "4f02000066554433221100000f00220003000000"
        ))
        XCTAssertEqual(
            error,
            .error(EncryptedUploadV2TransferErrorValue(
                transportSessionID: 0x0000_1122_3344_5566,
                result: 15,
                failedMessageType: 0x22,
                checkpointRevision: 3
            ))
        )

        XCTAssertThrowsError(
            try mapper.decodeEncryptedUploadV2TransferControl(Self.data(
                "210200006655443322110000020000000c0000003000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c770300000000000000"
            ))
        )
    }

    func testStartRejectsNonCanonicalDigestLength() throws {
        let mapper = try CoreModelMapper()
        XCTAssertThrowsError(try mapper.createEncryptedUploadV2Start(
            transportSessionID: 1,
            uploadSessionID: UUID(),
            recordingUUID: "00112233-4455-6677-8899-aabbccddeeff",
            recordingGeneration: 1,
            authorizationSHA256: Data(repeating: 0, count: 31),
            checkpointRevision: 0,
            nextCiphertextOffset: 0,
            prefixSHA256: Data(repeating: 0, count: 32),
            windowPackets: 1,
            dataPayloadBytes: 1
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
