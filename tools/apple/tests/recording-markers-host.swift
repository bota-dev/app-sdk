import Foundation
import CryptoKit

private struct MarkerTestFailure: Error { let message: String }
private func expect(_ condition: Bool, _ message: String) throws {
    if !condition { throw MarkerTestFailure(message: message) }
}
private extension Data {
    mutating func le<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}
private actor MarkerCatalogIO {
    let rejection: UInt16
    var flags: [UInt8] = []
    var streams: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    init(rejection: UInt16) { self.rejection = rejection }
    func subscribe(_ uuid: String) -> AsyncThrowingStream<Data, Error> {
        let pair = AsyncThrowingStream<Data, Error>.makeStream()
        streams[uuid] = pair.continuation
        return pair.stream
    }
    func write(_ command: Data) {
        flags.append(command[12])
        if command[12] == 1 {
            var error = Data([0x4f, 2, 0, 0]) + Data(command[4..<12])
            error.le(rejection); error.append(contentsOf: [0x25, 0]); error.le(UInt32(0))
            streams[BotaBluetoothUUIDs.recordingTransferV2]?.yield(error)
        } else {
            let end = Data([0x49, 2, 0, 0]) + Data(command[4..<12])
                + Data([0, 0, 0, 0, 1, 0, 0, 0]) + Data(SHA256.hash(data: Data()))
            streams[BotaBluetoothUUIDs.recordingListV2]?.yield(end)
        }
    }
    func unsubscribe(_ uuid: String) { streams.removeValue(forKey: uuid)?.finish() }
}
@main private struct MarkerHostTests {
    static func sha(_ value: Data) -> Data { Data(SHA256.hash(data: value)) }
    static func header(_ type: UInt8) -> Data {
        var value = Data([type, 2, 0, 0]); value.le(UInt64(9)); return value
    }
    static func chunk(_ document: Data, index: UInt32, offset: Int, length: Int, count: UInt32 = 2) -> Data {
        var value = header(0x4a)
        value.le(index); value.le(count); value.le(UInt16(offset)); value.le(UInt16(document.count))
        value.le(UInt16(length)); value.le(UInt16(0)); value.append(sha(document))
        value.append(document[offset..<(offset + length)])
        return value
    }
    static func main() async throws {
        let mapper = try CoreModelMapper()
        let markedList = try mapper.createEncryptedUploadV2List(transportSessionID: 9, includeMarkers: true)
        try expect(markedList[12] == 1, "Rust encodes marked catalog flag")
        for fault in ["none", "missing", "reorder", "tampered", "count", "offset", "ordinary"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let sink = UUID().uuidString
            let audio = Data([1, 2, 3, 4]), manifest = Data(repeating: 7, count: 580)
            try audio.write(to: root.appendingPathComponent(sink + ".encrypted-upload-v2"))
            let receiver = try EncryptedUploadV2TransferReceiver(rootDirectory: root, sinkID: sink,
                transportSessionID: 9, expectedCiphertextLength: 4, expectedCiphertextSHA256: sha(audio),
                maximumDataPayloadBytes: 128, maximumWindowPackets: 8, maximumMissingSequences: 8,
                checkpoint: .init(revision: 1, nextCiphertextOffset: 4, prefixSHA256: sha(audio), highestContiguousSequence: 1),
                mapper: mapper, markersRequired: fault != "ordinary")
            try await receiver.prepare(); try await receiver.resumeAccepted()
            for offset in [0, 290] {
                var packet = header(0x43)
                packet.le(UInt16(580)); packet.le(UInt16(offset)); packet.le(UInt16(290)); packet.le(UInt16(0))
                packet.append(sha(manifest)); packet.append(manifest[offset..<(offset + 290)])
                _ = try await receiver.receive(packet)
            }
            var rejected = false
            let documents = [Data(repeating: 8, count: 200), Data(repeating: 9, count: 402)]
            do {
                for (index, document) in documents.enumerated() {
                    if fault == "missing" && index == 1 { break }
                    for offset in stride(from: 0, to: document.count, by: 100) {
                        var packet = chunk(document, index: fault == "reorder" ? 1 : UInt32(index),
                            offset: offset, length: min(100, document.count - offset), count: fault == "count" ? 4098 : 2)
                        if fault == "tampered" { packet[60] ^= 1 }
                        if fault == "offset" { packet[20] = 1 }
                        _ = try await receiver.receive(packet)
                    }
                }
                var eof = header(0x44)
                eof.le(UInt32(0)); eof.le(UInt32(1)); eof.le(UInt64(4)); eof.append(sha(audio)); eof.append(sha(manifest))
                guard case let .completed(result)? = try await receiver.receive(eof) else {
                    throw MarkerTestFailure(message: "Missing completion")
                }
                try expect(result.markerDocuments == documents, "Exact opaque metadata")
            } catch is MarkerTestFailure { throw MarkerTestFailure(message: "Bad result for " + fault) }
              catch { rejected = true }
            try expect(rejected == (fault != "none"), "Fault admission: " + fault)
            try expect(try Data(contentsOf: root.appendingPathComponent(sink + ".encrypted-upload-v2")) == audio, "Failure retains ciphertext")
        }
        for rejection: UInt16 in [3, 9] {
            let io = MarkerCatalogIO(rejection: rejection)
            let catalog = EncryptedUploadV2Catalog(mapper: mapper,
                subscribe: { _, uuid in await io.subscribe(uuid) },
                write: { _, bytes in await io.write(bytes) }, unsubscribe: { _, uuid in await io.unsubscribe(uuid) })
            var failed = false
            do { _ = try await catalog.list(peripheralID: "device") } catch { failed = true }
            let flags = await io.flags
            try expect(failed == (rejection != 3), "Only unsupported marked list falls back")
            try expect(flags == (rejection == 3 ? [1, 0] : [1]), "Catalog opt-in and legacy fallback")
        }
        let registry = EncryptedUploadV2MaterialRegistry()
        let auth = Data(repeating: 1, count: 864), manifest = Data(repeating: 2, count: 580)
        let evidence = EncryptedUploadV2TransferEvidence(ciphertextLength: 4, ciphertextSHA256: sha(Data([1,2,3,4])),
            manifestLength: 580, manifestSHA256: sha(manifest), blockCount: 1)
        for receiptLength in [336, 632] {
            let id = "marker-\(receiptLength)", receipt = Data(repeating: 3, count: receiptLength)
            try await registry.register(id: id, provider: .init(authorization: auth,
                stagingRequest: { _ in URLRequest(url: URL(string: "https://example.test")!) },
                submitManifest: { _ in }, finalize: { _ in }, completionReceipt: { _ in receipt }, cancel: {}, submitMarkers: { _, _ in }))
            let prepared = try await registry.preparedMaterial(id: id)
            try expect(prepared.authorizationSHA256 == sha(auth.prefix(408)), "START digest is audio authorization")
            do {
                let result = try await registry.finalizeAndReceiveReceipt(id: id, lease: prepared.lease, evidence: evidence)
                try expect(receiptLength == 632 && result.receipt == receipt && result.receiptSHA256 == sha(receipt.prefix(336)), "CONFIRM requires exact dual receipt")
            } catch let error as EncryptedUploadV2MaterialRegistryError {
                try expect(receiptLength == 336 && error == .invalidReceipt, "Audio receipt alone is refused")
            }
        }
        print("PASS Apple marker host: Rust wire decoding, seven transfer integrity cases, catalog fallback and dual-receipt gating")
    }
}
