import AVFAudio
import BotaAppSDK
import Foundation
import LiveKit

/// Public LiveKit 2.18.0 APIs only. Track authority remains in the shared Rust owner.
final class VendorRoom: NSObject, RTCRoom, RoomDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let work = MediaTasks()
    private let readers = MediaTasks()
    private let nativeRoom = Room(connectOptions: ConnectOptions(autoSubscribe: false, reconnectAttempts: 0))
    private var events: RTCEvents?
    private var processor = ""
    private var allowed = Set<String>()
    private var retired = false
    private var reading = 0
    private struct Sink { let track: RemoteAudioTrack; let renderer: VendorRenderer }
    private var sinks: [String: Sink] = [:]
    private let externalInput: ExternalPCMInput?

    init(externalInput: ExternalPCMInput? = nil) {
        self.externalInput = externalInput
        super.init()
        nativeRoom.add(delegate: self)
    }
    func observe(_ events: RTCEvents?) { lock.withLock { self.events = events } }
    private func failure() { lock.withLock { retired ? nil : events }?.failed() }

    func connect(_ grant: SpeechGrant) async throws {
        lock.withLock { processor = grant.processorIdentity }
        try await nativeRoom.registerTextStreamHandler(for: "bota.speech.v1") { [weak self] reader, sender in
            guard let self else { return }
            let accepted = self.lock.withLock {
                guard !self.retired, sender.stringValue == self.processor, self.reading < 8 else { return false }
                self.reading += 1
                return true
            }
            guard accepted else { self.failure(); throw SpeechError.mediaFailed }
            defer { self.lock.withLock { self.reading -= 1 } }
            do {
                let task = try self.readers.submit {
                    let text = try await boundedText(reader)
                    self.lock.withLock { self.retired ? nil : self.events }?.text(sender.stringValue, text)
                }
                try await task.value
            } catch { self.failure(); throw SpeechError.mediaFailed }
        }
        try await nativeRoom.connect(url: grant.url, token: grant.token)
        guard nativeRoom.name == grant.room, nativeRoom.localParticipant.identity?.stringValue == grant.identity else {
            throw SpeechError.mediaFailed
        }
    }

    private final class Input: RTCInput, @unchecked Sendable {
        let track: LocalAudioTrack
        private let lock = NSLock()
        private var publication: LocalTrackPublication?
        var sid: String? { lock.withLock { publication?.sid.stringValue } }
        init(_ track: LocalAudioTrack) { self.track = track }
        func published(_ value: LocalTrackPublication) { lock.withLock { publication = value } }
        func dispose() async throws {
            var failed = false
            do { try await track.stop() } catch { failed = true }
            // LocalAudioTrack.stop only retires its frame watcher in the pinned SDK. Join the
            // explicit recording start as well; this adapter exclusively owns the vendor engine.
            do { try AudioManager.shared.stopLocalRecording() } catch { failed = true }
            if failed { throw SpeechError.cleanupFailed }
        }
    }
    func createInput() async throws -> any RTCInput {
        Input(await LocalAudioTrack.createTrack(name: "bota-original",
            options: externalInput == nil ? AudioCaptureOptions() : .noProcessing))
    }
    func publish(_ input: any RTCInput) async throws {
        guard let input = input as? Input else { throw SpeechError.invalidInput }
        let publication = try await nativeRoom.localParticipant.publish(audioTrack: input.track,
            options: AudioPublishOptions(name: "bota-original", preConnect: false))
        input.published(publication)
    }
    func unpublish(_ input: any RTCInput) async throws {
        guard let input = input as? Input else { throw SpeechError.invalidInput }
        for publication in nativeRoom.localParticipant.localAudioTracks where publication.track === input.track {
            try await nativeRoom.localParticipant.unpublish(publication: publication)
        }
    }
    func capture(_ enabled: Bool) throws {
        if let externalInput {
            guard AudioManager.shared.isManualRenderingMode else { externalInput.end(); throw SpeechError.mediaFailed }
            externalInput.capture(enabled)
        } else { AudioManager.shared.mixer.micVolume = enabled ? 1 : 0 }
    }

    func subscribe(_ sids: Set<String>) throws {
        lock.withLock { allowed = retired ? [] : sids }
        refresh()
    }
    private func refresh() {
        _ = try? work.submit(serial: true) { [self] in
            guard !lock.withLock({ retired }) else { return }
            do {
                let removed = lock.withLock { () -> [Sink] in
                    let keys = sinks.keys.filter { !allowed.contains($0) }
                    return keys.compactMap { sinks.removeValue(forKey: $0) }
                }
                for sink in removed { sink.track.remove(audioRenderer: sink.renderer) }
                for participant in nativeRoom.remoteParticipants.values {
                    for publication in participant.trackPublications.values {
                        guard let publication = publication as? RemoteTrackPublication else { continue }
                        let sid = publication.sid.stringValue
                        let desired = lock.withLock {
                            !retired && participant.identity?.stringValue == processor &&
                                publication.kind == .audio && allowed.contains(sid)
                        }
                        try await publication.set(subscribed: desired)
                        if desired, let track = publication.track as? RemoteAudioTrack { attach(track, sid: sid) }
                    }
                }
            } catch { failure() }
        }
    }

    private func attach(_ track: RemoteAudioTrack, sid: String) {
        let identity = UUID()
        let renderer = VendorRenderer(active: { [weak self] in
            guard let self else { return false }
            return self.lock.withLock { !self.retired && self.allowed.contains(sid) && self.sinks[sid]?.renderer.id == identity }
        }, frame: { [weak self] frame in
            guard let self else { return }
            self.lock.withLock { self.retired ? nil : self.events }?.frame(sid, frame)
        }, failed: { [weak self] in self?.failure() }, id: identity)
        let old = lock.withLock { () -> Sink? in
            guard !retired, allowed.contains(sid), sinks[sid]?.track !== track else { return nil }
            let old = sinks[sid]; sinks[sid] = Sink(track: track, renderer: renderer)
            return old
        }
        guard lock.withLock({ sinks[sid]?.renderer === renderer }) else { return }
        if let old { old.track.remove(audioRenderer: old.renderer) }
        track.add(audioRenderer: renderer)
    }

    func disconnect() async { await nativeRoom.disconnect() }
    func release() async throws {
        lock.withLock { retired = true; events = nil; allowed = [] }
        let pending = work.retire() + readers.retire()
        pending.forEach { $0.cancel() }
        await nativeRoom.disconnect()
        for task in pending { _ = await task.result }
        await nativeRoom.unregisterTextStreamHandler(for: "bota.speech.v1")
        nativeRoom.remove(delegate: self)
        let old = lock.withLock { defer { sinks.removeAll() }; return Array(sinks.values) }
        for sink in old { sink.track.remove(audioRenderer: sink.renderer) }
        try AudioManager.shared.stopLocalRecording()
    }

    func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) { refresh() }
    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { refresh() }
    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        remove(publication.sid.stringValue, notify: false)
    }
    func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) {
        guard lock.withLock({ participant.identity?.stringValue == processor }) else { return }
        remove(publication.sid.stringValue, notify: true)
    }
    private func remove(_ sid: String, notify: Bool) {
        _ = try? work.submit(serial: true) { [self] in
            let old = lock.withLock { sinks.removeValue(forKey: sid) }
            if let old { old.track.remove(audioRenderer: old.renderer) }
            if notify { lock.withLock { retired ? nil : events }?.removed(sid) }
        }
    }
    func room(_ room: Room, didStartReconnectWithMode mode: ReconnectMode) { failure() }
    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) { failure() }
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) { failure() }
    func room(_ room: Room, participant: RemoteParticipant, didFailToSubscribeTrackWithSid sid: Track.Sid, error: LiveKitError) { failure() }
}

private func boundedText(_ reader: TextStreamReader) async throws -> String {
    try await withThrowingTaskGroup(of: String.self) { group in
        group.addTask {
            var text = ""; var bytes = 0
            for try await chunk in reader {
                bytes += chunk.utf8.count
                guard bytes <= 32 * 1024 else { throw SpeechError.mediaFailed }
                text.append(chunk)
            }
            return text
        }
        group.addTask { try await Task.sleep(nanoseconds: 5_000_000_000); throw SpeechError.mediaTimeout }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw SpeechError.mediaFailed }
        return result
    }
}

/// Errors leave the native render thread before they can remove that same renderer.
final class VendorRenderer: NSObject, AudioRenderer, @unchecked Sendable {
    let id: UUID
    private let lock = NSLock()
    private var rejected = false
    private let active: @Sendable () -> Bool
    private let frame: @Sendable (PCMFrame) -> Void
    private let failed: @Sendable () -> Void
    init(active: @escaping @Sendable () -> Bool, frame: @escaping @Sendable (PCMFrame) -> Void,
         failed: @escaping @Sendable () -> Void, id: UUID = UUID()) {
        self.active = active; self.frame = frame; self.failed = failed; self.id = id
    }
    func render(pcmBuffer: AVAudioPCMBuffer) {
        guard active(), !lock.withLock({ rejected }) else { return }
        do { frame(try PCMFrame.copy(pcmBuffer)) }
        catch {
            let first = lock.withLock { defer { rejected = true }; return !rejected }
            if first { DispatchQueue.global().async { [self] in if active() { failed() } } }
        }
    }
}
