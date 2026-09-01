import Foundation

public enum DeviceAPIEnvironment: Sendable {
    case development
    case gamma
    case production
}

public actor DeviceControlManager {
    private var runtime: DeviceRuntime?

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }
    func detach() { runtime = nil }

    public func isProvisioned(_ device: ConnectedDevice) async throws -> Bool {
        try await readPairingState(from: device) == .paired
    }

    public func readPairingState(from device: ConnectedDevice) async throws -> PairingState {
        try await performOperation(device, operation: .decode) { runtime in
            let data = try await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.provisioningService,
                BotaBluetoothUUIDs.pairingState
            )
            guard let value = data.first else { return .unpaired }
            return Self.pairingState(value)
        }
    }

    public func readPublicKey(from device: ConnectedDevice) async throws -> String? {
        try await performOperation(device, operation: .decode) { runtime in
            guard let data = try? await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.authService,
                BotaBluetoothUUIDs.devicePublicKey
            ), data.count == 64 else { return nil }
            return data.hexString
        }
    }

    public func readAuthNonce(from device: ConnectedDevice) async throws -> String? {
        try await performOperation(device, operation: .decode) { runtime in
            guard let data = try? await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.authService,
                BotaBluetoothUUIDs.authNonce
            ), data.count == 16 else { return nil }
            return data.hexString
        }
    }

    public func setAPIEndpoint(
        _ environment: DeviceAPIEnvironment,
        on device: ConnectedDevice
    ) async throws {
        try await write(
            Data([Self.endpointCode(environment)]),
            service: BotaBluetoothUUIDs.provisioningService,
            characteristic: BotaBluetoothUUIDs.apiEndpoint,
            to: device
        )
    }

    public func deliverCertificate(
        _ certificatePEM: String,
        privateKeyPEM: String,
        to device: ConnectedDevice
    ) async throws {
        try await performOperation(device, operation: .encode) { runtime in
            let payload = Data("\(certificatePEM.trimmingCharacters(in: .whitespacesAndNewlines))\n\(privateKeyPEM.trimmingCharacters(in: .whitespacesAndNewlines))\n".utf8)
            let chunks = try runtime.createProvisioningChunks(payload, device.mtu)
            for chunk in chunks {
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.authService,
                    BotaBluetoothUUIDs.deviceCertificate,
                    chunk
                )
            }
        }
    }

    public func deliverBackendPublicKey(_ publicKey: Data, to device: ConnectedDevice) async throws {
        guard publicKey.count == 32 else { throw Self.invalid("backend public key must be 32 bytes") }
        try await write(
            publicKey,
            service: BotaBluetoothUUIDs.authService,
            characteristic: BotaBluetoothUUIDs.backendPublicKey,
            to: device
        )
    }

    public func writeGrant(_ grantBlob: String, to device: ConnectedDevice) async throws {
        guard let grant = Data(base64Encoded: grantBlob), !grant.isEmpty else {
            throw Self.invalid("grant blob is not valid base64 data")
        }
        try await write(
            grant,
            service: BotaBluetoothUUIDs.controlService,
            characteristic: BotaBluetoothUUIDs.deviceCommand,
            to: device
        )
    }

    public func syncTime(
        _ date: Date = Date(),
        timezoneOffsetMinutes: Int16? = nil,
        to device: ConnectedDevice
    ) async throws {
        guard date.timeIntervalSince1970 >= 0 else { throw Self.invalid("time sync date is before 1970") }
        let milliseconds = date.timeIntervalSince1970 * 1_000
        guard milliseconds <= Double(UInt64.max) else { throw Self.invalid("time sync date is out of range") }
        let offset = timezoneOffsetMinutes ?? Int16(
            clamping: TimeZone.current.secondsFromGMT(for: date) / 60
        )
        try await performOperation(device, operation: .encode) { runtime in
            let data = try runtime.createTimeSyncData(UInt64(milliseconds.rounded(.down)), offset)
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.controlService,
                BotaBluetoothUUIDs.timeSync,
                data
            )
        }
    }

    private func write(
        _ data: Data,
        service: String,
        characteristic: String,
        to device: ConnectedDevice
    ) async throws {
        try await performOperation(device, operation: .encode) { runtime in
            try await runtime.directWrite(device.id, service, characteristic, data)
        }
    }

    private func performOperation<T: Sendable>(
        _ device: ConnectedDevice,
        operation: BotaOperation,
        body: @escaping @Sendable (DeviceRuntime) async throws -> T
    ) async throws -> T {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let id = UUID()
        try await runtime.operations.begin(id, operation: operation)
        do {
            let value = try await body(runtime)
            await runtime.operations.end(id)
            return value
        } catch {
            await runtime.operations.end(id)
            throw error
        }
    }

    private func configuredRuntime() throws -> DeviceRuntime {
        guard let runtime else {
            throw BotaSDKError(
                code: .featureUnavailable,
                operation: .validate,
                retryable: false,
                detail: "BotaDeviceClient.configure() must be called first"
            )
        }
        return runtime
    }

    private static func pairingState(_ value: UInt8) -> PairingState {
        switch value {
        case 0: .unpaired
        case 1: .pairing
        case 2: .paired
        case 3: .error
        default: .unknown(value)
        }
    }

    private static func endpointCode(_ environment: DeviceAPIEnvironment) -> UInt8 {
        switch environment {
        case .development: 0
        case .production: 1
        case .gamma: 2
        }
    }

    private static func invalid(_ detail: String) -> BotaSDKError {
        BotaSDKError(
            code: .invalidInput,
            operation: .validate,
            retryable: false,
            detail: detail
        )
    }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
