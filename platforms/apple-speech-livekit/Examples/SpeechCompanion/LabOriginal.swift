import AVFAudio
import BotaAppSDK
import BotaSpeechLiveKit
import Foundation

struct OriginalView: Sendable {
    var enabled = false, capturing = false, finished = false
    var status = "", passages: [String] = []
}
@MainActor protocol LabOriginalOwner: AnyObject, Sendable {
    var capturing: Bool { get }
    var finished: Bool { get }
    var rtcLost: Bool { get }
    nonisolated func media(_ callbacks: SpeechMediaCallbacks) throws -> any SpeechMediaPort
    func start() async throws
    func finish() async throws
    func close() async throws
}
private final class OriginalBinding: @unchecked Sendable {
    private let lock = NSLock()
    private var track: String?, lost = false
    var publication: String? { lock.withLock { track } }
    var failed: Bool { lock.withLock { lost } }
    func published(_ track: String?) { lock.withLock { self.track = track } }
    func fail() { lock.withLock { lost = true } }
}
private final class OriginalMedia: SpeechMediaPort, @unchecked Sendable {
    let port: any SpeechMediaPort, binding: OriginalBinding
    init(_ port: any SpeechMediaPort, _ binding: OriginalBinding) { self.port = port; self.binding = binding }
    func connect(grant: SpeechGrant) async throws { try await port.connect(grant: grant) }
    func silencePlayback() throws { try port.silencePlayback() }
    func muteInput() throws { try port.muteInput() }
    func clearPlayback() async throws { try await port.clearPlayback() }
    func setPlayback(tracks: [SpeechTrack]) async throws { try await port.setPlayback(tracks: tracks) }
    func setInput(enabled: Bool) async throws {
        do { try await port.setInput(enabled: enabled); if enabled { binding.published(try port.inputPublication()) } }
        catch { binding.fail(); throw error }
    }
    var supportsSourceFinish: Bool { port.supportsSourceFinish }
    func holdInput() throws { try port.holdInput() }
    func inputPublication() throws -> String? { try port.inputPublication() }
    func resumeAudio() async throws { try await port.resumeAudio() }
    func close() async throws { try await port.close() }
}

/// Native foreground coordinator shared by the Apple and Flutter companions.
/// RTC failure does not close the microphone, encrypted archive or upload owner.
@MainActor final class LabOriginal: LabOriginalOwner {
    private struct TextPage { var after = 0, digest: String?, text: [String] = [], done = false }
    private let host: LabHost, joined: LabJoin
    private let directory: URL, identity: String
    private let update: @MainActor (OriginalView) -> Void
    nonisolated private let input: ExternalPCMInput
    nonisolated private let binding = OriginalBinding()
    private var archives: [String: SpeechCaptureArchive] = [:]
    private var completed: [String: TextPage] = [:]
    private var archive: SpeechCaptureArchive?
    private var captureId: String?
    private var microphone: SpeechMicrophoneCapture?
    private var starting: Task<SpeechMicrophoneCapture, any Error>?
    private var expiry: Date, worker: UInt32
    private var bound: String?
    private var polling: Task<Void, Never>?
    private var retirement: Task<Void, any Error>?
    private var route: OriginalAudioRoute?
    private var closed = false
    private var view = OriginalView(enabled: true)
    var capturing: Bool { view.capturing }
    var finished: Bool { view.finished }
    var rtcLost: Bool { binding.failed }
    private init(host: LabHost, joined: LabJoin, directory: URL, update: @escaping @MainActor (OriginalView) -> Void) throws {
        self.host = host; self.joined = joined; self.directory = directory; self.update = update
        let context = joined.configuration.context
        identity = String(data: try JSONSerialization.data(withJSONObject: [context.projectId, context.sessionId,
            context.participantId, context.memberGeneration]), encoding: .utf8)!
        input = try ExternalPCMInput(participantId: context.participantId, memberGeneration: context.memberGeneration)
        expiry = try Self.date(joined.grant.expiresAt); worker = joined.grant.workerGeneration
    }
    static func create(host: LabHost, joined: LabJoin, update: @escaping @MainActor (OriginalView) -> Void) async throws -> LabOriginal {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw LabFailure.unavailable }
        let owner = try LabOriginal(host: host, joined: joined, directory: directory.appendingPathComponent("BotaSpeechCompanion"), update: update)
        do { try await owner.prepare(); return owner }
        catch { try await owner.close(); throw error }
    }
    private static func date(_ text: String) throws -> Date {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let value = parser.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { throw LabFailure.unavailable }
        return value
    }
    private func show(_ status: String, passages: [String]? = nil) {
        view.status = status; if let passages { view.passages = passages }; update(view)
    }
    private func prepare() async throws {
        let scope = identity, directory = directory
        let ids = try await Task.detached { try SpeechCaptureArchive.list(scope: scope, directory: directory) }.value
        for id in ids {
            do { archives[id] = try await Task.detached { try SpeechCaptureArchive.recover(scope: scope, captureId: id, directory: directory) }.value }
            catch SpeechCaptureFailure.closed { completed[id] = TextPage() }
            catch { show("An existing encrypted original needs recovery and is retained on this phone.") }
        }
        let id = UUID().uuidString.lowercased(); captureId = id
        let prepared = try await host.prepareCapture(id)
        let acquired = try await Task.detached { try SpeechCaptureArchive.create(scope: scope, preparation: prepared, directory: directory) }.value
        archive = acquired; archives[id] = acquired
        try Task.checkCancellation()
        route = try OriginalAudioRoute()
        await host.observeRenewal { [weak self] grant in Task { @MainActor in
            guard let self else { return }
            do { try await self.renew(grant) } catch { await self.failure(error) }
        } }
        show("Original audio will be encrypted on this phone when you start the microphone.")
        polling = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard let self else { return }
                do { try await poll() } catch { await failure(error) }
            }
        }
    }
    private func renew(_ grant: SpeechGrant) async throws {
        guard !closed else { return }
        let context = joined.configuration.context
        guard grant.sessionId == context.sessionId, grant.participantId == context.participantId, grant.memberGeneration == context.memberGeneration else {
            try await finish(); return
        }
        expiry = try Self.date(grant.expiresAt); worker = grant.workerGeneration
        if view.capturing { try microphone?.renew(expiresAt: expiry) }
    }
    nonisolated func media(_ callbacks: SpeechMediaCallbacks) throws -> any SpeechMediaPort {
        let binding = binding
        let observed = SpeechMediaCallbacks(text: callbacks.text, trackRemoved: callbacks.trackRemoved,
            disconnected: { binding.fail(); callbacks.disconnected() }, failed: { binding.fail(); callbacks.failed() }, playbackBlocked: callbacks.playbackBlocked)
        return OriginalMedia(try LiveKitSpeechMedia.createExternal(callbacks: observed, input: input), binding)
    }
    func start() async throws {
        guard !closed, !view.finished, microphone == nil, starting == nil, expiry > Date(), let archive else { throw LabFailure.closed }
        input.setMuted(false)
        let input = input, expiry = expiry
        let task = Task {
            try await SpeechMicrophoneCapture.start(archive: archive, expiresAt: expiry, rtcFrame: { _ = input.offer(pcm16LE: $0) }, ended: { [weak self] reason in
                Task { @MainActor in
                    guard let self else { return }
                    self.view.capturing = false
                    do { try await archive.finish() } catch { await self.failure(error) }
                    self.view.finished = true
                    if !self.closed { self.show(reason == .interrupted ? "Capture was interrupted; its unknown tail is preserved." : "Microphone stopped. Original upload can continue.") }
                }
            })
        }
        starting = task; defer { starting = nil }
        let acquired = try await task.value
        guard !closed else { try await acquired.interruptAndStop(); throw LabFailure.closed }
        microphone = acquired
        if !view.finished { view.capturing = true; show("Recording an encrypted original. Live captions remain provisional.") }
    }
    func finish() async throws {
        if let starting { microphone = try await starting.value }
        try await microphone?.stop(); _ = await input.drain(); input.setMuted(true)
        if let archive, !(try await archive.snapshot().finished) { try await archive.finish() }
        view.capturing = false; view.finished = true
        if !closed { show("Microphone stopped. Original retained until verified publication.") }
    }
    private func failure(_ error: any Error) async {
        guard !(error is CancellationError), !closed else { return }
        if let denied = error as? SpeechHostFailure, denied == .unauthorized {
            try? await finish(); show("Authorization ended. Encrypted original remains on this phone.", passages: [])
        } else { show("Encrypted original retained on this phone. Upload will retry while this screen is open.") }
    }
    private struct Receipt: Decodable { let state: String; let capture_complete: Bool? }
    private struct Transcript: Decodable {
        struct Segment: Decodable {
            struct Span: Decodable { let clockId: String; let firstSample: UInt64; let samples: UInt64 }
            let text: String; let captureIntervals: [Span]; let crossesDiscontinuity: Bool
        }
        let alignment: String, state: String?, result_sha256: String?, next_segment: Int?, has_more: Bool?, capture_complete: Bool?, segments: [Segment]?
    }
    private func poll() async throws {
        guard !closed else { return }
        if let track = binding.publication, bound != track, let id = captureId {
            do { try await host.bindCapture(id, worker: worker, track: track); bound = track }
            catch { if let denied = error as? SpeechHostFailure, denied == .unauthorized { await failure(error) } }
        }
        for (id, retained) in archives {
            do {
                let value = try await retained.flush(host: host.capture(id))
                let receipt = try JSONDecoder().decode(Receipt.self, from: value)
                if receipt.state == "published" {
                    try await retained.close(); archives[id] = nil; completed[id] = TextPage()
                    show(receipt.capture_complete == true ? "Original audio verified. Waiting for aligned text." : "Original verified with gaps or an unknown tail. Waiting for aligned text.")
                } else if receipt.state == "verification_failed" { show("Original verification failed. Encrypted audio is retained.") }
            } catch { await failure(error) }
        }
        for (id, old) in completed where !old.done {
            var page = old
            let bytes = try await host.captureTranscript(id, after: page.after, digest: page.digest)
            let result = try JSONDecoder().decode(Transcript.self, from: bytes)
            if result.alignment == "no_audio" { page.done = true; completed[id] = page; show("No audio was captured.", passages: []); continue }
            if result.alignment == "unverified" || result.state == "failed" {
                show("Original verified. Aligned text is unavailable; transcription needs attention.", passages: []); continue
            }
            guard result.alignment == "verified_original" else { continue }
            guard let digest = result.result_sha256, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let next = result.next_segment, let more = result.has_more, next >= page.after, next > page.after || !more,
                  page.digest == nil || page.digest == digest, let segments = result.segments, segments.count <= 20 else { throw LabFailure.unavailable }
            for segment in segments {
                guard (1...512).contains(segment.captureIntervals.count), segment.text.utf8.count <= 65536,
                      segment.captureIntervals.allSatisfy({ $0.firstSample <= 345600000 && $0.samples <= 345600000 - $0.firstSample }) else { throw LabFailure.unavailable }
                let times = segment.captureIntervals.prefix(4).map { span in
                    "\(span.clockId.prefix(8)) · \(Double(span.firstSample) / 48000)–\(Double(span.firstSample + span.samples) / 48000) s"
                }.joined(separator: ", ")
                let preview = String(decoding: segment.text.utf8.prefix(4096), as: UTF8.self)
                page.text.append("\(times)\(segment.crossesDiscontinuity ? " · crosses a capture gap" : "")\n\(preview)\(segment.text.utf8.count > 4096 ? "…" : "")")
            }
            page.text = Array(page.text.suffix(64)); page.after = next; page.digest = digest; page.done = !more; completed[id] = page
            show(page.done && page.text.isEmpty ? "Original verified. No speech was recognized." :
                "Final text aligned to verified original samples\(result.capture_complete == true ? "." : "; gaps or an unknown tail remain.")", passages: page.text)
        }
    }
    func close() async throws {
        if let retirement { return try await retirement.value }
        closed = true; polling?.cancel()
        let task = Task {
            await polling?.value
            var failed = false
            do { try await finish() } catch { failed = true }
            for retained in archives.values { do { try await retained.close() } catch { failed = true } }
            archives.removeAll()
            do { try route?.close() } catch { failed = true }; route = nil
            if failed { throw LabFailure.unavailable }
        }
        retirement = task; try await task.value
    }
}

/// Only the standalone companion owns global audio routing; reusable capture
/// requires the host to supply its own audio session and preserves its settings.
@MainActor private final class OriginalAudioRoute {
    #if os(iOS)
    private static var held = false
    private let session = AVAudioSession.sharedInstance()
    private let prior: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)
    private let options: AVAudioSession.CategoryOptions
    init() throws {
        guard !Self.held else { throw LabFailure.conflict }
        prior = (session.category, session.mode, session.categoryOptions)
        #if compiler(>=6.2)
        options = [.allowBluetoothHFP]
        #else
        options = [.allowBluetooth]
        #endif
        Self.held = true
        do { try session.setCategory(.playAndRecord, mode: .voiceChat, options: options); try session.setActive(true) }
        catch { try? close(); throw error }
    }
    func close() throws {
        guard session.category == .playAndRecord, session.mode == .voiceChat, session.categoryOptions == options else { throw LabFailure.unavailable }
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(prior.0, mode: prior.1, options: prior.2)
        Self.held = false
    }
    #else
    init() throws {}
    func close() throws {}
    #endif
}
