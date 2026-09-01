import BotaDeviceSDKC
import XCTest

@testable import BotaAppleSDK

final class ProvisioningManagerTests: XCTestCase {
    func testDeviceControlReadsProvisioningIdentityAndWritesTypedPayloads() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let controls = DeviceControlManager()
        await controls.attach(await secureRuntime(runner: runner, recorder: recorder))
        let device = secureDevice()

        await recorder.setReadData(Data([2]))
        let provisioned = try await controls.isProvisioned(device)
        XCTAssertTrue(provisioned)

        await recorder.setReadData(Data(repeating: 0xab, count: 64))
        let publicKey = try await controls.readPublicKey(from: device)
        XCTAssertEqual(publicKey, String(repeating: "ab", count: 64))

        await recorder.setReadData(Data(repeating: 0xcd, count: 16))
        let nonce = try await controls.readAuthNonce(from: device)
        XCTAssertEqual(nonce, String(repeating: "cd", count: 16))

        try await controls.setAPIEndpoint(.gamma, on: device)
        try await controls.deliverBackendPublicKey(Data(repeating: 0xef, count: 32), to: device)
        try await controls.writeGrant(Data([1, 2, 3]).base64EncodedString(), to: device)
        try await controls.syncTime(
            Date(timeIntervalSince1970: 1_725_000_000.321),
            timezoneOffsetMinutes: -420,
            to: device
        )

        let reads = await recorder.reads
        XCTAssertEqual(reads.map(\.characteristicUUID), [
            BotaBluetoothUUIDs.pairingState,
            BotaBluetoothUUIDs.devicePublicKey,
            BotaBluetoothUUIDs.authNonce,
        ])
        let writes = await recorder.writes
        XCTAssertEqual(writes.map(\.characteristicUUID), [
            BotaBluetoothUUIDs.apiEndpoint,
            BotaBluetoothUUIDs.backendPublicKey,
            BotaBluetoothUUIDs.deviceCommand,
            BotaBluetoothUUIDs.timeSync,
        ])
        XCTAssertEqual(writes[0].data, Data([2]))
        XCTAssertEqual(writes[1].data, Data(repeating: 0xef, count: 32))
        XCTAssertEqual(writes[2].data, Data([1, 2, 3]))
        XCTAssertEqual(writes[3].data, Data([0x40, 0x69, 0xd1, 0x66, 0x41, 0x01, 0x5c, 0xfe]))
    }

    func testDeviceCertificateUsesFrozenProvisioningChunkFraming() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let controls = DeviceControlManager()
        await controls.attach(await secureRuntime(runner: runner, recorder: recorder))
        let device = secureDevice(mtu: 20)

        let payload = Data("certificate\nprivate-key\n".utf8)
        try await controls.deliverCertificate(
            " certificate ",
            privateKeyPEM: " private-key ",
            to: device
        )

        let writes = await recorder.writes
        XCTAssertEqual(writes.map(\.characteristicUUID), [
            BotaBluetoothUUIDs.deviceCertificate,
            BotaBluetoothUUIDs.deviceCertificate,
        ])
        XCTAssertEqual(writes.map(\.data), [
            Data([0, 2]) + payload.prefix(13),
            Data([1, 2]) + payload.dropFirst(13),
        ])
    }

    func testProvisionRegistersOpaqueMaterialAndForwardsOnlyItsIDToCore() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))
        let device = secureDevice()

        try await manager.provision(device, materialID: "bind-attempt-7") { request in
            XCTAssertEqual(request.serialNumber, device.serialNumber)
            return ProvisioningMaterial(apiEndpoint: Data([1]), deviceToken: Data([2]), mtu: 185)
        }

        let commands = await runner.commands
        let command = try XCTUnwrap(commands.first)
        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_PROVISION))
        XCTAssertEqual(
            command.fields.secureText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID)),
            "bind-attempt-7"
        )
        let registered = await recorder.provisioningIDs
        let unregistered = await recorder.unregisteredIDs
        XCTAssertEqual(registered, ["bind-attempt-7"])
        XCTAssertEqual(unregistered, ["bind-attempt-7"])
    }

    func testNoteConnectionSettingsRemoveEveryCellularSelectionBeforeWrite() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))
        let settings = DeviceConnectionSettings(
            enabledConnections: .init(wifi: true, cellular: true),
            heartbeatEnabledConnections: .init(wifi: true, cellular: true),
            uploadNetworkPreference: [.cellular, .wifi, .ble]
        )

        try await manager.writeConnectionSettings(settings, to: secureDevice(model: .botaNote))

        let writes = await recorder.writes
        let write = try XCTUnwrap(writes.first)
        let parsed = try CoreModelMapper().parseConnectionSettings(write.data)
        XCTAssertFalse(parsed.settings.enabledConnections.cellular)
        XCTAssertFalse(parsed.settings.heartbeatEnabledConnections.cellular)
        XCTAssertEqual(parsed.settings.uploadNetworkPreference, [.wifi, .ble])
        XCTAssertEqual(write.characteristicUUID, BotaBluetoothUUIDs.deviceSettings)
    }

    func testReadConnectionSettingsUsesTheSharedDecoder() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        await recorder.setReadData(Data([
            0x02, 0x03, 0x01, 0x02, 0x03, 0xff,
            0x00, 0x00, 0x3c, 0x81, 0x00, 0x00,
        ]))
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        let settings = try await manager.readConnectionSettings(from: secureDevice(model: .botaPin4G))

        XCTAssertEqual(settings.enabledConnections, .init(wifi: true, cellular: true))
        XCTAssertEqual(settings.heartbeatEnabledConnections, .init(wifi: true, cellular: false))
        XCTAssertEqual(settings.uploadNetworkPreference, [.wifi, .ble, .cellular])
        XCTAssertEqual(settings.powerManagement, .init(wifiIdleTimeoutSeconds: 0, cellularIdleTimeoutSeconds: -1))
        XCTAssertFalse(settings.streamingEnabled)
        let reads = await recorder.reads
        XCTAssertEqual(reads.first?.characteristicUUID, BotaBluetoothUUIDs.deviceSettings)
    }

    func testDeprovisionWritesGrantThenSubscribesBeforeRemoveOpcode() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))
        await recorder.setNotifications(
            [Data([0])],
            for: BotaBluetoothUUIDs.provisioningResult
        )

        let result = try await manager.deprovision(
            secureDevice(),
            grantBlob: Data([1, 2, 3]).base64EncodedString()
        )

        let writes = await recorder.writes
        XCTAssertEqual(result, .init(success: true))
        XCTAssertEqual(writes.map(\.data), [Data([1, 2, 3]), Data([5])])
        XCTAssertEqual(
            writes.map(\.characteristicUUID),
            [BotaBluetoothUUIDs.deviceCommand, BotaBluetoothUUIDs.deviceCommand]
        )
        XCTAssertFalse(writes.contains { $0.data == Data([6]) })
        let subscribed = await recorder.subscribedCharacteristics
        let unsubscribed = await recorder.unsubscribedCharacteristics
        XCTAssertEqual(subscribed, [BotaBluetoothUUIDs.provisioningResult])
        XCTAssertEqual(unsubscribed, [BotaBluetoothUUIDs.provisioningResult])
        let commands = await runner.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testDeprovisionReturnsFirmwareRejectionWithoutThrowing() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))
        await recorder.setNotifications(
            [Data([1])],
            for: BotaBluetoothUUIDs.provisioningResult
        )

        let result = try await manager.deprovision(
            secureDevice(),
            grantBlob: Data([4, 5, 6]).base64EncodedString()
        )

        XCTAssertEqual(result, .init(success: false, error: .invalidToken))
    }
}
