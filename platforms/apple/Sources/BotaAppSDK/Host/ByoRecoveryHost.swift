import Foundation

/// Native-only transition bridge. The owner supplies freshly authenticated
/// scope fields and a source-specific durable store. Save must fsync/flush the
/// file and directory; readback alone is not a substitute for that contract.
/// Signed documents, upload targets and bytes never enter these packets.
final class ByoRecoveryHost {
    struct Decision {
        let phase: UInt64
        let retryAfterMilliseconds: UInt64?
        let mayCleanup: Bool
        let renewalRevision: UInt64?
        let renewalOperation: String?
    }
    struct RenewalRequest: Equatable {
        let operationId: String
        let expectedRevision: UInt64
    }
    private let core: CoreAbiClient
    private let load: () throws -> Data?
    private let save: (Data) throws -> Void
    private let lock = NSLock()

    init(core: CoreAbiClient, load: @escaping () throws -> Data?, save: @escaping (Data) throws -> Void) {
        self.core = core; self.load = load; self.save = save
    }

    func advance(fields: [CoreField]) throws -> Decision {
        lock.lock(); defer { lock.unlock() }
        return try advanceLocked(fields: fields)
    }

    /// Fresh scope fields contain no command or checkpoint. The returned request
    /// is already durable; send it unchanged to the exact session's /recover.
    func prepareRenewal(scopeFields: [CoreField], operationId: String) throws -> RenewalRequest {
        lock.lock(); defer { lock.unlock() }
        let state = try advanceLocked(fields: scopeFields + [.unsigned(id: 97, value: 15)])
        guard let revision = state.renewalRevision else { throw Failure.invalidCheckpoint }
        if let pending = state.renewalOperation {
            return RenewalRequest(operationId: pending, expectedRevision: revision)
        }
        let prepared = try advanceLocked(fields: scopeFields + [.unsigned(id: 97, value: 13),
            .text(id: 219, value: operationId), .unsigned(id: 222, value: revision)])
        guard prepared.renewalOperation == operationId, prepared.renewalRevision == revision else {
            throw Failure.invalidCheckpoint
        }
        return RenewalRequest(operationId: operationId, expectedRevision: revision)
    }

    /// Call only after authenticating the same-session response and durably
    /// storing any opaque permit. Rust rejects stale/replaced request replies.
    func acceptRenewal(scopeFields: [CoreField], request: RenewalRequest, revision: UInt64) throws {
        guard request.expectedRevision < UInt64(UInt32.max), revision == request.expectedRevision + 1 else {
            throw Failure.invalidCheckpoint
        }
        _ = try advance(fields: scopeFields + [.unsigned(id: 97, value: 14),
            .text(id: 219, value: request.operationId), .unsigned(id: 222, value: revision)])
    }

    private func advanceLocked(fields: [CoreField]) throws -> Decision {
        var input = fields
        if let checkpoint = try load() {
            guard !checkpoint.isEmpty, checkpoint.count <= 2048 else { throw Failure.invalidCheckpoint }
            input.append(.bytes(id: 28, value: checkpoint))
        }
        let output = try core.protocolEncode(.init(kind: 0x052d, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: input))
        var checkpoint: Data?; var phase: UInt64?; var mayCleanup: Bool?; var retry: UInt64?
        var renewalRevision: UInt64?; var renewalOperation: String?
        for field in output.fields {
            switch field {
            case .bytes(id: 28, value: let bytes) where checkpoint == nil: checkpoint = bytes
            case .unsigned(id: 153, value: let value) where phase == nil: phase = value
            case .bool(id: 221, value: let value) where mayCleanup == nil: mayCleanup = value
            case .unsigned(id: 220, value: let value) where retry == nil: retry = value
            case .unsigned(id: 222, value: let value) where renewalRevision == nil: renewalRevision = value
            case .text(id: 219, value: let value) where renewalOperation == nil: renewalOperation = value
            default: throw Failure.invalidCheckpoint
            }
        }
        guard output.kind == 0x052d, let checkpoint, !checkpoint.isEmpty, checkpoint.count <= 2048,
              let phase, phase <= 9, let mayCleanup else { throw Failure.invalidCheckpoint }
        try save(checkpoint)
        guard try load() == checkpoint else { throw Failure.persistence }
        return Decision(phase: phase, retryAfterMilliseconds: retry, mayCleanup: mayCleanup,
            renewalRevision: renewalRevision, renewalOperation: renewalOperation)
    }
    enum Failure: Error { case invalidCheckpoint, persistence }
}
