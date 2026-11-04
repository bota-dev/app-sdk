import BotaAppSDK
@testable import BotaSpeechLiveKit
import Foundation
import Combine
@testable import SpeechCompanion

private final class LabFixture: LabTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { sent } }
    var response: LabResponse
    var responses: [String: LabResponse] = [:]
    var holdFirst = false
    let entered = Gate(), released = Gate()
    init(_ body: Data, status: Int = 200) { response = LabResponse(status: status, body: body) }
    func send(_ request: URLRequest) async throws -> LabResponse {
        let first = lock.withLock { sent.append(request); return sent.count == 1 }
        entered.open()
        if first && holdFirst { try await released.wait() }
        if let response = responses[request.url?.lastPathComponent ?? ""] { return response }
        if request.url?.lastPathComponent == "captions", response.status == 200 {
            let join = try JSONDecoder().decode(LabJoin.self, from: response.body)
            let query = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            return LabResponse(status: 200, body: try JSONSerialization.data(withJSONObject: [
                "protocol_version": 1, "session_id": join.configuration.context.sessionId,
                "participant_id": join.configuration.context.participantId,
                "member_generation": join.configuration.context.memberGeneration,
                "subscription_revision": query["subscriptionRevision"]!,
                "history": "retained", "records": [], "has_more": false, "next_cursor": "cursor_0"
            ]))
        }
        return response
    }
    func close() { released.open() }
}

final class CompanionChecks: @unchecked Sendable {
    private let origin = URL(string: "http://127.0.0.1:4173")!
    private let code = String(repeating: "a", count: 40)
    @MainActor
    func testReactNativeRtcClosePreservesIndependentOriginal() async throws {
        final class Original: LabOriginalOwner {
            nonisolated let room = FakeRoom(), output = FakeOutput()
            var capturing = false, finished = false, rtcLost = true, closed = false
            nonisolated func media(_ callbacks: SpeechMediaCallbacks) throws -> any SpeechMediaPort {
                try LiveKitSpeechMedia(room: room, output: output, callbacks: callbacks)
            }
            func start() async throws { capturing = true }
            func finish() async throws { capturing = false; finished = true }
            func close() async throws { try await finish(); closed = true }
        }
        let original = Original(), transport = LabFixture(try body(retention: "original_audio_and_text"))
        let owner = try ReactNativeLabOwner(origin: origin, role: "a", code: code, transport: transport,
            mediaFactory: { _ in throw CheckFailure(message: "Opened a second microphone") },
            originalFactory: { _, _, update in update(OriginalView(enabled: true)); return original })
        let joined = try JSONDecoder().decode(LabJoin.self, from: await owner.prepare())
        let handle = try owner.createMedia(joined.grant.sessionId)
        _ = try await owner.command(handle, action: "connect", body: String(decoding: JSONEncoder().encode(joined.grant), as: UTF8.self))
        _ = try await owner.command(handle, action: "input", body: "true"); try await owner.startOriginal()
        try await owner.closeMedia(handle)
        try require(original.capturing && !original.closed)
        try require(owner.fence(handle, "mute") && !owner.fence("foreign", "mute"))
        try await owner.finishOriginal(); try require(original.finished)
        try await owner.close(); try require(original.closed)
    }
    @MainActor
    func testReactNativeNativeExpiryRetiresMediaWithoutJsPolling() async throws {
        var object = try JSONSerialization.jsonObject(with: body()) as! [String: Any]
        var grant = object["grant"] as! [String: Any]
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        grant["expires_at"] = formatter.string(from: Date().addingTimeInterval(0.5)); object["grant"] = grant
        let transport = LabFixture(try JSONSerialization.data(withJSONObject: object)), room = FakeRoom(), output = FakeOutput()
        let owner = try ReactNativeLabOwner(origin: origin, role: "a", code: code, transport: transport,
            mediaFactory: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        let joined = try JSONDecoder().decode(LabJoin.self, from: await owner.prepare())
        let handle = try owner.createMedia(joined.grant.sessionId)
        _ = try await owner.command(handle, action: "connect", body: String(decoding: JSONEncoder().encode(joined.grant), as: UTF8.self))
        _ = try await owner.command(handle, action: "input", body: "true"); try require(room.captureEnabled)
        try await room.disconnected.wait(); try require(!room.captureEnabled)
        do { _ = try await owner.command(handle, action: "input", body: "true"); throw CheckFailure(message: "Expired input accepted") }
        catch LabFailure.closed {}
        try await owner.close()
    }
    @MainActor
    func testOriginalOwnerSurvivesRtcFailureAndStopsOnExplicitLeave() async throws {
        final class Original: LabOriginalOwner {
            nonisolated let room = FakeRoom(), output = FakeOutput()
            var capturing = false, finished = false, rtcLost = false, closed = false
            var update: (@MainActor (OriginalView) -> Void)?
            nonisolated func media(_ callbacks: SpeechMediaCallbacks) throws -> any SpeechMediaPort {
                try LiveKitSpeechMedia(room: room, output: output, callbacks: callbacks)
            }
            func start() async throws { capturing = true; update?(OriginalView(enabled: true, capturing: true)) }
            func finish() async throws { capturing = false; finished = true; update?(OriginalView(enabled: true, finished: true)) }
            func close() async throws { try await finish(); closed = true }
        }
        let original = Original(), transport = LabFixture(try body(retention: "original_audio_and_text"))
        let model = CompanionModel(transport: { transport }, requestMicrophone: { true },
            media: { _ in throw CheckFailure(message: "Opened a second microphone") },
            originalFactory: { _, _, update in original.update = update; update(OriginalView(enabled: true)); return original })
        await model.join(origin: origin, role: "a", code: code); await model.setInput(true)
        try require(model.connected && original.capturing)
        let ended = Gate()
        let observation = model.$connected.dropFirst().filter { !$0 }.sink { _ in ended.open() }
        defer { observation.cancel() }
        original.rtcLost = true; original.room.events?.failed()
        try await ended.wait()
        try require(original.capturing && !original.closed)
        await model.finish(); try require(original.finished && !original.capturing)
        await model.leave(); try require(original.closed)
    }
    @MainActor
    func testFlutterPreparationIsNativeAndConsumedByOnlyItsEngine() async throws {
        let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
        let owner = FlutterLabOwner(transport: { transport }, media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        owner.bindEngine("engine")
        let display = try await owner.prepare("engine", origin: origin, role: "a", code: code)
        try require(Set(display.keys) == Set(["sessionId", "role", "peerRole", "peerId", "languages", "language", "mode"]))
        let id = display["sessionId"] as! String
        do { _ = try owner.create("old", sessionId: id, observer: SpeechObserver()); throw CheckFailure(message: "Foreign engine accepted") }
        catch LabFailure.conflict {}
        let session = try owner.create("engine", sessionId: id, observer: SpeechObserver())
        try await session.ready(); try await session.setInput(true)
        do { _ = try owner.create("engine", sessionId: id, observer: SpeechObserver()); throw CheckFailure(message: "Preparation reused") }
        catch LabFailure.conflict {}
        try await owner.leave("engine").value
        try require(!owner.isCurrent("engine"))
    }
    @MainActor
    func testFlutterEngineReplacementRetiresLateBootstrap() async throws {
        let transport = LabFixture(try body()); transport.holdFirst = true
        let owner = FlutterLabOwner(transport: { transport }, media: { _ in throw CheckFailure(message: "Retired bootstrap created media") })
        owner.bindEngine("old")
        let joining = Task { _ = try await owner.prepare("old", origin: origin, role: "a", code: code) }
        try await transport.entered.wait(); owner.bindEngine("new")
        do { _ = try await joining.value; throw CheckFailure(message: "Retired bootstrap survived") }
        catch is CancellationError {} catch is LabFailure {}
        let display = try await owner.prepare("new", origin: origin, role: "a", code: code)
        try require(display["role"] as? String == "a")
        let permissionOwner = owner.permissionOwner("new")!
        try await owner.leave("old").value
        try require(owner.acceptsPermission("new", owner: permissionOwner))
        try await owner.leave("new").value
        try require(!owner.acceptsPermission("new", owner: permissionOwner))
    }
    @MainActor
    func testFlutterCleanupFailurePreventsNewEngineAdmission() async throws {
        let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
        room.releaseFails = true
        let owner = FlutterLabOwner(transport: { transport }, media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        owner.bindEngine("first")
        let display = try await owner.prepare("first", origin: origin, role: "a", code: code)
        let session = try owner.create("first", sessionId: display["sessionId"] as! String, observer: SpeechObserver())
        try await session.ready()
        do { try await owner.leave("first").value; throw CheckFailure(message: "Cleanup failure lost") }
        catch SpeechError.cleanupFailed {}
        let count = transport.requests.count; owner.bindEngine("second")
        do { _ = try await owner.prepare("second", origin: origin, role: "a", code: code); throw CheckFailure(message: "Failed cleanup accepted another engine") }
        catch LabFailure.closed {}
        try require(transport.requests.count == count)
    }
    private func body(retention: String = "text_only") throws -> Data {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("protocol/speech-session/client-v1.json").path) {
            let parent = root.deletingLastPathComponent()
            guard parent != root else { throw CheckFailure(message: "Speech fixture missing") }; root = parent
        }
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("protocol/speech-session/client-v1.json"))) as! [String: Any]
        var configuration = fixture["configuration"] as! [String: Any], context = configuration["context"] as! [String: Any]
        context["retention"] = retention; configuration["context"] = context
        var subscription = configuration["subscription"] as! [String: Any]
        subscription["sourceParticipantIds"] = [(subscription["sourceParticipantIds"] as! [String])[0]]
        configuration["subscription"] = subscription
        var grant = fixture["grant"] as! [String: Any]
        grant["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))
        return try JSONSerialization.data(withJSONObject: ["role": "a", "peer": ["role": "b",
            "participantId": (subscription["sourceParticipantIds"] as! [String])[0]], "allowedLanguages": ["en", "zh", "ja"],
            "configuration": configuration, "grant": grant])
    }
    func testCompanionJoinsOnlyTheLoopbackRoleWithoutProjectCredentials() async throws {
        let transport = LabFixture(try body())
        let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
        let joined = try await host.join()
        try require(joined.role == "a" && joined.configuration.context.retention == .textOnly)
        let request = transport.requests[0]
        try require(request.url?.absoluteString == "http://127.0.0.1:4173/speech-host/join")
        try require(request.value(forHTTPHeaderField: "Origin") == origin.absoluteString)
        try require(request.value(forHTTPHeaderField: "X-Speech-Code") == code)
        try require(request.value(forHTTPHeaderField: "Authorization") == nil)
        try require(request.httpBody == Data("{}".utf8))
        await host.close()
        do { _ = try await host.renewGrant(); throw CheckFailure(message: "Closed host reused") }
        catch is LabFailure {}
        try require(transport.requests.count == 1)
    }
    func testCompanionRefusesUnsupportedRetentionAndForeignOriginsBeforeCapture() async throws {
        for url in ["https://remote.invalid", "http://localhost:4173", "http://127.0.0.1:4173/path", "http://user@127.0.0.1:4173"] {
            let transport = LabFixture(try body())
            do { _ = try LabHost(origin: URL(string: url)!, role: "a", code: code, transport: transport)
                throw CheckFailure(message: "Foreign lab origin accepted") }
            catch LabFailure.invalidConfiguration {}
            try require(transport.requests.isEmpty)
        }
        let transport = LabFixture(try body(retention: "original_audio_and_text"))
        let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
        do { _ = try await host.join(); throw CheckFailure(message: "Unsupported archival accepted") }
        catch LabFailure.unsupportedSession {}
        await host.close()
    }
    func testCompanionRetirementRejectsLateBootstrap() async throws {
        let transport = LabFixture(try body()); transport.holdFirst = true
        let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
        let joining = Task { try await host.join() }; try await transport.entered.wait()
        await host.close()
        do { _ = try await joining.value; throw CheckFailure(message: "Late bootstrap survived close") }
        catch LabFailure.closed {}
    }
    func testCompanionDoesNotStartConcurrentBootstrapRequests() async throws {
        let transport = LabFixture(try body()); transport.holdFirst = true
        let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
        let first = Task { try await host.join() }; try await transport.entered.wait()
        do { _ = try await host.join(); await host.close(); _ = try? await first.value
            throw CheckFailure(message: "Concurrent bootstrap accepted") }
        catch LabFailure.conflict {}
        transport.released.open(); _ = try await first.value
        try require(transport.requests.count == 1); await host.close()
    }
    func testCompanionBoundsResponsesAndDoesNotRetryDeniedRequests() async throws {
        for (body, status) in [(Data(repeating: 1, count: 524_289), 200), (Data("private upstream error".utf8), 403)] {
            let transport = LabFixture(body, status: status)
            let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
            do { _ = try await host.join(); throw CheckFailure(message: "Invalid response accepted") }
            catch let failure as SpeechHostFailure { try require(failure == (status == 403 ? .unauthorized : .unavailable)) }
            try require(transport.requests.count == 1); await host.close()
        }
    }
    func testCompanionFinishUsesExplicitNullBoundariesAndAcceptsPendingResponse() async throws {
        let transport = LabFixture(try body())
        let pending = Data("{\"source\":null}".utf8)
        transport.responses["finish"] = LabResponse(status: 202, body: pending)
        let host = try LabHost(origin: origin, role: "a", code: code, transport: transport)
        let joined = try await host.join(), context = joined.configuration.context
        let request = try JSONDecoder().decode(SpeechFinishRequest.self, from: JSONSerialization.data(withJSONObject: [
            "requestId": 1, "projectId": context.projectId, "sessionId": context.sessionId,
            "participantId": context.participantId, "memberGeneration": context.memberGeneration,
            "workerGeneration": joined.grant.workerGeneration, "trackSid": "TR_input",
            "sourceId": NSNull(), "sourceEpoch": NSNull()
        ]))
        let result = try await host.finishSource(request: request)
        try require(result == pending)
        let sent = try JSONSerialization.jsonObject(with: transport.requests.last!.httpBody!) as! [String: Any]
        try require(sent["sourceId"] is NSNull && sent["sourceEpoch"] is NSNull, "Finish omitted explicit unknown boundaries")
        try require(sent["trackSid"] as? String == "TR_input")
        try require(transport.requests.count == 2)
        await host.close()
    }
    @MainActor
    func testCompanionAppUsesTheNativeOwnerAndClearsOnLeave() async throws {
        let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
        let model = CompanionModel(transport: { transport }, requestMicrophone: { true }, media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        await model.join(origin: origin, role: "a", code: code)
        try require(model.connected, "App did not join: \(model.notice); requests=\(transport.requests.compactMap { $0.url?.lastPathComponent })")
        try require(!room.captureEnabled && !model.inputEnabled && !model.listeningEnabled, "App joined with active media")
        await model.setInput(true); try require(room.captureEnabled, "App input did not start")
        await model.setListening(true); try require(room.captureEnabled && model.listeningEnabled, "Listening interrupted input")
        await model.setListening(false); try require(room.captureEnabled && !model.listeningEnabled, "Listening stop interrupted input")
        await model.leave()
        try require(!model.connected && model.pairs.isEmpty && !model.inputEnabled && !model.listeningEnabled, "Leave retained visible state")
        try require(!model.cleanupFailed, "Native cleanup failed")
    }
    @MainActor
    func testCompanionPairsCaptionsAndClearsOnLanguageChange() async throws {
        let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
        let join = try JSONDecoder().decode(LabJoin.self, from: body())
        transport.responses["subscription"] = LabResponse(status: 200, body: try JSONSerialization.data(withJSONObject: [
            "revision": 2, "targetLanguage": "ja", "mode": "translated", "sourceParticipantIds": [join.peer.participantId]
        ]))
        let model = CompanionModel(transport: { transport }, requestMicrophone: { true },
            media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        await model.join(origin: origin, role: "a", code: code)
        let context = join.configuration.context
        let common: [String: Any] = ["protocolVersion": 1, "projectId": context.projectId,
            "sessionId": context.sessionId, "retention": context.retention.rawValue,
            "participantId": context.participantId, "memberGeneration": context.memberGeneration,
            "workerGeneration": join.grant.workerGeneration, "subscriptionRevision": 1]
        func emit(_ fields: [String: Any]) throws {
            let event = common.merging(fields) { _, value in value }
            room.events?.text(join.grant.processorIdentity, String(decoding: try JSONSerialization.data(withJSONObject: event), as: UTF8.self))
        }
        try emit(["type": "subscription_applied", "targetLanguage": "zh", "mode": "translated"])
        let source = "44444444-4444-4444-8444-444444444444"
        var record: [String: Any] = ["protocolVersion": 1, "projectId": context.projectId,
            "sessionId": context.sessionId, "retention": context.retention.rawValue,
            "sourceId": source, "sourceEpoch": 1, "sourceParticipantId": join.peer.participantId,
            "sourceMemberGeneration": 1, "unitId": source + ":1:1:1", "sourceFirstSeq": 1,
            "sourceLastSeq": 1, "startMs": 0, "endMs": 100, "sourceLanguage": "en", "text": "Hello"]
        func caption(_ sequence: Int) throws {
            try emit(["type": "caption", "eventSequence": sequence, "sourceId": source, "sourceEpoch": 1,
                "sourceParticipantId": join.peer.participantId, "sourceMemberGeneration": 1, "record": record, "final": true])
        }
        let visible = Gate()
        let observer = model.$pairs.sink { pairs in
            if pairs.count == 1 && pairs[0].original == "Hello" && pairs[0].translation == "Translated" { visible.open() }
        }
        try caption(1); record["targetLanguage"] = "zh"; record["text"] = "Translated"; try caption(2)
        try await visible.wait()
        try require(model.pairs[0].originalFinal && model.pairs[0].translationFinal)
        // Queue a valid native caption before the UI task starts changing language.
        record.removeValue(forKey: "targetLanguage"); record["text"] = "Late old language"
        record["unitId"] = source + ":1:2:2"; record["sourceFirstSeq"] = 2; record["sourceLastSeq"] = 2
        try caption(3)
        await model.select(language: "ja", mode: .translated)
        try require(model.connected && model.language == "ja" && model.pairs.isEmpty, "Queued old-language caption survived selection")
        observer.cancel(); await model.leave()
    }
    @MainActor
    func testCompanionFinishKeepsListeningAndFailedCleanupBlocksReentry() async throws {
        let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
        let join = try JSONDecoder().decode(LabJoin.self, from: body())
        transport.responses["finish"] = LabResponse(status: 202, body: try JSONSerialization.data(withJSONObject: [
            "source": ["id": "44444444-4444-4444-8444-444444444444", "epoch": 1,
                "participant_id": join.grant.participantId, "member_generation": join.grant.memberGeneration,
                "track_sid": "TR_input", "state": "ended", "finish": ["state": "completed",
                    "worker_generation": join.grant.workerGeneration, "sequence": "2", "samples": "3200"]]
        ]))
        let model = CompanionModel(transport: { transport }, requestMicrophone: { true },
            media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
        await model.join(origin: origin, role: "a", code: code)
        await model.setInput(true); await model.setListening(true); await model.finish()
        try require(model.connected && model.listeningEnabled && !model.inputEnabled && !room.captureEnabled)
        try require(model.notice == "Input finished. Listening remains available.")
        room.releaseFails = true
        await model.leave()
        try require(model.cleanupFailed && model.pairs.isEmpty)
        let count = transport.requests.count
        await model.join(origin: origin, role: "a", code: code)
        try require(!model.connected && transport.requests.count == count, "Failed native cleanup admitted a successor")
    }
    @MainActor
    func testCompanionPermissionDenialAndLateApprovalNeverStartInput() async throws {
        for delayed in [false, true] {
            let transport = LabFixture(try body()), room = FakeRoom(), output = FakeOutput()
            let asked = Gate(), approved = Gate()
            let model = CompanionModel(transport: { transport }, requestMicrophone: {
                asked.open()
                if delayed { try? await approved.wait(); return true }
                return false
            }, media: { try LiveKitSpeechMedia(room: room, output: output, callbacks: $0) })
            await model.join(origin: origin, role: "a", code: code)
            let input = Task { await model.setInput(true) }
            try await asked.wait()
            if delayed { await model.leave(); approved.open() }
            await input.value
            try require(!room.captureEnabled && !model.inputEnabled, "Unapproved or retired input started capture")
            if !delayed { try require(model.connected && model.notice.contains("permission")) }
            await model.leave()
        }
    }
    @MainActor
    func testCompanionAppJoinsLateBootstrapBeforeAllowingAnotherOwner() async throws {
        let transport = LabFixture(try body()); transport.holdFirst = true
        let model = CompanionModel(transport: { transport }, requestMicrophone: { true }, media: { _ in throw CheckFailure(message: "Retired join created media") })
        let joining = Task { await model.join(origin: origin, role: "a", code: code) }
        try await transport.entered.wait()
        await model.leave(); await joining.value
        try require(!model.connected && !model.joining && !model.closing && !model.cleanupFailed)
    }
}
