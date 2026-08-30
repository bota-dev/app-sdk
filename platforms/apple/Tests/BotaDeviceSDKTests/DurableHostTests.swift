import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class DurableHostTests: XCTestCase {
    func testCheckpointAndFactoryResetJournalSurviveHostRecreation() async throws {
        let root = temporaryDirectory()
        let secureStorage = KeychainSecureStorageHost(
            service: "dev.bota.tests.\(UUID().uuidString)",
            backend: InMemoryKeychainBackend()
        )
        let first = FilePersistenceHost(rootDirectory: root, secureStorage: secureStorage)
        let checkpoint = Data([0x01, 0x02, 0x03])

        _ = try await payloads(first, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT),
            fields: [.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT), value: checkpoint)]
        ))
        let replacement = Data([0x04, 0x05])
        _ = try await payloads(first, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT),
            requestID: 2,
            fields: [.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT), value: replacement)]
        ))
        _ = try await payloads(first, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT),
            requestID: 2,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: "reset-1"),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE), value: 7),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT), value: 42),
            ]
        ))

        let recreated = FilePersistenceHost(rootDirectory: root, secureStorage: secureStorage)
        let loaded = try await payloads(recreated, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT),
            requestID: 3
        ))
        let reset = try await recreated.loadFactoryResetResult()

        XCTAssertEqual(loaded.first?.bytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT)), replacement)
        XCTAssertEqual(reset, PersistedFactoryResetResult(commandID: "reset-1", resultCode: 7, deletedRecordingCount: 42))
    }

    func testFactoryResetJournalDeletesOnlyTheExactCommand() async throws {
        let root = temporaryDirectory()
        let host = FilePersistenceHost(
            rootDirectory: root,
            secureStorage: KeychainSecureStorageHost(
                service: "dev.bota.tests.\(UUID().uuidString)",
                backend: InMemoryKeychainBackend()
            )
        )
        _ = try await payloads(host, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT),
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: "reset-current"),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE), value: 1),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT), value: 0),
            ]
        ))

        do {
            _ = try await payloads(host, effect(
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT),
                requestID: 2,
                fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: "reset-stale")]
            ))
            XCTFail("a stale command must not delete a newer reset result")
        } catch {}
        let retained = try await host.loadFactoryResetResult()
        XCTAssertEqual(retained?.commandID, "reset-current")

        _ = try await payloads(host, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT),
            requestID: 3,
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: "reset-current")]
        ))
        let deleted = try await host.loadFactoryResetResult()
        XCTAssertNil(deleted)
    }

    func testSecureValuesUseTheInjectedKeychainBackend() async throws {
        let backend = InMemoryKeychainBackend()
        let service = "dev.bota.tests.\(UUID().uuidString)"
        let first = KeychainSecureStorageHost(service: service, backend: backend)
        let value = Data("secret".utf8)
        _ = try await payloads(first, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_WRITE),
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: "device-key"),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: value),
            ]
        ))

        let recreated = KeychainSecureStorageHost(service: service, backend: backend)
        let loaded = try await payloads(recreated, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_SECURE_STORAGE_READ),
            requestID: 2,
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: "device-key")]
        ))

        XCTAssertEqual(loaded.first?.bytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE)), value)
    }

    func testRecordingSinkRequiresTruncateAndValidatesCRC32() async throws {
        let root = temporaryDirectory()
        let host = FileRecordingSinkHost(rootDirectory: root)
        let sinkID = UUID().uuidString
        let payload = Data("hello".utf8)

        do {
            _ = try await payloads(host, sinkEffect(.append, sinkID: sinkID, payload: payload))
            XCTFail("append must follow truncate")
        } catch {}

        _ = try await payloads(host, sinkEffect(.truncate, sinkID: sinkID))
        let append = try await payloads(host, sinkEffect(.append, sinkID: sinkID, requestID: 2, payload: payload))
        let finalized = try await payloads(host, sinkEffect(
            .finalize,
            sinkID: sinkID,
            requestID: 3,
            expectedCRC32: 0x3610_A686
        ))

        XCTAssertEqual(append.first?.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS)), 5)
        XCTAssertEqual(finalized.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FINALIZED))
        XCTAssertEqual(finalized.first?.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS)), 5)

        let mismatch = try await payloads(host, sinkEffect(
            .finalize,
            sinkID: sinkID,
            requestID: 4,
            expectedCRC32: 0
        ))
        XCTAssertEqual(mismatch.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_INTEGRITY_FAILED))
    }

    func testFirmwareBlobReadsOnlyRegisteredBoundedChunks() async throws {
        let root = temporaryDirectory()
        let file = root.appendingPathComponent("firmware.bin")
        try Data([0, 1, 2, 3, 4, 5]).write(to: file)
        let host = FileFirmwareBlobHost(maximumChunkLength: 4)
        await host.register(downloadID: 9, fileURL: file)

        let values = try await payloads(host, effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_FIRMWARE_BLOB_READ),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 9),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET), value: 2),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_LENGTH), value: 3),
            ]
        ))

        XCTAssertEqual(values.first?.bytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE)), Data([2, 3, 4]))
        XCTAssertEqual(values.first?.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET)), 2)

        do {
            _ = try await payloads(host, effect(
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_FIRMWARE_BLOB_READ),
                requestID: 2,
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 9),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET), value: 0),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_LENGTH), value: 5),
                ]
            ))
            XCTFail("a firmware read may not exceed the configured bound")
        } catch {}
    }

    func testApplicationMaterialIsResolvedByOpaqueID() async throws {
        let host = ApplicationMaterialHost()
        await host.registerProvisioning(id: "material-1") { request in
            XCTAssertEqual(request.serialNumber, "SERIAL-1")
            XCTAssertEqual(request.nonce, Data(repeating: 0x11, count: 16))
            return ProvisioningApplicationMaterial(
                apiEndpoint: Data("https://api.example.test".utf8),
                deviceToken: Data("device-token".utf8),
                mtu: 185
            )
        }

        let values = try await collect(await host.execute(effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_PREPARE_PROVISIONING),
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID), value: "material-1"),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: "SERIAL-1"),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NONCE), value: Data(repeating: 0x11, count: 16)),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_PUBLIC_KEY), value: Data(repeating: 0x22, count: 64)),
            ]
        )))

        XCTAssertEqual(values.first?.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MTU)), 185)
        XCTAssertEqual(
            values.first?.bytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_TOKEN)),
            Data("device-token".utf8)
        )
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func effect(_ kind: UInt32, requestID: UInt64 = 1, fields: [CoreField] = []) -> CoreEffect {
        try! CoreEffect(packet: CorePacket(
            kind: kind,
            operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING),
            requestID: requestID,
            cancellationHigh: 1,
            cancellationLow: 2,
            fields: fields
        ))
    }

    private enum SinkEffectKind { case truncate, append, finalize }

    private func sinkEffect(
        _ kind: SinkEffectKind,
        sinkID: String,
        requestID: UInt64 = 1,
        payload: Data = Data(),
        expectedCRC32: UInt64? = nil
    ) -> CoreEffect {
        var fields: [CoreField] = [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID), value: sinkID)]
        let effectKind: UInt32
        switch kind {
        case .truncate:
            effectKind = UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_TRUNCATE)
            fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: 0))
        case .append:
            effectKind = UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_APPEND)
            fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: requestID))
            fields.append(.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: payload))
        case .finalize:
            effectKind = UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_RECORDING_SINK_FINALIZE)
            if let expectedCRC32 {
                fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_EXPECTED_CRC32), value: expectedCRC32))
            }
        }
        return effect(effectKind, requestID: requestID, fields: fields)
    }

    private func payloads<H: PersistenceHost>(_ host: H, _ effect: CoreEffect) async throws -> [CoreHostEventPayload] {
        try await collect(await host.execute(effect))
    }

    private func payloads(_ host: FileRecordingSinkHost, _ effect: CoreEffect) async throws -> [CoreHostEventPayload] {
        try await collect(await host.execute(effect))
    }

    private func payloads(_ host: FileFirmwareBlobHost, _ effect: CoreEffect) async throws -> [CoreHostEventPayload] {
        try await collect(await host.execute(effect))
    }

    private func collect(_ stream: AsyncThrowingStream<CoreHostEventPayload, Error>) async throws -> [CoreHostEventPayload] {
        var values: [CoreHostEventPayload] = []
        for try await value in stream { values.append(value) }
        return values
    }
}

private final class InMemoryKeychainBackend: KeychainBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    func read(service: String, key: String) throws -> Data? {
        lock.withLock { values["\(service):\(key)"] }
    }

    func write(service: String, key: String, value: Data) throws {
        lock.withLock { values["\(service):\(key)"] = value }
    }

    func delete(service: String, key: String) throws {
        lock.withLock { values["\(service):\(key)"] = nil }
    }
}

private extension CoreHostEventPayload {
    func unsigned(_ id: UInt32) -> UInt64? {
        for field in fields {
            if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func bytes(_ id: UInt32) -> Data? {
        for field in fields {
            if case let .bytes(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
