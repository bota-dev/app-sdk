import Foundation

public enum RecordingSpeechMessage: Sendable { case control(Data), audio(Data) }
public protocol RecordingSpeechTransport: Sendable {
    func send(_ message: RecordingSpeechMessage) async throws
    func receive() async throws -> RecordingSpeechMessage
    func close() async
}
public protocol RecordingSpeechPlayback: Sendable {
    /// Return only after scheduled output is stopped and removed.
    func clear() async throws
    /// Consume or copy synchronously; false indicates bounded output pressure.
    func play(_ pcm: Data, outputId: String, offsetSamples: UInt64) -> Bool
    func drain() async throws
}

private final class RecordingSocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    let closed = SpeechCall<Void>()
    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: (any Error)?) { closed.resolve(.success(())) }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocolName: String?) {
        if protocolName != "bota.recording-speech.v1" { webSocketTask.cancel(with: .policyViolation, reason: nil) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
/// Owned ephemeral direct socket. The validated URL never contains a token.
public final class RecordingSpeechWebSocket: RecordingSpeechTransport, @unchecked Sendable {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let delegate: RecordingSocketDelegate
    public init(url: URL, protocolName: String) {
        delegate = RecordingSocketDelegate()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.timeoutIntervalForRequest = 10
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        socket = session.webSocketTask(with: url, protocols: [protocolName]); socket.maximumMessageSize = 32768; socket.resume()
    }
    public func send(_ message: RecordingSpeechMessage) async throws {
        switch message {
        case .control(let bytes): guard let text = String(data: bytes, encoding: .utf8) else { throw SpeechCaptureFailure.invalidInput }; try await socket.send(.string(text))
        case .audio(let bytes): try await socket.send(.data(bytes))
        }
    }
    public func receive() async throws -> RecordingSpeechMessage {
        switch try await socket.receive() {
        case .string(let text): return .control(Data(text.utf8))
        case .data(let bytes): return .audio(bytes)
        @unknown default: throw SpeechCaptureFailure.invalidInput
        }
    }
    public func close() async { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel(); _ = try? await delegate.closed.wait() }
}

/// Direct recording processing with shared Rust policy. The caller separately
/// owns microphone/external capture and its archive; close never stops those IOs.
/// Frames are copied into bounded native queues and never cross an App bridge.
public final class RecordingSpeechSession: @unchecked Sendable {
    private struct Frame { let index: Int; let first: UInt64; var bytes: Data }
    private let lock = NSRecursiveLock()
    private let transport: any RecordingSpeechTransport
    private let playback: any RecordingSpeechPlayback
    private let caption: @Sendable (Data) -> Void
    private let status: @Sendable (String) -> Void
    private let wake: AsyncStream<Void>.Continuation
    private var state: [String: Any]
    private var outgoing: [RecordingSpeechMessage] = []
    private var pending: [Frame] = []
    private var outgoingBytes = 0, pendingBytes = 0
    private var stopped = false, finished = false
    private var receiver: Task<Void, Never>?, sender: Task<Void, Never>?, deadline: Task<Void, Never>?
    private let readyCall = SpeechCall<Void>(), finishCall = SpeechCall<Void>()
    private var targetCall: SpeechCall<Void>?
    private var closing: Task<Void, any Error>?
    private static func object(_ bytes: Data) throws -> [String: Any] {
        guard bytes.count <= 32768, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw SpeechCaptureFailure.invalidInput }
        return value
    }
    private static func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    public init(configurationJSON: Data, grantJSON: Data, playback: any RecordingSpeechPlayback,
                transportFactory: @Sendable (URL, String) throws -> any RecordingSpeechTransport = { RecordingSpeechWebSocket(url: $0, protocolName: $1) },
                onCaption: @escaping @Sendable (Data) -> Void = { _ in }, onStatus: @escaping @Sendable (String) -> Void = { _ in }) throws {
        self.playback = playback; caption = onCaption; status = onStatus
        let created = try Self.object(RecordingSpeechPolicy.evaluate(Self.json(["op": "create", "configuration": Self.object(configurationJSON),
            "grant": Self.object(grantJSON), "nowMs": UInt64(Date().timeIntervalSince1970 * 1000)])))
        guard let state = created["state"] as? [String: Any], let urlText = created["url"] as? String, let url = URL(string: urlText),
              let protocolName = created["protocol"] as? String, let control = created["control"] as? [String: Any] else { throw SpeechCaptureFailure.invalidInput }
        self.state = state; transport = try transportFactory(url, protocolName)
        let (stream, wake) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1)); self.wake = wake
        try lock.withLock { try enqueue(.control(Self.json(control))) }
        // Publish all task handles before callbacks can initiate joined cleanup.
        lock.lock()
        defer { lock.unlock() }
        sender = Task { [weak self] in
            for await _ in stream {
                guard let self else { return }
                do { try await self.flush() } catch { self.interrupt(); return }
            }
        }
        let transport = self.transport
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled { let message = try await transport.receive(); guard let self else { return }; try await self.receive(message) }
            } catch { self?.interrupt() }
        }
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)); if self?.lock.withLock({ self?.state["ready"] as? Bool != true }) == true { self?.interrupt() } }
            catch { /* A successful handshake retires this deadline. */ }
        }
    }
    private func step(_ input: [String: Any]) throws -> [String: Any] {
        guard !stopped else { throw SpeechCaptureFailure.closed }
        var command = input; command["state"] = state
        let result = try Self.object(RecordingSpeechPolicy.evaluate(Self.json(command)))
        guard let next = result["state"] as? [String: Any] else { throw SpeechCaptureFailure.invalidInput }
        state = next; return result
    }
    private func enqueue(_ message: RecordingSpeechMessage) throws {
        guard !stopped else { throw SpeechCaptureFailure.closed }
        let count: Int; switch message { case .audio(let bytes), .control(let bytes): count = bytes.count }
        guard outgoing.count < 32, outgoingBytes + count <= 38400 else { throw SpeechCaptureFailure.busy }
        outgoing.append(message); outgoingBytes += count; wake.yield(())
    }
    private func flush() async throws {
        while let message = lock.withLock({ stopped || outgoing.isEmpty ? nil : outgoing.removeFirst() }) {
            try await transport.send(message)
            lock.withLock { switch message { case .audio(let bytes), .control(let bytes): outgoingBytes -= bytes.count } }
        }
    }
    public func bindMicrophone(clockId: String) throws { _ = try lock.withLock { try step(["op": "bind_microphone", "clockId": clockId]) } }
    public func ready() async throws {
        do { try await readyCall.wait() } catch { interrupt(); throw error }
    }
    /// Call from the same native sample callback offered to SpeechCapturePump.
    /// The counter advances with capture even if this live branch refuses data.
    @discardableResult public func offer(sourceIndex: Int, firstSample: UInt64, pcm: Data) -> Bool {
        do {
            return try lock.withLock {
                guard !stopped, state["ready"] as? Bool == true, state["finishing"] as? Bool != true,
                      !pcm.isEmpty, pcm.count <= 9600, pcm.count.isMultiple(of: 2) else { return false }
                if !(state["pending"] is NSNull) {
                    guard pendingBytes + pcm.count <= 38400 else { throw SpeechCaptureFailure.busy }
                    pending.append(Frame(index: sourceIndex, first: firstSample, bytes: pcm)); pendingBytes += pcm.count; return true
                }
                let result = try step(["op": "frame", "sourceIndex": sourceIndex, "firstSample": firstSample, "samples": pcm.count / 2])
                guard let header = result["header"] as? [UInt8] else { throw SpeechCaptureFailure.invalidInput }
                var bytes = Data(header); bytes.append(pcm); try enqueue(.audio(bytes)); return true
            }
        } catch { interrupt(); return false }
    }
    private func clearAndAcknowledge() async throws {
        try await playback.clear()
        try lock.withLock {
            guard let target = state["target"] as? [String: Any], let revision = target["revision"] else { throw SpeechCaptureFailure.invalidInput }
            let result = try step(["op": "playback_cleared", "revision": revision])
            try enqueue(.control(Self.json(result["control"] as! [String: Any])))
        }
    }
    public func setRoute(headphones: Bool) async throws {
        let control = try lock.withLock { try Self.json(step(["op": "route", "route": headphones ? "headphones" : "unqualified"])["control"] as! [String: Any]) }
        if !headphones { try await playback.clear() }
        try lock.withLock { try enqueue(.control(control)) }
    }
    public func changeTarget(_ language: String, requestId: String) async throws {
        let (control, call) = try lock.withLock { () -> (Data, SpeechCall<Void>) in
            guard targetCall == nil else { throw SpeechCaptureFailure.busy }
            let result = try step(["op": "target", "language": language, "requestId": requestId]), call = SpeechCall<Void>()
            targetCall = call; return (try Self.json(result["control"] as! [String: Any]), call)
        }
        let timeout = Task { [weak self] in do { try await Task.sleep(for: .seconds(15)); self?.interrupt() } catch {} }
        defer { timeout.cancel() }
        do { try await playback.clear(); try lock.withLock { try enqueue(.control(control)) }; try await call.wait() }
        catch { interrupt(); throw SpeechCaptureFailure.unavailable }
    }
    public func finish() async throws {
        try lock.withLock { try enqueue(.control(Self.json(step(["op": "finish"])["control"] as! [String: Any]))) }
        let timeout = Task { [weak self] in do { try await Task.sleep(for: .seconds(60)); self?.interrupt() } catch {} }
        defer { timeout.cancel() }
        do { try await finishCall.wait() } catch { interrupt(); throw error }
    }
    private func receive(_ message: RecordingSpeechMessage) async throws {
        switch message {
        case .audio(let bytes):
            guard bytes.count >= 18, bytes.count <= 32768, bytes.prefix(4) == Data("BRT1".utf8) else { throw SpeechCaptureFailure.invalidInput }
            let raw = Array(bytes), idSize = Int(raw[4]) | Int(raw[5]) << 8, header = Int(raw[6]) | Int(raw[7]) << 8
            var offset: UInt64 = 0; for index in 0..<8 { offset |= UInt64(raw[8 + index]) << (8 * index) }
            guard idSize <= 256, header == 16 + idSize, bytes.count > header, (bytes.count - header).isMultiple(of: 2),
                  let outputId = String(data: bytes.subdata(in: 16..<header), encoding: .utf8) else { throw SpeechCaptureFailure.invalidInput }
            let blocked = try lock.withLock { () -> Bool in
                let accepted = try step(["op": "audio_chunk", "outputId": outputId, "offsetSamples": offset, "samples": (bytes.count - header) / 2])["accepted"] as? Bool == true
                return accepted && !playback.play(bytes.subdata(in: header..<bytes.count), outputId: outputId, offsetSamples: offset)
            }
            if blocked {
                _ = try lock.withLock { try step(["op": "clear"]) }; try await playback.clear(); status("output_skipped")
            }
        case .control(let bytes):
            let event = try Self.object(bytes), type = event["type"] as? String
            if type == "ready" {
                _ = try lock.withLock { try step(["op": "ready", "event": event, "nowMs": UInt64(Date().timeIntervalSince1970 * 1000)]) }
                try await clearAndAcknowledge(); deadline?.cancel(); readyCall.resolve(.success(())); return
            }
            guard lock.withLock({ (state["configuration"] as? [String: Any])?["activityId"] as? String == event["activityId"] as? String &&
                state["generation"] as? Int == event["generation"] as? Int }) else { throw SpeechCaptureFailure.invalidInput }
            if type == "target_committed" {
                guard let target = event["target"] as? [String: Any], let revision = target["revision"], let language = target["language"], let request = event["requestId"] else { throw SpeechCaptureFailure.invalidInput }
                _ = try lock.withLock { try step(["op": "target_committed", "requestId": request, "revision": revision, "language": language]) }
                try await clearAndAcknowledge()
                try lock.withLock {
                    let frames = pending; pending.removeAll(); pendingBytes = 0
                    for frame in frames { guard offer(sourceIndex: frame.index, firstSample: frame.first, pcm: frame.bytes) else { throw SpeechCaptureFailure.unavailable } }
                    targetCall?.resolve(.success(())); targetCall = nil
                }
            } else if type == "audio_clear" {
                _ = try lock.withLock { try step(["op": "clear"]) }; try await playback.clear()
            } else if type == "audio_start" {
                guard event["sampleRate"] as? Int == 24000 else { throw SpeechCaptureFailure.invalidInput }
                _ = try lock.withLock { try step(["op": "audio_start", "activityId": event["activityId"]!, "generation": event["generation"]!,
                    "revision": event["revision"] ?? NSNull(), "outputId": event["outputId"] ?? NSNull()]) }
            } else if type == "audio_end" {
                _ = try lock.withLock { try step(["op": "audio_end", "outputId": event["outputId"] ?? NSNull(), "samples": event["samples"] ?? NSNull()]) }
            } else if type == "caption" {
                guard let value = event["caption"] as? [String: Any], let text = value["text"] as? String, event["final"] is Bool,
                      event["revision"] as? Int == value["revision"] as? Int else { throw SpeechCaptureFailure.invalidInput }
                var command = value; command.removeValue(forKey: "text"); command["op"] = "caption"; command["textBytes"] = text.utf8.count
                command["activityId"] = event["activityId"]; command["generation"] = event["generation"]
                if try lock.withLock({ try step(command)["accepted"] as? Bool == true }) { caption(bytes) }
            } else if type == "finished" {
                lock.withLock { finished = true }; try await playback.drain(); finishCall.resolve(.success(()))
            } else if type == "status" { status("interrupted") }
            else { throw SpeechCaptureFailure.invalidInput }
        }
    }
    private func interrupt() {
        let report = lock.withLock { !stopped && !finished }; if report { status("interrupted") }
        Task { try? await close() }
    }
    public func close() async throws {
        let task = lock.withLock { () -> Task<Void, any Error> in
            if let closing { return closing }
            stopped = true; outgoing.removeAll(); pending.removeAll(); pendingBytes = 0
            deadline?.cancel(); wake.finish(); receiver?.cancel(); sender?.cancel()
            readyCall.resolve(.failure(SpeechCaptureFailure.closed)); targetCall?.resolve(.failure(SpeechCaptureFailure.closed)); finishCall.resolve(.failure(SpeechCaptureFailure.closed))
            let task = Task { [self] in
                var failure: (any Error)?
                do { try await playback.clear() } catch { failure = error }
                await transport.close()
                await receiver?.value; await sender?.value
                if let failure { throw failure }
            }; closing = task; return task
        }
        try await task.value
    }
}
