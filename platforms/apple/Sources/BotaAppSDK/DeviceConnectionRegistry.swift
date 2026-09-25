import Foundation

actor DeviceConnectionRegistry {
    private(set) var current: ConnectedDevice?
    private var connectionGeneration = UUID()

    func set(_ device: ConnectedDevice) { connectionGeneration = UUID(); current = device }
    func clear() { connectionGeneration = UUID(); current = nil }

    func generation(for device: ConnectedDevice) throws -> UUID {
        try require(device)
        return connectionGeneration
    }

    func ownsGeneration(_ generation: UUID) -> Bool { connectionGeneration == generation }

    func require(_ device: ConnectedDevice, generation: UUID) throws {
        try require(device)
        guard ownsGeneration(generation) else {
            throw BotaSDKError(code: .notConnected, operation: .readDeviceLogs, retryable: true,
                               detail: "the diagnostic connection was replaced")
        }
    }

    func require(_ device: ConnectedDevice) throws {
        guard current?.id == device.id, current?.serialNumber == device.serialNumber else {
            throw BotaSDKError(
                code: .notConnected,
                operation: .validate,
                retryable: true,
                detail: "the device is not the current verified connection"
            )
        }
    }
}
