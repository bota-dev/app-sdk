import CryptoKit
import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2TransferReceiverTests: XCTestCase {
    func testMissingWindowWritesOpaqueBytesByOffsetAndRequestsOnlyTheGap() async throws {
        let fixture = try Fixture()
        let receiver = try fixture.receiver(expectedCiphertext: Data("abcdef".utf8))
        try await receiver.prepare()

        let firstData = try await receiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        XCTAssertNil(firstData)
        let thirdData = try await receiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 3,
            offset: 4,
            bytes: Data("ef".utf8)
        ))
        XCTAssertNil(thirdData)

        let received = try await receiver.receive(Self.windowEnd(
            sessionID: fixture.sessionID,
            windowIndex: 7,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: Self.sha256(Data("abcdef".utf8)),
            checkpointRevision: 1
        ))
        let staged = try XCTUnwrap(received)
        XCTAssertEqual(
            staged,
            .windowStaged(.init(
                checkpoint: .init(
                    revision: 1,
                    nextCiphertextOffset: 6,
                    prefixSHA256: Self.sha256(Data("abcdef".utf8)),
                    highestContiguousSequence: 3
                ),
                missingSequences: [2]
            ))
        )

        let repair = try await receiver.repairAcknowledgement(missingSequences: [2])
        XCTAssertEqual(Self.readUInt32(repair, at: 16), 1)
        XCTAssertEqual(Self.readUInt64(repair, at: 20), 2)
        XCTAssertEqual(Data(repair[28..<60]), Self.sha256(Data("ab".utf8)))
        XCTAssertEqual(Self.readUInt32(repair, at: 60), 0)
        XCTAssertEqual(Self.readUInt16(repair, at: 64), 1)
        XCTAssertEqual(Self.readUInt32(repair, at: 68), 2)

        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), Data([0x61, 0x62, 0, 0, 0x65, 0x66]))
    }

    func testCleanWindowCannotBeAcknowledgedBeforeExactCheckpointIsDurable() async throws {
        let fixture = try Fixture()
        let ciphertext = Data("abcdef".utf8)
        let receiver = try fixture.receiver(expectedCiphertext: ciphertext)
        try await receiver.prepare()

        for (sequence, offset, bytes) in [
            (UInt32(1), UInt64(0), Data("ab".utf8)),
            (UInt32(2), UInt64(2), Data("cd".utf8)),
            (UInt32(3), UInt64(4), Data("ef".utf8)),
        ] {
            let event = try await receiver.receive(Self.dataPacket(
                sessionID: fixture.sessionID,
                sequence: sequence,
                offset: offset,
                bytes: bytes
            ))
            XCTAssertNil(event)
        }
        let checkpoint = EncryptedUploadV2CheckpointValue(
            revision: 1,
            nextCiphertextOffset: 6,
            prefixSHA256: Self.sha256(ciphertext),
            highestContiguousSequence: 3
        )
        let cleanWindow = try await receiver.receive(Self.windowEnd(
            sessionID: fixture.sessionID,
            windowIndex: 7,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: checkpoint.prefixSHA256,
            checkpointRevision: 1
        ))
        XCTAssertEqual(
            cleanWindow,
            .windowStaged(.init(checkpoint: checkpoint, missingSequences: []))
        )

        await XCTAssertThrowsErrorAsync(
            try await receiver.windowAcknowledgement(for: checkpoint)
        ) { error in
            XCTAssertEqual(
                error as? EncryptedUploadV2TransferReceiverError,
                .checkpointNotPersisted
            )
        }
        await XCTAssertThrowsErrorAsync(
            try await receiver.checkpointDidPersist(.init(
                revision: 2,
                nextCiphertextOffset: 6,
                prefixSHA256: checkpoint.prefixSHA256,
                highestContiguousSequence: 3
            ))
        ) { error in
            XCTAssertEqual(
                error as? EncryptedUploadV2TransferReceiverError,
                .checkpointMismatch
            )
        }

        try await receiver.checkpointDidPersist(checkpoint)
        let acknowledgement = try await receiver.windowAcknowledgement(for: checkpoint)
        XCTAssertEqual(Self.readUInt32(acknowledgement, at: 12), 7)
        XCTAssertEqual(Self.readUInt32(acknowledgement, at: 16), 3)
        XCTAssertEqual(Self.readUInt64(acknowledgement, at: 20), 6)
        XCTAssertEqual(Data(acknowledgement[28..<60]), checkpoint.prefixSHA256)
        XCTAssertEqual(Self.readUInt32(acknowledgement, at: 60), 1)
        XCTAssertEqual(Self.readUInt16(acknowledgement, at: 64), 0)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), ciphertext)
    }

    func testRepairedWindowAndManifestProduceExactOpaqueCompletionEvidence() async throws {
        let fixture = try Fixture()
        let ciphertext = Data("abcdef".utf8)
        let manifest = Data((0..<580).map { UInt8($0 % 251) })
        let receiver = try fixture.receiver(expectedCiphertext: ciphertext)
        try await receiver.prepare()

        let firstData = try await receiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        XCTAssertNil(firstData)
        let thirdData = try await receiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 3,
            offset: 4,
            bytes: Data("ef".utf8)
        ))
        XCTAssertNil(thirdData)
        _ = try await receiver.receive(Self.windowEnd(
            sessionID: fixture.sessionID,
            windowIndex: 7,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: Self.sha256(ciphertext),
            checkpointRevision: 1
        ))
        _ = try await receiver.repairAcknowledgement(missingSequences: [2])
        let repairedData = try await receiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 2,
            offset: 2,
            bytes: Data("cd".utf8)
        ))
        XCTAssertNil(repairedData)

        let checkpoint = EncryptedUploadV2CheckpointValue(
            revision: 1,
            nextCiphertextOffset: 6,
            prefixSHA256: Self.sha256(ciphertext),
            highestContiguousSequence: 3
        )
        let cleanWindow = try await receiver.receive(Self.windowEnd(
            sessionID: fixture.sessionID,
            windowIndex: 7,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: checkpoint.prefixSHA256,
            checkpointRevision: 1
        ))
        XCTAssertEqual(
            cleanWindow,
            .windowStaged(.init(checkpoint: checkpoint, missingSequences: []))
        )
        try await receiver.checkpointDidPersist(checkpoint)
        _ = try await receiver.windowAcknowledgement(for: checkpoint)

        let trailingManifest = try await receiver.receive(Self.manifestChunk(
            sessionID: fixture.sessionID,
            totalLength: 580,
            offset: 300,
            digest: Self.sha256(manifest),
            bytes: Data(manifest[300..<580])
        ))
        XCTAssertNil(trailingManifest)
        let leadingManifest = try await receiver.receive(Self.manifestChunk(
            sessionID: fixture.sessionID,
            totalLength: 580,
            offset: 0,
            digest: Self.sha256(manifest),
            bytes: Data(manifest[0..<300])
        ))
        XCTAssertNil(leadingManifest)

        let evidence = EncryptedUploadV2TransferEvidence(
            ciphertextLength: 6,
            ciphertextSHA256: Self.sha256(ciphertext),
            manifestLength: 580,
            manifestSHA256: Self.sha256(manifest),
            blockCount: 1
        )
        let completed = try await receiver.receive(Self.eof(
            sessionID: fixture.sessionID,
            finalSequence: 3,
            blockCount: 1,
            ciphertextLength: 6,
            ciphertextSHA256: evidence.ciphertextSHA256,
            manifestSHA256: evidence.manifestSHA256
        ))
        XCTAssertEqual(
            completed,
            .completed(.init(fileURL: fixture.fileURL, manifest: manifest, evidence: evidence))
        )
    }

    func testForeignSessionConflictingDuplicateAndOverlappingPacketsFailClosed() async throws {
        let fixture = try Fixture()
        let receiver = try fixture.receiver(expectedCiphertext: Data("abcdef".utf8))
        try await receiver.prepare()

        await XCTAssertThrowsErrorAsync(
            try await receiver.receive(Self.dataPacket(
                sessionID: fixture.sessionID + 1,
                sequence: 1,
                offset: 0,
                bytes: Data("ab".utf8)
            ))
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2TransferReceiverError, .sessionMismatch)
        }
        await XCTAssertThrowsErrorAsync(
            try await receiver.receive(Self.dataPacket(
                sessionID: fixture.sessionID,
                sequence: 1,
                offset: 0,
                bytes: Data("ab".utf8)
            ))
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2TransferReceiverError, .notPrepared)
        }

        let conflictReceiver = try fixture.receiver(expectedCiphertext: Data("abcdef".utf8))
        try await conflictReceiver.prepare()
        let firstData = try await conflictReceiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        XCTAssertNil(firstData)
        await XCTAssertThrowsErrorAsync(
            try await conflictReceiver.receive(Self.dataPacket(
                sessionID: fixture.sessionID,
                sequence: 1,
                offset: 0,
                bytes: Data("zz".utf8)
            ))
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2TransferReceiverError, .packetConflict)
        }

        let overlapReceiver = try fixture.receiver(expectedCiphertext: Data("abcdef".utf8))
        try await overlapReceiver.prepare()
        let overlapFirstData = try await overlapReceiver.receive(Self.dataPacket(
            sessionID: fixture.sessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        XCTAssertNil(overlapFirstData)
        await XCTAssertThrowsErrorAsync(
            try await overlapReceiver.receive(Self.dataPacket(
                sessionID: fixture.sessionID,
                sequence: 2,
                offset: 1,
                bytes: Data("cd".utf8)
            ))
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2TransferReceiverError, .packetConflict)
        }
    }

    func testResumePreparationTruncatesUnprovedTailAndVerifiesDurablePrefix() async throws {
        let fixture = try Fixture()
        try FileManager.default.createDirectory(
            at: fixture.root,
            withIntermediateDirectories: true
        )
        try Data("abcUNPROVED".utf8).write(to: fixture.fileURL)
        let checkpoint = EncryptedUploadV2CheckpointValue(
            revision: 4,
            nextCiphertextOffset: 3,
            prefixSHA256: Self.sha256(Data("abc".utf8)),
            highestContiguousSequence: 2
        )
        let receiver = try fixture.receiver(
            expectedCiphertext: Data("abcdef".utf8),
            checkpoint: checkpoint
        )

        try await receiver.prepare()

        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), Data("abc".utf8))

        try Data("wrong".utf8).write(to: fixture.fileURL)
        let rejected = try fixture.receiver(
            expectedCiphertext: Data("abcdef".utf8),
            checkpoint: checkpoint
        )
        await XCTAssertThrowsErrorAsync(try await rejected.prepare()) { error in
            XCTAssertEqual(error as? EncryptedUploadV2TransferReceiverError, .integrityMismatch)
        }
    }

    func testResumeAtCompleteCiphertextAcceptsEofWithoutAnotherDataWindow() async throws {
        let fixture = try Fixture()
        let ciphertext = Data("abcdef".utf8)
        let manifest = Data((0..<580).map { UInt8($0 % 251) })
        try FileManager.default.createDirectory(
            at: fixture.root,
            withIntermediateDirectories: true
        )
        try ciphertext.write(to: fixture.fileURL)
        let receiver = try fixture.receiver(
            expectedCiphertext: ciphertext,
            checkpoint: .init(
                revision: 4,
                nextCiphertextOffset: 6,
                prefixSHA256: Self.sha256(ciphertext),
                highestContiguousSequence: 93
            )
        )
        try await receiver.prepare()
        let leadingManifest = try await receiver.receive(Self.manifestChunk(
            sessionID: fixture.sessionID,
            totalLength: 580,
            offset: 0,
            digest: Self.sha256(manifest),
            bytes: Data(manifest[0..<300])
        ))
        XCTAssertNil(leadingManifest)
        let trailingManifest = try await receiver.receive(Self.manifestChunk(
            sessionID: fixture.sessionID,
            totalLength: 580,
            offset: 300,
            digest: Self.sha256(manifest),
            bytes: Data(manifest[300..<580])
        ))
        XCTAssertNil(trailingManifest)

        let evidence = EncryptedUploadV2TransferEvidence(
            ciphertextLength: 6,
            ciphertextSHA256: Self.sha256(ciphertext),
            manifestLength: 580,
            manifestSHA256: Self.sha256(manifest),
            blockCount: 1
        )
        let completed = try await receiver.receive(Self.eof(
            sessionID: fixture.sessionID,
            finalSequence: 93,
            blockCount: 1,
            ciphertextLength: 6,
            ciphertextSHA256: evidence.ciphertextSHA256,
            manifestSHA256: evidence.manifestSHA256
        ))
        XCTAssertEqual(
            completed,
            .completed(.init(fileURL: fixture.fileURL, manifest: manifest, evidence: evidence))
        )
    }

    private struct Fixture {
        let root: URL
        let sinkID = "53B6CE85-B90A-4C11-9359-FD7E3A5B3344"
        let sessionID: UInt64 = 0x0000_1122_3344_5566

        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        }

        var fileURL: URL {
            root.appendingPathComponent(sinkID).appendingPathExtension("encrypted-upload-v2")
        }

        func receiver(
            expectedCiphertext: Data,
            checkpoint: EncryptedUploadV2CheckpointValue? = nil
        ) throws -> EncryptedUploadV2TransferReceiver {
            try EncryptedUploadV2TransferReceiver(
                rootDirectory: root,
                sinkID: sinkID,
                transportSessionID: sessionID,
                expectedCiphertextLength: UInt64(expectedCiphertext.count),
                expectedCiphertextSHA256: SelfTest.sha256(expectedCiphertext),
                maximumDataPayloadBytes: 4,
                maximumWindowPackets: 4,
                maximumMissingSequences: 2,
                checkpoint: checkpoint ?? .init(
                    revision: 0,
                    nextCiphertextOffset: 0,
                    prefixSHA256: SelfTest.sha256(Data())
                ),
                mapper: try CoreModelMapper()
            )
        }
    }

    private enum SelfTest {
        static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    }

    private static func sha256(_ data: Data) -> Data { SelfTest.sha256(data) }

    private static func dataPacket(
        sessionID: UInt64,
        sequence: UInt32,
        offset: UInt64,
        bytes: Data
    ) -> Data {
        var data = header(type: 0x41, sessionID: sessionID)
        data.appendLE(sequence)
        data.appendLE(offset)
        data.appendLE(UInt16(bytes.count))
        data.appendLE(UInt16(0))
        data.append(bytes)
        return data
    }

    private static func windowEnd(
        sessionID: UInt64,
        windowIndex: UInt32,
        firstSequence: UInt32,
        lastSequence: UInt32,
        nextOffset: UInt64,
        prefixSHA256: Data,
        checkpointRevision: UInt32
    ) -> Data {
        var data = header(type: 0x42, sessionID: sessionID)
        data.appendLE(windowIndex)
        data.appendLE(firstSequence)
        data.appendLE(lastSequence)
        data.appendLE(nextOffset)
        data.append(prefixSHA256)
        data.appendLE(checkpointRevision)
        return data
    }

    private static func manifestChunk(
        sessionID: UInt64,
        totalLength: UInt16,
        offset: UInt16,
        digest: Data,
        bytes: Data
    ) -> Data {
        var data = header(type: 0x43, sessionID: sessionID)
        data.appendLE(totalLength)
        data.appendLE(offset)
        data.appendLE(UInt16(bytes.count))
        data.appendLE(UInt16(0))
        data.append(digest)
        data.append(bytes)
        return data
    }

    private static func eof(
        sessionID: UInt64,
        finalSequence: UInt32,
        blockCount: UInt32,
        ciphertextLength: UInt64,
        ciphertextSHA256: Data,
        manifestSHA256: Data
    ) -> Data {
        var data = header(type: 0x44, sessionID: sessionID)
        data.appendLE(finalSequence)
        data.appendLE(blockCount)
        data.appendLE(ciphertextLength)
        data.append(ciphertextSHA256)
        data.append(manifestSHA256)
        return data
    }

    private static func header(type: UInt8, sessionID: UInt64) -> Data {
        var data = Data([type, 0x02, 0, 0])
        data.appendLE(sessionID)
        return data
    }

    private static func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
        data[offset..<(offset + 2)].enumerated().reduce(0) { value, pair in
            value | (UInt16(pair.element) << UInt16(pair.offset * 8))
        }
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        data[offset..<(offset + 4)].enumerated().reduce(0) { value, pair in
            value | (UInt32(pair.element) << UInt32(pair.offset * 8))
        }
    }

    private static func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
        data[offset..<(offset + 8)].enumerated().reduce(0) { value, pair in
            value | (UInt64(pair.element) << UInt64(pair.offset * 8))
        }
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("expected expression to throw", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
