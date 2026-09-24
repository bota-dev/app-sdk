import Foundation

public enum DeviceAPIEnvironment: Sendable {
    case development
    case gamma
    case production
}

enum RecordingControlCommand: Equatable, Sendable {
    case start
    case stop
}

public actor DeviceControlManager {
    private struct RecordingStateObserver {
        let continuation: AsyncThrowingStream<RecordingState, Error>.Continuation
        let lease: RecordingControlSubscriptionLease
        var task: Task<Void, Never>?
    }

    private static let operationTimeoutNanoseconds: UInt64 = 30_000_000_000

    private var runtime: DeviceRuntime?
    private var recordingStateObservers: [UUID: RecordingStateObserver] = [:]

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }
    func detach() async {
        await stopAllRecordingStateObservers()
        runtime = nil
    }

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
        let grant = try Self.grantData(grantBlob)
        try await write(
            grant,
            service: BotaBluetoothUUIDs.controlService,
            characteristic: BotaBluetoothUUIDs.deviceCommand,
            to: device
        )
    }

    public func requestStartRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await requestRecordingControl(.start, device: device, grantBlob: grantBlob)
    }

    public func requestStopRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await requestRecordingControl(.stop, device: device, grantBlob: grantBlob)
    }

    public func readRecordingState(from device: ConnectedDevice) async throws -> RecordingState {
        try await performOperation(device, operation: .readStatus) { runtime in
            let data = try await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.controlService,
                BotaBluetoothUUIDs.recordingStatus
            )
            return try runtime.parseRecordingState(data)
        }
    }

    public func recordingStateUpdates(
        for device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<RecordingState, Error> {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let source = try await runtime.directSubscribe(
            device.id,
            BotaBluetoothUUIDs.controlService,
            BotaBluetoothUUIDs.recordingStatus
        )
        let lease = RecordingControlSubscriptionLease(runtime: runtime, deviceID: device.id)
        let id = UUID()
        let pair = AsyncThrowingStream<RecordingState, Error>.makeStream()
        recordingStateObservers[id] = RecordingStateObserver(
            continuation: pair.continuation,
            lease: lease,
            task: nil
        )
        let task = Task {
            do {
                for try await data in source {
                    pair.continuation.yield(try runtime.parseRecordingState(data))
                }
                pair.continuation.finish()
            } catch is CancellationError {
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
            await self.completeRecordingStateObserver(id)
        }
        recordingStateObservers[id]?.task = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.stopRecordingStateObserver(id) }
        }
        return pair.stream
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

    private func requestRecordingControl(
        _ command: RecordingControlCommand,
        device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        let grant = try Self.grantData(grantBlob)
        return try await performOperation(device, operation: .encode) { runtime in
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.controlService,
                BotaBluetoothUUIDs.deviceCommand,
                grant
            )
            if command == .stop { try await runtime.delay(50) }
            return try await Self.withRecordingSubscription(runtime: runtime, deviceID: device.id) {
                notifications in
                if command == .stop { try await runtime.delay(50) }
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.controlService,
                    BotaBluetoothUUIDs.recordingControl,
                    try runtime.createRecordingControlCommand(command)
                )
                return try await Self.awaitRecordingControlResult(notifications, runtime: runtime)
            }
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

    private func completeRecordingStateObserver(_ id: UUID) async {
        guard let observer = recordingStateObservers.removeValue(forKey: id) else { return }
        await observer.lease.close()
    }

    private func stopRecordingStateObserver(_ id: UUID) async {
        guard let observer = recordingStateObservers.removeValue(forKey: id) else { return }
        observer.task?.cancel()
        observer.continuation.finish()
        await observer.lease.close()
    }

    private func stopAllRecordingStateObservers() async {
        let observers = recordingStateObservers
        recordingStateObservers.removeAll()
        for observer in observers.values {
            observer.task?.cancel()
            observer.continuation.finish()
            await observer.lease.close()
        }
    }

    private static func withRecordingSubscription<T: Sendable>(
        runtime: DeviceRuntime,
        deviceID: String,
        body: @escaping @Sendable (AsyncThrowingStream<Data, Error>) async throws -> T
    ) async throws -> T {
        let source = try await runtime.directSubscribe(
            deviceID,
            BotaBluetoothUUIDs.controlService,
            BotaBluetoothUUIDs.recordingStatus
        )
        let lease = RecordingControlSubscriptionLease(runtime: runtime, deviceID: deviceID)
        return try await withTaskCancellationHandler {
            do {
                let value = try await body(source)
                await lease.close()
                return value
            } catch {
                await lease.close()
                throw error
            }
        } onCancel: {
            Task { await lease.close() }
        }
    }

    private static func awaitRecordingControlResult(
        _ notifications: AsyncThrowingStream<Data, Error>,
        runtime: DeviceRuntime
    ) async throws -> RecordingControlResult {
        try await withThrowingTaskGroup(of: RecordingControlResult.self) { group in
            group.addTask {
                for try await data in notifications {
                    return try runtime.parseRecordingControlResult(data)
                }
                throw BotaSDKError(
                    code: .unexpectedEvent,
                    operation: .encode,
                    retryable: true,
                    detail: "Recording control ended without a result"
                )
            }
            group.addTask {
                try await Task.sleep(nanoseconds: operationTimeoutNanoseconds)
                throw BotaSDKError(
                    code: .timeout,
                    operation: .encode,
                    retryable: true,
                    detail: "Recording control timed out"
                )
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static func grantData(_ value: String) throws -> Data {
        guard let data = Data(base64Encoded: value), !data.isEmpty else {
            throw invalid("grant blob is not valid base64 data")
        }
        return data
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

private actor RecordingControlSubscriptionLease {
    private let runtime: DeviceRuntime
    private let deviceID: String
    private var closed = false

    init(runtime: DeviceRuntime, deviceID: String) {
        self.runtime = runtime
        self.deviceID = deviceID
    }

    func close() async {
        guard !closed else { return }
        closed = true
        try? await runtime.directUnsubscribe(
            deviceID,
            BotaBluetoothUUIDs.controlService,
            BotaBluetoothUUIDs.recordingStatus
        )
    }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
