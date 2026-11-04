import Foundation

struct SpeechTiming: Sendable {
    let now: @Sendable () -> UInt64
    let sleep: @Sendable (_ milliseconds: UInt64) async throws -> Void
    static func system() -> Self {
        let epoch = Date().timeIntervalSince1970
        let uptime = ProcessInfo.processInfo.systemUptime
        return Self(now: {
            UInt64(max(Date().timeIntervalSince1970, epoch + ProcessInfo.processInfo.systemUptime - uptime) * 1000)
        }, sleep: { try await Task.sleep(nanoseconds: $0 * 1_000_000) })
    }
}

private final class SpeechWaiter<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, any Error>?
    private var continuation: CheckedContinuation<Value, any Error>?
    func resolve(_ value: Result<Value, any Error>) {
        let pending = lock.withLock { () -> CheckedContinuation<Value, any Error>? in
            guard result == nil else { return nil }
            result = value
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(with: value)
    }
    func value() async throws -> Value {
        try await withCheckedThrowingContinuation { done in
            let existing = lock.withLock { () -> Result<Value, any Error>? in
                if result == nil { continuation = done }
                return result
            }
            if let existing { done.resume(with: existing) }
        }
    }
}

/// A bounded owner, not a task-group race: groups wait for uncooperative children.
/// Settling the call cancels the native task without treating cancellation as
/// cleanup proof. The media port still owns late acquisition/teardown settlement.
final class SpeechCall<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, any Error>?
    private var waiters: [UUID: SpeechWaiter<Value>] = [:]
    private var operation: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var completions: [@Sendable () -> Void] = []

    func whenComplete(_ body: @escaping @Sendable () -> Void) {
        let settled = lock.withLock { () -> Bool in
            if result == nil { completions.append(body); return false }
            return true
        }
        if settled { body() }
    }

    func start(timing: SpeechTiming, timeout: UInt64? = nil, error: SpeechError = .mediaTimeout,
               body: @escaping @Sendable () async throws -> Value) {
        lock.withLock {
            guard result == nil, operation == nil else { return }
            operation = Task {
                do { try Task.checkCancellation(); self.resolve(.success(try await body())) }
                catch { self.resolve(.failure(error)) }
            }
            if let timeout {
                deadline = Task {
                    do { try await timing.sleep(timeout); try Task.checkCancellation(); self.resolve(.failure(error)) }
                    catch { /* Cancellation of the deadline does not replace the actual result. */ }
                }
            }
        }
    }
    func resolve(_ value: Result<Value, any Error>) {
        let retired = lock.withLock { () -> ([SpeechWaiter<Value>], Task<Void, Never>?, Task<Void, Never>?, [@Sendable () -> Void])? in
            guard result == nil else { return nil }
            result = value
            let retired = (Array(waiters.values), operation, deadline, completions)
            waiters.removeAll(); operation = nil; deadline = nil; completions.removeAll()
            return retired
        }
        guard let retired else { return }
        retired.1?.cancel(); retired.2?.cancel()
        retired.3.forEach { $0() }
        retired.0.forEach { $0.resolve(value) }
    }
    func cancel() { resolve(.failure(CancellationError())) }
    func wait() async throws -> Value {
        let waiter = SpeechWaiter<Value>()
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let existing = lock.withLock { () -> Result<Value, any Error>? in
                if result == nil { waiters[id] = waiter }
                return result
            }
            if let existing { waiter.resolve(existing) }
            defer { _ = lock.withLock { waiters.removeValue(forKey: id) } }
            return try await waiter.value()
        } onCancel: {
            waiter.resolve(.failure(CancellationError()))
            _ = self.lock.withLock { self.waiters.removeValue(forKey: id) }
        }
    }
}
