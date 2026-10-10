import Foundation

actor DeviceOperationCoordinator {
    private var owner: UUID?
    private var control: UUID?
    private var live = false

    func begin(_ id: UUID, operation: BotaOperation, allowRecordingControl: Bool = false, recordingControl: Bool = false) throws {
        if owner != nil, live, recordingControl, control == nil { control = id; return }
        guard owner == nil, control == nil else {
            throw BotaSDKError(
                code: .operationInProgress,
                operation: operation,
                retryable: false,
                detail: "another device operation is already active"
            )
        }
        owner = id; live = allowRecordingControl
    }

    func end(_ id: UUID) {
        if control == id { control = nil }
        if owner == id { owner = nil; live = false }
    }
}
