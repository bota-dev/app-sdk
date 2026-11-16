import BotaAppSDK
import Foundation

private final class RecordingMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data] = [], bytes = 0, stopped = false, overflow = false
    func offer(_ data: Data) {
        lock.withLock {
            guard !stopped, !overflow else { return }
            guard data.count <= 32768, values.count < 32, bytes + data.count <= 524288 else {
                overflow = true; values.removeAll(); bytes = 0; return
            }
            values.append(data); bytes += data.count
        }
    }
    func read() throws -> String {
        let batch = try lock.withLock {
            guard !stopped, !overflow else { throw LabFailure.closed }
            let batch = values; values = []; bytes = 0; return batch
        }
        let objects = try batch.map { try JSONSerialization.jsonObject(with: $0) }
        guard let result = String(data: try JSONSerialization.data(withJSONObject: objects), encoding: .utf8) else { throw LabFailure.unavailable }
        return result
    }
    func close() { lock.withLock { stopped = true; values.removeAll(); bytes = 0 } }
}

@MainActor
final class RecordingLabBridge {
    typealias Factory = @MainActor (String, @escaping @Sendable (Data) -> Void, @escaping @Sendable (String) -> Void) async throws -> any RecordingSpeechConnection
    private final class Entry {
        let id: String, mailbox = RecordingMailbox()
        var stopped = false
        var pending: Task<any RecordingSpeechConnection, any Error>?
        var owner: (any RecordingSpeechConnection)?
        var closing: Task<Void, any Error>?
        var commands: [UUID: (cancel: () -> Void, done: Task<Void, Never>)] = [:]
        init(_ id: String) { self.id = id }
    }
    private let factory: Factory
    private var current: Entry?
    private var previous: Task<Void, any Error>?
    init(factory: @escaping Factory) { self.factory = factory }
    func start(_ id: String, activityId: String) async throws {
        guard current == nil, id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { throw LabFailure.conflict }
        try await previous?.value
        guard current == nil else { throw LabFailure.conflict }
        let entry = Entry(id); current = entry; let mailbox = entry.mailbox
        let task = Task { @MainActor in
            try await factory(activityId, { mailbox.offer($0) }, { status in
                guard ["interrupted","output_skipped","archive_unavailable","capture_interrupted"].contains(status),
                      let data = try? JSONSerialization.data(withJSONObject: ["type": "status", "status": status]) else { return }
                mailbox.offer(data)
            })
        }
        entry.pending = task
        do { let owner = try await task.value; entry.owner = owner; guard !entry.stopped, current === entry else { throw LabFailure.closed } }
        catch { try await close(id); throw error }
    }
    func call<T: Sendable>(_ id: String, action: @escaping @MainActor (any RecordingSpeechConnection) async throws -> T) async throws -> T {
        guard let entry = current, entry.id == id, !entry.stopped, entry.commands.count < 32, let owner = entry.owner else { throw LabFailure.closed }
        let key = UUID(), task = Task { @MainActor in try await action(owner) }
        entry.commands[key] = ({ task.cancel() }, Task { _ = await task.result })
        defer { entry.commands[key] = nil }
        let value = try await task.value
        guard current === entry, !entry.stopped else { throw LabFailure.closed }; return value
    }
    func events(_ id: String) async throws -> String {
        guard let entry = current, entry.id == id, !entry.stopped else { throw LabFailure.closed }
        do { return try entry.mailbox.read() } catch { try await close(id); throw error }
    }
    func close(_ id: String? = nil) async throws {
        guard let entry = current else { return try await previous?.value ?? () }
        guard id == nil || id == entry.id else { throw LabFailure.conflict }
        if let closing = entry.closing { return try await closing.value }
        entry.stopped = true; entry.mailbox.close(); entry.pending?.cancel()
        let commands = Array(entry.commands.values); for command in commands { command.cancel() }
        let task = Task { @MainActor in
            let owner: (any RecordingSpeechConnection)?
            if let current = entry.owner { owner = current } else { do { owner = try await entry.pending?.value } catch is RecordingCleanupFailure { throw RecordingCleanupFailure() } catch { owner = nil } }
            defer { if self.current === entry { self.current = nil } }
            do { try await owner?.close() } catch { for command in commands { await command.done.value }; throw error }
            for command in commands { await command.done.value }
        }
        entry.closing = task; previous = task; try await task.value
    }
}
