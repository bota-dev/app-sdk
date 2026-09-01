import BotaAppleSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleSecurityTests: XCTestCase {
    func testDeviceControlsDelegateTypedValuesToAppleFacade() async throws {
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

        let provisioned = try await security.isProvisioned(connected)
        let publicKey = try await security.readPublicKey(from: connected)
        let nonce = try await security.readAuthNonce(from: connected)
        XCTAssertTrue(provisioned)
        XCTAssertEqual(publicKey, "public-key")
        XCTAssertEqual(nonce, "nonce")
        try await security.setAPIEndpoint(.gamma, on: connected)
        try await security.deliverCertificate("cert", privateKeyPEM: "key", to: connected)
        try await security.deliverBackendPublicKey(Data([1, 2, 3]), to: connected)
        try await security.writeGrant("AQID", to: connected)
        try await security.syncTime(connected)

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.environment, .gamma)
        XCTAssertEqual(snapshot.certificate, "cert")
        XCTAssertEqual(snapshot.privateKey, "key")
        XCTAssertEqual(snapshot.backendPublicKey, Data([1, 2, 3]))
        XCTAssertEqual(snapshot.grantBlob, "AQID")
        XCTAssertTrue(snapshot.timeSynced)
    }

    func testRecordingControlsAndStateStreamDelegateToAppleFacade() async throws {
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
        let updates = RecordingStateCapture()

        let startResult = try await security.requestStartRecording(
            connected,
            grantBlob: "c3RhcnQ="
        )
        let stopResult = try await security.requestStopRecording(
            connected,
            grantBlob: "c3RvcA=="
        )
        let recordingState = try await security.readRecordingState(from: connected)
        XCTAssertEqual(startResult, RecordingControlResult(success: true))
        XCTAssertEqual(
            stopResult,
            RecordingControlResult(success: false, error: .notRecording)
        )
        XCTAssertEqual(
            recordingState,
            RecordingState(active: true, recordingID: "recording-1", initiatedBy: .remote)
        )

        try await security.startRecordingStateUpdates(connected) { state in
            Task { await updates.append(state) }
        }
        await client.emitRecordingState(.init(active: false, initiatedBy: .local))
        let update = await updates.next()
        XCTAssertEqual(update, RecordingState(active: false, initiatedBy: .local))
        await security.stopRecordingStateUpdates()
        await security.stopRecordingStateUpdates()
        await client.waitForRecordingStateTermination()

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.startRecordingGrant, "c3RhcnQ=")
        XCTAssertEqual(snapshot.stopRecordingGrant, "c3RvcA==")
        XCTAssertEqual(snapshot.recordingStateTerminationCount, 1)
    }

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
        let deprovision = try await security.deprovision(connected, grantBlob: "AQID")

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.material?.apiEndpoint, Data("https://api.bota.dev".utf8))
        XCTAssertEqual(snapshot.material?.deviceToken, Data("dtok_example".utf8))
        XCTAssertEqual(snapshot.material?.mtu, 247)
        XCTAssertEqual(snapshot.deprovisionedSerials, [connected.serialNumber])
        XCTAssertEqual(snapshot.deprovisionGrant, "AQID")
        XCTAssertEqual(deprovision, DeprovisionResult(success: true))
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
                bindingGeneration: 9,
                onGrantRequest: { request in
                    Task { await requests.append(request) }
                },
                onPersistenceRequest: nil
            )
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
            currentBindingGeneration: 9,
            onPersistenceRequest: nil
        )
        XCTAssertEqual(
            resumed,
            .init(commandID: "reset-command-1", bindingGeneration: 9)
        )

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.factoryResetGrant, Data("grant".utf8))
        XCTAssertEqual(snapshot.resumedBindingGenerations, [9])
    }

    func testFactoryResetWaitsForApplicationPersistenceResolution() async throws {
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
        let grantRequests = FactoryResetRequestCapture()
        let persistenceRequests = FactoryResetPersistenceRequestCapture()

        let operation = Task {
            try await security.factoryReset(
                connected,
                commandID: "reset-command-1",
                bindingGeneration: 9,
                onGrantRequest: { request in
                    Task { await grantRequests.append(request) }
                },
                onPersistenceRequest: { request in
                    Task { await persistenceRequests.append(request) }
                }
            )
        }
        let grantRequest = await grantRequests.next()
        try await security.resolveFactoryResetGrant(
            requestID: grantRequest.requestID,
            grantBlob: "Z3JhbnQ="
        )
        let persistenceRequest = await persistenceRequests.next()
        XCTAssertEqual(persistenceRequest.localRecordingsDeleted, 7)
        let pendingSnapshot = await client.snapshot()
        XCTAssertEqual(pendingSnapshot.factoryResetPersistenceCompletions, 0)

        try await security.resolveFactoryResetResultPersistence(
            requestID: persistenceRequest.requestID
        )
        _ = try await operation.value

        let completedSnapshot = await client.snapshot()
        XCTAssertEqual(completedSnapshot.factoryResetPersistenceCompletions, 1)
    }

    func testFactoryResetResumeFallsBackToFirmwareReplayAfterReinstall() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleSecurityClient(hasPendingFactoryReset: false)
        let security = BotaDeviceSDKAppleSecurity(client: client)
        let persistenceRequests = FactoryResetPersistenceRequestCapture()

        let operation = Task {
            try await security.resumePendingFactoryReset(
                connected,
                currentBindingGeneration: 0,
                onPersistenceRequest: { request in
                    Task { await persistenceRequests.append(request) }
                }
            )
        }
        let request = await persistenceRequests.next()
        XCTAssertEqual(request.localRecordingsDeleted, 7)
        try await security.resolveFactoryResetResultPersistence(requestID: request.requestID)

        let completion = try await operation.value
        XCTAssertEqual(completion?.bindingGeneration, 0)
        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.unjournaledResumeBindingGenerations, [0])
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
                bindingGeneration: 9,
                onGrantRequest: { request in
                Task { await malformedRequests.append(request) }
                },
                onPersistenceRequest: nil
            )
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
                bindingGeneration: 10,
                onGrantRequest: { request in
                Task { await cancelledRequests.append(request) }
                },
                onPersistenceRequest: nil
            )
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

private actor FactoryResetPersistenceRequestCapture {
    private var requests: [BotaDeviceSDKAppleFactoryResetPersistenceRequest] = []
    private var waiter: CheckedContinuation<
        BotaDeviceSDKAppleFactoryResetPersistenceRequest,
        Never
    >?

    func append(_ request: BotaDeviceSDKAppleFactoryResetPersistenceRequest) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: request)
        } else {
            requests.append(request)
        }
    }

    func next() async -> BotaDeviceSDKAppleFactoryResetPersistenceRequest {
        if !requests.isEmpty { return requests.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private actor RecordingStateCapture {
    private var values: [RecordingState] = []
    private var waiter: CheckedContinuation<RecordingState, Never>?

    func append(_ value: RecordingState) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: value)
        } else {
            values.append(value)
        }
    }

    func next() async -> RecordingState {
        if !values.isEmpty { return values.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private actor TestAppleSecurityClient: BotaDeviceSDKAppleSecurityClient {
    struct Snapshot: Sendable {
        let material: ProvisioningMaterial?
        let deprovisionedSerials: [String]
        let deprovisionGrant: String?
        let factoryResetGrant: Data?
        let factoryResetCancelled: Bool
        let factoryResetPersistenceCompletions: Int
        let resumedBindingGenerations: [UInt64]
        let unjournaledResumeBindingGenerations: [UInt64]
        let connectionSettings: DeviceConnectionSettings?
        let environment: DeviceAPIEnvironment?
        let certificate: String?
        let privateKey: String?
        let backendPublicKey: Data?
        let grantBlob: String?
        let timeSynced: Bool
        let startRecordingGrant: String?
        let stopRecordingGrant: String?
        let recordingStateTerminationCount: Int
    }

    private var material: ProvisioningMaterial?
    private var deprovisionedSerials: [String] = []
    private var deprovisionGrant: String?
    private var factoryResetGrant: Data?
    private var factoryResetCancelled = false
    private var factoryResetPersistenceCompletions = 0
    private var resumedBindingGenerations: [UInt64] = []
    private var unjournaledResumeBindingGenerations: [UInt64] = []
    private var connectionSettings: DeviceConnectionSettings?
    private var environment: DeviceAPIEnvironment?
    private var certificate: String?
    private var privateKey: String?
    private var backendPublicKey: Data?
    private var grantBlob: String?
    private var timeSynced = false
    private var startRecordingGrant: String?
    private var stopRecordingGrant: String?
    private var recordingStateContinuation: AsyncThrowingStream<RecordingState, Error>.Continuation?
    private var recordingStateTerminationCount = 0
    private var recordingStateTerminationWaiter: CheckedContinuation<Void, Never>?
    private let connectionSettingsReadResult: DeviceConnectionSettings
    private let hasPendingFactoryReset: Bool

    init(connectionSettingsReadResult: DeviceConnectionSettings = .init(
        enabledConnections: .init(wifi: true, cellular: false),
        uploadNetworkPreference: [.wifi, .ble]
    ), hasPendingFactoryReset: Bool = true) {
        self.connectionSettingsReadResult = connectionSettingsReadResult
        self.hasPendingFactoryReset = hasPendingFactoryReset
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

    func deprovision(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> DeprovisionResult {
        deprovisionedSerials.append(device.serialNumber)
        deprovisionGrant = grantBlob
        return DeprovisionResult(success: true)
    }

    func isProvisioned(_ device: ConnectedDevice) async throws -> Bool { true }
    func readPublicKey(from device: ConnectedDevice) async throws -> String? { "public-key" }
    func readAuthNonce(from device: ConnectedDevice) async throws -> String? { "nonce" }
    func setAPIEndpoint(_ environment: DeviceAPIEnvironment, on device: ConnectedDevice) async throws {
        self.environment = environment
    }
    func deliverCertificate(
        _ certificatePEM: String,
        privateKeyPEM: String,
        to device: ConnectedDevice
    ) async throws {
        certificate = certificatePEM
        privateKey = privateKeyPEM
    }
    func deliverBackendPublicKey(_ publicKey: Data, to device: ConnectedDevice) async throws {
        backendPublicKey = publicKey
    }
    func writeGrant(_ grantBlob: String, to device: ConnectedDevice) async throws {
        self.grantBlob = grantBlob
    }
    func syncTime(_ device: ConnectedDevice) async throws { timeSynced = true }
    func requestStartRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        startRecordingGrant = grantBlob
        return .init(success: true)
    }
    func requestStopRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        stopRecordingGrant = grantBlob
        return .init(success: false, error: .notRecording)
    }
    func readRecordingState(from device: ConnectedDevice) async throws -> RecordingState {
        .init(active: true, recordingID: "recording-1", initiatedBy: .remote)
    }
    func recordingStateUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<RecordingState, Error> {
        let pair = AsyncThrowingStream<RecordingState, Error>.makeStream()
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.recordingStateTerminated() }
        }
        recordingStateContinuation = pair.continuation
        return pair.stream
    }

    func emitRecordingState(_ state: RecordingState) {
        recordingStateContinuation?.yield(state)
    }

    func waitForRecordingStateTermination() async {
        if recordingStateTerminationCount > 0 { return }
        await withCheckedContinuation { recordingStateTerminationWaiter = $0 }
    }

    private func recordingStateTerminated() {
        recordingStateTerminationCount += 1
        recordingStateContinuation = nil
        recordingStateTerminationWaiter?.resume()
        recordingStateTerminationWaiter = nil
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
        persistResult: FactoryResetResultPersister?,
        using provider: @escaping FactoryResetGrantProvider
    ) async throws -> FactoryResetCompletion {
        factoryResetGrant = try await provider(.init(
            serialNumber: device.serialNumber,
            nonce: Data([0x44, 0x55, 0x66, 0x77]),
            commandID: commandID,
            bindingGeneration: bindingGeneration
        ))
        if let persistResult {
            try await persistResult(.init(localRecordingsDeleted: 7))
            factoryResetPersistenceCompletions += 1
        }
        return .init(commandID: commandID, bindingGeneration: bindingGeneration)
    }

    func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64,
        persistResult: FactoryResetResultPersister?
    ) async throws -> FactoryResetCompletion? {
        resumedBindingGenerations.append(currentBindingGeneration)
        guard hasPendingFactoryReset else { return nil }
        return .init(
            commandID: "reset-command-1",
            bindingGeneration: currentBindingGeneration
        )
    }

    func resumeUnjournaledFactoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        bindingGeneration: UInt64,
        persistResult: @escaping FactoryResetResultPersister
    ) async throws -> FactoryResetCompletion {
        unjournaledResumeBindingGenerations.append(bindingGeneration)
        try await persistResult(.init(localRecordingsDeleted: 7))
        return .init(commandID: commandID, bindingGeneration: bindingGeneration)
    }

    func cancelFactoryReset() async throws {
        factoryResetCancelled = true
    }

    func snapshot() -> Snapshot {
        Snapshot(
            material: material,
            deprovisionedSerials: deprovisionedSerials,
            deprovisionGrant: deprovisionGrant,
            factoryResetGrant: factoryResetGrant,
            factoryResetCancelled: factoryResetCancelled,
            factoryResetPersistenceCompletions: factoryResetPersistenceCompletions,
            resumedBindingGenerations: resumedBindingGenerations,
            unjournaledResumeBindingGenerations: unjournaledResumeBindingGenerations,
            connectionSettings: connectionSettings,
            environment: environment,
            certificate: certificate,
            privateKey: privateKey,
            backendPublicKey: backendPublicKey,
            grantBlob: grantBlob,
            timeSynced: timeSynced,
            startRecordingGrant: startRecordingGrant,
            stopRecordingGrant: stopRecordingGrant,
            recordingStateTerminationCount: recordingStateTerminationCount
        )
    }
}
