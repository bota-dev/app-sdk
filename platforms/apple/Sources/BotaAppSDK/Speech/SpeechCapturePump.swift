import Foundation

protocol SpeechCaptureSink: Sendable {
    func begin(_ clock: String) async throws
    func append(_ firstSample: UInt64, _ pcm: Data) async throws
    func end(_ samples: UInt64) async throws
    func interrupt() async throws
}
private struct ArchiveCaptureSink: SpeechCaptureSink {
    let archive: SpeechCaptureArchive
    func begin(_ clock: String) async throws { try await archive.beginClock(clock) }
    func append(_ firstSample: UInt64, _ pcm: Data) async throws { try await archive.append(firstSample: firstSample, pcm: pcm) }
    func end(_ samples: UInt64) async throws { try await archive.endClock(samples: samples) }
    func interrupt() async throws { try await archive.interruptClock() }
}

/// A bounded disk branch. The audio callback never waits for encryption, disk or HTTP.
/// Four pending chunks include the active write; excess audio leaves real sample gaps.
public final class SpeechCapturePump: @unchecked Sendable {
    private struct Chunk { let first: UInt64; var bytes: Data }
    private let lock = NSLock()
    private let sink: any SpeechCaptureSink
    private let failed: @Sendable () -> Void
    private let stream: AsyncStream<Void>
    private let wake: AsyncStream<Void>.Continuation
    private var writer: Task<Void, any Error>?
    private var queue: [Chunk] = []
    private var partial = Data()
    private var outstanding = 0
    private var samples: UInt64 = 0
    private var stopping = false
    private var known = false
    private init(sink: any SpeechCaptureSink, failed: @escaping @Sendable () -> Void) {
        self.sink = sink; self.failed = failed
        (stream, wake) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        partial.reserveCapacity(96000)
    }
    public static func start(archive: SpeechCaptureArchive, failed: @escaping @Sendable () -> Void = {}) async throws -> SpeechCapturePump {
        try await start(sink: ArchiveCaptureSink(archive: archive), clock: UUID().uuidString.lowercased(), failed: failed)
    }
    static func start(sink: any SpeechCaptureSink, clock: String, failed: @escaping @Sendable () -> Void = {}) async throws -> SpeechCapturePump {
        try await sink.begin(clock)
        let pump = SpeechCapturePump(sink: sink, failed: failed)
        pump.writer = Task { try await pump.write() }
        return pump
    }
    /// Copies mono 48 kHz PCM16LE. True includes archive drops under disk pressure;
    /// feed these same bytes to RTC independently. False means the source must stop.
    @discardableResult public func offer(_ pcm: Data) -> Bool {
        lock.withLock {
            guard !stopping, !pcm.isEmpty, pcm.count <= 96000, pcm.count.isMultiple(of: 2),
                  samples + UInt64(pcm.count / 2) <= 345600000 else { return false }
            var offset = 0
            while offset < pcm.count {
                let count = min(96000 - partial.count, pcm.count - offset)
                partial.append(pcm.subdata(in: (pcm.startIndex + offset)..<(pcm.startIndex + offset + count)))
                samples += UInt64(count / 2); offset += count
                if partial.count == 96000 { enqueue() }
            }
            return true
        }
    }
    private func enqueue() {
        guard !partial.isEmpty else { return }
        if outstanding < 4 {
            queue.append(Chunk(first: samples - UInt64(partial.count / 2), bytes: partial))
            outstanding += 1; wake.yield(())
        }
        partial.resetBytes(in: 0..<partial.count); partial.removeAll(keepingCapacity: true)
    }
    private func write() async throws {
        defer {
            lock.withLock {
                partial.resetBytes(in: 0..<partial.count); partial.removeAll()
                for index in queue.indices { queue[index].bytes.resetBytes(in: 0..<queue[index].bytes.count) }
                queue.removeAll(); outstanding = 0
            }
            wake.finish()
        }
        var iterator = stream.makeAsyncIterator()
        do {
            while true {
                if var chunk = lock.withLock({ queue.isEmpty ? nil : queue.removeFirst() }) {
                    defer { chunk.bytes.resetBytes(in: 0..<chunk.bytes.count); lock.withLock { outstanding -= 1 } }
                    try await sink.append(chunk.first, chunk.bytes)
                    continue
                }
                let end = lock.withLock { stopping ? (samples, known) : nil }
                if let end {
                    if end.1 { try await sink.end(end.0) } else { try await sink.interrupt() }
                    return
                }
                _ = await iterator.next()
            }
        } catch {
            lock.withLock { stopping = true; known = false }
            try? await sink.interrupt(); failed(); throw error
        }
    }
    /// Stop and join the physical source first. Interruptions never infer a known EOF.
    public func stop(endKnown: Bool) async throws {
        let task = lock.withLock {
            if !stopping { stopping = true; known = endKnown; enqueue(); wake.yield(()) }
            return writer
        }
        try await task?.value
    }
}
