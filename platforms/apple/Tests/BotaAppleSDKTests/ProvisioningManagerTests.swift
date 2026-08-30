import BotaDeviceSDKC
import XCTest

@testable import BotaAppleSDK

final class ProvisioningManagerTests: XCTestCase {
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

    func testDeprovisionWritesOnlyTheRemoveOpcode() async throws {
        let runner = SecureWorkflowRunner()
        let recorder = SecureLifecycleRecorder()
        let manager = ProvisioningManager()
        await manager.attach(await secureRuntime(runner: runner, recorder: recorder))

        try await manager.deprovision(secureDevice())

        let writes = await recorder.writes
        XCTAssertEqual(writes.map(\.data), [Data([5])])
        XCTAssertEqual(writes.first?.characteristicUUID, BotaBluetoothUUIDs.deviceCommand)
        XCTAssertFalse(writes.contains { $0.data == Data([6]) })
        let commands = await runner.commands
        XCTAssertTrue(commands.isEmpty)
    }
}
