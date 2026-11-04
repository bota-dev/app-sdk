import CryptoKit
import Foundation

public enum SpeechCaptureFailure: Error, Sendable { case invalidInput, unavailable, busy, closed }
public struct SpeechCaptureSnapshot: Codable, Sendable {
    public struct Clock: Codable, Sendable { public let id: String; public let samples: UInt64; public let endKnown: Bool }
    public let captureId: String
    public let recordingId: String
    public let archiveSamples: UInt64
    public let nextSequence: Int
    public let activeClock: Bool
    public let finished: Bool
    public let clocks: [Clock]
}
/// The native host authenticates each request to its own backend. Keys and
/// ciphertext bodies must remain native, outside Dart/Pigeon/JavaScript bridges.
public protocol SpeechCaptureHost: Sendable {
    func status(captureId: String) async throws -> Data
    func upload(captureId: String, packet: Data) async throws -> Data
    func complete(captureId: String, manifest: Data) async throws -> Data
}

/// Original audio remains independent from the RTC owner. OS crypto and SQLite
/// handle bytes; shared Rust policy owns capture clocks, chains and receipts.
public actor SpeechCaptureArchive {
    /// Scoped identities, including completed receipt tombstones. Host status
    /// decides publication; file discovery never authorizes audio deletion.
    public static func list(scope: String, directory: URL) throws -> [String] { try SpeechCaptureStorage.list(scope: scope, directory: directory) }
    private struct Packet: Codable, Sendable { let nonce: String; let ciphertext: String }
    private struct Journal: Codable, Sendable {
        let scope: String
        var state: Data
        var manifest: Packet?
        var manifestSha256: String?
    }
    private struct Preparation: Decodable {
        let protocol_version: Int, profile: String, capture_id: String, recording_id: String, sample_rate: Int, channels: Int
        let format: String, cipher: String, data_key: String, maximum_chunk_samples: Int, upload_until: String
    }
    private let store: SpeechCaptureStorage
    private let keys: any SpeechCaptureKeys
    private var key: SymmetricKey?
    private var journal: Journal
    private let captureId: String
    private var closed = false
    private var published = false
    private var network: Task<Data, any Error>?
    private var call: SpeechCall<Data>?
    private var closing: Task<Void, any Error>?
    private init(store: SpeechCaptureStorage, keys: any SpeechCaptureKeys, key: SymmetricKey, journal: Journal, captureId: String) {
        self.store = store; self.keys = keys; self.key = key; self.journal = journal; self.captureId = captureId
    }
    private static func object(_ data: Data, maximum: Int = 65536) throws -> [String: Any] {
        guard data.count <= maximum, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SpeechCaptureFailure.invalidInput }
        return value
    }
    private static func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private static func policy(_ command: [String: Any]) throws -> Data { try SpeechCapturePolicy.evaluate(json(command)) }
    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func decode(_ text: String) throws -> Data {
        guard let bytes = Data(base64Encoded: text), bytes.base64EncodedString() == text else { throw SpeechCaptureFailure.invalidInput }
        return bytes
    }
    private static func aad(_ capture: String, kind: String) throws -> Data {
        let value = try object(policy(["op": "aad", "captureId": capture, "kind": kind]))
        guard let text = value["aad"] as? String else { throw SpeechCaptureFailure.invalidInput }
        return try decode(text)
    }
    private static func seal(_ bytes: Data, key: SymmetricKey, aad: Data) throws -> Packet {
        let box = try AES.GCM.seal(bytes, using: key, authenticating: aad)
        return Packet(nonce: box.nonce.withUnsafeBytes { Data($0).base64EncodedString() }, ciphertext: (box.ciphertext + box.tag).base64EncodedString())
    }
    private static func open(_ packet: Packet, key: SymmetricKey, aad: Data, maximum: Int) throws -> Data {
        let nonce = try decode(packet.nonce), bytes = try decode(packet.ciphertext)
        guard nonce.count == 12, bytes.count >= 16, bytes.count <= maximum + 16 else { throw SpeechCaptureFailure.invalidInput }
        return try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: bytes.dropLast(16), tag: bytes.suffix(16)), using: key, authenticating: aad)
    }
    private static func encrypted(_ journal: Journal, key: SymmetricKey, captureId: String) throws -> Data {
        var bytes = try JSONEncoder().encode(journal); defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard bytes.count <= 65536 else { throw SpeechCaptureFailure.invalidInput }
        return try JSONEncoder().encode(seal(bytes, key: key, aad: aad(captureId, kind: "journal")))
    }
    public static func create(scope: String, preparation: Data, directory: URL) throws -> SpeechCaptureArchive {
        try create(scope: scope, preparation: preparation, directory: directory, keys: SpeechCaptureKeychain())
    }
    static func create(scope: String, preparation: Data, directory: URL, keys: any SpeechCaptureKeys) throws -> SpeechCaptureArchive {
        guard preparation.count <= 8192 else { throw SpeechCaptureFailure.invalidInput }
        let p = try JSONDecoder().decode(Preparation.self, from: preparation)
        let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expiry = dates.date(from: p.upload_until) ?? ISO8601DateFormatter().date(from: p.upload_until)
        guard p.protocol_version == 1, p.profile == "speech_capture_pcm_v1", p.sample_rate == 48000, p.channels == 1,
              p.format == "pcm_s16le", p.cipher == "AES-256-GCM", p.maximum_chunk_samples == 48000,
              let expiry, expiry > Date() else { throw SpeechCaptureFailure.invalidInput }
        let state = try policy(["op": "create", "captureId": p.capture_id, "recordingId": p.recording_id, "retention": "original_audio_and_text"])
        let store = try SpeechCaptureStorage(scope: scope, captureId: p.capture_id, directory: directory)
        do {
            guard try store.journal() == nil, try store.receipt() == nil else { throw SpeechCaptureFailure.busy }
            var raw = try decode(p.data_key); defer { raw.resetBytes(in: 0..<raw.count) }
            guard raw.count == 32 else { throw SpeechCaptureFailure.invalidInput }
            try keys.write(store.keyId, value: raw)
            let key = SymmetricKey(data: raw), journal = Journal(scope: scope, state: state)
            try store.save(encrypted(journal, key: key, captureId: p.capture_id))
            return SpeechCaptureArchive(store: store, keys: keys, key: key, journal: journal, captureId: p.capture_id)
        } catch { store.close(); throw error }
    }
    public static func recover(scope: String, captureId: String, directory: URL) throws -> SpeechCaptureArchive {
        try recover(scope: scope, captureId: captureId, directory: directory, keys: SpeechCaptureKeychain())
    }
    static func recover(scope: String, captureId: String, directory: URL, keys: any SpeechCaptureKeys) throws -> SpeechCaptureArchive {
        let aad = try aad(captureId, kind: "journal")
        let store = try SpeechCaptureStorage(scope: scope, captureId: captureId, directory: directory)
        do {
            if try store.receipt() != nil { try keys.delete(store.keyId); throw SpeechCaptureFailure.closed }
            guard let sealed = try store.journal(), var raw = try keys.read(store.keyId), raw.count == 32 else { throw SpeechCaptureFailure.unavailable }
            defer { raw.resetBytes(in: 0..<raw.count) }
            let key = SymmetricKey(data: raw), packet = try JSONDecoder().decode(Packet.self, from: sealed)
            var plain = try open(packet, key: key, aad: aad, maximum: 65536); defer { plain.resetBytes(in: 0..<plain.count) }
            var journal = try JSONDecoder().decode(Journal.self, from: plain)
            journal.state = try policy(["op": "restore", "state": object(journal.state)])
            let snapshot = try JSONDecoder().decode(SpeechCaptureSnapshot.self, from: journal.state)
            guard journal.scope == scope, snapshot.captureId == captureId else { throw SpeechCaptureFailure.invalidInput }
            if !snapshot.finished {
                journal.state = try policy(["op": "recover", "state": object(journal.state)])
                journal = try finish(journal, key: key)
                try store.save(encrypted(journal, key: key, captureId: captureId))
            }
            return SpeechCaptureArchive(store: store, keys: keys, key: key, journal: journal, captureId: captureId)
        } catch { store.close(); throw error }
    }
    private static func finish(_ journal: Journal, key: SymmetricKey) throws -> Journal {
        if journal.manifest != nil { return journal }
        var next = journal
        let value = try object(policy(["op": "finish", "state": object(journal.state)]))
        guard let manifest = value["manifest"] as? [String: Any], let state = value["state"] as? [String: Any], let aad = value["aad"] as? String else { throw SpeechCaptureFailure.invalidInput }
        let packet = try seal(json(manifest), key: key, aad: decode(aad))
        next.state = try json(state); next.manifest = packet
        next.manifestSha256 = digest(Data((packet.nonce + "\0" + packet.ciphertext).utf8))
        return next
    }
    private func active() throws -> SymmetricKey {
        guard !closed, !published, let key else { throw SpeechCaptureFailure.closed }; return key
    }
    private func save(_ next: Journal, chunk: (sequence: Int, packet: Data, sha256: String)? = nil) throws {
        try store.save(Self.encrypted(next, key: active(), captureId: captureId), chunk: chunk); journal = next
    }
    public func snapshot() throws -> SpeechCaptureSnapshot { try JSONDecoder().decode(SpeechCaptureSnapshot.self, from: journal.state) }
    public func beginClock(_ clockId: String) throws {
        var next = journal; next.state = try Self.policy(["op": "begin_clock", "state": Self.object(journal.state), "clockId": clockId]); try save(next)
    }
    /// Copies at most one second. Call from a bounded native capture queue; its
    /// success proves atomic ciphertext/journal durability, never publication.
    public func append(firstSample: UInt64, pcm: Data) throws {
        guard !pcm.isEmpty, pcm.count <= 96000, pcm.count.isMultiple(of: 2) else { throw SpeechCaptureFailure.invalidInput }
        let value = try Self.object(Self.policy(["op": "plan", "state": Self.object(journal.state), "firstSample": firstSample, "samples": pcm.count / 2]))
        guard let header = value["header"] as? [String: Any], let sequence = header["sequence"] as? Int, let aad = value["aad"] as? String else { throw SpeechCaptureFailure.invalidInput }
        let authenticated = try Self.decode(aad), packet = try Self.seal(pcm, key: active(), aad: authenticated)
        let sha256 = try Self.digest(authenticated + Self.decode(packet.nonce) + Self.decode(packet.ciphertext))
        var next = journal; next.state = try Self.policy(["op": "commit", "state": Self.object(journal.state), "header": header, "sha256": sha256])
        let body = try Self.json(["header": header, "nonce": packet.nonce, "ciphertext": packet.ciphertext])
        try save(next, chunk: (sequence, body, sha256))
    }
    public func endClock(samples: UInt64) throws {
        var next = journal; next.state = try Self.policy(["op": "end_clock", "state": Self.object(journal.state), "samples": samples]); try save(next)
    }
    public func interruptClock() throws {
        var next = journal; next.state = try Self.policy(["op": "recover", "state": Self.object(journal.state)]); try save(next)
    }
    public func finish() throws {
        if journal.manifest != nil { return }
        try save(Self.finish(journal, key: active()))
    }
    private func request(_ work: @escaping @Sendable () async throws -> Data) async throws -> Data {
        _ = try active(); try Task.checkCancellation()
        let pending = SpeechCall<Data>(); call = pending
        defer { pending.cancel(); call = nil }
        pending.start(timing: .system(), timeout: 15000, body: work)
        let bytes = try await pending.wait()
        _ = try active(); try Task.checkCancellation()
        guard bytes.count <= 524288 else { throw SpeechCaptureFailure.invalidInput }; return bytes
    }
    public func flush(host: any SpeechCaptureHost) async throws -> Data {
        if let network { return try await network.value }
        _ = try active()
        let task = Task { try await self.upload(host) }; network = task
        defer { network = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private func upload(_ host: any SpeechCaptureHost) async throws -> Data {
        let id = captureId
        var receipt = try await request { try await host.status(captureId: id) }
        if try Self.object(receipt, maximum: 524288)["state"] as? String != "published" {
            let count = try snapshot().nextSequence
            for sequence in 0..<count {
                _ = try active(); try Task.checkCancellation()
                if try store.uploaded(sequence) { continue }
                guard let packet = try store.packet(sequence) else { throw SpeechCaptureFailure.invalidInput }
                let ack = try await request { try await host.upload(captureId: id, packet: packet) }
                let value = try Self.object(ack)
                guard value["sequence"] as? Int == sequence, value["stored"] as? Bool == true, let sha256 = value["sha256"] as? String else { throw SpeechCaptureFailure.invalidInput }
                try store.acknowledge(sequence, sha256: sha256)
            }
            if let manifest = journal.manifest, count == (try snapshot().nextSequence) {
                let bytes = try JSONEncoder().encode(manifest)
                receipt = try await request { try await host.complete(captureId: id, manifest: bytes) }
            }
        }
        if try Self.object(receipt, maximum: 524288)["state"] as? String == "published" {
            guard let sha256 = journal.manifestSha256 else { throw SpeechCaptureFailure.invalidInput }
            _ = try Self.policy(["op": "receipt", "state": Self.object(journal.state), "manifestSha256": sha256, "receipt": Self.object(receipt, maximum: 524288)])
            try store.publish(receipt); published = true; key = nil
            try keys.delete(store.keyId)
        }
        return receipt
    }
    /// Joins owned IO and releases the lock. Unpublished ciphertext is retained.
    public func close() async throws {
        if let closing { return try await closing.value }
        closed = true; network?.cancel(); call?.cancel()
        let pending = network
        let retirement = Task {
            _ = await pending?.result
            defer { self.key = nil; self.store.close() }
            if self.published { try self.keys.delete(self.store.keyId) }
        }
        closing = retirement; try await retirement.value
    }
}
