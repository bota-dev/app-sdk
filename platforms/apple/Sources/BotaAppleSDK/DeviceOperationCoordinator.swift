import Foundation

actor DeviceOperationCoordinator {
    private var owner: UUID?

    func begin(_ id: UUID, operation: BotaOperation) throws {
        guard owner == nil else {
            throw BotaSDKError(
                code: .operationInProgress,
                operation: operation,
                retryable: false,
                detail: "another device operation is already active"
            )
        }
        owner = id
    }

    func end(_ id: UUID) {
        if owner == id { owner = nil }
    }
}
