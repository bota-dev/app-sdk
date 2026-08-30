struct CorePacket: Equatable, Sendable {
    let kind: UInt32
    let operation: UInt32
    let requestID: UInt64
    let cancellationHigh: UInt64
    let cancellationLow: UInt64
    let fields: [CoreField]
}
