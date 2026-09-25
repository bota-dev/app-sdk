import Foundation

actor EncryptedUploadV2Catalog {
    private let subscribe: @Sendable (String, String) async throws -> AsyncThrowingStream<Data, Error>
    private let write: @Sendable (String, Data) async throws -> Void
    private let unsubscribe: @Sendable (String, String) async throws -> Void
    private let mapper: CoreModelMapper
    private var active = false

    init(bluetooth: CoreBluetoothHost, mapper: CoreModelMapper) {
        self.init(mapper: mapper, subscribe: { peripheralID, uuid in
            try await bluetooth.subscribe(peripheralID: peripheralID, serviceUUID: BotaBluetoothUUIDs.storageService, characteristicUUID: uuid)
        }, write: { peripheralID, data in
            try await bluetooth.write(peripheralID: peripheralID, serviceUUID: BotaBluetoothUUIDs.storageService,
                                      characteristicUUID: BotaBluetoothUUIDs.transferControlV2, data: data)
        }, unsubscribe: { peripheralID, uuid in
            try await bluetooth.unsubscribe(peripheralID: peripheralID, serviceUUID: BotaBluetoothUUIDs.storageService, characteristicUUID: uuid)
        })
    }

    init(mapper: CoreModelMapper,
         subscribe: @escaping @Sendable (String, String) async throws -> AsyncThrowingStream<Data, Error>,
         write: @escaping @Sendable (String, Data) async throws -> Void,
         unsubscribe: @escaping @Sendable (String, String) async throws -> Void) {
        self.mapper = mapper
        self.subscribe = subscribe
        self.write = write
        self.unsubscribe = unsubscribe
    }

    func list(peripheralID: String, timeoutNanoseconds: UInt64 = 30_000_000_000) async throws -> [EncryptedUploadV2Recording] {
        guard !active else {
            throw BotaSDKError(code: .operationInProgress, operation: .transferRecording,
                               retryable: false, detail: "another v2 catalog is active")
        }
        active = true
        defer { active = false }
        let sessionID = UInt64.random(in: 1...UInt64.max)
        _ = try mapper.decodeEncryptedUploadV2Catalog(Data(), transportSessionID: sessionID)
        defer { _ = try? mapper.decodeEncryptedUploadV2Catalog(Data(), transportSessionID: sessionID) }
        var subscribed: [String] = []
        do {
            try Task.checkCancellation()
            let entries = try await subscribe(peripheralID, BotaBluetoothUUIDs.recordingListV2)
            subscribed.append(BotaBluetoothUUIDs.recordingListV2)
            try Task.checkCancellation()
            let errors = try await subscribe(peripheralID, BotaBluetoothUUIDs.recordingTransferV2)
            subscribed.append(BotaBluetoothUUIDs.recordingTransferV2)
            let result = try await withThrowingTaskGroup(of: [EncryptedUploadV2Recording].self) { group in
                group.addTask { [mapper] in
                    for try await data in entries {
                        if let result = try mapper.decodeEncryptedUploadV2Catalog(data, transportSessionID: sessionID) {
                            return result
                        }
                    }
                    throw Self.closed()
                }
                group.addTask { [mapper] in
                    for try await data in errors {
                        let value = try mapper.decodeEncryptedUploadV2TransferControl(data)
                        guard case let .error(error) = value else { throw Self.closed() }
                        if error.transportSessionID != sessionID { continue }
                        guard error.failedMessageType == 0x25 else { throw Self.closed() }
                        throw BotaSDKError(code: .protocolRejected, operation: .transferRecording,
                                           retryable: false, protocolStatus: error.result, detail: "device rejected v2 catalog")
                    }
                    throw Self.closed()
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: timeoutNanoseconds)
                    throw BotaSDKError(code: .timeout, operation: .transferRecording,
                                       retryable: true, detail: "v2 catalog timed out")
                }
                defer { group.cancelAll() }
                try Task.checkCancellation()
                try await write(peripheralID, mapper.createEncryptedUploadV2List(transportSessionID: sessionID))
                guard let value = try await group.next() else { throw Self.closed() }
                return value
            }
            for uuid in subscribed {
                try await unsubscribe(peripheralID, uuid)
            }
            return result
        } catch {
            for uuid in subscribed {
                try? await unsubscribe(peripheralID, uuid)
            }
            throw error
        }
    }

    private static func closed() -> BotaSDKError {
        BotaSDKError(code: .unexpectedEvent, operation: .transferRecording,
                     retryable: false, detail: "unexpected v2 catalog response")
    }
}
