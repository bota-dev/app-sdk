import Foundation

/// Shared Rust wire decisions; platform code only performs file and network I/O.
func byoCustomer(_ command: UInt64, _ value: [String: Any]) throws -> Data {
    let core = try CoreAbiClient()
    let reply = try core.protocolEncode(.init(kind: 0x0530, operation: 0, requestID: 0,
        cancellationHigh: 0, cancellationLow: 0, fields: [.unsigned(id: 97, value: command), .bytes(id: 30, value: byoJSON(value))]))
    for case .bytes(id: 30, value: let bytes) in reply.fields { return bytes }
    throw ByoFailure.protocolViolation
}
func byoTransferAck(_ proof: [String: Any], segment: [String: Any], customer: Bool) throws {
    _ = try byoCustomer(2, ["proof": proof, "segment": segment, "customer": customer])
}
