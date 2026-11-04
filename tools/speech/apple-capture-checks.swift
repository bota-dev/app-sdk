import Foundation
import CryptoKit
import AVFAudio

private final class MemoryCaptureKeys: SpeechCaptureKeys, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    var count: Int { lock.withLock { values.count } }
    func read(_ id: String) throws -> Data? { lock.withLock { values[id] } }
    func write(_ id: String, value: Data) throws { lock.withLock { values[id] = value } }
    func delete(_ id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}
private actor ReceiptCaptureHost: SpeechCaptureHost {
    private var receipt: Data?
    private let clock: String
    private var pcm = Data()
    func original() -> Data { pcm }
    init(clock: String) { self.clock = clock }
    func status(captureId: String) async throws -> Data { receipt ?? Data("{\"state\":\"open\"}".utf8) }
    func upload(captureId: String, packet: Data) async throws -> Data {
        func policy(_ value: [String: Any]) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: SpeechCapturePolicy.evaluate(JSONSerialization.data(withJSONObject: value))) as! [String: Any]
        }
        let initial = try policy(["op": "create", "captureId": captureId, "recordingId": "rec_fixture", "retention": "original_audio_and_text"])
        let active = try policy(["op": "begin_clock", "state": initial, "clockId": clock])
        let value = try JSONSerialization.jsonObject(with: packet) as! [String: Any]
        let header = value["header"] as! [String: Any]
        let plan = try policy(["op": "plan", "state": active, "firstSample": header["firstSample"]!, "samples": header["samples"]!])
        let proof = Data(base64Encoded: plan["aad"] as! String)! + Data(base64Encoded: value["nonce"] as! String)! + Data(base64Encoded: value["ciphertext"] as! String)!
        let ciphertext = Data(base64Encoded: value["ciphertext"] as! String)!
        pcm.append(try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(base64Encoded: value["nonce"] as! String)!),
            ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16)), using: SymmetricKey(data: Data(repeating: 7, count: 32)),
            authenticating: Data(base64Encoded: plan["aad"] as! String)!))
        let sha = SHA256.hash(data: proof).map { String(format: "%02x", $0) }.joined()
        return try JSONSerialization.data(withJSONObject: ["sequence": 0, "sha256": sha, "stored": true])
    }
    func complete(captureId: String, manifest: Data) async throws -> Data {
        let packet = try JSONSerialization.jsonObject(with: manifest) as! [String: String]
        let sha = SHA256.hash(data: Data((packet["nonce"]! + "\0" + packet["ciphertext"]!).utf8)).map { String(format: "%02x", $0) }.joined()
        let result = try JSONSerialization.data(withJSONObject: ["profile": "speech_capture_pcm_v1", "capture_id": captureId,
            "recording_id": "wrong_recording", "state": "published", "audio_verification": "verified", "archive_samples": pcm.count / 2,
            "manifest_sha256": sha, "content_sha256": String(repeating: "ab", count: 32)])
        receipt = result; return result
    }
    func correct() throws {
        var value = try JSONSerialization.jsonObject(with: receipt!) as! [String: Any]
        value["recording_id"] = "rec_fixture"; receipt = try JSONSerialization.data(withJSONObject: value)
    }
}
private actor PausedCaptureHost: SpeechCaptureHost {
    private var entered = false
    private var entry: CheckedContinuation<Void, Never>?
    private var reply: CheckedContinuation<Data, Never>?
    func status(captureId: String) async throws -> Data {
        entered = true; entry?.resume(); entry = nil
        return await withCheckedContinuation { reply = $0 }
    }
    func wait() async { if !entered { await withCheckedContinuation { entry = $0 } } }
    func release() { reply?.resume(returning: Data("{\"state\":\"open\"}".utf8)); reply = nil }
    func upload(captureId: String, packet: Data) async throws -> Data { fatalError("Unexpected upload") }
    func complete(captureId: String, manifest: Data) async throws -> Data { fatalError("Unexpected completion") }
}
private actor PausedCaptureSink: SpeechCaptureSink {
    var positions: [UInt64] = []
    var ended: UInt64?
    var release: CheckedContinuation<Void, Never>?
    var entered: CheckedContinuation<Void, Never>?
    var paused = false
    func begin(_ clock: String) {}
    func append(_ first: UInt64, _ bytes: Data) async throws {
        if positions.isEmpty {
            paused = true; entered?.resume(); entered = nil
            await withCheckedContinuation { release = $0 }
        }
        guard bytes.count == 96000, bytes.first == 7 else { fatalError("Borrowed PCM changed") }
        positions.append(first)
    }
    func waitForWrite() async { if !paused { await withCheckedContinuation { entered = $0 } } }
    func resume() { release?.resume(); release = nil }
    func end(_ samples: UInt64) { ended = samples }
    func interrupt() { fatalError("Known EOF was lost") }
    func verify() {
        guard positions == [0, 48000, 96000, 144000], ended == 336000 else { fatalError("Unbounded disk queue or lost capture gap") }
    }
}
@main private struct AppleCaptureChecks {
    static func vector(_ path: String) throws {
        let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard hash == "4554c3bcadcf7a54e01ad34edd07b3b97e1cc8276e0b1d0b4fbb795c37035009" else { fatalError("Canonical vector drift") }
        let fixture = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let key = SymmetricKey(data: Data(base64Encoded: fixture["key"] as! String)!)
        func decrypt(_ packet: [String: Any], _ aad: String) throws -> Data {
            let ciphertext = Data(base64Encoded: packet["ciphertext"] as! String)!
            return try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(base64Encoded: packet["nonce"] as! String)!),
                ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16)), using: key, authenticating: Data(base64Encoded: aad)!)
        }
        for chunk in fixture["chunks"] as! [[String: Any]] {
            let packet = chunk["packet"] as! [String: Any], header = packet["header"] as! [String: Any]
            let plain = try decrypt(packet, chunk["aad"] as! String)
            guard plain.map({ String(format: "%02x", $0) }).joined() == chunk["pcmHex"] as! String else { fatalError("PCM mismatch") }
            let created = try SpeechCapturePolicy.evaluate(JSONSerialization.data(withJSONObject: ["op": "create", "captureId": fixture["captureId"]!,
                "recordingId": fixture["recordingId"]!, "retention": "original_audio_and_text"]))
            let initial = try JSONSerialization.jsonObject(with: created)
            let active = try SpeechCapturePolicy.evaluate(JSONSerialization.data(withJSONObject: ["op": "begin_clock", "state": initial, "clockId": header["clockId"]!]))
            if header["sequence"] as! Int == 0 {
                let planned = try SpeechCapturePolicy.evaluate(JSONSerialization.data(withJSONObject: ["op": "plan", "state": JSONSerialization.jsonObject(with: active),
                    "firstSample": header["firstSample"]!, "samples": header["samples"]!]))
                guard (try JSONSerialization.jsonObject(with: planned) as! [String: Any])["aad"] as! String == chunk["aad"] as! String else { fatalError("Native AAD mismatch") }
            }
        }
        let manifest = fixture["manifest"] as! [String: Any]
        guard try decrypt(manifest["packet"] as! [String: Any], manifest["aad"] as! String).base64EncodedString() == manifest["plaintext"] as! String else { fatalError("Manifest mismatch") }
    }
    static func main() async throws {
        try vector(CommandLine.arguments[2])
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), keys = MemoryCaptureKeys()
        let capture = "10000000-0000-4000-8000-000000000001", clock = "20000000-0000-4000-8000-000000000001"
        let preparation = try JSONSerialization.data(withJSONObject: ["protocol_version": 1, "profile": "speech_capture_pcm_v1",
            "capture_id": capture, "recording_id": "rec_fixture", "sample_rate": 48000, "channels": 1,
            "format": "pcm_s16le", "cipher": "AES-256-GCM", "maximum_chunk_samples": 48000,
            "upload_until": "2099-01-01T00:00:00Z", "data_key": Data(repeating: 7, count: 32).base64EncodedString()] as [String: Any])
        let archive = try SpeechCaptureArchive.create(scope: "synthetic-owner", preparation: preparation, directory: root, keys: keys)
        try await archive.beginClock(clock)
        try await archive.append(firstSample: 4, pcm: Data([1, 0, 2, 0]))
        do {
            _ = try SpeechCaptureArchive.recover(scope: "synthetic-owner", captureId: capture, directory: root, keys: keys)
            fatalError("Concurrent capture ownership was accepted")
        } catch { }
        try await archive.close()
        let recovered = try SpeechCaptureArchive.recover(scope: "synthetic-owner", captureId: capture, directory: root, keys: keys)
        let snapshot = try await recovered.snapshot()
        guard snapshot.finished, snapshot.archiveSamples == 2 else { fatalError("Lost durable capture") }
        guard snapshot.clocks.first?.endKnown == false else { fatalError("Crash tail was invented") }
        try await recovered.close()
        let receiptKeys = MemoryCaptureKeys()
        var receiptArchive = try SpeechCaptureArchive.create(scope: "receipt-owner", preparation: preparation, directory: root, keys: receiptKeys)
        try await receiptArchive.beginClock(clock); try await receiptArchive.append(firstSample: 0, pcm: Data([9, 0]))
        try await receiptArchive.endClock(samples: 1); try await receiptArchive.finish()
        let receiptHost = ReceiptCaptureHost(clock: clock)
        do { _ = try await receiptArchive.flush(host: receiptHost); fatalError("Foreign receipt deleted original") } catch {}
        guard receiptKeys.count == 1 else { fatalError("Wrong receipt deleted key") }
        try await receiptArchive.close()
        receiptArchive = try SpeechCaptureArchive.recover(scope: "receipt-owner", captureId: capture, directory: root, keys: receiptKeys)
        try await receiptHost.correct(); _ = try await receiptArchive.flush(host: receiptHost)
        guard receiptKeys.count == 0 else { fatalError("Verified original retained key") }
        try await receiptArchive.close()
        let stored = try SpeechCaptureStorage(scope: "receipt-owner", captureId: capture, directory: root)
        guard try stored.packet(0) == nil, try stored.journal() == nil, try stored.receipt() != nil else { fatalError("Receipt deletion was not atomic") }
        stored.close()
        do { _ = try SpeechCaptureArchive.create(scope: "receipt-owner", preparation: preparation, directory: root, keys: receiptKeys)
            fatalError("Receipt tombstone reused") } catch {}
        let lateKeys = MemoryCaptureKeys()
        let late = try SpeechCaptureArchive.create(scope: "late-http", preparation: preparation, directory: root, keys: lateKeys)
        let host = PausedCaptureHost(), pending = Task { try await late.flush(host: host) }
        await host.wait()
        let started = Date(); try await late.close()
        guard Date().timeIntervalSince(started) < 2, lateKeys.count == 1 else { fatalError("Close waited for uncooperative HTTP or deleted original") }
        await host.release()
        do { _ = try await pending.value; fatalError("Late HTTP completion survived close") } catch {}
        let retry = try SpeechCaptureArchive.recover(scope: "late-http", captureId: capture, directory: root, keys: lateKeys)
        try await retry.close()
        let conversionArchive = try SpeechCaptureArchive.create(scope: "converted-original", preparation: preparation, directory: root, keys: MemoryCaptureKeys())
        let convertedPump = try await SpeechCapturePump.start(archive: conversionArchive)
        let convertedClock = try await conversionArchive.snapshot().clocks[0].id
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
        let converter = try SpeechCaptureConversion(format: format)
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
        input.frameLength = 480
        for channel in 0..<2 { for frame in 0..<480 { input.floatChannelData![channel][frame] = Float(frame % 32) / 64 } }
        var rtc = Data()
        func fork(_ bytes: Data) -> Bool { guard convertedPump.offer(bytes) else { return false }; rtc.append(bytes); return true }
        guard converter.convert(input, final: false, consume: fork), converter.convert(nil, final: true, consume: fork),
              rtc.count == 960, rtc.contains(where: { $0 != 0 }) else { fatalError("Native conversion failed to produce canonical PCM") }
        try await convertedPump.stop(endKnown: true); try await conversionArchive.finish()
        let convertedHost = ReceiptCaptureHost(clock: convertedClock)
        do { _ = try await conversionArchive.flush(host: convertedHost); fatalError("Foreign receipt accepted") } catch {}
        guard await convertedHost.original() == rtc else { fatalError("RTC conversion diverged from encrypted original") }
        try await conversionArchive.close()
        let sink = PausedCaptureSink()
        let pump = try await SpeechCapturePump.start(sink: sink, clock: clock)
        var pcm = Data(repeating: 7, count: 96000)
        guard pump.offer(pcm) else { fatalError("Capture rejected") }
        await sink.waitForWrite()
        for _ in 0..<6 { guard pump.offer(pcm) else { fatalError("Bounded drop stopped capture") } }
        pcm.resetBytes(in: 0..<pcm.count)
        let stop = Task { try await pump.stop(endKnown: true) }
        await sink.resume(); try await stop.value
        await sink.verify()
        guard !pump.offer(Data([0, 0])) else { fatalError("Late capture accepted") }
        try await pump.stop(endKnown: true)
        print("PASS Apple encrypted capture atomic persistence, exclusive ownership and crash recovery")
        print("PASS Apple bounded capture writes, original sample gaps and joined stop")
        print("PASS Apple CryptoKit and Rust ABI canonical capture vector")
        print("PASS Apple exact-receipt deletion, tombstone isolation and late HTTP fencing")
        print("PASS Apple actual AVAudioConverter PCM matches decrypted original bytes")
    }
}
