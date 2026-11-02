import BotaAppSDK
import Foundation

/// Optional microphone media port. The host supplies permission, grants and exclusive audio ownership.
public final class LiveKitSpeechMedia: SpeechMediaPort, @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private let room: any RTCRoom
    private let output: any PCMOutput
    private let callbacks: SpeechMediaCallbacks
    private let inputTasks = MediaTasks()
    private let outputTasks = MediaTasks()
    private let otherTasks = MediaTasks()
    private var closing: Task<Void, any Error>?
    private var closed = false
    private var attempted = false
    private var connected = false
    private var held = false
    private var inputVersion: UInt64 = 0
    private var playbackVersion: UInt64 = 0
    private var input: (any RTCInput)?
    private var cleanupFailed = false
    private let onCleanClose: @Sendable () throws -> Void

    init(room: any RTCRoom, output: any PCMOutput, callbacks: SpeechMediaCallbacks,
         onCleanClose: @escaping @Sendable () throws -> Void = {}) {
        self.room = room; self.output = output; self.callbacks = callbacks; self.onCleanClose = onCleanClose
        room.observe(RTCEvents(text: { [weak self] sender, text in
            guard let self, self.lock.withLock({ !self.closed }) else { return }
            self.callbacks.text(sender, text)
        }, frame: { [weak output] sid, frame in
            // Native render callbacks never acquire the media owner lock during sink removal.
            output?.frame(sid, frame)
        }, removed: { [weak self] sid in self?.removed(sid) }, failed: { [weak self] in self?.fail() }))
    }

    public static func create(callbacks: SpeechMediaCallbacks) throws -> LiveKitSpeechMedia {
        let lease = try VendorAudioLease.acquire()
        let output = ApplePCMOutput(failed: { callbacks.playbackBlocked() })
        return LiveKitSpeechMedia(room: VendorRoom(), output: output, callbacks: callbacks,
            onCleanClose: { try lease.release() })
    }

    private func checkOpen() throws { if closed { throw SpeechError.closed } }

    public func connect(grant: SpeechGrant) async throws {
        let task = try lock.withLock {
            try checkOpen()
            guard !attempted, grant.provider == "livekit" else { throw SpeechError.invalidInput }
            attempted = true
            return try otherTasks.submit { [self] in
                try await room.connect(grant)
                try lock.withLock { try checkOpen(); connected = true }
            }
        }
        try await task.value
    }

    public func muteInput() throws {
        try lock.withLock { inputVersion &+= 1; try room.capture(false) }
    }
    public func silencePlayback() throws {
        try lock.withLock {
            playbackVersion &+= 1
            try output.silence()
            try room.subscribe([])
        }
    }
    public var supportsSourceFinish: Bool { true }
    public func holdInput() throws {
        try lock.withLock { try checkOpen(); held = true; try room.capture(false) }
    }
    public func inputPublication() throws -> String? {
        try lock.withLock {
            try checkOpen()
            guard let input else { return nil }
            guard let sid = input.sid, !sid.isEmpty else { throw SpeechError.mediaFailed }
            return sid
        }
    }

    public func setInput(enabled: Bool) async throws {
        let task = try lock.withLock {
            try checkOpen()
            if !enabled { try muteInput() }
            let version = inputVersion
            return try inputTasks.submit(serial: true) { [self] in
                if !enabled {
                    let old = lock.withLock { defer { input = nil }; return input }
                    if let old { try await dispose(old) }
                    lock.withLock { held = false }
                    return
                }
                let start = try lock.withLock {
                    try checkOpen()
                    guard version == inputVersion else { return false }
                    guard connected else { throw SpeechError.mediaFailed }
                    if input != nil { try room.capture(!held); return false }
                    return true
                }
                guard start else { return }
                let acquired = try await room.createInput()
                var retained = false
                var failure: (any Error)?
                do {
                    let current = try lock.withLock {
                        try room.capture(false)
                        guard !closed, version == inputVersion else { return false }
                        input = acquired
                        return true
                    }
                    if current {
                        try await room.publish(acquired)
                        retained = try lock.withLock {
                            guard !closed, version == inputVersion else { return false }
                            guard let sid = acquired.sid, !sid.isEmpty else { throw SpeechError.mediaFailed }
                            try room.capture(!held)
                            return true
                        }
                    }
                } catch { failure = error }
                if retained { return }
                lock.withLock { if input === acquired { input = nil } }
                try await dispose(acquired)
                if let failure { throw failure }
            }
        }
        try await task.value
    }

    private func dispose(_ input: any RTCInput) async throws {
        var failed = false
        do { try await room.unpublish(input) } catch { failed = true }
        do { try await input.dispose() } catch { failed = true }
        if failed { lock.withLock { cleanupFailed = true }; throw SpeechError.cleanupFailed }
    }

    public func setPlayback(tracks: [SpeechTrack]) async throws {
        let task = try lock.withLock {
            try checkOpen()
            let version = playbackVersion
            let sids = Set(tracks.map(\.mediaTrackSid))
            guard sids.count <= 16 else { throw SpeechError.mediaFailed }
            return try outputTasks.submit(serial: true) { [self] in
                try lock.withLock {
                    try checkOpen()
                    guard version == playbackVersion else { return }
                    try output.select(sids)
                    try room.subscribe(sids)
                }
            }
        }
        try await task.value
    }

    public func clearPlayback() async throws {
        let task = try lock.withLock {
            try checkOpen(); try silencePlayback()
            return try outputTasks.submit(serial: true) { [self] in try await output.clear() }
        }
        try await task.value
    }
    public func resumeAudio() async throws { try lock.withLock { try checkOpen() } }

    private func removed(_ sid: String) {
        lock.withLock {
            guard !closed else { return }
            let version = playbackVersion
            _ = try? otherTasks.submit { [self] in
                do {
                    try await output.drain(sid)
                    if lock.withLock({ !closed && playbackVersion == version }) { callbacks.trackRemoved(sid) }
                } catch {
                    if lock.withLock({ !closed }) {
                        do { try silencePlayback(); callbacks.playbackBlocked() }
                        catch { fail() }
                    }
                }
            }
        }
    }

    private func fail() {
        let notify = lock.withLock {
            guard !closed else { return false }
            do { try silencePlayback() } catch { cleanupFailed = true }
            do { try muteInput() } catch { cleanupFailed = true }
            return true
        }
        if notify { callbacks.failed() }
    }

    public func close() async throws {
        let task = lock.withLock {
            if let closing { return closing }
            closed = true; connected = false; room.observe(nil)
            do { try silencePlayback() } catch { cleanupFailed = true }
            do { try muteInput() } catch { cleanupFailed = true }
            let pending = inputTasks.retire() + outputTasks.retire() + otherTasks.retire()
            let task = Task { [self] in
                // Disconnect wakes vendor operations; joining still proves their actual settlement.
                await room.disconnect()
                for operation in pending { _ = await operation.result }
                var failed = false
                let old = lock.withLock { defer { input = nil }; return input }
                if let old { do { try await dispose(old) } catch { failed = true } }
                do { try await output.close() } catch { failed = true }
                await room.disconnect()
                do { try await room.release() } catch { failed = true }
                guard !failed, !lock.withLock({ cleanupFailed }) else { throw SpeechError.cleanupFailed }
                do { try onCleanClose() } catch { throw SpeechError.cleanupFailed }
            }
            closing = task
            return task
        }
        try await task.value
    }
}
