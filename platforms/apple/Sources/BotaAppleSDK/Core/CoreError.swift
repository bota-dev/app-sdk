struct CoreError: Error, Equatable, Sendable {
    let code: UInt32
    let operation: UInt32
    let retryable: Bool
    let protocolStatus: UInt16?
    let detail: String
}
