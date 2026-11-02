import AVFAudio
@testable import BotaAppSDK
@testable import BotaSpeechLiveKit
import Foundation

struct CheckFailure: Error { let message: String }
func require(_ condition: @autoclosure () throws -> Bool, _ message: String = "Speech media check failed") throws {
    if try !condition() { throw CheckFailure(message: message) }
}

final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    var isOpen: Bool { lock.withLock { opened } }
    private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    func wait() async throws {
        let id = UUID()
        let completed = await withCheckedContinuation { done in
            let ready = lock.withLock { if opened { return true }; waiters[id] = done; return false }
            if ready { done.resume(returning: true) }
            else {
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    lock.withLock { waiters.removeValue(forKey: id) }?.resume(returning: false)
                }
            }
        }
        try require(completed, "Native phase did not settle within the test watchdog")
    }
    func open() {
        let pending = lock.withLock { opened = true; defer { waiters.removeAll() }; return Array(waiters.values) }
        pending.forEach { $0.resume(returning: true) }
    }
}

final class FakeInput: RTCInput, @unchecked Sendable {
    private let lock = NSLock()
    private var disposals = 0
    var disposalCount: Int { lock.withLock { disposals } }
    var disposeFails = false
    let sid: String? = "TR_input"
    let disposed = Gate()
    func dispose() async throws {
        lock.withLock { disposals += 1 }; disposed.open()
        if disposeFails { throw SpeechError.cleanupFailed }
    }
}

final class FakeRoom: RTCRoom, @unchecked Sendable {
    private let lock = NSLock()
    private var enabled = false
    var captureEnabled: Bool { lock.withLock { enabled } }
    var events: RTCEvents?
    let input = FakeInput()
    let acquiring = Gate()
    var acquireGate: Gate?
    var publishFails = false
    var releaseFails = false
    let released = Gate()
    let disconnected = Gate()
    func observe(_ events: RTCEvents?) { self.events = events }
    func connect(_ grant: SpeechGrant) async throws {}
    func createInput() async throws -> any RTCInput {
        acquiring.open()
        if let acquireGate { try await acquireGate.wait() }
        return input
    }
    func publish(_ input: any RTCInput) async throws { if publishFails { throw SpeechError.mediaFailed } }
    func unpublish(_ input: any RTCInput) async throws {}
    func capture(_ enabled: Bool) throws { lock.withLock { self.enabled = enabled } }
    func subscribe(_ sids: Set<String>) throws {}
    func disconnect() async { disconnected.open() }
    func release() async throws { released.open(); if releaseFails { throw SpeechError.cleanupFailed } }
}

final class FakeOutput: PCMOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var sids = Set<String>()
    var selected: Set<String> { lock.withLock { sids } }
    var clearGate: Gate?
    var drainGate: Gate?
    let clearing = Gate()
    let draining = Gate()
    let audible = Gate()
    func silence() throws { lock.withLock { sids = [] } }
    func select(_ sids: Set<String>) throws { lock.withLock { self.sids = sids }; if !sids.isEmpty { audible.open() } }
    func frame(_ sid: String, _ frame: PCMFrame) {}
    func clear() async throws { clearing.open(); if let clearGate { try await clearGate.wait() } }
    func drain(_ sid: String) async throws { draining.open(); if let drainGate { try await drainGate.wait() } }
    func close() async throws {}
}

final class Notices: @unchecked Sendable {
    let removed = Gate()
    let failed = Gate()
    var callbacks: SpeechMediaCallbacks {
        SpeechMediaCallbacks(text: { _, _ in }, trackRemoved: { _ in self.removed.open() },
            disconnected: { self.failed.open() }, failed: { self.failed.open() }, playbackBlocked: {})
    }
}

final class MediaChecks: @unchecked Sendable {
    private let grant = SpeechGrant(protocolVersion: 1, provider: "livekit", url: "wss://example.invalid",
        room: "room", identity: "listener", token: "redacted", expiresAt: "2099-01-01T00:00:00Z",
        sessionId: "session", participantId: "participant", memberGeneration: 1, workerGeneration: 1,
        processorIdentity: "processor")
    private var track: SpeechTrack {
        get throws {
            try JSONDecoder().decode(SpeechTrack.self, from: Data("""
            {"mediaTrackSid":"TR_output","sourceId":"source","sourceEpoch":1,
             "sourceParticipantId":"speaker","origin":"generated","outputId":"output"}
            """.utf8))
        }
    }

    func testConnectionStartsNeitherCaptureNorPlayback() async throws {
        let room = FakeRoom(); let output = FakeOutput()
        let media = LiveKitSpeechMedia(room: room, output: output, callbacks: Notices().callbacks)
        try await media.connect(grant: grant)
        try require(!room.captureEnabled); try require(output.selected.isEmpty)
        try await media.close()
    }

    func testHoldSurvivesLateAcquisitionWithoutInterruptingListening() async throws {
        let room = FakeRoom(); let output = FakeOutput(); let acquired = Gate()
        room.acquireGate = acquired
        let media = LiveKitSpeechMedia(room: room, output: output, callbacks: Notices().callbacks)
        try await media.connect(grant: grant); try await media.setPlayback(tracks: [track])
        let start = Task { try await media.setInput(enabled: true) }
        try await room.acquiring.wait(); try media.holdInput(); acquired.open(); try await start.value
        try require(!room.captureEnabled); try require(media.inputPublication() == "TR_input")
        try require(output.selected == ["TR_output"])
        try await media.close()
    }

    func testCloseJoinsAcquisitionEvenWhenItsPublicWaiterIsCancelled() async throws {
        let room = FakeRoom(); let acquired = Gate(); room.acquireGate = acquired
        let media = LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: Notices().callbacks)
        try await media.connect(grant: grant)
        let start = Task { try await media.setInput(enabled: true) }
        try await room.acquiring.wait(); start.cancel()
        let close = Task { try await media.close() }
        acquired.open(); _ = await start.result; try await close.value
        try await room.input.disposed.wait(); try await room.released.wait()
        try require(!room.captureEnabled)
    }

    func testClearWaitsForNativeFlushWhileCaptureContinues() async throws {
        let room = FakeRoom(); let output = FakeOutput(); let flushed = Gate(); output.clearGate = flushed
        let media = LiveKitSpeechMedia(room: room, output: output, callbacks: Notices().callbacks)
        try await media.connect(grant: grant); try await media.setInput(enabled: true)
        try await media.setPlayback(tracks: [track])
        let clear = Task { try await media.clearPlayback() }
        try await output.clearing.wait()
        try require(room.captureEnabled); try require(output.selected.isEmpty)
        flushed.open(); try await clear.value; try await media.close()
    }

    func testFailedPublicationIsDisposedAndNotRetained() async throws {
        let room = FakeRoom(); room.publishFails = true
        let media = LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: Notices().callbacks)
        try await media.connect(grant: grant)
        var failed = false
        do { try await media.setInput(enabled: true) } catch { failed = true }
        try require(failed, "Publication should fail")
        try require(media.inputPublication() == nil); try await room.input.disposed.wait()
        try await media.close()
    }

    func testCleanupFailureRemainsTheResultForEveryCloseCaller() async throws {
        let room = FakeRoom(); room.releaseFails = true
        let media = LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: Notices().callbacks)
        try await media.connect(grant: grant)
        for _ in 0..<2 {
            var result: SpeechError?
            do { try await media.close() } catch { result = error as? SpeechError }
            try require(result == .cleanupFailed, "Cleanup failure was forgotten")
        }
    }

    func testPublicSessionExecutesActualRustPolicyThroughTheAdapter() async throws {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("protocol/speech-session/client-v1.json").path) {
            let parent = root.deletingLastPathComponent()
            guard parent != root else { throw CheckFailure(message: "Canonical speech fixture missing") }
            root = parent
        }
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("protocol/speech-session/client-v1.json"))) as! [String: Any]
        let configuration = try JSONDecoder().decode(SpeechConfiguration.self,
            from: JSONSerialization.data(withJSONObject: fixture["configuration"]!))
        var credential = fixture["grant"] as! [String: Any]
        credential["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))
        let grant = try JSONDecoder().decode(SpeechGrant.self, from: JSONSerialization.data(withJSONObject: credential))
        struct Host: SpeechHostCallbacks {
            let grant: SpeechGrant
            func renewGrant() async throws -> SpeechGrant { grant }
            func changeSubscription(selection: SpeechSelection) async throws -> SpeechSubscription {
                .init(revision: 2, selection: selection)
            }
        }
        let room = FakeRoom(); let output = FakeOutput()
        let session = try SpeechSession(configuration: configuration, grant: grant,
            mediaFactory: { LiveKitSpeechMedia(room: room, output: output, callbacks: $0) }, host: Host(grant: grant))
        do {
            try await session.ready(); try await session.setInput(true); try await session.setListening(true)
            try require(room.captureEnabled)
            var event: [String: Any] = ["protocolVersion": 1, "projectId": configuration.context.projectId,
                "sessionId": grant.sessionId, "retention": "live_only", "type": "subscription_applied",
                "workerGeneration": grant.workerGeneration, "participantId": grant.participantId,
                "memberGeneration": grant.memberGeneration, "subscriptionRevision": 1, "targetLanguage": "zh", "mode": "translated"]
            func text(_ value: [String: Any]) throws -> String {
                String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
            }
            room.events!.text(grant.processorIdentity, try text(event))
            event["mode"] = nil
            event.merge(["type": "audio_start", "eventSequence": 1,
                "sourceId": "44444444-4444-4444-8444-444444444444", "sourceEpoch": 1,
                "sourceParticipantId": "33333333-3333-4333-8333-333333333333", "sourceMemberGeneration": 1,
                "unitId": "unit_1", "outputId": "output_1", "transport": "webrtc", "codec": "opus",
                "sourceSampleRate": 24000, "channels": 1, "origin": "generated", "voice": "neutral", "mediaTrackSid": "TR_output"],
                uniquingKeysWith: { _, current in current })
            room.events!.text(grant.processorIdentity, try text(event))
            try await output.audible.wait()
            try require(output.selected == ["TR_output"])
            try await session.setListening(false)
            try require(room.captureEnabled); try require(output.selected.isEmpty)
            try await session.setInput(false); try await session.close()
        } catch { try? await session.close(); throw error }
    }

    func testLateUnownedInputCleanupRunsOnceAndRemainsFailed() async throws {
        let room = FakeRoom(); let acquired = Gate(); room.acquireGate = acquired; room.input.disposeFails = true
        let media = LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: Notices().callbacks)
        try await media.connect(grant: grant)
        let start = Task { try await media.setInput(enabled: true) }
        try await room.acquiring.wait()
        let close = Task { try await media.close() }
        try await room.disconnected.wait(); acquired.open()
        _ = await start.result
        var result: SpeechError?
        do { try await close.value } catch { result = error as? SpeechError }
        try require(result == .cleanupFailed)
        try require(room.input.disposalCount == 1, "A late unowned input must be disposed exactly once")
    }

    func testUnpublicationWaitsForTheNativePlaybackTail() async throws {
        let room = FakeRoom(); let output = FakeOutput(); let notices = Notices(); let tail = Gate()
        output.drainGate = tail
        let media = LiveKitSpeechMedia(room: room, output: output, callbacks: notices.callbacks)
        try await media.connect(grant: grant); try await media.setPlayback(tracks: [track])
        room.events!.removed("TR_output"); try await output.draining.wait()
        try require(!notices.removed.isOpen); try require(output.selected == ["TR_output"])
        tail.open(); try await notices.removed.wait(); try await media.close()
    }

    func testRetiredTailCannotRemoveANewerSelection() async throws {
        let room = FakeRoom(); let output = FakeOutput(); let notices = Notices(); let tail = Gate()
        output.drainGate = tail
        let media = LiveKitSpeechMedia(room: room, output: output, callbacks: notices.callbacks)
        try await media.connect(grant: grant); try await media.setPlayback(tracks: [track])
        room.events!.removed("TR_output"); try await output.draining.wait()
        try await media.clearPlayback(); try await media.setPlayback(tracks: [track])
        tail.open(); try await media.close()
        try require(!notices.removed.isOpen)
    }
}
