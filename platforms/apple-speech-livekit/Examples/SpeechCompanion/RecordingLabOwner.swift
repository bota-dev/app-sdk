import BotaAppSDK
import Foundation

struct RecordingCleanupFailure: Error {}

/// Native foreground admission and archival for the direct recording protocol.
/// No project key, grant, archive key or PCM crosses an App presentation bridge.
@MainActor
final class RecordingLabOwner: RecordingSpeechConnection {
    private let origin: URL, activityId: String, transport: any LabTransport
    private var code: String
    private let status: @Sendable (String) -> Void
    private var live: RecordingSpeechMicrophoneSession?
    private var originalOnly: SpeechMicrophoneCapture?
    private var route: OriginalAudioRoute?
    private var archives: [String: SpeechCaptureArchive] = [:]
    private struct Page { var after = 0; var digest: String?; var passages: [String] = []; var done = false }
    private var completed: [String: Page] = [:]
    private var polling: Task<Void, Never>?
    private var closing: Task<Void, any Error>?
    private var closed = false
    private(set) var originalView = OriginalView()
    private init(origin: URL, code: String, activityId: String, transport: any LabTransport, status: @escaping @Sendable (String) -> Void) {
        self.origin = origin; self.code = code; self.activityId = activityId; self.transport = transport; self.status = status
    }
    static func start(origin: URL, code: String, activityId: String, target: String, retention: String,
        headphones: @escaping @Sendable () -> Bool, caption: @escaping @Sendable (Data) -> Void,
        status: @escaping @Sendable (String) -> Void, transport: any LabTransport = NativeLabTransport()) async throws -> RecordingLabOwner {
        guard origin.scheme == "http", origin.host == "127.0.0.1", origin.user == nil, origin.password == nil,
              origin.path.isEmpty, origin.query == nil, origin.fragment == nil, (1...65535).contains(origin.port ?? 80),
              code.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil,
              UUID(uuidString: activityId)?.uuidString.lowercased() == activityId,
              ["en","zh","ja","ko","es","fr","de"].contains(target), ["original_audio_and_text","text_only","live_only"].contains(retention) else {
            transport.close(); throw LabFailure.invalidConfiguration
        }
        let owner = RecordingLabOwner(origin: origin, code: code, activityId: activityId, transport: transport, status: status)
        do { try await owner.prepare(target: target, retention: retention, headphones: headphones, caption: caption); return owner }
        catch {
            do { try await owner.close() } catch { throw RecordingCleanupFailure() }
            throw error
        }
    }
    private func request(_ action: String, _ body: [String: Any]) async throws -> Data {
        guard !closed else { throw LabFailure.closed }
        var request = URLRequest(url: origin.appendingPathComponent("recording-host/" + action), cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue(code, forHTTPHeaderField: "X-Recording-Code")
        let response = try await transport.send(request); try Task.checkCancellation()
        guard !closed, (200...299).contains(response.status), response.body.count <= 524288 else { throw LabFailure.unavailable }
        return response.body
    }
    private struct CaptureHost: SpeechCaptureHost {
        let owner: RecordingLabOwner, id: String
        func status(captureId: String) async throws -> Data { try await owner.capture("status", expected: id, id: captureId) }
        func upload(captureId: String, packet: Data) async throws -> Data { try await owner.capture("chunk", expected: id, id: captureId, packet: packet) }
        func complete(captureId: String, manifest: Data) async throws -> Data { try await owner.capture("complete", expected: id, id: captureId, packet: manifest) }
    }
    private func capture(_ action: String, expected: String, id: String, packet: Data? = nil) async throws -> Data {
        guard id == expected else { throw LabFailure.conflict }
        var body: [String: Any] = ["captureId": id]
        if let packet { body["packet"] = try JSONSerialization.jsonObject(with: packet) }
        return try await request("capture_" + action, body)
    }
    private func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LabFailure.unavailable }; return value
    }
    private func prepare(target: String, retention: String, headphones: @escaping @Sendable () -> Bool,
                         caption: @escaping @Sendable (Data) -> Void) async throws {
        let clock = UUID().uuidString.lowercased(), original = retention == "original_audio_and_text"
        var body: [String: Any] = ["activityId": activityId, "clockId": clock, "targetLanguage": target, "sourceLanguage": "multi", "retention": retention]
        if original { body["captureId"] = UUID().uuidString.lowercased() }
        var admission = try object(await request("start", body))
        guard admission["clockId"] as? String == clock, let activity = admission["activity"] as? [String: Any], activity["id"] as? String == activityId,
              let scope = admission["scope"] as? String, !scope.isEmpty, scope.utf8.count <= 512,
              let expiration = activity["expires_at"] as? String,
              let expiry = Self.date(expiration), expiry > Date() else { throw LabFailure.unavailable }
        originalView.enabled = original
        var archive: SpeechCaptureArchive?
        if original {
            guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw LabFailure.unavailable }
            let directory = root.appendingPathComponent("BotaRecordingSpeech")
            let retained: [String]
            do { retained = try SpeechCaptureArchive.list(scope: scope, directory: directory) }
            catch { retained = []; originalView.status = "Earlier original storage could not be opened." }
            for id in retained {
                do { archives[id] = try SpeechCaptureArchive.recover(scope: scope, captureId: id, directory: directory) }
                catch SpeechCaptureFailure.closed { completed[id] = Page() }
                catch { originalView.status = "An encrypted original needs recovery and is retained." }
            }
            guard let preparation = admission["prepared"] as? [String: Any], let id = preparation["capture_id"] as? String else { throw LabFailure.unavailable }
            var bytes = try JSONSerialization.data(withJSONObject: preparation)
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            do { archive = try SpeechCaptureArchive.create(scope: scope, preparation: bytes, directory: directory); archives[id] = archive }
            catch { status("archive_unavailable"); originalView.status = "Original storage unavailable. Live captions continue." }
            admission.removeValue(forKey: "prepared")
        }
        route = try OriginalAudioRoute()
        var configuration = try JSONSerialization.data(withJSONObject: admission["configuration"] as Any)
        var grant = try JSONSerialization.data(withJSONObject: admission["grant"] as Any)
        defer { configuration.resetBytes(in: 0..<configuration.count); grant.resetBytes(in: 0..<grant.count) }
        do { live = try await RecordingSpeechMicrophoneSession.start(configurationJSON: configuration, grantJSON: grant, clockId: clock, expiresAt: expiry,
            archive: archive, headphoneRoute: headphones, onCaption: caption, onStatus: status) }
        catch is RecordingSpeechCleanupFailure { throw RecordingCleanupFailure() }
        catch is CancellationError { throw CancellationError() }
        catch {
            status("interrupted")
            let report = status
            originalOnly = try await SpeechMicrophoneCapture.start(archive: archive, expiresAt: expiry, clockId: clock,
                onArchiveError: { report("archive_unavailable") }, ended: { if $0 != .stopped { report("capture_interrupted") } })
        }
        originalView.capturing = true
        polling = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard let self, !self.closed else { return }; await self.poll()
            }
        }
    }
    private static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: text) { return value }; formatter.formatOptions = [.withInternetDateTime]; return formatter.date(from: text)
    }
    private func poll() async {
        for (id, archive) in archives {
            if closed { return }
            do {
                let value = try object(await archive.flush(host: CaptureHost(owner: self, id: id)))
                if value["state"] as? String == "published" { try await archive.close(); archives[id] = nil; completed[id] = Page(); originalView.status = "Original verified. Final text is pending." }
            } catch { if !closed { originalView.status = "Encrypted original retained. Upload will retry while this activity is open." } }
        }
        for (id, var page) in completed {
            if closed { return }; if page.done { continue }
            do {
                var body: [String: Any] = ["captureId": id, "afterSegment": page.after]; if let digest = page.digest { body["resultSha256"] = digest }
                let value = try object(await request("capture_transcript", body))
                if value["alignment"] as? String == "no_audio" || ["failed","unavailable"].contains(value["state"] as? String ?? "") {
                    page.done = true; completed[id] = page; originalView.passages = []; originalView.status = "Final original text is unavailable."; continue
                }
                guard value["alignment"] as? String == "verified_original", value["state"] as? String == "completed" else { continue }
                guard let digest = value["result_sha256"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      let next = value["next_segment"] as? Int, let more = value["has_more"] as? Bool, next >= page.after, !more || next > page.after,
                      page.digest == nil || page.digest == digest, let segments = value["segments"] as? [[String: Any]], let state = value["final_translation"] as? String else { throw LabFailure.unavailable }
                page.digest = digest; page.after = next
                for segment in segments {
                    guard let text = segment["text"] as? String else { throw LabFailure.unavailable }
                    let translations = (segment["translation_units"] as? [[String: Any]] ?? []).map { unit in
                        "[\(unit["targetLanguage"] as? String ?? ""); revision \(unit["revision"] as? Int ?? 0)] \(unit["targetText"] as? String ?? unit["state"] as? String ?? "pending")"
                    }
                    page.passages.append(text + "\n" + translations.joined(separator: "\n"))
                }
                page.passages = Array(page.passages.suffix(64)); originalView.passages = page.passages
                originalView.status = "Final source \(digest.prefix(12)); translation \(state)"
                if !more { page.done = ["completed","failed"].contains(state); if !page.done { page.after = 0; page.passages = [] } }
            } catch { page.after = 0; page.digest = nil; page.passages = []; originalView.passages = []; originalView.status = "Refreshing final original text." }
            completed[id] = page
        }
    }
    func changeTarget(language: String, requestId: String) async throws { guard let live else { throw LabFailure.unavailable }; try await live.changeTarget(language: language, requestId: requestId) }
    func qualifyHeadphones() async throws -> Bool { try await live?.qualifyHeadphones() ?? false }
    func finish() async throws {
        defer { originalView.capturing = false; originalView.finished = true }
        do { if let live { try await live.finish() } else { try await originalOnly?.stop() } }
        catch { _ = try? await request("end", ["activityId": activityId]); throw error }
        _ = try await request("end", ["activityId": activityId])
    }
    func close() async throws {
        if let closing { return try await closing.value }
        closed = true; transport.close(); polling?.cancel()
        let task = Task { @MainActor in
            await polling?.value
            var failure: (any Error)?
            do { try await live?.close(); try await originalOnly?.interruptAndStop() } catch { failure = error }
            for archive in archives.values { do { try await archive.close() } catch { failure = error } }
            do { try route?.close() } catch { failure = error }
            code = ""; if let failure { throw failure }
        }
        closing = task; try await task.value
    }
}
