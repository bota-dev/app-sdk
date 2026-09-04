import BotaDeviceSDKC
import Foundation

actor CoreBluetoothHost: BluetoothHost {
    private let driver: any CentralDriver
    private let radioArbiter: RadioArbiter
    private let operationGate = PeripheralOperationGate()
    private let serviceDiscoveryTimeoutNanoseconds: UInt64

    init(
        driver: any CentralDriver,
        radioArbiter: RadioArbiter = RadioArbiter(),
        serviceDiscoveryTimeoutNanoseconds: UInt64 = 10_000_000_000
    ) {
        self.driver = driver
        self.radioArbiter = radioArbiter
        self.serviceDiscoveryTimeoutNanoseconds = serviceDiscoveryTimeoutNanoseconds
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        let task = Task {
            do {
                switch effect {
                case .bluetoothStartScan:
                    try await scan(effect, continuation: pair.continuation)
                case .bluetoothStopScan:
                    try await driver.stopScan()
                    pair.continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_STOPPED)))
                case .bluetoothConnect:
                    try await connect(effect, continuation: pair.continuation)
                case .bluetoothDiscoverServices:
                    try await discover(effect, continuation: pair.continuation)
                case .bluetoothDisconnect:
                    let peripheralID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID))
                    try await disconnect(peripheralID: peripheralID)
                    pair.continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_DISCONNECTED),
                        fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID)]
                    ))
                case .bluetoothRead:
                    try await read(effect, continuation: pair.continuation)
                case .bluetoothWrite:
                    try await write(effect, continuation: pair.continuation)
                case .bluetoothSubscribe:
                    try await subscribe(effect, continuation: pair.continuation)
                case .bluetoothUnsubscribe:
                    try await unsubscribe(effect)
                case .timerSchedule, .timerCancel, .persistenceLoadCheckpoint,
                     .persistenceSaveCheckpoint, .persistenceDeleteCheckpoint,
                     .persistenceSaveConnectionIdentity, .persistenceSaveFactoryResetResult,
                     .persistenceDeleteFactoryResetResult, .secureStorageRead, .secureStorageWrite,
                     .secureStorageDelete, .networkDownload, .networkUpload, .progress,
                     .prepareProvisioning, .prepareFactoryResetGrant, .recordingSinkTruncate,
                     .recordingSinkAppend, .recordingSinkFinalize, .recordingSinkDiscard,
                     .streamingSinkAppendPlaintext, .streamingSinkBeginEncrypted,
                     .streamingSinkAppendEncrypted, .streamingSinkFinalize,
                     .streamingSinkDiscard,
                     .firmwareBlobRead, .encryptedUploadV2LoadCheckpoint,
                     .encryptedUploadV2DeleteCheckpoint, .encryptedUploadV2TruncateSink,
                     .encryptedUploadV2PrepareSession, .encryptedUploadV2StartTransfer,
                     .encryptedUploadV2RepairWindow, .encryptedUploadV2SaveCheckpoint,
                     .encryptedUploadV2AcknowledgeWindow, .encryptedUploadV2StageArtifacts,
                     .encryptedUploadV2AwaitReceipt, .encryptedUploadV2ConfirmWithReceipt,
                     .encryptedUploadV2Abort:
                    throw invalid(effect, "non-Bluetooth effect reached CoreBluetoothHost")
                }
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
        }
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        return pair.stream
    }

    func disconnect(peripheralID: String) async throws {
        try await driver.disconnect(peripheralID: peripheralID)
        await radioArbiter.release(peripheralID: peripheralID)
    }

    func read(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws -> Data {
        try await serialized(peripheralID) {
            try await driver.read(
                peripheralID: peripheralID,
                serviceUUID: serviceUUID,
                characteristicUUID: characteristicUUID
            )
        }
    }

    func subscribe(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws -> AsyncThrowingStream<Data, Error> {
        try await serialized(peripheralID) {
            try await driver.subscribe(
                peripheralID: peripheralID,
                serviceUUID: serviceUUID,
                characteristicUUID: characteristicUUID
            )
        }
    }

    func write(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String,
        data: Data
    ) async throws {
        try await serialized(peripheralID) {
            try await driver.write(
                peripheralID: peripheralID,
                serviceUUID: serviceUUID,
                characteristicUUID: characteristicUUID,
                data: data,
                withResponse: true
            )
        }
    }

    func unsubscribe(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws {
        try await serialized(peripheralID) {
            try await driver.unsubscribe(
                peripheralID: peripheralID,
                serviceUUID: serviceUUID,
                characteristicUUID: characteristicUUID
            )
        }
    }

    private func scan(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let allowDuplicates = try requiredBool(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES))
        var seen: Set<String> = []
        let connected = await driver.connectedPeripherals(serviceUUIDs: BotaBluetoothUUIDs.botaServices)
        for advertisement in connected where allowDuplicates || seen.insert(advertisement.id).inserted {
            continuation.yield(advertisement.payload)
        }
        let advertisements = try await driver.startScan(allowDuplicates: allowDuplicates)
        for try await advertisement in advertisements {
            if allowDuplicates || seen.insert(advertisement.id).inserted {
                continuation.yield(advertisement.payload)
            }
        }
    }

    private func connect(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let peripheralID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID))
        let priority: RadioPriority = effect.operation == UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT)
            ? .manualSelection
            : .backgroundReconnect
        if let preempted = await radioArbiter.acquire(peripheralID: peripheralID, priority: priority),
           preempted != peripheralID {
            try? await driver.disconnect(peripheralID: preempted)
        } else if await radioArbiter.owner?.peripheralID != peripheralID {
            throw CentralDriverError.bluetoothUnavailable
        }
        try await serialized(peripheralID) { try await driver.connect(peripheralID: peripheralID) }
        continuation.yield(.init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_CONNECTED),
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID)]
        ))
    }

    private func discover(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let peripheralID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID))
        do {
            try await withTimeout(serviceDiscoveryTimeoutNanoseconds) {
                try await self.serialized(peripheralID) {
                    let services = try await self.driver.discoverServices(
                        peripheralID: peripheralID,
                        serviceUUIDs: BotaBluetoothUUIDs.botaServices + [
                            BotaBluetoothUUIDs.deviceInformationService,
                            BotaBluetoothUUIDs.batteryService,
                        ]
                    )
                    try await self.driver.discoverCharacteristics(peripheralID: peripheralID, serviceUUIDs: services)
                }
            }
        } catch is TimeoutError {
            try? await driver.disconnect(peripheralID: peripheralID)
            await radioArbiter.release(peripheralID: peripheralID)
            throw CentralDriverError.serviceDiscoveryTimedOut(peripheralID)
        }
        continuation.yield(.init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SERVICES_DISCOVERED),
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID)]
        ))
    }

    private func read(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let values = try await characteristicFields(effect)
        let data = try await serialized(values.peripheralID) {
            try await driver.read(
                peripheralID: values.peripheralID,
                serviceUUID: values.serviceUUID,
                characteristicUUID: values.characteristicUUID
            )
        }
        continuation.yield(.init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_READ_COMPLETED),
            fields: [.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: data)]
        ))
    }

    private func write(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let values = try await characteristicFields(effect)
        let payload = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD))
        let withResponse = try requiredBool(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_WITH_RESPONSE))
        try await serialized(values.peripheralID) {
            try await driver.write(
                peripheralID: values.peripheralID,
                serviceUUID: values.serviceUUID,
                characteristicUUID: values.characteristicUUID,
                data: payload,
                withResponse: withResponse
            )
        }
        continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_WRITE_COMPLETED)))
    }

    private func subscribe(
        _ effect: CoreEffect,
        continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation
    ) async throws {
        let values = try await characteristicFields(effect)
        let notifications = try await serialized(values.peripheralID) {
            try await driver.subscribe(
                peripheralID: values.peripheralID,
                serviceUUID: values.serviceUUID,
                characteristicUUID: values.characteristicUUID
            )
        }
        continuation.yield(.init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SUBSCRIBED),
            fields: [.text(
                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHARACTERISTIC_UUID),
                value: values.characteristicUUID
            )]
        ))
        for try await data in notifications {
            continuation.yield(.init(
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_NOTIFICATION),
                fields: [
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHARACTERISTIC_UUID), value: values.characteristicUUID),
                    .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: data),
                ]
            ))
        }
    }

    private func unsubscribe(_ effect: CoreEffect) async throws {
        let values = try await characteristicFields(effect)
        try await serialized(values.peripheralID) {
            try await driver.unsubscribe(
                peripheralID: values.peripheralID,
                serviceUUID: values.serviceUUID,
                characteristicUUID: values.characteristicUUID
            )
        }
    }

    private func serialized<T: Sendable>(
        _ peripheralID: String,
        operation: @Sendable () async throws -> T
    ) async throws -> T {
        await operationGate.acquire(peripheralID)
        do {
            let value = try await operation()
            await operationGate.release(peripheralID)
            return value
        } catch {
            await operationGate.release(peripheralID)
            throw error
        }
    }

    private func characteristicFields(_ effect: CoreEffect) async throws -> (
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) {
        let currentOwner = await radioArbiter.owner
        let peripheralID = effect.packet.fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID))
            ?? currentOwner?.peripheralID
        guard let peripheralID else {
            throw invalid(effect, "Bluetooth operation has no current peripheral")
        }
        return (
            peripheralID,
            try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERVICE_UUID)),
            try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHARACTERISTIC_UUID))
        )
    }

    private func requiredText(_ effect: CoreEffect, _ id: UInt32) throws -> String {
        guard let value = effect.packet.fields.text(id) else { throw invalid(effect, "missing text field \(id)") }
        return value
    }

    private func requiredBool(_ effect: CoreEffect, _ id: UInt32) throws -> Bool {
        guard let value = effect.packet.fields.bool(id) else { throw invalid(effect, "missing Boolean field \(id)") }
        return value
    }

    private func requiredBytes(_ effect: CoreEffect, _ id: UInt32) throws -> Data {
        guard let value = effect.packet.fields.bytes(id) else { throw invalid(effect, "missing bytes field \(id)") }
        return value
    }

    private func invalid(_ effect: CoreEffect, _ detail: String) -> CoreError {
        CoreError(
            code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INVALID_INPUT),
            operation: effect.operation,
            retryable: false,
            protocolStatus: nil,
            detail: detail
        )
    }
}

private actor PeripheralOperationGate {
    private var busy: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func acquire(_ peripheralID: String) async {
        guard busy.contains(peripheralID) else {
            busy.insert(peripheralID)
            return
        }
        await withCheckedContinuation { waiters[peripheralID, default: []].append($0) }
    }

    func release(_ peripheralID: String) {
        if var queued = waiters[peripheralID], !queued.isEmpty {
            let next = queued.removeFirst()
            waiters[peripheralID] = queued.isEmpty ? nil : queued
            next.resume()
        } else {
            busy.remove(peripheralID)
        }
    }
}

private struct TimeoutError: Error {}

private func withTimeout<T: Sendable>(
    _ nanoseconds: UInt64,
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        let race = TimeoutRace(continuation)
        Task {
            do { race.resolve(.success(try await operation())) }
            catch { race.resolve(.failure(error)) }
        }
        Task {
            try await Task.sleep(nanoseconds: nanoseconds)
            race.resolve(.failure(TimeoutError()))
        }
    }
}

private final class TimeoutRace<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    init(_ continuation: CheckedContinuation<T, Error>) {
        self.continuation = continuation
    }

    func resolve(_ result: Result<T, Error>) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

private extension CentralAdvertisement {
    var payload: CoreHostEventPayload {
        var fields: [CoreField] = [
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: id),
            .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: Int64(rssi)),
        ]
        if let name { fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME), value: name)) }
        if let advertisedAddress {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS), value: advertisedAddress))
        }
        return CoreHostEventPayload(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_RESULT), fields: fields)
    }
}

private extension Array where Element == CoreField {
    func text(_ id: UInt32) -> String? {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func bool(_ id: UInt32) -> Bool? {
        for field in self {
            if case let .bool(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func bytes(_ id: UInt32) -> Data? {
        for field in self {
            if case let .bytes(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
