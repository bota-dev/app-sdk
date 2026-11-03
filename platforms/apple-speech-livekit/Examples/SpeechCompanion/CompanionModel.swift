import BotaAppSDK
import BotaSpeechLiveKit
import AVFoundation
import Combine
import Foundation

private enum CompanionEvent: Sendable { case state(SpeechState), caption(SpeechCaption), error(SpeechError) }
private enum CompanionFailure: Error { case microphoneDenied }
private final class CompanionMailbox: @unchecked Sendable {
    let stream: AsyncStream<CompanionEvent>
    private let continuation: AsyncStream<CompanionEvent>.Continuation
    private let lock = NSLock()
    private var retired = false, overflow = false
    var overflowed: Bool { lock.withLock { overflow } }
    init() {
        let pair = AsyncStream<CompanionEvent>.makeStream(bufferingPolicy: .bufferingOldest(32))
        stream = pair.stream; continuation = pair.continuation
    }
    func offer(_ value: CompanionEvent) {
        lock.withLock {
            guard !retired else { return }
            if case .dropped = continuation.yield(value) { retired = true; overflow = true; continuation.finish() }
        }
    }
    func close() { lock.withLock { retired = true; continuation.finish() } }
}

struct CaptionPair: Identifiable {
    let id: String
    let speaker: String
    var original = "", translation = ""
    var originalFinal = false, translationFinal = false
}

/// The example owns UI lifetime only. The installed native SDK and Rust policy
/// retain capture, authorization, subscription and source-finish decisions.
@MainActor
final class CompanionModel: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var joining = false
    @Published private(set) var closing = false
    @Published private(set) var cleanupFailed = false
    @Published private(set) var inputEnabled = false
    @Published private(set) var listeningEnabled = false
    @Published private(set) var notice = "Choose a role and join your local session."
    @Published private(set) var pairs: [CaptionPair] = []
    @Published private(set) var languages = ["en", "zh", "ja"]
    @Published private(set) var language = "zh"
    @Published private(set) var mode: SpeechListeningMode = .translated
    @Published private(set) var busy: Set<String> = []
    @Published private(set) var state: SpeechState?
    private let transport: @Sendable () -> any LabTransport
    private let requestMicrophone: @Sendable () async -> Bool
    private let media: @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort
    private var generation = UUID()
    private var session: SpeechSession?
    private var host: LabHost?
    private var initial: LabJoin?
    private var retiredCaptionRevision: UInt32 = 0
    private var bootstrap: Task<LabJoin, any Error>?
    private var retirement: Task<Void, any Error>?
    private var mailbox: CompanionMailbox?
    private var pump: Task<Void, Never>?

    init(transport: @escaping @Sendable () -> any LabTransport = { NativeLabTransport() },
         requestMicrophone: @escaping @Sendable () async -> Bool = { await AVCaptureDevice.requestAccess(for: .audio) },
         media: @escaping @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort = { try LiveKitSpeechMedia.create(callbacks: $0) }) {
        self.transport = transport; self.requestMicrophone = requestMicrophone; self.media = media
    }
    func join(origin: URL, role: String, code: String) async {
        guard !joining, !closing, !connected, !cleanupFailed, session == nil else { return }
        generation = UUID(); let owner = generation
        joining = true; notice = "Joining…"
        do {
            let host = try LabHost(origin: origin, role: role, code: code, transport: transport())
            self.host = host
            let task = Task { try await host.join() }; bootstrap = task
            let value = try await task.value
            guard owner == generation else { return }
            bootstrap = nil; initial = value; retiredCaptionRevision = 0
            language = value.configuration.subscription.selection.targetLanguage
            mode = value.configuration.subscription.selection.mode; languages = value.allowedLanguages
            let mailbox = CompanionMailbox(); self.mailbox = mailbox
            pump = Task { [weak self] in
                for await event in mailbox.stream {
                    guard let self, self.generation == owner else { return }
                    await self.receive(event)
                }
                if mailbox.overflowed, let self, self.generation == owner {
                    await self.leave(reason: "The display could not keep up. Join again.")
                }
            }
            let session = try SpeechSession(configuration: value.configuration, grant: value.grant, mediaFactory: media,
                host: host, observer: SpeechObserver(stateChanged: { mailbox.offer(.state($0)) },
                    caption: { mailbox.offer(.caption($0)) }, error: { mailbox.offer(.error($0)) }))
            self.session = session
            try await session.ready()
            guard owner == generation else { return }
            connected = true; joining = false; state = session.state
            notice = "Connected. Input and listening are off."
        } catch {
            if owner == generation { await leave(reason: "Could not join. Check the role, code and active session.") }
        }
    }
    func leave(reason: String = "Left the session.") async {
        if let retirement { _ = try? await retirement.value; return }
        generation = UUID()
        let pending = bootstrap, session = session, host = host
        bootstrap = nil; self.session = nil; self.host = nil; initial = nil
        pending?.cancel(); mailbox?.close(); mailbox = nil; pump?.cancel(); pump = nil
        connected = false; joining = false; closing = true; inputEnabled = false; listeningEnabled = false
        pairs.removeAll(); state = nil; busy.removeAll(); notice = reason
        let task = Task { @MainActor in
            await host?.close()
            _ = await pending?.result
            try await session?.close()
        }
        retirement = task
        do { try await task.value }
        catch { cleanupFailed = true; notice = "Audio cleanup failed. Close and reopen this App before joining again." }
        closing = false; retirement = nil
    }
    func setInput(_ enabled: Bool) async {
        guard !busy.contains("finish") else { return }
        let owner = generation
        if await run("input", { session in
            if enabled {
                guard await requestMicrophone() else { throw CompanionFailure.microphoneDenied }
                guard owner == generation else { throw CancellationError() }
            }
            try await session.setInput(enabled)
        }) { inputEnabled = enabled }
    }
    func setListening(_ enabled: Bool) async {
        if await run("listen", { try await $0.setListening(enabled) }) { listeningEnabled = enabled }
    }
    func select(language: String, mode: SpeechListeningMode) async {
        guard let initial, let session, !busy.contains("selection"), languages.contains(language) else { return }
        let oldLanguage = self.language, oldMode = self.mode
        retiredCaptionRevision = session.state.subscriptionRevision
        self.language = language; self.mode = mode; pairs.removeAll()
        let selection = SpeechSelection(targetLanguage: language, mode: mode, sourceParticipantIds: [initial.peer.participantId])
        if !(await run("selection", { try await $0.changeSubscription(selection) })), connected {
            self.language = oldLanguage; self.mode = oldMode
            notice = "Preference update failed. Leave and join again to refresh it."
        }
    }
    func finish() async {
        inputEnabled = false
        var status = "unavailable"
        if await run("finish", { status = try await $0.finishInput().status }) {
            notice = status == "completed" ? "Input finished. Listening remains available." :
                status == "no_source" ? "No input was started." : "Input finish was interrupted. Listening remains available."
        }
    }
    func resumeAudio() async { _ = await run("resume", { try await $0.resumeAudio() }) }
    func recoverCaptions() async {
        var status = "unavailable"
        if await run("recovery", { status = try await $0.recoverCaptions().status }), status == "unavailable" {
            notice = "This session does not retain caption history."
        }
    }
    private func run(_ operation: String, _ action: (SpeechSession) async throws -> Void) async -> Bool {
        guard let session, connected, !busy.contains(operation) else { return false }
        let owner = generation; busy.insert(operation)
        defer { if owner == generation { busy.remove(operation) } }
        do {
            try await action(session)
            guard owner == generation else { return false }
            state = session.state; return true
        } catch {
            guard owner == generation else { return false }
            if session.state.disconnect { await leave(reason: "The session ended. Join again with current authorization.") }
            else if error is CompanionFailure { notice = "Microphone permission is required. Enable it in system settings, then try again." }
            else { notice = "The action could not finish. Try again or leave the session." }
            return false
        }
    }
    private func receive(_ event: CompanionEvent) async {
        switch event {
        case .state(let queued):
            let state = session?.state ?? queued
            self.state = state
            if !state.canCapture { inputEnabled = false }
            if state.disconnect { await leave(reason: "The session ended. Join again with current authorization.") }
        case .error(let error):
            if error == .playbackBlocked { notice = "Audio is paused. Select Resume audio." }
            else if error == .authorizationUnavailable { await leave(reason: "Authorization ended. Join again.") }
            else { notice = "A session action could not finish." }
        case .caption(let caption):
            guard let initial, let session, caption.subscriptionRevision > retiredCaptionRevision,
                  caption.subscriptionRevision == session.state.subscriptionRevision else { return }
            let record = caption.record
            let key = "\(record.sourceId)/\(record.sourceEpoch)/\(record.unitId)"
            if !pairs.contains(where: { $0.id == key }) {
                if pairs.count == 100 { pairs.removeFirst() }
                pairs.append(CaptionPair(id: key, speaker: "Speaker " + (record.sourceParticipantId == initial.peer.participantId ? initial.peer.role : initial.role).uppercased()))
            }
            guard let index = pairs.firstIndex(where: { $0.id == key }) else { return }
            if let target = record.targetLanguage {
                guard target == language, !pairs[index].translationFinal || caption.isFinal else { return }
                pairs[index].translation = record.text; pairs[index].translationFinal = caption.isFinal
            } else if !pairs[index].originalFinal || caption.isFinal {
                pairs[index].original = record.text; pairs[index].originalFinal = caption.isFinal
            }
        }
    }
}
