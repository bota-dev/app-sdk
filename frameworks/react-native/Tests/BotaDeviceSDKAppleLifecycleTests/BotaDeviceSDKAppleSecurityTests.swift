import BotaAppleSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleSecurityTests: XCTestCase {
    func testProvisioningMaterialRoundTripAndDeprovisionDelegateToAppleFacade() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: false,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleSecurityClient()
        let security = BotaDeviceSDKAppleSecurity(client: client)
        let requests = ProvisioningRequestCapture()

        let operation = Task {
            try await security.provision(connected) { request in
                Task { await requests.append(request) }
            }
        }
        let request = await requests.next()
        XCTAssertEqual(request.serialNumber, connected.serialNumber)
        XCTAssertEqual(request.nonce, "00112233")
        XCTAssertEqual(request.devicePublicKey, "aabbccdd")

        try await security.resolveProvisioningMaterial(
            requestID: request.requestID,
            apiEndpoint: "https://api.bota.dev",
            deviceToken: "dtok_example",
            mtu: 247
        )
        try await operation.value
        try await security.deprovision(connected)

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.material?.apiEndpoint, Data("https://api.bota.dev".utf8))
        XCTAssertEqual(snapshot.material?.deviceToken, Data("dtok_example".utf8))
        XCTAssertEqual(snapshot.material?.mtu, 247)
        XCTAssertEqual(snapshot.deprovisionedSerials, [connected.serialNumber])
    }

    func testFactoryResetGrantRoundTripAndExactGenerationResumeDelegateToAppleFacade() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleSecurityClient()
        let security = BotaDeviceSDKAppleSecurity(client: client)
        let requests = FactoryResetRequestCapture()

        let operation = Task {
            try await security.factoryReset(
                connected,
                commandID: "reset-command-1",
                bindingGeneration: 9
            ) { request in
                Task { await requests.append(request) }
            }
        }
        let request = await requests.next()
        XCTAssertEqual(request.serialNumber, connected.serialNumber)
        XCTAssertEqual(request.nonce, "44556677")
        XCTAssertEqual(request.commandID, "reset-command-1")
        XCTAssertEqual(request.bindingGeneration, 9)

        try await security.resolveFactoryResetGrant(
            requestID: request.requestID,
            grantBlob: "Z3JhbnQ="
        )
        let completion = try await operation.value
        XCTAssertEqual(
            completion,
            .init(commandID: "reset-command-1", bindingGeneration: 9)
        )
        let resumed = try await security.resumePendingFactoryReset(
            connected,
            currentBindingGeneration: 9
        )
        XCTAssertEqual(
            resumed,
            .init(commandID: "reset-command-1", bindingGeneration: 9)
        )

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.factoryResetGrant, Data("grant".utf8))
        XCTAssertEqual(snapshot.resumedBindingGenerations, [9])
    }

    func testConnectionSettingsDelegateToAppleFacade() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaNote,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleSecurityClient()
        let security = BotaDeviceSDKAppleSecurity(client: client)
        let settings = DeviceConnectionSettings(
            enabledConnections: .init(wifi: true, cellular: true),
            heartbeatEnabledConnections: .init(wifi: true, cellular: true),
            uploadNetworkPreference: [.wifi, .ble, .cellular],
            powerManagement: .init(
                wifiIdleTimeoutSeconds: 0,
                cellularIdleTimeoutSeconds: -1
            ),
            streamingEnabled: false,
            streamingFlushIntervalSeconds: 30
        )

        try await security.writeConnectionSettings(settings, to: connected)

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.connectionSettings, settings)
    }

    func testConnectionSettingsReadDelegatesToAppleFacade() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaNote,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let expected = DeviceConnectionSettings(
            enabledConnections: .init(wifi: true, cellular: false),
            heartbeatEnabledConnections: .init(wifi: true, cellular: false),
            uploadNetworkPreference: [.wifi, .ble]
        )
        let client = TestAppleSecurityClient(connectionSettingsReadResult: expected)
        let security = BotaDeviceSDKAppleSecurity(client: client)

        let settings = try await security.readConnectionSettings(from: connected)

        XCTAssertEqual(settings, expected)
    }

    func testFactoryResetRejectsMalformedGrantAndCancelsPendingRequestsOnDestroy() async {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let malformedClient = TestAppleSecurityClient()
        let malformedSecurity = BotaDeviceSDKAppleSecurity(client: malformedClient)
        let malformedRequests = FactoryResetRequestCapture()
        let malformedOperation = Task {
            try await malformedSecurity.factoryReset(
                connected,
                commandID: "reset-command-1",
                bindingGeneration: 9
            ) { request in
                Task { await malformedRequests.append(request) }
            }
        }
        let malformedRequest = await malformedRequests.next()

        try? await malformedSecurity.resolveFactoryResetGrant(
            requestID: malformedRequest.requestID,
            grantBlob: "not-encoded"
        )
        do {
            _ = try await malformedOperation.value
            XCTFail("malformed factory reset grant should fail")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                "factory reset grant is not valid encoded data"
            )
        }

        let cancelledClient = TestAppleSecurityClient()
        let cancelledSecurity = BotaDeviceSDKAppleSecurity(client: cancelledClient)
        let cancelledRequests = FactoryResetRequestCapture()
        let cancelledOperation = Task {
            try await cancelledSecurity.factoryReset(
                connected,
                commandID: "reset-command-2",
                bindingGeneration: 10
            ) { request in
                Task { await cancelledRequests.append(request) }
            }
        }
        _ = await cancelledRequests.next()
        await cancelledSecurity.cancelAll()
        do {
            _ = try await cancelledOperation.value
            XCTFail("cancelled factory reset grant should fail")
        } catch {}

        let cancelledSnapshot = await cancelledClient.snapshot()
        XCTAssertTrue(cancelledSnapshot.factoryResetCancelled)
    }
}

private actor ProvisioningRequestCapture {
    private var requests: [BotaDeviceSDKAppleProvisioningRequest] = []
    private var waiter: CheckedContinuation<BotaDeviceSDKAppleProvisioningRequest, Never>?

    func append(_ request: BotaDeviceSDKAppleProvisioningRequest) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: request)
        } else {
            requests.append(request)
        }
    }

    func next() async -> BotaDeviceSDKAppleProvisioningRequest {
        if !requests.isEmpty { return requests.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private actor FactoryResetRequestCapture {
    private var requests: [BotaDeviceSDKAppleFactoryResetRequest] = []
    private var waiter: CheckedContinuation<BotaDeviceSDKAppleFactoryResetRequest, Never>?

    func append(_ request: BotaDeviceSDKAppleFactoryResetRequest) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: request)
        } else {
            requests.append(request)
        }
    }

    func next() async -> BotaDeviceSDKAppleFactoryResetRequest {
        if !requests.isEmpty { return requests.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private actor TestAppleSecurityClient: BotaDeviceSDKAppleSecurityClient {
    struct Snapshot: Sendable {
        let material: ProvisioningMaterial?
        let deprovisionedSerials: [String]
        let factoryResetGrant: Data?
        let factoryResetCancelled: Bool
        let resumedBindingGenerations: [UInt64]
        let connectionSettings: DeviceConnectionSettings?
    }

    private var material: ProvisioningMaterial?
    private var deprovisionedSerials: [String] = []
    private var factoryResetGrant: Data?
    private var factoryResetCancelled = false
    private var resumedBindingGenerations: [UInt64] = []
    private var connectionSettings: DeviceConnectionSettings?
    private let connectionSettingsReadResult: DeviceConnectionSettings

    init(connectionSettingsReadResult: DeviceConnectionSettings = .init(
        enabledConnections: .init(wifi: true, cellular: false),
        uploadNetworkPreference: [.wifi, .ble]
    )) {
        self.connectionSettingsReadResult = connectionSettingsReadResult
    }

    func provision(
        _ device: ConnectedDevice,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws {
        material = try await provider(.init(
            serialNumber: device.serialNumber,
            nonce: Data([0x00, 0x11, 0x22, 0x33]),
            devicePublicKey: Data([0xAA, 0xBB, 0xCC, 0xDD])
        ))
    }

    func deprovision(_ device: ConnectedDevice) async throws {
        deprovisionedSerials.append(device.serialNumber)
    }

    func writeConnectionSettings(
        _ settings: DeviceConnectionSettings,
        to device: ConnectedDevice
    ) async throws {
        connectionSettings = settings
    }

    func readConnectionSettings(from device: ConnectedDevice) async throws -> DeviceConnectionSettings {
        connectionSettingsReadResult
    }

    func cancelCurrentOperation() async throws {}

    func factoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        bindingGeneration: UInt64,
        using provider: @escaping FactoryResetGrantProvider
    ) async throws -> FactoryResetCompletion {
        factoryResetGrant = try await provider(.init(
            serialNumber: device.serialNumber,
            nonce: Data([0x44, 0x55, 0x66, 0x77]),
            commandID: commandID,
            bindingGeneration: bindingGeneration
        ))
        return .init(commandID: commandID, bindingGeneration: bindingGeneration)
    }

    func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64
    ) async throws -> FactoryResetCompletion? {
        resumedBindingGenerations.append(currentBindingGeneration)
        return .init(
            commandID: "reset-command-1",
            bindingGeneration: currentBindingGeneration
        )
    }

    func cancelFactoryReset() async throws {
        factoryResetCancelled = true
    }

    func snapshot() -> Snapshot {
        Snapshot(
            material: material,
            deprovisionedSerials: deprovisionedSerials,
            factoryResetGrant: factoryResetGrant,
            factoryResetCancelled: factoryResetCancelled,
            resumedBindingGenerations: resumedBindingGenerations,
            connectionSettings: connectionSettings
        )
    }
}
