import Foundation

/// Unreleased native speech control facade. Rust owns policy; supplied ports own
/// authenticated HTTP and native media. Await ready(), explicitly close(), and
/// inspect cleanup failures before reusing audio ownership. Cancellation of a
/// public async control call retires the session; a cancelled close waiter does
/// not cancel cleanup. Actual RTC/device qualification is separate.
public final class SpeechSession: @unchecked Sendable {
    // Every access is protected by the enclosing session's recursive lock.
    private final class Slot: @unchecked Sendable {
        var version: UInt64 = 0
        var dirty = false
        var task: SpeechCall<Void>?
        var operation: SpeechCall<Void>?
    }
    private struct PlaybackKey: Equatable {
        let enabled: Bool
        let generation: UInt32
        let clear: Bool
        let tracks: [String]
    }
    private let lock = NSRecursiveLock()
    private let policy: NativeSpeechPolicy
    private let host: any SpeechHostCallbacks
    private let observer: SpeechObserver
    private let timing: SpeechTiming
    private var media: (any SpeechMediaPort)?
    private var latest: SpeechState
    private var ended = false
    private var connected = false
    private var bootstrapFailed = false
    private let readyCall = SpeechCall<Void>()
    private var connecting: SpeechCall<Void>?
    private var changing: SpeechCall<SpeechSubscription>?
    private var renewing: SpeechCall<SpeechGrant>?
    private var resumes: [UUID: SpeechCall<Void>] = [:]
    private var recovery: SpeechCall<Void>?
    private var recoveryId: UInt32?
    private var finishing: SpeechCall<Void>?
    private var finishId: UInt32?
    private var finishWaiter: SpeechCall<SpeechSourceFinish>?
    private var changes = SpeechCall<Void>()
    private let capture = Slot()
    private let playback = Slot()
    private var captureMode: String?
    private var playbackKey: PlaybackKey?
    private var timer: Task<Void, Never>?
    private var lastRenewal: UInt64 = 0
    private var closeCall: SpeechCall<Void>?

    public var state: SpeechState { lock.withLock { latest } }

    public convenience init(configuration: SpeechConfiguration, grant: SpeechGrant,
                            mediaFactory: @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort,
                            host: any SpeechHostCallbacks, observer: SpeechObserver = .init()) throws {
        try self.init(configuration: configuration, grant: grant, mediaFactory: mediaFactory,
                      host: host, observer: observer, timing: .system())
    }

    init(configuration: SpeechConfiguration, grant: SpeechGrant,
         mediaFactory: @Sendable (SpeechMediaCallbacks) throws -> any SpeechMediaPort,
         host: any SpeechHostCallbacks, observer: SpeechObserver, timing: SpeechTiming) throws {
        self.host = host; self.observer = observer; self.timing = timing
        do {
            policy = try NativeSpeechPolicy(configurationJSON: JSONEncoder().encode(configuration),
                                            grantJSON: JSONEncoder().encode(grant), nowMs: timing.now())
            latest = try SpeechJSON.update(policy.step(commandJSON: SpeechJSON.command("tick"), nowMs: timing.now())).state
        } catch { throw SpeechError.invalidInput }
        do {
            if host.supportsCaptionRecovery { latest = try readPolicy(SpeechJSON.command("enable_caption_recovery")).state }
            media = try mediaFactory(.init(text: { [weak self] sender, json in
                self?.receive("event", ["sender": sender, "json": json])
            }, trackRemoved: { [weak self] sid in self?.receive("track_removed", ["mediaTrackSid": sid]) },
            disconnected: { [weak self] in self?.mediaFailure() }, failed: { [weak self] in self?.mediaFailure() },
            playbackBlocked: { [weak self] in self?.lock.withLock {
                guard let self, !self.ended else { return }; self.observer.error(.playbackBlocked)
            } }))
        } catch { policy.close(); throw SpeechError.mediaFailed }
        lock.withLock {
            if bootstrapFailed { fail(.mediaFailed) }
            readyCall.start(timing: timing) { [self] in
                do {
                    let call = try lock.withLock { () -> SpeechCall<Void> in
                        try active()
                        let call = SpeechCall<Void>(); connecting = call
                        let port = try port()
                        call.start(timing: timing, timeout: 10_000) { try await port.connect(grant: grant) }
                        return call
                    }
                    try await call.wait()
                    try lock.withLock { try active(); connected = true; _ = try command("connected") }
                    try await waitSlot(capture); try await waitSlot(playback)
                    try lock.withLock {
                        try active()
                        timer = Task { [self] in
                            while !Task.isCancelled {
                                do { try await timing.sleep(250); try Task.checkCancellation(); tick() }
                                catch { break }
                            }
                        }
                    }
                } catch {
                    let code = lock.withLock { () -> SpeechError in
                        let code = ended ? .closed : (error as? SpeechError ?? .mediaFailed)
                        if !ended { fail(code) }
                        return code
                    }
                    throw code
                }
                lock.withLock { connecting = nil }
            }
        }
    }

    public func ready() async throws { try await owned { try await self.readyCall.wait() } }
    public func setInput(_ enabled: Bool) async throws {
        try await owned {
            try self.lock.withLock {
                try self.active()
                if enabled && self.finishWaiter != nil { throw SpeechError.sourceFinishPending }
                let state = try self.command("set_microphone", ["enabled": enabled])
                if enabled && state.sourceFinish.holdPublication { throw SpeechError.sourceFinishPending }
            }
            try await self.waitSlot(self.capture)
        }
    }
    public func setMicrophone(_ enabled: Bool) async throws { try await setInput(enabled) }
    public func setListening(_ enabled: Bool) async throws {
        try await owned {
            _ = try self.lock.withLock { try self.command("set_listening", ["enabled": enabled]) }
            try await self.waitSlot(self.playback)
        }
    }
    public func changeSubscription(_ selection: SpeechSelection) async throws {
        try await owned {
            let (id, call) = try self.lock.withLock { () -> (UInt32, SpeechCall<SpeechSubscription>) in
                try self.active(); self.changing?.cancel()
                let id = try self.command("begin_change").changeId
                let call = SpeechCall<SpeechSubscription>(); self.changing = call
                call.start(timing: self.timing, timeout: 10_000, error: .subscriptionUnavailable) {
                    try await self.host.changeSubscription(selection: selection)
                }
                return (id, call)
            }
            defer { self.lock.withLock { call.cancel(); if self.changing === call { self.changing = nil } } }
            do {
                let desired = try await call.wait()
                try self.lock.withLock {
                    try self.active()
                    guard self.changing === call else { throw SpeechError.superseded }
                    _ = try self.command("apply_desired", ["changeId": id, "subscription": SpeechJSON.object(desired)])
                }
            } catch {
                if Task.isCancelled { throw CancellationError() }
                try self.lock.withLock {
                    try self.active()
                    guard self.changing === call else { throw SpeechError.superseded }
                    if error as? SpeechHostFailure == .unauthorized { self.fail(.authorizationUnavailable) }
                    self.observer.error(.subscriptionUnavailable)
                }
                throw SpeechError.subscriptionUnavailable
            }
        }
    }
    public func resumeAudio() async throws {
        try await owned {
            let id = UUID()
            let call = try self.lock.withLock { () -> SpeechCall<Void> in
                try self.active(); let port = try self.port(); let call = SpeechCall<Void>(); self.resumes[id] = call
                call.start(timing: self.timing, timeout: 10_000, error: .playbackBlocked) { try await port.resumeAudio() }
                return call
            }
            defer { self.lock.withLock { call.cancel(); self.resumes[id] = nil } }
            do { try await call.wait() }
            catch {
                if Task.isCancelled { throw CancellationError() }
                try self.lock.withLock { try self.active(); self.observer.error(.playbackBlocked) }
                throw SpeechError.playbackBlocked
            }
        }
    }
    public func recoverCaptions() async throws -> SpeechCaptionRecovery {
        try await owned {
            let change = try self.lock.withLock { () -> UInt32 in
                try self.active()
                guard self.host.supportsCaptionRecovery else { throw SpeechError.captionRecoveryUnavailable }
                return self.latest.changeId
            }
            try await self.readyCall.wait()
            _ = try self.lock.withLock { try self.unchanged(change); return try self.command("recover_captions") }
            while let call = try self.lock.withLock({ try self.unchanged(change); return self.recovery }) {
                do { try await call.wait() }
                catch is CancellationError { try Task.checkCancellation(); try self.lock.withLock { try self.unchanged(change) } }
            }
            return try self.lock.withLock {
                try self.unchanged(change)
                if self.latest.recovery.status == "retrying" { throw SpeechError.captionRecoveryUnavailable }
                if self.latest.recovery.status == "stale" { throw SpeechError.captionRecoveryStale }
                return self.latest.recovery
            }
        }
    }
    public func finishInput() async throws -> SpeechSourceFinish {
        try await owned {
            let call = try self.lock.withLock { () -> SpeechCall<SpeechSourceFinish> in
                try self.active()
                if let call = self.finishWaiter { return call }
                let call = SpeechCall<SpeechSourceFinish>()
                if ["completed", "interrupted", "no_source"].contains(self.latest.sourceFinish.status) {
                    call.resolve(.success(self.latest.sourceFinish)); return call
                }
                if self.latest.sourceFinish.status == "stale" { throw SpeechError.sourceFinishStale }
                guard self.host.supportsSourceFinish, try self.port().supportsSourceFinish else { throw SpeechError.sourceFinishUnavailable }
                self.finishWaiter = call
                call.whenComplete { self.lock.withLock { if self.finishWaiter === call { self.finishWaiter = nil } } }
                _ = try self.command("begin_source_finish")
                call.start(timing: self.timing) {
                    try await self.readyCall.wait(); try await self.waitSlot(self.capture)
                    while let changed = try self.lock.withLock({ () -> SpeechCall<Void>? in
                        try self.active()
                        return self.latest.sourceFinish.holdPublication && self.latest.sourceFinish.status != "unavailable" ? self.changes : nil
                    }) { try await changed.wait() }
                    try self.lock.withLock {
                        try self.active()
                        if self.latest.sourceFinish.status == "unavailable" { throw SpeechError.sourceFinishUnavailable }
                        if self.latest.sourceFinish.status == "stale" { throw SpeechError.sourceFinishStale }
                    }
                    try await self.waitSlot(self.capture)
                    return try self.lock.withLock { try self.active(); return self.latest.sourceFinish }
                }
                return call
            }
            return try await call.wait()
        }
    }
    public func finishMicrophone() async throws -> SpeechSourceFinish { try await finishInput() }
    public func close() async throws { try await lock.withLock { beginClose() }.wait() }

    private func owned<Value: Sendable>(_ body: () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await body()
        } onCancel: { _ = self.lock.withLock { self.beginClose() } }
    }
    private func active() throws { if ended { throw SpeechError.closed } }
    private func unchanged(_ change: UInt32) throws {
        try active(); if latest.changeId != change { throw SpeechError.superseded }
    }
    private func port() throws -> any SpeechMediaPort { guard let media else { throw SpeechError.mediaFailed }; return media }
    private func readPolicy(_ data: Data) throws -> SpeechPolicyUpdate {
        var output = try policy.step(commandJSON: data, nowMs: timing.now())
        defer { output.resetBytes(in: output.startIndex..<output.endIndex) }
        return try SpeechJSON.update(output)
    }
    private func command(_ type: String, _ fields: [String: Any] = [:]) throws -> SpeechState {
        try command(SpeechJSON.command(type, fields))
    }
    private func command(_ data: Data) throws -> SpeechState {
        try active()
        let result: SpeechPolicyUpdate
        do { result = try readPolicy(data) }
        catch { fail(.invalidInput); throw SpeechError.invalidInput }
        latest = result.state
        if latest.disconnect { _ = beginClose(); return latest }
        reconcile(); reconcileRequests(); publishState()
        func current() -> Bool { !ended && latest.changeId == result.state.changeId && latest.subscriptionRevision == result.state.subscriptionRevision }
        for caption in result.captions { if !current() { break }; observer.caption(caption) }
        if current(), let event = result.event { observer.event(event) }
        return latest
    }
    private func publishState() {
        let pending = changes; changes = SpeechCall<Void>(); pending.resolve(.success(()))
        observer.stateChanged(latest)
    }
    private func fail(_ error: SpeechError) { if !ended { _ = beginClose(readyError: error); observer.error(error) } }
    private func receive(_ type: String, _ fields: [String: Any]) {
        lock.withLock {
            guard media != nil else { bootstrapFailed = true; return }
            if !ended { _ = try? command(type, fields) }
        }
    }
    private func mediaFailure() { lock.withLock { if media == nil { bootstrapFailed = true } else { fail(.mediaFailed) } } }

    private func reconcile() {
        guard !ended, connected, let media else { return }
        let mode = latest.sourceFinish.holdPublication ? "hold" : (latest.canCapture ? "on" : "off")
        if captureMode != mode {
            captureMode = mode; capture.version += 1; capture.dirty = true
            do {
                if mode == "hold" { try media.holdInput() } else { capture.operation?.cancel() }
                if mode == "off" { try media.muteInput() }
            } catch { fail(.mediaFailed); return }
            startCapture()
        }
        let key = PlaybackKey(enabled: latest.canPlay, generation: latest.clearGeneration,
                              clear: latest.clearPlayback, tracks: latest.tracks.map(\.mediaTrackSid).sorted())
        if playbackKey != key {
            playbackKey = key; playback.version += 1; playback.dirty = true; playback.operation?.cancel()
            if !latest.canPlay || latest.clearPlayback {
                do { try media.silencePlayback() } catch { fail(.mediaFailed); return }
            }
            startPlayback()
        }
    }
    private func startCapture() {
        startSlot(capture, restart: { self.startCapture() }) { version, state in
            if state.sourceFinish.holdPublication {
                try self.lock.withLock {
                    if !self.ended && self.capture.version == version && self.latest.sourceFinish.status == "preparing" {
                        _ = try self.command("source_publication", ["trackSid": self.port().inputPublication() as Any? ?? NSNull()])
                    }
                }
            } else { try await self.perform(self.capture, version: version) { try await $0.setInput(enabled: state.canCapture) } }
        }
    }
    private func startPlayback() {
        startSlot(playback, restart: { self.startPlayback() }) { version, state in
            if state.clearPlayback {
                try await self.perform(self.playback, version: version) { try await $0.clearPlayback() }
                try self.lock.withLock {
                    if !self.ended && self.playback.version == version {
                        _ = try self.command("buffers_cleared", ["generation": state.clearGeneration])
                    }
                }
            } else {
                try await self.perform(self.playback, version: version) { try await $0.setPlayback(tracks: state.canPlay ? state.tracks : []) }
            }
        }
    }
    private func startSlot(_ slot: Slot, restart: @escaping @Sendable () -> Void,
                           execute: @escaping @Sendable (UInt64, SpeechState) async throws -> Void) {
        guard !ended, slot.task == nil else { return }
        let task = SpeechCall<Void>(); slot.task = task
        task.whenComplete { self.lock.withLock {
            if slot.task === task { slot.task = nil }; if !self.ended && slot.dirty { restart() }
        } }
        task.start(timing: timing) {
            while let work = self.lock.withLock({ () -> (UInt64, SpeechState)? in
                guard !self.ended, slot.dirty else { return nil }
                slot.dirty = false; return (slot.version, self.latest)
            }) {
                do { try await execute(work.0, work.1) }
                catch {
                    try self.lock.withLock {
                        if !self.ended && slot.version == work.0 {
                            let code = error as? SpeechError ?? .mediaFailed; self.fail(code); throw code
                        }
                    }
                }
            }
        }
    }
    private func perform(_ slot: Slot, version: UInt64, action: @escaping @Sendable (any SpeechMediaPort) async throws -> Void) async throws {
        let call = try lock.withLock { () -> SpeechCall<Void> in
            try active(); guard slot.version == version else { throw SpeechError.superseded }
            let port = try port(); let call = SpeechCall<Void>(); slot.operation = call
            call.start(timing: timing, timeout: 10_000) { try await action(port) }
            return call
        }
        defer { lock.withLock { if slot.operation === call { slot.operation = nil } } }
        try await call.wait()
    }
    private func waitSlot(_ slot: Slot) async throws {
        while let call = try lock.withLock({ try active(); return slot.task }) {
            do { try await call.wait() }
            catch is CancellationError { try Task.checkCancellation(); try lock.withLock { try active() } }
        }
    }

    private func reconcileRequests() {
        guard !ended, connected else { return }
        let caption = latest.recovery.request
        if caption?.requestId != recoveryId { recovery?.cancel() }
        if host.supportsCaptionRecovery, let caption, recovery == nil {
            let task = SpeechCall<Void>(); recovery = task; recoveryId = caption.requestId
            task.whenComplete { self.lock.withLock {
                if self.recovery === task { self.recovery = nil; self.recoveryId = nil }; self.reconcileRequests()
            } }
            task.start(timing: timing) {
                await self.request(call: { try await self.host.readCaptions(request: caption) }, success: { body in
                    guard self.latest.recovery.request?.requestId == caption.requestId else { return }
                    self.recovery = nil; self.recoveryId = nil
                    _ = try self.command(SpeechJSON.response("caption_page", id: caption.requestId, field: "page", body: body))
                }, failure: { reason in
                    guard self.latest.recovery.request?.requestId == caption.requestId else { return }
                    self.recovery = nil; self.recoveryId = nil
                    _ = try self.command("caption_failure", ["requestId": caption.requestId, "reason": reason.rawValue])
                    self.observer.error(reason == .unauthorized ? .authorizationUnavailable :
                        (reason == .staleSubscription ? .captionRecoveryStale : .captionRecoveryUnavailable))
                })
            }
        }
        let finish = latest.sourceFinish.request
        if finish?.requestId != finishId { finishing?.cancel() }
        if host.supportsSourceFinish, let finish, finishing == nil {
            let task = SpeechCall<Void>(); finishing = task; finishId = finish.requestId
            task.whenComplete { self.lock.withLock {
                if self.finishing === task { self.finishing = nil; self.finishId = nil }; self.reconcileRequests()
            } }
            task.start(timing: timing) {
                await self.request(call: { try await self.host.finishSource(request: finish) }, success: { body in
                    guard self.latest.sourceFinish.request?.requestId == finish.requestId else { return }
                    self.finishing = nil; self.finishId = nil
                    _ = try self.command(SpeechJSON.response("source_finish_result", id: finish.requestId, field: "body", body: body))
                }, failure: { reason in
                    guard self.latest.sourceFinish.request?.requestId == finish.requestId else { return }
                    self.finishing = nil; self.finishId = nil
                    _ = try self.command("source_finish_failure", ["requestId": finish.requestId, "reason": reason.rawValue])
                    if reason != .unavailable { self.observer.error(reason == .unauthorized ? .authorizationUnavailable : .sourceFinishStale) }
                })
            }
        }
    }
    private func request(call: @escaping @Sendable () async throws -> Data,
                         success: (Data) throws -> Void, failure: (SpeechHostFailure) throws -> Void) async {
        let operation = SpeechCall<Data>(); operation.start(timing: timing, timeout: 5_000, body: call)
        defer { operation.cancel() }
        do {
            let body = try await operation.wait()
            try lock.withLock { if !ended && !Task.isCancelled { try success(body) } }
        } catch {
            if !Task.isCancelled { lock.withLock { if !ended { try? failure(error as? SpeechHostFailure ?? .unavailable) } } }
        }
    }
    func tick() {
        lock.withLock {
            guard !ended else { return }
            do {
                _ = try command("tick"); let now = timing.now()
                guard !ended, renewing == nil, latest.expiresAtMs <= now + 30_000, now >= lastRenewal + 5_000 else { return }
                lastRenewal = now
                let call = SpeechCall<SpeechGrant>(); renewing = call
                call.start(timing: timing, timeout: 5_000, error: .authorizationUnavailable) { try await self.host.renewGrant() }
                Task {
                    defer { self.lock.withLock { call.cancel(); if self.renewing === call { self.renewing = nil } } }
                    do {
                        let grant = try await call.wait()
                        try self.lock.withLock {
                            if !self.ended && self.renewing === call {
                                let json = String(decoding: try JSONEncoder().encode(grant), as: UTF8.self)
                                _ = try self.command("renew", ["grantJson": json])
                            }
                        }
                    } catch {
                        self.lock.withLock {
                            if !self.ended {
                                if error as? SpeechHostFailure == .unauthorized { self.fail(.authorizationUnavailable) }
                                else { self.observer.error(.authorizationUnavailable) }
                            }
                        }
                    }
                }
            } catch { /* The invalid/expired policy has already retired this owner. */ }
        }
    }
    private func beginClose(readyError: SpeechError = .closed) -> SpeechCall<Void> {
        if let closeCall { return closeCall }
        let close = SpeechCall<Void>(); closeCall = close
        ended = true; connected = false
        timer?.cancel(); timer = nil; connecting?.cancel(); changing?.cancel(); renewing?.cancel()
        recovery?.cancel(); finishing?.cancel(); capture.operation?.cancel(); playback.operation?.cancel()
        capture.task?.cancel(); playback.task?.cancel(); resumes.values.forEach { $0.cancel() }; resumes.removeAll()
        readyCall.resolve(.failure(readyError)); finishWaiter?.resolve(.failure(SpeechError.closed))
        var failed = false
        do { try media?.silencePlayback() } catch { failed = true }
        do { try media?.muteInput() } catch { failed = true }
        if let closed = try? readPolicy(SpeechJSON.command("closed")).state { latest = closed }
        latest = latest.closed(); policy.close(); publishState()
        let immediateFailure = failed
        close.start(timing: timing) {
            let cleanup = SpeechCall<Void>()
            cleanup.start(timing: self.timing, timeout: 10_000, error: .cleanupFailed) { try await self.media?.close() }
            var failed = immediateFailure
            do { try await cleanup.wait() } catch { failed = true }
            if failed { self.observer.error(.cleanupFailed); throw SpeechError.cleanupFailed }
        }
        return close
    }
}
