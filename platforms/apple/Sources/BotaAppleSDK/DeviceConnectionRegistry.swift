actor DeviceConnectionRegistry {
    private(set) var current: ConnectedDevice?

    func set(_ device: ConnectedDevice) { current = device }
    func clear() { current = nil }

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
