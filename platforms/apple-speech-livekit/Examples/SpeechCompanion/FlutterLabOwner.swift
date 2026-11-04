import BotaAppSDK
import BotaSpeechLiveKit
import Foundation

/// One process owner prepares native authorization for the current Flutter engine.
/// Callers may expose only the returned display metadata to Dart.
@MainActor
final class FlutterLabOwner {
    private let transport: @Sendable () -> any LabTransport
    private let media: @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort
    private var engine: String?
    private var revision = UUID()
    private var host: LabHost?
    private var joined: LabJoin?
    private var session: SpeechSession?
    private var bootstrap: Task<LabJoin, any Error>?
    private var retirement: Task<Void, any Error>?
    private var closing = false, failed = false
    init(transport: @escaping @Sendable () -> any LabTransport = { NativeLabTransport() },
         media: @escaping @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort = { try LiveKitSpeechMedia.create(callbacks: $0) }) {
        self.transport = transport; self.media = media
    }
    func bindEngine(_ id: String) {
        guard engine != id else { return }
        engine = id; _ = retire()
    }
    func isCurrent(_ id: String) -> Bool { engine == id && !failed && joined != nil }
    func permissionOwner(_ id: String) -> UUID? { isCurrent(id) ? revision : nil }
    func acceptsPermission(_ id: String, owner: UUID) -> Bool { isCurrent(id) && revision == owner }
    func prepare(_ id: String, origin: URL, role: String, code: String) async throws -> [String: Any] {
        guard engine == id, !failed else { throw LabFailure.closed }
        try await retirement?.value
        guard engine == id, !failed, host == nil, bootstrap == nil else { throw LabFailure.conflict }
        let owner = UUID(); revision = owner
        do {
            let host = try LabHost(origin: origin, role: role, code: code, transport: transport()); self.host = host
            let task = Task { try await host.join() }; bootstrap = task
            let value = try await task.value
            guard engine == id, revision == owner else { throw LabFailure.closed }
            bootstrap = nil; joined = value
            let selection = value.configuration.subscription.selection
            return ["sessionId": value.configuration.context.sessionId, "role": value.role,
                "peerRole": value.peer.role, "peerId": value.peer.participantId,
                "languages": value.allowedLanguages, "language": selection.targetLanguage,
                "mode": selection.mode == .captionsOnly ? "captionsOnly" : selection.mode == .original ? "original" : "translated"]
        } catch {
            if engine == id, revision == owner { try await retire().value }
            throw error
        }
    }
    func create(_ id: String, sessionId: String, observer: SpeechObserver) throws -> SpeechSession {
        guard engine == id, !failed, !closing, session == nil, let joined, let host,
              joined.configuration.context.sessionId == sessionId else { throw LabFailure.conflict }
        let value = try SpeechSession(configuration: joined.configuration, grant: joined.grant,
            mediaFactory: media, host: host, observer: observer)
        session = value; return value
    }
    func leave(_ id: String) -> Task<Void, any Error> { engine == id ? retire() : Task {} }
    private func retire() -> Task<Void, any Error> {
        if let retirement, closing || failed { return retirement }
        revision = UUID()
        let pending = bootstrap, native = session, host = host
        bootstrap = nil; session = nil; self.host = nil; joined = nil; closing = true
        pending?.cancel()
        let task = Task { @MainActor in
            defer { closing = false }
            await host?.close(); _ = await pending?.result
            do { try await native?.close() }
            catch { failed = true; throw error }
        }
        retirement = task; return task
    }
}
