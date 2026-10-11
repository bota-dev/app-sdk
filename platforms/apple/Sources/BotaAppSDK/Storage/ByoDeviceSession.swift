import Foundation

struct ByoDeviceSession {
    typealias Refresh = @Sendable () async throws -> Void
    static func run(runtime: DeviceRuntime, device: ConnectedDevice, recording: ByoRecording?,
                    options: ByoStorageOptions, live: Bool = false, validateOwner: @escaping @Sendable () async throws -> Void) async throws -> ByoUploadResult {
        try await withLink(runtime: runtime, device: device, options: options, validateOwner: validateOwner) { ble, http, refresh in
            try await refresh()
            let selectedRecording: ByoRecording
            if let recording { selectedRecording = recording }
            else {
                guard live else { throw ByoFailure.invalidConfiguration }
                let current = try byoObject(await ble.call(9))
                guard current["closed"] as? Bool == false, let uuid = current["recording_uuid"] as? String,
                      let generation = current["recording_generation"] as? UInt32, generation > 0 else { throw ByoFailure.protocolViolation }
                selectedRecording = ByoRecording(uuid: uuid, generation: generation)
            }
            let recording = selectedRecording
            let capability = try byoObject(await ble.call(1))
            var selected = false
            if (capability["upload_modes"] as? [String])?.contains("http_segments") == true {
                guard let parsed = UUID(uuidString: recording.uuid), parsed.uuidString.lowercased() == recording.uuid else { throw ByoFailure.invalidConfiguration }
                var uuid = parsed.uuid; var generation = recording.generation.littleEndian
                let identity = withUnsafeBytes(of: &uuid) { Data($0) } + withUnsafeBytes(of: &generation) { Data($0) }
                do { selected = try byoObject(await ble.call(9, identity))["stream_selected"] as? Bool == true }
                catch ByoFailure.deviceRejected { selected = false }
            }
            if live || selected { return try await ByoStreamSession(options: options, recording: recording, ble: ble, http: http, refresh: refresh).run() }
            return try await ByoUploadSession(options: options, recording: recording, ble: ble, http: http, refresh: refresh).run()
        }
    }
    static func list(runtime: DeviceRuntime, device: ConnectedDevice, options: ByoStorageOptions,
                     validateOwner: @escaping @Sendable () async throws -> Void) async throws -> [ByoRecording] {
        try await withLink(runtime: runtime, device: device, options: options, validateOwner: validateOwner) { ble, _, refresh in
            try await refresh()
            var cursor: UInt32 = 0; var result: [ByoRecording] = []; var seen: Set<String> = []
            var refreshed = ByoContinuousInstant.now
            for _ in 0..<4097 {
                if refreshed.seconds(to: .now) > 30 { try await refresh(); refreshed = .now }
                var raw = cursor.littleEndian
                let request = withUnsafeBytes(of: &raw) { Data($0) }
                let bytes: Data
                do { bytes = try await ble.call(8, request) }
                catch ByoFailure.contextExpired { try await refresh(); bytes = try await ble.call(8, request) }
                let reply = try byoObject(bytes)
                guard let next = reply["next"] as? UInt32 else { throw ByoFailure.protocolViolation }
                if let entry = reply["recording"] as? [String: Any] {
                    guard let uuid = entry["recording_uuid"] as? String, UUID(uuidString: uuid)?.uuidString.lowercased() == uuid,
                          let generation = entry["recording_generation"] as? UInt32 else { throw ByoFailure.protocolViolation }
                    if seen.insert("\(uuid):\(generation)").inserted { result.append(ByoRecording(uuid: uuid, generation: generation)) }
                }
                if next == 0 { return result }
                guard next > cursor else { throw ByoFailure.protocolViolation }; cursor = next
            }
            throw ByoFailure.protocolViolation
        }
    }
    private static func withLink<T: Sendable>(runtime: DeviceRuntime, device: ConnectedDevice,
                    options: ByoStorageOptions, validateOwner: @escaping @Sendable () async throws -> Void,
                    body: @escaping @Sendable (ByoBLEHost, ByoHTTP, @escaping Refresh) async throws -> T) async throws -> T {
        let generation = try await runtime.connection.generation(for: device)
        let validate: @Sendable () async throws -> Void = {
            try Task.checkCancellation(); try await validateOwner(); try await options.validateScope()
            try await runtime.connection.require(device, generation: generation)
        }
        let mapper = try CoreModelMapper()
        let writer = EncryptedUploadV2SignedBlobWriter(mapper: mapper,
            maximumWriteLength: runtime.encryptedUploadV2MaximumWriteLength,
            subscribe: { try await runtime.directSubscribe($0, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.transferSignedBlobV2) },
            write: { try await runtime.directWrite($0, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.transferSignedBlobV2, $1) },
            unsubscribe: { try await runtime.directUnsubscribe($0, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.transferSignedBlobV2) })
        let ids = ByoSignedWriteIDs()
        let context = EncryptedUploadV2ContextHost(begin: { attempt in
            try await validate()
            try await runtime.directWrite(device.id, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.uploadContextV2,
                mapper.createEncryptedUploadV2ContextBegin(attemptID: attempt))
        }, read: {
            try await validate()
            let bytes = try await runtime.directRead(device.id, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.uploadContextV2)
            try await validate(); return try mapper.decodeEncryptedUploadV2ContextSnapshot(bytes)
        }, sendDocument: { kind, bytes in
            try await validate()
            try await writer.send(peripheralID: device.id, kind: kind, writeID: ids.next(), document: bytes, maximumDocumentBytes: 408)
            try await validate()
        }, validateDocument: { try mapper.validateEncryptedUploadV2ContextDocument(kind: $0, data: $1) })
        let http = try ByoHTTP(options)
        let ble = ByoBLEHost(core: try CoreAbiClient(), capacity: try await runtime.encryptedUploadV2MaximumWriteLength(device.id),
            write: { try await runtime.directWrite(device.id, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.transferControlV2, $0) },
            subscribe: { try await runtime.directSubscribe(device.id, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.recordingTransferV2) },
            unsubscribe: { try await runtime.directUnsubscribe(device.id, BotaBluetoothUUIDs.storageService, BotaBluetoothUUIDs.recordingTransferV2) },
            validate: validate)
        let refresh: Refresh = { try await validate(); try await context.refresh(provider: { try await http.contextExchange($0) }) }
        do {
            try await validate(); try await ble.start()
            let result = try await body(ble, http, refresh)
            _ = try await ble.call(7)
            try await ble.close(); return result
        } catch {
            // Finish cancellation before releasing the shared operation. If
            // teardown is uncertain, retire the connection, retaining source.
            await context.cancel()
            await Task.detached {
                let aborted = (try? await ble.call(7)) != nil
                do {
                    try await ble.close()
                    if !aborted { try? await runtime.disconnect(device.id) }
                } catch { try? await runtime.disconnect(device.id) }
            }.value
            throw error
        }
    }
}

private final class ByoSignedWriteIDs: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt32 = 0
    func next() -> UInt32 {
        lock.lock(); defer { lock.unlock() }
        value = value == UInt32.max ? 1 : value + 1; return value
    }
}
