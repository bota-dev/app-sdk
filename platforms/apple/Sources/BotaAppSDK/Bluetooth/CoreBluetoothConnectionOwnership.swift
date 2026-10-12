import Foundation

// Accessed only on CoreBluetoothDriver's serial queue.
struct CoreBluetoothConnectionOwnership {
    private var identities: [UUID: String] = [:]
    private var pending: [UUID: CheckedContinuation<Void, Error>] = [:]

    func identity(_ id: UUID) -> String? { identities[id] }

    mutating func connect(
        _ id: UUID,
        systemConnected: Bool,
        continuation: CheckedContinuation<Void, Error>,
        start: () -> Void
    ) {
        if systemConnected, identities[id] != nil {
            continuation.resume()
            return
        }
        identities.removeValue(forKey: id)
        pending.removeValue(forKey: id)?.resume(throwing: CentralDriverError.disconnected(id.uuidString))
        pending[id] = continuation
        start()
    }

    mutating func didConnect(_ id: UUID) {
        identities[id] = UUID().uuidString
        pending.removeValue(forKey: id)?.resume()
    }

    mutating func didFailToConnect(_ id: UUID, error: Error) {
        identities.removeValue(forKey: id)
        failPending(id, error: error)
    }

    mutating func didDisconnect(_ id: UUID, error: Error) {
        identities.removeValue(forKey: id)
        failPending(id, error: error)
    }

    mutating func failPending(_ id: UUID, error: Error) {
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    mutating func clear(error: Error) {
        identities.removeAll()
        let requests = pending.values
        pending.removeAll()
        requests.forEach { $0.resume(throwing: error) }
    }
}
