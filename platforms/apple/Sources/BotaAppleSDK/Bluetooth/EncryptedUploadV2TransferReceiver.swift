import CryptoKit
@preconcurrency import Foundation

struct EncryptedUploadV2CheckpointValue: Equatable, Sendable {
    let revision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let highestContiguousSequence: UInt32?

    init(
        revision: UInt32,
        nextCiphertextOffset: UInt64,
        prefixSHA256: Data,
        highestContiguousSequence: UInt32? = nil
    ) {
        self.revision = revision
        self.nextCiphertextOffset = nextCiphertextOffset
        self.prefixSHA256 = prefixSHA256
        self.highestContiguousSequence = highestContiguousSequence
    }
}

struct EncryptedUploadV2WindowStageValue: Equatable, Sendable {
    let checkpoint: EncryptedUploadV2CheckpointValue
    let missingSequences: [UInt32]
}

struct EncryptedUploadV2CompletedTransferValue: Equatable, Sendable {
    let fileURL: URL
    let manifest: Data
    let evidence: EncryptedUploadV2TransferEvidence
}

enum EncryptedUploadV2TransferReceiverEvent: Equatable, Sendable {
    case windowStaged(EncryptedUploadV2WindowStageValue)
    case completed(EncryptedUploadV2CompletedTransferValue)
}

enum EncryptedUploadV2TransferReceiverError: Error, Equatable, Sendable {
    case invalidConfiguration
    case notPrepared
    case sessionMismatch
    case packetConflict
    case malformedWindow
    case tooManyMissingSequences
    case checkpointMismatch
    case checkpointNotPersisted
    case manifestConflict
    case integrityMismatch
    case unexpectedPayload
    case deviceError(UInt16)
}

actor EncryptedUploadV2TransferReceiver {
    private struct PacketMetadata: Equatable, Sendable {
        let offset: UInt64
        let length: UInt64
        let sha256: Data

        var endOffset: UInt64 { offset + length }
    }

    private struct PendingWindow: Sendable {
        let value: EncryptedUploadV2WindowEndValue
        let checkpoint: EncryptedUploadV2CheckpointValue
        let missingSequences: [UInt32]
        let highestContiguousSequence: UInt32
        let contiguousOffset: UInt64
        let contiguousSHA256: Data
        var checkpointPersisted: Bool
    }

    private static let manifestLength = 580

    private let rootDirectory: URL
    private let sinkID: String
    private let fileManager: FileManager
    private let transportSessionID: UInt64
    private let expectedCiphertextLength: UInt64
    private let expectedCiphertextSHA256: Data
    private let maximumDataPayloadBytes: UInt16
    private let maximumWindowPackets: UInt16
    private let maximumMissingSequences: UInt16
    private let mapper: CoreModelMapper

    private var checkpoint: EncryptedUploadV2CheckpointValue
    private var prepared = false
    private var packets: [UInt32: PacketMetadata] = [:]
    private var pendingWindow: PendingWindow?
    private var manifest = Data(repeating: 0, count: manifestLength)
    private var manifestBytesPresent = [Bool](repeating: false, count: manifestLength)
    private var manifestSHA256: Data?
    private var terminal = false
    private var completed = false

    init(
        rootDirectory: URL,
        sinkID: String,
        transportSessionID: UInt64,
        expectedCiphertextLength: UInt64,
        expectedCiphertextSHA256: Data,
        maximumDataPayloadBytes: UInt16,
        maximumWindowPackets: UInt16,
        maximumMissingSequences: UInt16,
        checkpoint: EncryptedUploadV2CheckpointValue,
        mapper: CoreModelMapper,
        fileManager: FileManager = .default
    ) throws {
        guard UUID(uuidString: sinkID) != nil,
              transportSessionID != 0,
              expectedCiphertextLength > 0,
              expectedCiphertextSHA256.count == 32,
              maximumDataPayloadBytes > 0,
              maximumWindowPackets > 0,
              maximumMissingSequences > 0,
              checkpoint.nextCiphertextOffset <= expectedCiphertextLength,
              checkpoint.prefixSHA256.count == 32,
              (checkpoint.nextCiphertextOffset == 0)
                == (checkpoint.highestContiguousSequence == nil)
        else {
            throw EncryptedUploadV2TransferReceiverError.invalidConfiguration
        }
        self.rootDirectory = rootDirectory
        self.sinkID = sinkID
        self.transportSessionID = transportSessionID
        self.expectedCiphertextLength = expectedCiphertextLength
        self.expectedCiphertextSHA256 = expectedCiphertextSHA256
        self.maximumDataPayloadBytes = maximumDataPayloadBytes
        self.maximumWindowPackets = maximumWindowPackets
        self.maximumMissingSequences = maximumMissingSequences
        self.checkpoint = checkpoint
        self.mapper = mapper
        self.fileManager = fileManager
    }

    func prepare() throws {
        try fileManager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        if !fileManager.fileExists(atPath: fileURL.path) {
            guard checkpoint.nextCiphertextOffset == 0 else {
                throw EncryptedUploadV2TransferReceiverError.integrityMismatch
            }
            guard fileManager.createFile(atPath: fileURL.path, contents: nil) else {
                throw EncryptedUploadV2TransferReceiverError.integrityMismatch
            }
        }
        let handle = try FileHandle(forUpdating: fileURL)
        defer { try? handle.close() }
        let currentSize = try handle.seekToEnd()
        guard currentSize >= checkpoint.nextCiphertextOffset else {
            throw EncryptedUploadV2TransferReceiverError.integrityMismatch
        }
        try handle.truncate(atOffset: checkpoint.nextCiphertextOffset)
        try handle.synchronize()
        guard Self.secureEqual(
            try sha256Prefix(length: checkpoint.nextCiphertextOffset),
            checkpoint.prefixSHA256
        ) else {
            throw EncryptedUploadV2TransferReceiverError.integrityMismatch
        }
#if os(iOS)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
#endif
        prepared = true
    }

    func receive(_ rawValue: Data) throws -> EncryptedUploadV2TransferReceiverEvent? {
        guard prepared, !terminal, !completed else {
            throw EncryptedUploadV2TransferReceiverError.notPrepared
        }
        do {
            let payload = try mapper.decodeEncryptedUploadV2TransferPayload(rawValue)
            guard payload.transportSessionID == transportSessionID else {
                throw EncryptedUploadV2TransferReceiverError.sessionMismatch
            }
            switch payload {
            case let .data(value):
                try receiveData(value)
                return nil
            case let .windowEnd(value):
                return .windowStaged(try receiveWindowEnd(value))
            case let .manifestChunk(value):
                try receiveManifest(value)
                return nil
            case let .eof(value):
                let transfer = try receiveEOF(value)
                completed = true
                return .completed(transfer)
            case let .error(value):
                guard value.result != 0 else {
                    throw EncryptedUploadV2TransferReceiverError.unexpectedPayload
                }
                throw EncryptedUploadV2TransferReceiverError.deviceError(value.result)
            }
        } catch {
            terminal = true
            throw error
        }
    }

    func repairAcknowledgement(missingSequences: [UInt32]) throws -> Data {
        guard prepared, !terminal, !completed, let pendingWindow else {
            throw EncryptedUploadV2TransferReceiverError.unexpectedPayload
        }
        guard !pendingWindow.missingSequences.isEmpty,
              pendingWindow.missingSequences == missingSequences
        else {
            throw EncryptedUploadV2TransferReceiverError.checkpointMismatch
        }
        return try mapper.createEncryptedUploadV2WindowAcknowledgement(
            transportSessionID: transportSessionID,
            windowIndex: pendingWindow.value.windowIndex,
            highestContiguousSequence: pendingWindow.highestContiguousSequence,
            nextCiphertextOffset: pendingWindow.contiguousOffset,
            prefixSHA256: pendingWindow.contiguousSHA256,
            checkpointRevision: checkpoint.revision,
            missingSequences: missingSequences
        )
    }

    func checkpointDidPersist(_ persistedCheckpoint: EncryptedUploadV2CheckpointValue) throws {
        guard prepared, !terminal, !completed,
              var pendingWindow,
              pendingWindow.missingSequences.isEmpty,
              Self.sameCheckpoint(pendingWindow.checkpoint, persistedCheckpoint)
        else {
            throw EncryptedUploadV2TransferReceiverError.checkpointMismatch
        }
        pendingWindow.checkpointPersisted = true
        self.pendingWindow = pendingWindow
    }

    func windowAcknowledgement(for persistedCheckpoint: EncryptedUploadV2CheckpointValue) throws -> Data {
        guard prepared, !terminal, !completed,
              let pendingWindow,
              pendingWindow.missingSequences.isEmpty,
              Self.sameCheckpoint(pendingWindow.checkpoint, persistedCheckpoint)
        else {
            throw EncryptedUploadV2TransferReceiverError.checkpointMismatch
        }
        guard pendingWindow.checkpointPersisted else {
            throw EncryptedUploadV2TransferReceiverError.checkpointNotPersisted
        }
        let acknowledgement = try mapper.createEncryptedUploadV2WindowAcknowledgement(
            transportSessionID: transportSessionID,
            windowIndex: pendingWindow.value.windowIndex,
            highestContiguousSequence: pendingWindow.value.lastSequence,
            nextCiphertextOffset: persistedCheckpoint.nextCiphertextOffset,
            prefixSHA256: persistedCheckpoint.prefixSHA256,
            checkpointRevision: persistedCheckpoint.revision,
            missingSequences: []
        )
        checkpoint = persistedCheckpoint
        packets.removeAll(keepingCapacity: true)
        self.pendingWindow = nil
        return acknowledgement
    }

    private var fileURL: URL {
        rootDirectory.appendingPathComponent(sinkID).appendingPathExtension("encrypted-upload-v2")
    }

    private func receiveData(_ value: EncryptedUploadV2DataValue) throws {
        let (endOffset, offsetOverflow) = value.ciphertextOffset.addingReportingOverflow(
            UInt64(value.bytes.count)
        )
        guard pendingWindow?.missingSequences.isEmpty != true,
              !value.bytes.isEmpty,
              value.bytes.count <= Int(maximumDataPayloadBytes),
              value.ciphertextOffset >= checkpoint.nextCiphertextOffset,
              !offsetOverflow,
              endOffset <= expectedCiphertextLength
        else {
            throw EncryptedUploadV2TransferReceiverError.unexpectedPayload
        }
        let metadata = PacketMetadata(
            offset: value.ciphertextOffset,
            length: UInt64(value.bytes.count),
            sha256: Self.sha256(value.bytes)
        )
        if let existing = packets[value.sequence] {
            guard existing.offset == metadata.offset,
                  existing.length == metadata.length,
                  Self.secureEqual(existing.sha256, metadata.sha256)
            else {
                throw EncryptedUploadV2TransferReceiverError.packetConflict
            }
            return
        }
        guard packets.count < Int(maximumWindowPackets),
              !packets.values.contains(where: { Self.overlaps($0, metadata) })
        else {
            throw EncryptedUploadV2TransferReceiverError.packetConflict
        }
        try write(value.bytes, at: value.ciphertextOffset)
        packets[value.sequence] = metadata
    }

    private func receiveWindowEnd(
        _ value: EncryptedUploadV2WindowEndValue
    ) throws -> EncryptedUploadV2WindowStageValue {
        let (span, sequenceOverflow) = value.lastSequence.subtractingReportingOverflow(
            value.firstSequence
        )
        let followsAcknowledgedSequence = checkpoint.highestContiguousSequence.map { highest in
            let (expected, overflow) = highest.addingReportingOverflow(1)
            return !overflow && value.firstSequence == expected
        } ?? true
        guard value.firstSequence <= value.lastSequence,
              followsAcknowledgedSequence,
              value.checkpointRevision > checkpoint.revision,
              value.nextCiphertextOffset > checkpoint.nextCiphertextOffset,
              value.nextCiphertextOffset <= expectedCiphertextLength,
              value.prefixSHA256.count == 32,
              !sequenceOverflow,
              span < UInt32(maximumWindowPackets),
              packets.keys.allSatisfy({ value.firstSequence ... value.lastSequence ~= $0 })
        else {
            throw EncryptedUploadV2TransferReceiverError.malformedWindow
        }

        var missingSequences: [UInt32] = []
        var sequence = value.firstSequence
        while true {
            if packets[sequence] == nil { missingSequences.append(sequence) }
            if sequence == value.lastSequence { break }
            sequence += 1
        }
        guard missingSequences.count <= Int(maximumMissingSequences) else {
            throw EncryptedUploadV2TransferReceiverError.tooManyMissingSequences
        }

        var contiguousOffset = checkpoint.nextCiphertextOffset
        var highestContiguousSequence = value.firstSequence == 0 ? 0 : value.firstSequence - 1
        sequence = value.firstSequence
        while true {
            guard let packet = packets[sequence] else { break }
            guard packet.offset == contiguousOffset else {
                throw EncryptedUploadV2TransferReceiverError.malformedWindow
            }
            contiguousOffset = packet.endOffset
            highestContiguousSequence = sequence
            if sequence == value.lastSequence { break }
            sequence += 1
        }
        let contiguousSHA256 = try sha256Prefix(length: contiguousOffset)
        let candidate = EncryptedUploadV2CheckpointValue(
            revision: value.checkpointRevision,
            nextCiphertextOffset: value.nextCiphertextOffset,
            prefixSHA256: value.prefixSHA256,
            highestContiguousSequence: value.lastSequence
        )
        if missingSequences.isEmpty {
            guard contiguousOffset == value.nextCiphertextOffset,
                  Self.secureEqual(contiguousSHA256, value.prefixSHA256)
            else {
                throw EncryptedUploadV2TransferReceiverError.integrityMismatch
            }
        }
        pendingWindow = PendingWindow(
            value: value,
            checkpoint: candidate,
            missingSequences: missingSequences,
            highestContiguousSequence: highestContiguousSequence,
            contiguousOffset: contiguousOffset,
            contiguousSHA256: contiguousSHA256,
            checkpointPersisted: false
        )
        return .init(checkpoint: candidate, missingSequences: missingSequences)
    }

    private func receiveManifest(_ value: EncryptedUploadV2ManifestChunkValue) throws {
        let (end, offsetOverflow) = Int(value.chunkOffset).addingReportingOverflow(
            value.bytes.count
        )
        guard pendingWindow == nil,
              value.totalManifestLength == Self.manifestLength,
              value.manifestSHA256.count == 32,
              !value.bytes.isEmpty,
              !offsetOverflow,
              end <= Self.manifestLength,
              manifestSHA256 == nil
                || Self.secureEqual(manifestSHA256 ?? Data(), value.manifestSHA256)
        else {
            throw EncryptedUploadV2TransferReceiverError.manifestConflict
        }
        for (relativeIndex, byte) in value.bytes.enumerated() {
            let index = Int(value.chunkOffset) + relativeIndex
            if manifestBytesPresent[index], manifest[index] != byte {
                throw EncryptedUploadV2TransferReceiverError.manifestConflict
            }
            manifest[index] = byte
            manifestBytesPresent[index] = true
        }
        manifestSHA256 = value.manifestSHA256
    }

    private func receiveEOF(
        _ value: EncryptedUploadV2EOFValue
    ) throws -> EncryptedUploadV2CompletedTransferValue {
        guard pendingWindow == nil,
              packets.isEmpty,
              checkpoint.highestContiguousSequence == value.finalSequence,
              value.blockCount > 0,
              value.ciphertextLength == expectedCiphertextLength,
              Self.secureEqual(value.ciphertextSHA256, expectedCiphertextSHA256),
              manifestSHA256.map({ Self.secureEqual(value.manifestSHA256, $0) }) == true,
              manifestBytesPresent.allSatisfy({ $0 }),
              Self.secureEqual(Self.sha256(manifest), value.manifestSHA256),
              try fileSize() == expectedCiphertextLength,
              Self.secureEqual(
                try sha256Prefix(length: expectedCiphertextLength),
                expectedCiphertextSHA256
              )
        else {
            throw EncryptedUploadV2TransferReceiverError.integrityMismatch
        }
        let evidence = EncryptedUploadV2TransferEvidence(
            ciphertextLength: value.ciphertextLength,
            ciphertextSHA256: value.ciphertextSHA256,
            manifestLength: UInt16(Self.manifestLength),
            manifestSHA256: value.manifestSHA256,
            blockCount: value.blockCount
        )
        return .init(fileURL: fileURL, manifest: manifest, evidence: evidence)
    }

    private func write(_ data: Data, at offset: UInt64) throws {
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    private func fileSize() throws -> UInt64 {
        let values = try fileURL.resourceValues(forKeys: [.fileSizeKey])
        return UInt64(values.fileSize ?? 0)
    }

    private func sha256Prefix(length: UInt64) throws -> Data {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        var remaining = length
        while remaining > 0 {
            let readCount = Int(min(remaining, 64 * 1024))
            guard let chunk = try handle.read(upToCount: readCount), !chunk.isEmpty else {
                throw EncryptedUploadV2TransferReceiverError.integrityMismatch
            }
            hasher.update(data: chunk)
            remaining -= UInt64(chunk.count)
        }
        return Data(hasher.finalize())
    }

    private static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    private static func sameCheckpoint(
        _ lhs: EncryptedUploadV2CheckpointValue,
        _ rhs: EncryptedUploadV2CheckpointValue
    ) -> Bool {
        lhs.revision == rhs.revision
            && lhs.nextCiphertextOffset == rhs.nextCiphertextOffset
            && lhs.highestContiguousSequence == rhs.highestContiguousSequence
            && secureEqual(lhs.prefixSHA256, rhs.prefixSHA256)
    }

    private static func secureEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var difference: UInt8 = 0
        for (left, right) in zip(lhs, rhs) {
            difference |= left ^ right
        }
        return difference == 0
    }

    private static func overlaps(_ lhs: PacketMetadata, _ rhs: PacketMetadata) -> Bool {
        lhs.offset < rhs.endOffset && rhs.offset < lhs.endOffset
    }
}

private extension EncryptedUploadV2TransferPayloadValue {
    var transportSessionID: UInt64 {
        switch self {
        case let .data(value): value.transportSessionID
        case let .windowEnd(value): value.transportSessionID
        case let .manifestChunk(value): value.transportSessionID
        case let .eof(value): value.transportSessionID
        case let .error(value): value.transportSessionID
        }
    }
}
