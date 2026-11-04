import Foundation
#if !BOTA_SPEECH_HOST_CHECKS
@testable import BotaAppSDK
#endif

private struct SpeechCheckFailure: Error { let message: String; init(_ message: String) { self.message = message } }
private func speechCheckTrue(_ value: Bool) throws { if !value { throw SpeechCheckFailure("Expected true") } }
private func speechCheckFalse(_ value: Bool) throws { if value { throw SpeechCheckFailure("Expected false") } }
private func speechCheckEqual<T: Equatable>(_ actual: T, _ expected: T) throws { if actual != expected { throw SpeechCheckFailure("Expected equality") } }

private final class SpeechTestProbe<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Value
    private var pending: [UUID: (@Sendable (Value) -> Bool, SpeechCall<Value>)] = [:]
    init(_ value: Value) { current = value }
    var value: Value { lock.withLock { current } }
    func update(_ body: (inout Value) -> Void) {
        lock.withLock {
            body(&current)
            let ready = pending.filter { $0.value.0(current) }
            for (id, row) in ready { pending[id] = nil; row.1.resolve(.success(current)) }
        }
    }
    func wait(_ condition: @escaping @Sendable (Value) -> Bool) async throws -> Value {
        let id = UUID(); let call = SpeechCall<Value>()
        lock.withLock {
            if condition(current) { call.resolve(.success(current)) } else { pending[id] = (condition, call) }
        }
        defer { _ = lock.withLock { pending.removeValue(forKey: id) } }
        return try await call.wait()
    }
}
private final class SpeechTestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var pending: [CheckedContinuation<Void, Never>] = []
    func open() {
        let rows = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            opened = true; defer { pending.removeAll() }; return pending
        }
        rows.forEach { $0.resume() }
    }
    // Deliberately ignores Task cancellation to model a late native callback.
    func wait() async {
        await withCheckedContinuation { done in
            let ready = lock.withLock { () -> Bool in if opened { return true }; pending.append(done); return false }
            if ready { done.resume() }
        }
    }
}
private final class SpeechTestMedia: SpeechMediaPort, @unchecked Sendable {
    struct State: Sendable {
        var callbacks: SpeechMediaCallbacks?
        var calls: [String] = []
        var held = false
        var closed = false
        var muted = true
        var publication: String?
        var tracks: [SpeechTrack] = []
        var connect: @Sendable () async throws -> Void = {}
        var clear: @Sendable () async throws -> Void = {}
        var input: @Sendable (Bool) async throws -> Void = { _ in }
        var cleanup: @Sendable () async throws -> Void = {}
        var resume: @Sendable () async throws -> Void = {}
    }
    let state = SpeechTestProbe(State())
    let supportsSourceFinish = true
    func connect(grant: SpeechGrant) async throws { state.update { $0.calls.append("connect") }; try await state.value.connect() }
    func silencePlayback() { state.update { $0.calls.append("silence"); $0.tracks = [] } }
    func muteInput() { state.update { $0.calls.append("mute"); $0.muted = true } }
    func clearPlayback() async throws {
        state.update { $0.calls.append("clear") }; try await state.value.clear()
        state.update { if !Task.isCancelled { $0.tracks = [] } }
    }
    func setPlayback(tracks: [SpeechTrack]) {
        state.update { $0.calls.append("play"); if !$0.closed && !Task.isCancelled { $0.tracks = tracks } }
    }
    func setInput(enabled: Bool) async throws {
        state.update { $0.calls.append("input:\(enabled)") }
        try await state.value.input(enabled)
        state.update {
            if !Task.isCancelled { if !enabled { $0.held = false }; $0.muted = !enabled || $0.held || $0.closed }
        }
    }
    func holdInput() { state.update { $0.calls.append("hold"); $0.held = true; $0.muted = true } }
    func inputPublication() -> String? { state.update { $0.calls.append("publication") }; return state.value.publication }
    func resumeAudio() async throws { state.update { $0.calls.append("resume") }; try await state.value.resume() }
    func close() async throws { state.update { $0.calls.append("close"); $0.closed = true }; try await state.value.cleanup() }
}
private final class SpeechTestHost: SpeechHostCallbacks, @unchecked Sendable {
    struct State: Sendable {
        var change: @Sendable (SpeechSelection) async throws -> SpeechSubscription = { .init(revision: 2, selection: $0) }
        var renew: @Sendable () async throws -> SpeechGrant = { throw SpeechHostFailure.unavailable }
        var captions: (@Sendable (SpeechCaptionRequest) async throws -> Data)?
        var finish: (@Sendable (SpeechFinishRequest) async throws -> Data)?
    }
    let state = SpeechTestProbe(State())
    var supportsCaptionRecovery: Bool { state.value.captions != nil }
    var supportsSourceFinish: Bool { state.value.finish != nil }
    func changeSubscription(selection: SpeechSelection) async throws -> SpeechSubscription { try await state.value.change(selection) }
    func renewGrant() async throws -> SpeechGrant { try await state.value.renew() }
    func readCaptions(request: SpeechCaptionRequest) async throws -> Data {
        guard let body = state.value.captions else { throw SpeechHostFailure.unavailable }; return try await body(request)
    }
    func finishSource(request: SpeechFinishRequest) async throws -> Data {
        guard let body = state.value.finish else { throw SpeechHostFailure.unavailable }; return try await body(request)
    }
}
private final class SpeechTestFixture: @unchecked Sendable {
    let configuration: SpeechConfiguration
    let grant: SpeechGrant
    let media = SpeechTestMedia()
    let host = SpeechTestHost()
    let state = SpeechTestProbe<SpeechState?>(nil)
    let captions = SpeechTestProbe<[SpeechCaption]>([])
    let errors = SpeechTestProbe<[SpeechError]>([])
    let clock = SpeechTestProbe<UInt64>(1_793_491_200_000)
    let gates = SpeechTestProbe<[SpeechTestGate]>([])
    static let source = "44444444-4444-4444-8444-444444444444"
    init(fixtureURL: URL, retention: SpeechRetention = .liveOnly) throws {
        struct Fixture: Decodable { let configuration: SpeechConfiguration; let grant: SpeechGrant }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        let c = fixture.configuration.context
        configuration = .init(context: .init(projectId: c.projectId, sessionId: c.sessionId, participantId: c.participantId,
                                             memberGeneration: c.memberGeneration, retention: retention, canPublish: true, canSubscribe: true),
                              subscription: fixture.configuration.subscription)
        grant = fixture.grant
    }
    func gate() -> SpeechTestGate { let gate = SpeechTestGate(); gates.update { $0.append(gate) }; return gate }
    func open() throws -> SpeechSession {
        try SpeechSession(configuration: configuration, grant: grant,
                          mediaFactory: { callbacks in self.media.state.update { $0.callbacks = callbacks }; return self.media },
                          host: host, observer: .init(stateChanged: { value in self.state.update { $0 = value } },
                            caption: { value in self.captions.update { $0.append(value) } },
                            error: { value in self.errors.update { $0.append(value) } }),
                          timing: .init(now: { self.clock.value }, sleep: SpeechTiming.system().sleep))
    }
    func selection(_ language: String) -> SpeechSelection {
        .init(targetLanguage: language, mode: .translated, sourceParticipantIds: configuration.subscription.selection.sourceParticipantIds)
    }
    func applied(_ revision: UInt32 = 1, _ language: String = "zh") -> [String: Any] {
        ["protocolVersion": 1, "projectId": configuration.context.projectId, "sessionId": grant.sessionId,
         "retention": configuration.context.retention.rawValue, "type": "subscription_applied", "workerGeneration": grant.workerGeneration,
         "participantId": grant.participantId, "memberGeneration": grant.memberGeneration,
         "subscriptionRevision": revision, "targetLanguage": language, "mode": "translated"]
    }
    func audio(_ revision: UInt32 = 1, _ language: String = "zh") -> [String: Any] {
        var value = applied(revision, language); value.removeValue(forKey: "mode")
        value.merge(["type": "audio_start", "eventSequence": 1, "sourceId": Self.source, "sourceEpoch": 1,
                     "sourceParticipantId": configuration.subscription.selection.sourceParticipantIds[0], "sourceMemberGeneration": 1,
                     "unitId": "unit_1", "outputId": "output_1", "transport": "webrtc", "codec": "opus",
                     "sourceSampleRate": 24000, "channels": 1, "origin": "generated", "voice": "neutral", "mediaTrackSid": "TR_output"]) { _, b in b }
        return value
    }
    func event(_ value: [String: Any], sender: String? = nil) throws {
        media.state.value.callbacks?.text(sender ?? grant.processorIdentity,
                                         String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self))
    }
    func page(_ request: SpeechCaptionRequest, sequence: Int = 1, more: Bool = false) throws -> Data {
        let source = Self.source
        let record: [String: Any] = ["protocolVersion": 1, "projectId": configuration.context.projectId,
            "sessionId": grant.sessionId, "retention": configuration.context.retention.rawValue,
            "sourceId": source, "sourceEpoch": 1, "sourceParticipantId": configuration.subscription.selection.sourceParticipantIds[0],
            "sourceMemberGeneration": 1, "unitId": "\(source):1:\(sequence):\(sequence)",
            "sourceFirstSeq": sequence, "sourceLastSeq": sequence, "startMs": 0, "endMs": 100,
            "sourceLanguage": "en", "text": "Hello 🌍\u{0}"]
        return try JSONSerialization.data(withJSONObject: ["protocol_version": 1, "session_id": grant.sessionId,
            "participant_id": grant.participantId, "member_generation": grant.memberGeneration,
            "subscription_revision": request.subscriptionRevision, "history": "retained",
            "records": [["sequence": String(sequence), "record": record]], "has_more": more, "next_cursor": "cursor_\(sequence)"])
    }
    func finished(_ status: String) throws -> Data {
        let hasBoundary = status == "draining" || status == "completed"
        return try JSONSerialization.data(withJSONObject: ["source": ["id": Self.source, "epoch": 1,
            "participant_id": grant.participantId, "member_generation": grant.memberGeneration,
            "track_sid": "TR_original", "state": status == "completed" ? "ended" : "active",
            "finish": ["state": status, "worker_generation": grant.workerGeneration,
                       "sequence": hasBoundary ? "2" : NSNull(), "samples": hasBoundary ? "3200" : NSNull()]]])
    }
}

struct SpeechSessionChecks: Sendable {
    let fixtureURL: URL
    private func run(_ fixture: SpeechTestFixture, body: @escaping @Sendable (SpeechSession) async throws -> Void) async throws {
        let session = try fixture.open()
        let watchdog = SpeechCall<Void>()
        watchdog.start(timing: .system(), timeout: 5_000) { try await body(session) }
        do {
            try await watchdog.wait(); fixture.gates.value.forEach { $0.open() }; try? await session.close()
        } catch {
            fixture.gates.value.forEach { $0.open() }; try? await session.close(); throw error
        }
    }

    func testDuplexLanguageChangeWaitsForCurrentHttpWorkerAndClear() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let http = f.gate(); let clear = f.gate()
        try await run(f) { session in
            try await session.ready(); try await session.setInput(true); try await session.setListening(true)
            try f.event(f.applied()); _ = try await f.state.wait { $0?.canPlay == true }
            try f.event(f.audio()); _ = try await f.media.state.wait { $0.tracks.count == 1 }
            f.host.state.update { $0.change = { selection in await http.wait(); return .init(revision: 2, selection: selection) } }
            f.media.state.update { $0.clear = { await clear.wait() } }
            let changing = Task { try await session.changeSubscription(f.selection("ja")) }
            _ = try await f.state.wait { $0?.changeId == 1 }
            try speechCheckTrue(session.state.canCapture); try speechCheckFalse(f.media.state.value.muted)
            try speechCheckTrue(f.media.state.value.tracks.isEmpty)
            try f.event(f.applied(2, "ja")); http.open(); try await changing.value
            try speechCheckFalse(session.state.canPlay)
            clear.open(); _ = try await f.state.wait { $0?.canPlay == true }
            try f.event(f.audio()); try speechCheckTrue(session.state.tracks.isEmpty)
            try f.event(f.audio(2, "ja")); _ = try await f.media.state.wait { $0.tracks.count == 1 }
            try await session.setListening(false); try speechCheckTrue(session.state.canCapture); try speechCheckFalse(f.media.state.value.muted)
        }
    }
    func testSupersededHttpCannotReplaceNewLanguage() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let old = f.gate(); let entered = SpeechTestProbe(false)
        f.host.state.update { $0.change = { selection in
            if selection.targetLanguage == "ja" { entered.update { $0 = true }; await old.wait() }
            return .init(revision: selection.targetLanguage == "ja" ? 2 : 3, selection: selection)
        } }
        try await run(f) { session in
            try await session.ready()
            let previous = Task { try await session.changeSubscription(f.selection("ja")) }
            _ = try await entered.wait { $0 }
            try await session.changeSubscription(f.selection("fr")); old.open()
            do { try await previous.value; throw SpeechCheckFailure("Expected superseded request") }
            catch { try speechCheckEqual(error as? SpeechError, .superseded) }
            try speechCheckEqual(session.state.subscriptionRevision, 3); try speechCheckFalse(session.state.disconnect)
        }
    }
    func testCancelledCaptureClosesAndJoinsLateAcquisition() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let late = f.gate(); let settled = f.gate(); let entered = SpeechTestProbe(false)
        f.media.state.update { $0.input = { enabled in if enabled { entered.update { $0 = true }; await late.wait(); settled.open() } }
            $0.cleanup = { await settled.wait() } }
        try await run(f) { session in
            try await session.ready(); let input = Task { try await session.setInput(true) }
            _ = try await entered.wait { $0 }; input.cancel()
            _ = try await f.state.wait { $0?.disconnect == true }
            try speechCheckTrue(f.media.state.value.muted)
            let closed = SpeechTestProbe(false)
            let close = Task { try await session.close(); closed.update { $0 = true } }
            _ = try await f.media.state.wait { $0.closed }; try speechCheckFalse(closed.value)
            late.open(); try await close.value; _ = try? await input.value
            try speechCheckTrue(f.media.state.value.muted); try speechCheckEqual(f.media.state.value.calls.filter { $0 == "close" }.count, 1)
            try f.event(f.applied()); try speechCheckTrue(session.state.disconnect)
        }
    }
    func testFinishHoldsPendingPublicationThenDrainsWhileListening() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let acquire = f.gate(); let entered = SpeechTestProbe(false)
        let requests = SpeechTestProbe<[SpeechFinishRequest]>([])
        f.media.state.update { $0.input = { enabled in if enabled {
            entered.update { $0 = true }; await acquire.wait(); f.media.state.update { $0.publication = "TR_original" }
        } } }
        f.host.state.update { $0.finish = { request in requests.update { $0.append(request) }; return try f.finished(requests.value.count == 1 ? "draining" : "completed") } }
        try await run(f) { session in
            try await session.ready(); try await session.setListening(true); try f.event(f.applied())
            _ = try await f.state.wait { $0?.canPlay == true }
            let input = Task { try await session.setInput(true) }; _ = try await entered.wait { $0 }
            let finish = Task { try await session.finishInput() }
            _ = try await f.media.state.wait { $0.held }; try speechCheckTrue(requests.value.isEmpty)
            acquire.open(); try await input.value
            _ = try await f.state.wait { $0?.sourceFinish.status == "draining" }
            try speechCheckTrue(session.state.canPlay); try speechCheckEqual(requests.value.first?.trackSid, "TR_original")
            f.clock.update { $0 += 1000 }; session.tick()
            let result = try await finish.value; try speechCheckEqual(result.status, "completed")
            try speechCheckEqual(requests.value.last?.sourceId, SpeechTestFixture.source)
            let repeated = try await session.finishInput(); try speechCheckEqual(repeated, result); try speechCheckEqual(requests.value.count, 2)
            try await session.setInput(true); try speechCheckEqual(session.state.sourceFinish.status, "idle")
        }
    }
    func testCaptionRecoveryUsesSharedCursorAndPreservesUnicode() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL, retention: .textOnly); let gate = f.gate(); let requests = SpeechTestProbe<[SpeechCaptionRequest]>([])
        f.host.state.update { $0.captions = { request in
            requests.update { $0.append(request) }; await gate.wait()
            return try f.page(request, sequence: requests.value.count, more: requests.value.count == 1)
        } }
        try await run(f) { session in
            try await session.ready(); _ = try await requests.wait { !$0.isEmpty }
            gate.open()
            // Observe the automatic first page before explicitly requesting the
            // next one. Creating a Task does not prove it joined the first read.
            let first = try await f.state.wait { $0?.recovery.cursor == "cursor_1" }
            try speechCheckTrue(first?.recovery.hasMore == true)
            let result = try await session.recoverCaptions()
            try speechCheckEqual(result.cursor, "cursor_2"); try speechCheckFalse(result.hasMore)
            let captions = try await f.captions.wait { $0.count == 2 }
            try speechCheckEqual(requests.value.count, 2); try speechCheckEqual(requests.value.first?.cursor, nil)
            try speechCheckEqual(requests.value.last?.cursor, "cursor_1"); try speechCheckEqual(captions[0].record.text, "Hello 🌍\u{0}")
            try speechCheckTrue(captions.allSatisfy(\.isFinal)); try speechCheckFalse(String(describing: captions[0]).contains("Hello"))
        }
    }
    func testAuthorizationRevocationAndExpiryRetireMedia() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL, retention: .textOnly); let gate = f.gate()
        f.host.state.update { $0.captions = { _ in await gate.wait(); throw SpeechHostFailure.unauthorized } }
        try await run(f) { session in
            try await session.ready(); try await session.setInput(true); gate.open()
            _ = try await f.errors.wait { $0.contains(.authorizationUnavailable) }
            try speechCheckTrue(session.state.disconnect); try speechCheckTrue(f.media.state.value.muted)
        }
        let expired = try SpeechTestFixture(fixtureURL: fixtureURL)
        try await run(expired) { session in
            try await session.ready(); try await session.setInput(true)
            expired.clock.update { $0 += 60_000 }; session.tick()
            try speechCheckTrue(session.state.disconnect); try speechCheckTrue(expired.media.state.value.muted)
        }
    }
    func testFailedConnectionPreservesStableErrorAndSingleClose() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); f.media.state.update { $0.connect = { throw SpeechHostFailure.unavailable } }
        try await run(f) { session in
            do { try await session.ready(); throw SpeechCheckFailure("Expected connection failure") }
            catch { try speechCheckEqual(error as? SpeechError, .mediaFailed) }
            try await session.close(); try await session.close()
            try speechCheckEqual(f.media.state.value.calls.filter { $0 == "close" }.count, 1)
        }
    }
    func testFailedCleanupRemainsFailedForEveryCaller() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); f.media.state.update { $0.cleanup = { throw SpeechHostFailure.unavailable } }
        try await run(f) { session in
            try await session.ready()
            for _ in 0..<2 {
                do { try await session.close(); throw SpeechCheckFailure("Expected uncertain cleanup") }
                catch { try speechCheckEqual(error as? SpeechError, .cleanupFailed) }
            }
            try speechCheckTrue(session.state.disconnect); try speechCheckEqual(f.media.state.value.calls.filter { $0 == "close" }.count, 1)
        }
    }
    func testNoPublicationIsNotCompletedAsr() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let requests = SpeechTestProbe(0)
        f.host.state.update { $0.finish = { _ in requests.update { $0 += 1 }; throw SpeechHostFailure.unavailable } }
        try await run(f) { session in
            try await session.ready(); let first = try await session.finishInput(); let second = try await session.finishInput()
            try speechCheckEqual(first.status, "no_source"); try speechCheckEqual(second, first)
            try speechCheckEqual(requests.value, 0); try speechCheckFalse(session.state.disconnect)
        }
    }
    func testBoundedCallDoesNotJoinAnUncooperativeNativeTask() async throws {
        let gate = SpeechTestGate(); let entered = SpeechTestProbe(false)
        let deadline = SpeechTestGate(); let installed = SpeechTestProbe(false)
        let call = SpeechCall<Void>()
        call.start(timing: .init(now: { 0 }, sleep: { _ in installed.update { $0 = true }; await deadline.wait() }), timeout: 10_000) {
            entered.update { $0 = true }; await gate.wait()
        }
        let watchdog = SpeechCall<Void>()
        watchdog.start(timing: .system(), timeout: 5_000) {
            _ = try await entered.wait { $0 }; _ = try await installed.wait { $0 }; deadline.open()
            do { try await call.wait(); throw SpeechCheckFailure("Expected bounded timeout") }
            catch { try speechCheckEqual(error as? SpeechError, .mediaTimeout) }
        }
        defer { gate.open(); deadline.open() }
        try await watchdog.wait()
    }

    func testRetiredCaptionRequestDoesNotBlockOrPublishIntoNewRevision() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL, retention: .textOnly)
        let old = f.gate(); let entered = SpeechTestProbe(false)
        f.host.state.update { $0.captions = { request in
            if request.subscriptionRevision == 1 { entered.update { $0 = true }; await old.wait() }
            return try f.page(request)
        } }
        try await run(f) { session in
            try await session.ready(); _ = try await entered.wait { $0 }
            try await session.changeSubscription(f.selection("ja"))
            let captions = try await f.captions.wait { !$0.isEmpty }
            try speechCheckEqual(captions.map(\.subscriptionRevision), [2])
            old.open(); try await session.close()
            try speechCheckTrue(f.captions.value.allSatisfy { $0.subscriptionRevision == 2 })
        }
    }
    func testMalformedCaptionBodyIsRejectedByRust() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL, retention: .textOnly); let gate = f.gate()
        f.host.state.update { $0.captions = { _ in await gate.wait(); return Data("{\"unexpected\":\"PRIVATE_TOKEN_CANARY\"}".utf8) } }
        try await run(f) { session in
            try await session.ready(); try await session.setInput(true); gate.open()
            _ = try await f.errors.wait { $0.contains(.invalidInput) }
            try speechCheckTrue(session.state.disconnect); try speechCheckTrue(f.media.state.value.muted)
            try speechCheckTrue(f.captions.value.isEmpty)
        }
    }
    func testConcurrentFinishSharesAuthorityAndRejectsHeldInput() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let gate = f.gate(); let requests = SpeechTestProbe(0)
        f.media.state.update { $0.publication = "TR_original" }
        f.host.state.update { $0.finish = { _ in requests.update { $0 += 1 }; await gate.wait(); return try f.finished("completed") } }
        try await run(f) { session in
            try await session.ready(); try await session.setInput(true)
            let first = Task { try await session.finishInput() }; _ = try await requests.wait { $0 == 1 }
            let second = Task { try await session.finishInput() }
            do { try await session.setInput(true); throw SpeechCheckFailure("Held input unexpectedly enabled") }
            catch { try speechCheckEqual(error as? SpeechError, .sourceFinishPending) }
            gate.open(); let a = try await first.value; let b = try await second.value
            try speechCheckEqual(a, b); try speechCheckEqual(a.status, "completed"); try speechCheckEqual(requests.value, 1)
        }
    }
    func testHttpFirstAndStaleClearCannotResumeCurrentAudio() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let old = f.gate(); let current = f.gate()
        let clears = SpeechTestProbe(0)
        try await run(f) { session in
            try await session.ready(); try await session.setInput(true); try await session.setListening(true)
            try f.event(f.applied()); _ = try await f.state.wait { $0?.canPlay == true }
            f.media.state.update { $0.clear = {
                clears.update { $0 += 1 }
                if clears.value == 1 { await old.wait() } else { await current.wait() }
            } }
            f.host.state.update { $0.change = { .init(revision: $0.targetLanguage == "ja" ? 2 : 3, selection: $0) } }
            try await session.changeSubscription(f.selection("ja")); _ = try await clears.wait { $0 == 1 }
            try speechCheckFalse(session.state.canPlay)
            try await session.changeSubscription(f.selection("fr")); _ = try await clears.wait { $0 == 2 }
            try f.event(f.applied(2, "ja")); try f.event(f.applied(3, "fr")); old.open()
            try speechCheckFalse(session.state.canPlay); try speechCheckTrue(session.state.canCapture)
            current.open(); _ = try await f.state.wait { $0?.canPlay == true }
            try f.event(f.audio(3, "fr")); _ = try await f.media.state.wait { $0.tracks.count == 1 }
        }
    }
    func testCancellingCloseWaiterDoesNotCancelActualCleanup() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let cleanup = f.gate(); let entered = SpeechTestProbe(false)
        f.media.state.update { $0.cleanup = { entered.update { $0 = true }; await cleanup.wait() } }
        try await run(f) { session in
            try await session.ready()
            let first = Task { try await session.close() }; _ = try await entered.wait { $0 }; first.cancel()
            do { try await first.value; throw SpeechCheckFailure("Expected cancelled close waiter") }
            catch is CancellationError { }
            cleanup.open(); try await session.close()
            try speechCheckEqual(f.media.state.value.calls.filter { $0 == "close" }.count, 1)
        }
    }
    func testCloseCancelsResumeBeforeCleanupSettles() async throws {
        let f = try SpeechTestFixture(fixtureURL: fixtureURL); let late = f.gate(); let cleanup = f.gate()
        let entered = SpeechTestProbe(false); let cancelled = SpeechTestProbe(false)
        f.media.state.update { $0.resume = {
            await withTaskCancellationHandler { entered.update { $0 = true }; await late.wait() }
                onCancel: { cancelled.update { $0 = true } }
        }; $0.cleanup = { await cleanup.wait() } }
        try await run(f) { session in
            try await session.ready(); let resume = Task { try await session.resumeAudio() }
            _ = try await entered.wait { $0 }
            let closed = SpeechTestProbe(false)
            let close = Task { try await session.close(); closed.update { $0 = true } }
            _ = try await cancelled.wait { $0 }; try speechCheckFalse(closed.value)
            do { try await resume.value; throw SpeechCheckFailure("Expected retired playback resume") }
            catch { try speechCheckEqual(error as? SpeechError, .closed) }
            late.open(); cleanup.open(); try await close.value
        }
    }
    func testCancellationBeforeTaskStartRetiresCompletionOwnershipExactlyOnce() async throws {
        let count = SpeechTestProbe(0); let bodyStarted = SpeechTestProbe(false); let call = SpeechCall<Void>()
        call.whenComplete { count.update { $0 += 1 } }
        call.cancel(); call.cancel()
        call.start(timing: .system()) { bodyStarted.update { $0 = true } }
        try speechCheckEqual(count.value, 1); try speechCheckFalse(bodyStarted.value)
        do { try await call.wait(); throw SpeechCheckFailure("Expected cancelled operation") }
        catch is CancellationError { }
    }
}
