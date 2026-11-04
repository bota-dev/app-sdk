import BotaAppSDK
import BotaSpeechLiveKit
import Foundation

/// The synchronous bridge fences use the native media port's thread-safe controls.
/// The queue holds bounded metadata only; it never carries PCM or archive keys.
private final class ReactNativeMediaBox: @unchecked Sendable {
    private let lock = NSLock()
    private var port: (any SpeechMediaPort)?, handle: String?
    private var closed = false, overflow = false
    private var queue: [Data] = [], bytes = 0
    func install(_ port: any SpeechMediaPort) -> String {
        lock.withLock { self.port = port; let id = UUID().uuidString; handle = id; return id }
    }
    func current(_ id: String) throws -> any SpeechMediaPort {
        try lock.withLock { guard handle == id, !closed, let port else { throw LabFailure.closed }; return port }
    }
    func offer(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        let failed: (any SpeechMediaPort)? = lock.withLock {
            guard !closed, !overflow else { return nil }
            guard queue.count < 32, data.count <= 70000, bytes + data.count <= 450000 else {
                overflow = true; queue.removeAll(); bytes = 0; return port
            }
            queue.append(data); bytes += data.count; return nil
        }
        if let failed { try? failed.silencePlayback(); try? failed.muteInput() }
    }
    func fence(_ id: String, _ action: String) -> Bool {
        guard lock.withLock({ handle == id }) else { return false }
        if lock.withLock({ closed }) { return true }
        do {
            let port = try current(id)
            switch action { case "silence": try port.silencePlayback(); case "mute": try port.muteInput()
            case "hold": try port.holdInput(); default: return false }
            return true
        } catch { return lock.withLock { closed } }
    }
    func events(_ id: String) throws -> String {
        try lock.withLock {
            guard handle == id else { throw LabFailure.closed }
            if closed { return "[]" }
            if overflow { return "[{\"type\":\"failed\"}]" }
            let result = "[" + queue.map { String(decoding: $0, as: UTF8.self) }.joined(separator: ",") + "]"
            queue.removeAll(); bytes = 0; return result
        }
    }
    func retire(_ id: String) throws -> (any SpeechMediaPort)? {
        try lock.withLock {
            guard handle == id else { throw LabFailure.closed }; closed = true; queue.removeAll(); bytes = 0
            let value = port; port = nil; return value
        }
    }
}

/// App-owned native IO. RN executes shared session policy as generated JS; this
/// owner composes only native media, original capture, durable storage and HTTP.
@MainActor final class ReactNativeLabOwner {
    private let host: LabHost
    private let mediaFactory: @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort
    private let originalFactory: (@MainActor (LabHost, LabJoin, @escaping @MainActor (OriginalView) -> Void) async throws -> any LabOriginalOwner)?
    private let box = ReactNativeMediaBox()
    private var joined: LabJoin?, original: (any LabOriginalOwner)?
    private var view = OriginalView()
    private var handle: String?
    private var mediaUsed = false, closed = false
    private var commands: [UUID: Task<String, any Error>] = [:]
    private var closingMedia: Task<Void, any Error>?, retirement: Task<Void, any Error>?
    private var expiry: Date?, expiryTask: Task<Void, Never>?
    init(origin: URL, role: String, code: String, transport: any LabTransport = NativeLabTransport(),
         mediaFactory: @escaping @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort = { try LiveKitSpeechMedia.create(callbacks: $0) },
         originalFactory: (@MainActor (LabHost, LabJoin, @escaping @MainActor (OriginalView) -> Void) async throws -> any LabOriginalOwner)? = nil) throws {
        host = try LabHost(origin: origin, role: role, code: code, transport: transport, originalCapable: true)
        self.mediaFactory = mediaFactory; self.originalFactory = originalFactory
    }
    func prepare() async throws -> Data {
        let value = try await host.join(); guard !closed else { throw LabFailure.closed }; joined = value
        try authorize(value.grant)
        if value.configuration.context.retention == .originalAudioAndText {
            let update: @MainActor (OriginalView) -> Void = { [weak self] view in
                guard let self, !closed else { return }; self.view = view
            }
            let acquired: any LabOriginalOwner
            if let originalFactory { acquired = try await originalFactory(host, value, update) }
            else { acquired = try await LabOriginal.create(host: host, joined: value, update: update) }
            guard !closed else { try await acquired.close(); throw LabFailure.closed }; original = acquired
        }
        return try await host.takeJoinPayload()
    }
    func renew() async throws -> Data {
        let response = try await host.renewResponse(); try authorize(JSONDecoder().decode(SpeechGrant.self, from: response)); return response
    }
    private func authorize(_ grant: SpeechGrant) throws {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expected = joined?.configuration.context,
              grant.sessionId == expected.sessionId, grant.participantId == expected.participantId, grant.memberGeneration == expected.memberGeneration,
              let deadline = parser.date(from: grant.expiresAt) ?? ISO8601DateFormatter().date(from: grant.expiresAt), deadline > Date() else { throw LabFailure.closed }
        expiry = deadline; expiryTask?.cancel()
        expiryTask = Task { [weak self] in
            while deadline > Date() {
                do { try await Task.sleep(nanoseconds: UInt64(min(1, max(0.001, deadline.timeIntervalSinceNow)) * 1_000_000_000)) }
                catch { return }
            }
            guard let self, !closed, expiry == deadline else { return }
            box.offer(["type": "disconnected"])
            if let handle {
                _ = fence(handle, "silence"); _ = fence(handle, "mute")
                try? await closeMedia(handle)
            }
            try? await original?.finish()
        }
    }
    func createMedia(_ sessionId: String) throws -> String {
        guard !closed, !mediaUsed, let expiry, expiry > Date(), let joined, joined.configuration.context.sessionId == sessionId else { throw LabFailure.conflict }
        mediaUsed = true; let box = box
        let callbacks = SpeechMediaCallbacks(text: { box.offer(["type": "text", "sender": $0, "json": $1]) },
            trackRemoved: { box.offer(["type": "removed", "sid": $0]) }, disconnected: { box.offer(["type": "disconnected"]) },
            failed: { box.offer(["type": "failed"]) }, playbackBlocked: { box.offer(["type": "blocked"]) })
        let port = try original?.media(callbacks) ?? mediaFactory(callbacks)
        let id = box.install(port); handle = id; return id
    }
    nonisolated func fence(_ id: String, _ action: String) -> Bool { box.fence(id, action) }
    nonisolated func events(_ id: String) throws -> String { try box.events(id) }
    func command(_ id: String, action: String, body: String) async throws -> String {
        guard !closed, let expiry, expiry > Date(), body.utf8.count <= 65536, commands.count < 8 else { throw LabFailure.closed }
        let port = try box.current(id), request = UUID(), data = Data(body.utf8)
        let task = Task { @MainActor in
            switch action {
            case "connect":
                let grant = try JSONDecoder().decode(SpeechGrant.self, from: data)
                guard let expected = joined?.configuration.context, grant.sessionId == expected.sessionId,
                      grant.participantId == expected.participantId, grant.memberGeneration == expected.memberGeneration else { throw LabFailure.closed }
                try await port.connect(grant: grant)
            case "clear": try await port.clearPlayback()
            case "input":
                guard ["true", "false"].contains(body) else { throw LabFailure.invalidConfiguration }
                try await port.setInput(enabled: body == "true")
                if body == "true", let sid = try port.inputPublication() {
                    return String(decoding: try JSONEncoder().encode(sid), as: UTF8.self)
                }
            case "playback":
                let tracks = try JSONDecoder().decode([SpeechTrack].self, from: data)
                guard tracks.count <= 16 else { throw LabFailure.invalidConfiguration }; try await port.setPlayback(tracks: tracks)
            case "resume": try await port.resumeAudio()
            default: throw LabFailure.invalidConfiguration
            }
            return "null"
        }
        commands[request] = task; defer { commands[request] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    func startOriginal() async throws { guard !closed else { throw LabFailure.closed }; try await original?.start() }
    func finishOriginal() async throws { guard !closed else { throw LabFailure.closed }; try await original?.finish() }
    func originalView() throws -> String {
        guard !closed else { throw LabFailure.closed }
        let data = try JSONSerialization.data(withJSONObject: ["enabled": view.enabled, "capturing": view.capturing,
            "finished": view.finished, "rtcAvailable": original?.rtcLost != true, "status": view.status, "passages": view.passages])
        return String(decoding: data, as: UTF8.self)
    }
    func closeMedia(_ id: String) async throws {
        guard handle == id else { throw LabFailure.closed }
        if let closingMedia { return try await closingMedia.value }
        let port = try box.retire(id), pending = Array(commands.values); pending.forEach { $0.cancel() }
        let task = Task {
            var failure: (any Error)?
            do { try await port?.close() } catch { failure = error }
            for command in pending { _ = await command.result }
            if let failure { throw failure }
        }
        closingMedia = task; try await task.value
    }
    func close() async throws {
        if let retirement { return try await retirement.value }; closed = true; expiryTask?.cancel()
        let task = Task {
            await host.close()
            var failure: (any Error)?
            do { try await original?.finish() } catch { failure = error }
            do { if let handle { try await closeMedia(handle) } } catch { failure = error }
            do { try await original?.close() } catch { failure = error }
            original = nil; joined = nil; view = OriginalView()
            if let failure { throw failure }
        }
        retirement = task; try await task.value
    }
}
