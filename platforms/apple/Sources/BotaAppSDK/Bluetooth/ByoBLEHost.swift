import Foundation

/// BYO v3 is independent of the frozen encrypted-v2 transfer profile. Rust owns
/// frame encoding/validation; native code owns ATT subscription and cancellation.
struct ByoBLECodec {
    struct Frame: Sendable {
        let opcode, operation, status, requestID, offset, total: UInt64
        let payload: Data
    }
    let core: CoreAbiClient
    func encode(opcode: UInt64, operation: UInt64, requestID: UInt64,
                offset: Int, total: Int, payload: Data, capacity: Int) throws -> Data {
        let packet = try core.protocolEncode(.init(kind: 0x052e, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: [
                .unsigned(id: 127, value: opcode), .unsigned(id: 97, value: operation),
                .unsigned(id: 24, value: 0), .unsigned(id: 152, value: requestID),
                .unsigned(id: 39, value: UInt64(offset)), .unsigned(id: 150, value: UInt64(total)),
                .unsigned(id: 112, value: UInt64(capacity)), .bytes(id: 33, value: payload)]))
        guard packet.kind == 0x052e, packet.fields.count == 1,
              case let .bytes(id: 30, value: bytes) = packet.fields[0] else { throw ByoFailure.protocolViolation }
        return bytes
    }
    func decode(_ bytes: Data) throws -> Frame {
        let packet = try core.protocolDecode(.init(kind: 0x052f, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: [.bytes(id: 30, value: bytes)]))
        var values: [UInt32: UInt64] = [:]; var payload: Data?
        for field in packet.fields {
            switch field {
            case let .unsigned(id, value) where [127, 97, 24, 152, 39, 150].contains(id):
                guard values.updateValue(value, forKey: id) == nil else { throw ByoFailure.protocolViolation }
            case let .bytes(id: 33, value: value) where payload == nil: payload = value
            default: throw ByoFailure.protocolViolation
            }
        }
        guard packet.kind == 0x052f, values.count == 6, let payload else { throw ByoFailure.protocolViolation }
        return Frame(opcode: values[127]!, operation: values[97]!, status: values[24]!,
            requestID: values[152]!, offset: values[39]!, total: values[150]!, payload: payload)
    }
}

protocol ByoDeviceLink: Sendable {
    func call(_ operation: UInt64, _ document: Data) async throws -> Data
}

actor ByoBLEHost: ByoDeviceLink {
    private let codec: ByoBLECodec
    private let write: @Sendable (Data) async throws -> Void
    private let subscribe: @Sendable () async throws -> AsyncThrowingStream<Data, Error>
    private let unsubscribe: @Sendable () async throws -> Void
    private let validate: @Sendable () async throws -> Void
    private let inbox = ByoBLEInbox()
    private let capacity: Int
    private var pump: Task<Void, Never>?
    private var active = false

    init(core: CoreAbiClient, capacity: Int,
         write: @escaping @Sendable (Data) async throws -> Void,
         subscribe: @escaping @Sendable () async throws -> AsyncThrowingStream<Data, Error>,
         unsubscribe: @escaping @Sendable () async throws -> Void,
         validate: @escaping @Sendable () async throws -> Void) {
        self.codec = ByoBLECodec(core: core); self.capacity = min(512, capacity)
        self.write = write; self.subscribe = subscribe; self.unsubscribe = unsubscribe; self.validate = validate
    }
    func start() async throws {
        guard pump == nil, capacity > 12 else { throw ByoFailure.protocolViolation }
        let stream = try await subscribe(); let inbox = self.inbox
        pump = Task {
            do {
                for try await bytes in stream { await inbox.receive(bytes) }
                await inbox.fail(ByoFailure.disconnected)
            } catch { await inbox.fail(error) }
        }
    }
    /// Callers retain the device operation reservation until teardown settles.
    func close() async throws {
        pump?.cancel(); await inbox.fail(CancellationError())
        do { try await unsubscribe() }
        catch { await pump?.value; pump = nil; throw error }
        await pump?.value; pump = nil
    }
    func call(_ operation: UInt64, _ document: Data = Data()) async throws -> Data {
        guard !active, pump != nil, document.count <= 8192 else {
            throw ByoFailure.protocolViolation
        }
        active = true; defer { active = false }
        let id = try ByoRequestIDs.next()
        var offset = 0; var reply: ByoBLECodec.Frame
        repeat {
            let end = min(document.count, offset + capacity - 12)
            let frame = try codec.encode(opcode: 112, operation: operation, requestID: id,
                offset: offset, total: document.count, payload: document.subdata(in: offset..<end), capacity: capacity)
            reply = try await exchange(frame, operation: operation, id: id, expectedOffset: end < document.count ? end : 0)
            if end < document.count {
                guard reply.status == 1, reply.offset == end, reply.total == document.count,
                      reply.payload.isEmpty else { throw ByoFailure.protocolViolation }
            } else { try successful(reply) }
            offset = end
        } while offset < document.count
        var output = reply.payload
        let total = Int(reply.total)
        guard reply.offset == 0, total <= 8192, output.count <= total else { throw ByoFailure.protocolViolation }
        while output.count < total {
            let frame = try codec.encode(opcode: 114, operation: operation, requestID: id,
                offset: output.count, total: 0, payload: Data(), capacity: capacity)
            reply = try await exchange(frame, operation: operation, id: id, expectedOffset: output.count)
            try successful(reply)
            guard reply.offset == output.count, reply.total == total, !reply.payload.isEmpty,
                  output.count + reply.payload.count <= total else { throw ByoFailure.protocolViolation }
            output.append(reply.payload)
        }
        return output
    }
    private func successful(_ frame: ByoBLECodec.Frame) throws {
        if frame.status == 3 { throw ByoFailure.contextExpired }
        guard frame.status == 0 else { throw ByoFailure.deviceRejected }
    }
    private func exchange(_ bytes: Data, operation: UInt64, id: UInt64, expectedOffset: Int) async throws -> ByoBLECodec.Frame {
        for attempt in 0..<3 {
            try Task.checkCancellation(); try await validate(); try await write(bytes)
            do {
                // Duplicate notifications cannot grow memory or extend a timeout indefinitely.
                for _ in 0..<8 {
                    let frame = try codec.decode(try await inbox.next())
                    guard frame.opcode == 113 else { throw ByoFailure.protocolViolation }
                    if frame.requestID < id { continue }
                    guard frame.requestID == id, frame.operation == operation else { throw ByoFailure.protocolViolation }
                    if frame.status < 2 && frame.offset != expectedOffset { continue }
                    try await validate(); return frame
                }
                throw ByoFailure.protocolViolation
            } catch ByoFailure.timeout {
                if attempt == 2 { throw ByoFailure.timeout }
            }
        }
        throw ByoFailure.timeout
    }
}

private actor ByoBLEInbox {
    private var queued: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var failure: Error?
    private var timer: Task<Void, Never>?
    func receive(_ bytes: Data) {
        guard failure == nil else { return }
        if let waiter { self.waiter = nil; timer?.cancel(); waiter.resume(returning: bytes) }
        else if queued.count < 8 { queued.append(bytes) }
        else { fail(ByoFailure.protocolViolation) }
    }
    func fail(_ error: Error) {
        failure = error; timer?.cancel(); let current = waiter; waiter = nil
        current?.resume(throwing: error); queued.removeAll()
    }
    private func timeout() {
        let current = waiter; waiter = nil; current?.resume(throwing: ByoFailure.timeout)
    }
    func next() async throws -> Data {
        try Task.checkCancellation()
        if let failure { throw failure }
        if !queued.isEmpty { return queued.removeFirst() }
        guard waiter == nil else { throw ByoFailure.protocolViolation }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiter = continuation
                timer = Task {
                    do { try await Task.sleep(nanoseconds: 10_000_000_000); self.timeout() } catch {}
                }
            }
        } onCancel: { Task { await self.fail(CancellationError()) } }
    }
}

enum ByoFailure: Error { case protocolViolation, disconnected, timeout, contextExpired, deviceRejected,
    invalidConfiguration, persistence, identityConflict, notSelected, pending, expiredAuthorization, http(Int) }

private enum ByoRequestIDs {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var value: UInt64 = 0
    static func next() throws -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        guard value < UInt64(UInt32.max) else { throw ByoFailure.protocolViolation }
        value += 1; return value
    }
}
