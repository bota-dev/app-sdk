import BotaDeviceSDK
import Foundation
import XCTest

final class PhysicalDeviceTests: XCTestCase {
    func testBluetoothPermissionScanVisibilityAndSerialVerifiedConnection() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            XCTAssertEqual(device.serialNumber, configuration.serialNumber)
            XCTAssertEqual(device.deviceType, configuration.model.deviceType)
        }
    }

    func testReconnectAfterAppRestartAndStatus() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        let first = try await connectedDevice(configuration)
        let client = BotaDeviceClient()
        try await client.configure(BotaConfiguration(
            applicationSupportDirectory: configuration.applicationSupportDirectory
        ))
        do {
            let reconnected = try await client.devices.reconnect(
                serialNumber: configuration.serialNumber,
                hint: .init(
                    storedPeripheralID: first.id,
                    scanTimeoutMilliseconds: configuration.scanTimeoutMilliseconds
                )
            )
            XCTAssertEqual(reconnected.serialNumber, configuration.serialNumber)
            let status = try await client.devices.readStatus()
            XCTAssertTrue((0...100).contains(status.batteryLevel))
        } catch {
            await client.destroy()
            throw error
        }
        await client.destroy()
    }

    func testConnectionSettingsWrite() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_SETTINGS_WRITE")
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            let cellular = configuration.model != .botaNote
            try await client.provisioning.writeConnectionSettings(
                .init(
                    enabledConnections: .init(wifi: true, cellular: cellular),
                    uploadNetworkPreference: cellular ? [.wifi, .ble, .cellular] : [.wifi, .ble],
                    streamingEnabled: false
                ),
                to: device
            )
        }
    }

    func testProvisioning() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_PROVISIONING")
        let material = try configuration.provisioningMaterial()
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            try await client.provisioning.provision(
                device,
                materialID: "physical-\(configuration.serialNumber)"
            ) { request in
                XCTAssertEqual(request.serialNumber, configuration.serialNumber)
                return material
            }
        }
    }

    func testRecordingTransferAndUploadOwnership() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_RECORDING_DELETE")
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            let recordings = try await client.recordings.listRecordings(device)
            let requestedUUID = configuration.environment["BOTA_RECORDING_UUID"]
            guard let recording = requestedUUID.flatMap({ uuid in recordings.first { $0.uuid == uuid } })
                ?? recordings.first
            else {
                XCTFail("Physical recording transfer requires a recording fixture on the device")
                return
            }
            let transfer = try await client.recordings.syncRecording(device, recording: recording)
            let transferEvents = try await self.collect(
                transfer,
                timeoutSeconds: configuration.operationTimeoutSeconds
            )
            XCTAssertTrue(transferEvents.contains { event in
                if case .completed = event { return true }
                return false
            })

            let ownership = try await client.recordings.observeUploadOwnership(
                device,
                recordingUUID: recording.uuid,
                uploadID: try configuration.value("BOTA_UPLOAD_ID"),
                destinationID: try configuration.value("BOTA_UPLOAD_DESTINATION_ID")
            )
            let ownershipEvents = try await self.collect(
                ownership,
                timeoutSeconds: configuration.operationTimeoutSeconds
            )
            XCTAssertTrue(ownershipEvents.contains { event in
                if case .result = event { return true }
                return false
            })
        }
    }

    func testFirmwareUpdateRebootReconnectAndReadback() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_OTA")
        let image = try configuration.firmwareImage()
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            let updates = try await client.ota.updateFirmware(device, image: image)
            let progress = try await self.collect(
                updates,
                timeoutSeconds: configuration.operationTimeoutSeconds
            )
            XCTAssertTrue(progress.contains { $0.phase == .complete })
            let status = try await client.devices.readStatus()
            XCTAssertTrue((0...100).contains(status.batteryLevel))
        }
    }

    func testDeviceLogsAndDisconnectCleanup() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            let logs = try await client.logs.streamLogs(device)
            let line = try await self.first(logs, timeoutSeconds: configuration.operationTimeoutSeconds)
            XCTAssertFalse(line.message.isEmpty)
            try await client.devices.disconnect()
        }
    }

    func testRemoveOnlyDeprovision() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_DEPROVISION")
        guard configuration.environment["BOTA_ALLOW_FACTORY_RESET"] != "1" else {
            throw ConfigurationError.invalid("run deprovision and factory reset separately")
        }
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            try await client.provisioning.deprovision(device)
        }
    }

    func testAuthenticatedFactoryResetReceipt() async throws {
        let configuration = try PhysicalTestConfiguration.load()
        try configuration.requireGate("BOTA_ALLOW_FACTORY_RESET")
        guard configuration.environment["BOTA_ALLOW_DEPROVISION"] != "1" else {
            throw ConfigurationError.invalid("run deprovision and factory reset separately")
        }
        let commandID = try configuration.value("BOTA_FACTORY_RESET_COMMAND_ID")
        let bindingGeneration = try configuration.uint64("BOTA_BINDING_GENERATION")
        let expectedNonce = try configuration.expectedResetNonce()
        let grant = try configuration.data("BOTA_FACTORY_RESET_GRANT_BASE64")
        try await withClient(configuration) { client in
            let device = try await self.connectSelected(client, configuration)
            let completion = try await client.factoryReset.factoryReset(
                device,
                commandID: commandID,
                grantID: "physical-reset-\(commandID)",
                bindingGeneration: bindingGeneration
            ) { request in
                XCTAssertEqual(request.serialNumber, configuration.serialNumber)
                XCTAssertEqual(request.commandID, commandID)
                XCTAssertEqual(request.bindingGeneration, bindingGeneration)
                XCTAssertEqual(request.nonce, expectedNonce)
                return grant
            }
            XCTAssertEqual(completion.commandID, commandID)
            XCTAssertEqual(completion.bindingGeneration, bindingGeneration)
        }
    }

    private func connectedDevice(_ configuration: PhysicalTestConfiguration) async throws -> ConnectedDevice {
        let client = BotaDeviceClient()
        try await client.configure(BotaConfiguration(
            applicationSupportDirectory: configuration.applicationSupportDirectory
        ))
        do {
            let device = try await connectSelected(client, configuration)
            await client.destroy()
            return device
        } catch {
            await client.destroy()
            throw error
        }
    }

    private func withClient(
        _ configuration: PhysicalTestConfiguration,
        operation: (BotaDeviceClient) async throws -> Void
    ) async throws {
        let client = BotaDeviceClient()
        try await client.configure(BotaConfiguration(
            applicationSupportDirectory: configuration.applicationSupportDirectory
        ))
        do {
            try await operation(client)
            await client.destroy()
        } catch {
            await client.destroy()
            throw error
        }
    }

    private func connectSelected(
        _ client: BotaDeviceClient,
        _ configuration: PhysicalTestConfiguration
    ) async throws -> ConnectedDevice {
        let scan = try await client.devices.startScan(
            timeoutMilliseconds: configuration.scanTimeoutMilliseconds,
            allowDuplicates: false
        )
        var candidates: [DiscoveredDevice] = []
        for try await candidate in scan { candidates.append(candidate) }
        for candidate in candidates {
            do {
                return try await client.devices.connect(
                    serialNumber: configuration.serialNumber,
                    device: candidate
                )
            } catch let error as BotaDeviceSDKError where error.code == .identityMismatch {
                continue
            }
        }
        throw BotaDeviceSDKError(
            code: .deviceNotFound,
            operation: .connect,
            retryable: true,
            detail: "serial-verified physical test device was not visible during the scan window"
        )
    }

    private func collect<Element: Sendable>(
        _ stream: AsyncThrowingStream<Element, Error>,
        timeoutSeconds: UInt64
    ) async throws -> [Element] {
        try await withThrowingTaskGroup(of: [Element].self) { group in
            group.addTask {
                var values: [Element] = []
                for try await value in stream { values.append(value) }
                return values
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeoutSeconds))
                throw PhysicalHarnessError.timeout
            }
            let result = try await group.next() ?? []
            group.cancelAll()
            return result
        }
    }

    private func first<Element: Sendable>(
        _ stream: AsyncThrowingStream<Element, Error>,
        timeoutSeconds: UInt64
    ) async throws -> Element {
        let values = try await withThrowingTaskGroup(of: [Element].self) { group in
            group.addTask {
                for try await value in stream { return [value] }
                return []
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeoutSeconds))
                throw PhysicalHarnessError.timeout
            }
            let result = try await group.next() ?? []
            group.cancelAll()
            return result
        }
        guard let value = values.first else { throw PhysicalHarnessError.noValue }
        return value
    }
}

private enum PhysicalHarnessError: Error {
    case timeout
    case noValue
}
