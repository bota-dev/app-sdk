enum RadioPriority: Int, Sendable {
    case backgroundReconnect = 0
    case manualSelection = 1
}

struct RadioOwner: Equatable, Sendable {
    let peripheralID: String
    let priority: RadioPriority
}

actor RadioArbiter {
    private(set) var owner: RadioOwner?

    func acquire(peripheralID: String, priority: RadioPriority) -> String? {
        guard let owner else {
            self.owner = RadioOwner(peripheralID: peripheralID, priority: priority)
            return nil
        }
        if owner.peripheralID == peripheralID {
            self.owner = RadioOwner(peripheralID: peripheralID, priority: max(owner.priority, priority))
            return nil
        }
        guard priority.rawValue > owner.priority.rawValue else { return peripheralID }
        self.owner = RadioOwner(peripheralID: peripheralID, priority: priority)
        return owner.peripheralID
    }

    func release(peripheralID: String) {
        if owner?.peripheralID == peripheralID { owner = nil }
    }
}

private func max(_ lhs: RadioPriority, _ rhs: RadioPriority) -> RadioPriority {
    lhs.rawValue >= rhs.rawValue ? lhs : rhs
}
