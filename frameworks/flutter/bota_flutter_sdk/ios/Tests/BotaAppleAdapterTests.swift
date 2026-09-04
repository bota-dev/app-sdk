import BotaAppleSDK
import Foundation
import XCTest

@testable import BotaFlutterSdk

@MainActor
final class BotaAppleAdapterTests: XCTestCase {
  private let validID = "0123456789abcdef0123456789abcdef"

  func testInvalidOperationIDFailsBeforeNativeState() async throws {
    let native = AdapterTestClient()
    let adapter = makeAdapter(native: native)

    do {
      try await adapter.configure(
        operationId: "not-an-id",
        configuration: configurationMessage()
      )
      XCTFail("expected invalid operation ID")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "invalid_operation_id")
    }

    let invocations = await native.invocations
    XCTAssertEqual(invocations, [])
  }

  func testOneShotOperationsMapToNativeManagersAndCallbacks() async throws {
    let native = AdapterTestClient()
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter)
    try await configure(adapter)

    let connected = try await adapter.connect(
      operationId: id(2),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    XCTAssertEqual(connected.serialNumber, "BP-001")
    _ = try await adapter.reconnect(
      operationId: id(3),
      serialNumber: "BP-001",
      hint: reconnectHint()
    )
    try await adapter.disconnect(operationId: id(4))
    _ = try await adapter.connect(
      operationId: id(5),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    _ = try await adapter.readDeviceStatus(operationId: id(6))
    try await adapter.cancelDeviceOperation(operationId: id(7))
    try await adapter.startRecording(
      operationId: id(8),
      device: deviceReference(),
      requestId: "c3RhcnQtZ3JhbnQ="
    )
    try await adapter.stopRecording(
      operationId: id(9),
      device: deviceReference(),
      requestId: "c3RvcC1ncmFudA=="
    )
    _ = try await adapter.readRecordingState(
      operationId: id(10),
      device: deviceReference()
    )
    try await adapter.provision(
      operationId: id(11),
      device: deviceReference(),
      materialId: id(101)
    )
    _ = try await adapter.readConnectionSettings(
      operationId: id(12),
      device: deviceReference()
    )
    try await adapter.writeConnectionSettings(
      operationId: id(13),
      device: deviceReference(),
      settings: settingsMessage()
    )
    _ = try await adapter.deprovision(
      operationId: id(14),
      device: deviceReference(),
      materialId: "ZGVwcm92aXNpb24tZ3JhbnQ="
    )
    try await adapter.cancelProvisioningOperation(operationId: id(15))
    _ = try await adapter.factoryReset(
      operationId: id(16),
      device: deviceReference(),
      command: resetCommand()
    )
    _ = try await adapter.resumePendingFactoryReset(operationId: id(17))
    _ = try await adapter.resumeUnjournaledFactoryReset(
      operationId: id(18),
      device: deviceReference(),
      command: resetCommand(commandID: "command-2")
    )
    try await adapter.cancelFactoryResetOperation(operationId: id(19))
    _ = try await adapter.listRecordings(
      operationId: id(20),
      device: deviceReference()
    )
    _ = try await adapter.takeTransferMetadata(operationId: id(21), sinkId: "sink-1")
    try await adapter.confirmRecording(
      operationId: id(22),
      device: deviceReference(),
      recordingId: "recording-1"
    )
    try await adapter.cancelRecordingOperation(operationId: id(23))
    try await adapter.cancelOtaOperation(operationId: id(24))
    try await adapter.stopLogs(operationId: id(25))
    _ = try await adapter.configureWifi(
      operationId: id(26),
      device: deviceReference(),
      credentials: BotaWifiCredentialsMessage(ssid: "Bota", password: "secret"),
      materialId: "d2lmaS1ncmFudA=="
    )
    _ = try await adapter.disconnectWifi(
      operationId: id(27),
      device: deviceReference()
    )
    _ = try await adapter.readWifiStatus(
      operationId: id(28),
      device: deviceReference()
    )
    _ = try await adapter.scanWifi(
      operationId: id(29),
      device: deviceReference()
    )
    try await adapter.cancelWifiOperation(operationId: id(30))
    try await adapter.destroy(operationId: id(31))

    let invocations = await native.invocations
    XCTAssertEqual(
      Set(invocations),
      Set([
        "configure", "connect", "reconnect", "disconnect", "readDeviceStatus",
        "cancelDeviceOperation", "startRecording", "stopRecording", "readRecordingState",
        "provision", "readConnectionSettings", "writeConnectionSettings", "deprovision",
        "cancelProvisioningOperation", "factoryReset", "resumePendingFactoryReset",
        "resumeUnjournaledFactoryReset", "cancelFactoryResetOperation", "listRecordings",
        "takeTransferMetadata", "confirmRecording", "cancelRecordingOperation",
        "cancelOtaOperation", "stopLogs", "configureWifi", "disconnectWifi",
        "readWifiStatus", "scanWifi", "cancelWifiOperation",
        "destroy",
      ])
    )
    XCTAssertEqual(flutter.materialKinds, ["provisioning", "factoryReset"])
    XCTAssertEqual(flutter.persistedResetCommands, ["command-1", "command-1", "command-2"])
  }

  func testAllNativeStreamKindsEmitMappedEvents() async throws {
    let native = AdapterTestClient()
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter)
    try await configure(adapter)
    _ = try await adapter.connect(
      operationId: id(2),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )

    let requests: [BotaSubscriptionRequestMessage] = [
      BotaScanSubscriptionMessage(timeoutMillis: 1_000, allowDuplicates: false),
      BotaConnectionSubscriptionMessage(),
      BotaDeviceStatusSubscriptionMessage(),
      BotaRecordingStateSubscriptionMessage(device: deviceReference()),
      BotaRecordingSyncSubscriptionMessage(
        device: deviceReference(),
        recording: recordingMessage(),
        sinkId: "sink-1",
        confirmOnCompletion: false
      ),
      BotaUploadOwnershipSubscriptionMessage(
        device: deviceReference(),
        recordingId: "recording-1",
        uploadId: "upload-1",
        destinationId: "destination-1"
      ),
      BotaFirmwareUpdateSubscriptionMessage(
        device: deviceReference(),
        image: BotaFirmwareImageMessage(
          sourceId: "firmware-source",
          version: "1.2.3",
          sizeBytes: 512,
          crc32: 123
        )
      ),
      BotaLogSubscriptionMessage(device: deviceReference()),
      BotaWifiStatusSubscriptionMessage(device: deviceReference()),
    ]

    for (offset, request) in requests.enumerated() {
      try await adapter.startSubscription(subscriptionId: id(50 + offset), request: request)
    }

    try await eventually { flutter.events.count == requests.count * 2 }
    XCTAssertEqual(Set(flutter.events.map(\.subscriptionId)).count, requests.count)
    XCTAssertEqual(flutter.callbackKinds, ["firmware"])
    let invocations = await native.invocations
    XCTAssertTrue(invocations.contains("scanStream"))
    XCTAssertTrue(invocations.contains("firmwareStream"))
    XCTAssertTrue(invocations.contains("recordingSyncStream"))
  }

  func testCancellationRemovesSubscriptionBeforeStoppingNativeOwner() async throws {
    let native = AdapterTestClient(useHangingScan: true)
    let adapter = makeAdapter(native: native)
    try await configure(adapter)
    let subscriptionID = id(70)
    try await adapter.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    try await adapter.cancelSubscription(subscriptionId: subscriptionID)

    let activeSubscriptionCount = await adapter.activeSubscriptionCount
    let cancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(activeSubscriptionCount, 0)
    XCTAssertEqual(cancellationCount, 1)
  }

  func testDetachReleasesOnlyItsEngineWork() async throws {
    let native = AdapterTestClient(useHangingScan: true)
    let flutterA = AdapterTestFlutterApi()
    let flutterB = AdapterTestFlutterApi()
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, flutter: flutterA, leases: leases, engineID: "a")
    let adapterB = makeAdapter(native: native, flutter: flutterB, leases: leases, engineID: "b")
    try await configure(adapterA, operationID: id(1))
    try await configure(adapterB, operationID: id(2))
    try await adapterA.startSubscription(
      subscriptionId: id(80),
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    await adapterA.detach()

    let intermediateLeaseCount = await leases.leaseCount
    let intermediateDestroyCount = await native.destroyCount
    XCTAssertEqual(intermediateLeaseCount, 1)
    XCTAssertEqual(intermediateDestroyCount, 0)
    _ = try await adapterB.readDeviceStatus(operationId: id(81))
    await adapterB.detach()
    let finalDestroyCount = await native.destroyCount
    XCTAssertEqual(finalDestroyCount, 1)
  }

  func testConflictingEngineConfigurationUsesStableBridgeCode() async throws {
    let native = AdapterTestClient()
    let leases = NativeLeaseCoordinator(client: native)
    let first = makeAdapter(native: native, leases: leases, engineID: "first")
    let second = makeAdapter(native: native, leases: leases, engineID: "second")
    try await configure(first)

    do {
      try await second.configure(
        operationId: id(82),
        configuration: configurationMessage(namespace: "different")
      )
      XCTFail("expected configuration conflict")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "configuration_conflict")
    }

    let invocations = await native.invocations
    XCTAssertEqual(invocations.filter { $0 == "configure" }.count, 1)
  }

  func testUnknownRawValuesAndLargeValuesAreHandledExplicitly() throws {
    let unknown = try BotaAppleMapper.deviceType(.unknown(247))
    XCTAssertEqual(unknown.name, "unknown")
    XCTAssertEqual(unknown.rawValue, 247)
    XCTAssertEqual(
      try BotaAppleMapper.deviceType(
        BotaDeviceTypeMessage(name: "future", rawValue: 247)
      ),
      .unknown(247)
    )

    XCTAssertThrowsError(
      try BotaAppleMapper.recordingProgress(
        RecordingTransferProgress(
          completedBytes: UInt64(Int64.max) + 1,
          totalBytes: UInt64(Int64.max) + 1
        )
      )
    ) { error in
      XCTAssertEqual((error as? BotaSDKError)?.code, .payloadTooLarge)
    }

    let settings = try BotaAppleMapper.connectionSettings(
      DeviceConnectionSettings(
        enabledConnections: .init(wifi: true, cellular: false),
        uploadNetworkPreference: [.wifi],
        powerManagement: .init(wifiIdleTimeoutSeconds: 0, cellularIdleTimeoutSeconds: -1)
      ))
    XCTAssertEqual(settings.powerManagement.wifiIdleTimeoutMillis, 0)
    XCTAssertEqual(settings.powerManagement.cellularIdleTimeoutMillis, -1_000)

    let deprovision = BotaAppleMapper.deprovisionResult(
      DeprovisionResult(success: false, error: .invalidToken)
    )
    XCTAssertEqual(deprovision.error?.name, "invalidToken")
  }

  func testNativeErrorPreservesStableFields() async throws {
    let native = AdapterTestClient()
    await native.setReadStatusError(
      BotaSDKError(
        code: .unknown(900),
        operation: .unknown(901),
        retryable: true,
        protocolStatus: 17,
        detail: "native detail"
      )
    )
    let adapter = makeAdapter(native: native)
    try await configure(adapter)

    do {
      _ = try await adapter.readDeviceStatus(operationId: id(90))
      XCTFail("expected native error")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "bota_sdk_error")
      let details = try XCTUnwrap(error.details as? BotaErrorMessage)
      XCTAssertEqual(details.code.rawValue, 900)
      XCTAssertEqual(details.operation.rawValue, 901)
      XCTAssertTrue(details.retryable)
      XCTAssertEqual(details.protocolStatus, 17)
      XCTAssertEqual(details.detail, "native detail")
    }
  }

  func testUploadDestinationCallbackMapsRequestWithoutPayloadBytes() async throws {
    let native = AdapterTestClient()
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter)
    try await configure(adapter)

    let request = try await adapter.requestUploadDestination(
      destinationID: "destination-1",
      recordingID: "recording-1",
      uploadID: "upload-1"
    )

    XCTAssertEqual(request.url?.absoluteString, "https://example.com/upload")
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(flutter.callbackKinds, ["upload"])
  }

  func testCallbackResponseIDAndKindAreValidated() async throws {
    let native = AdapterTestClient()
    let wrongID = makeAdapter(
      native: native,
      flutter: AdapterTestFlutterApi(responseMode: .wrongID),
      engineID: "wrong-id"
    )
    try await configure(wrongID)
    _ = try await wrongID.connect(
      operationId: id(91),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    do {
      try await wrongID.provision(
        operationId: id(92),
        device: deviceReference(),
        materialId: id(191)
      )
      XCTFail("expected callback ID rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "callback_id_mismatch")
    }

    let wrongKind = makeAdapter(
      native: AdapterTestClient(),
      flutter: AdapterTestFlutterApi(responseMode: .wrongMaterialKind),
      engineID: "wrong-kind"
    )
    try await configure(wrongKind, operationID: id(93))
    _ = try await wrongKind.connect(
      operationId: id(94),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    do {
      try await wrongKind.provision(
        operationId: id(95),
        device: deviceReference(),
        materialId: id(195)
      )
      XCTFail("expected callback kind rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "callback_kind_mismatch")
    }
  }

  private func makeAdapter(
    native: AdapterTestClient,
    flutter: AdapterTestFlutterApi = AdapterTestFlutterApi(),
    leases: NativeLeaseCoordinator? = nil,
    engineID: String = "engine"
  ) -> BotaAppleAdapter {
    BotaAppleAdapter(
      engineID: engineID,
      client: native,
      leaseCoordinator: leases ?? NativeLeaseCoordinator(client: native),
      flutterApi: flutter,
      applicationSupportRoot: URL(fileURLWithPath: "/tmp/bota-flutter-tests")
    )
  }

  private func configure(
    _ adapter: BotaAppleAdapter,
    operationID: String = "00000000000000000000000000000001"
  ) async throws {
    try await adapter.configure(
      operationId: operationID,
      configuration: configurationMessage()
    )
  }

  private func configurationMessage(
    namespace: String = "adapter-tests"
  ) -> BotaConfigurationMessage {
    BotaConfigurationMessage(
      applicationSupportNamespace: namespace,
      hasProvisioningMaterialCallback: true,
      hasFactoryResetGrantCallback: true,
      hasFactoryResetResultCallback: true,
      hasUploadDestinationCallback: true,
      hasFirmwareCallback: true
    )
  }

  private func discoveredMessage() -> BotaDiscoveredDeviceMessage {
    BotaDiscoveredDeviceMessage(
      id: "peripheral-1",
      name: "Bota Pin",
      deviceType: BotaDeviceTypeMessage(name: "botaPin", rawValue: nil),
      firmwareVersion: "1.0.0",
      macAddress: "AA:BB:CC:DD:EE:FF",
      pairingState: BotaPairingStateMessage(name: "paired", rawValue: nil),
      rssi: -42,
      discoveredAtMillis: 1_700_000_000_000
    )
  }

  private func reconnectHint() -> BotaReconnectHintMessage {
    BotaReconnectHintMessage(
      storedPeripheralId: "peripheral-1",
      advertisedAddress: nil,
      storedName: "Bota Pin",
      scanTimeoutMillis: 1_000,
      connectionTimeoutMillis: 2_000
    )
  }

  private func deviceReference() -> BotaDeviceReferenceMessage {
    BotaDeviceReferenceMessage(id: "peripheral-1")
  }

  private func resetCommand(commandID: String = "command-1") -> BotaFactoryResetCommandMessage {
    BotaFactoryResetCommandMessage(commandId: commandID, bindingGeneration: 4)
  }

  private func recordingMessage() -> BotaDeviceRecordingMessage {
    BotaDeviceRecordingMessage(
      recordingId: "recording-1",
      startedAtMillis: 1_700_000_000_000,
      durationMillis: 2_000,
      fileSizeBytes: 512,
      codec: BotaAudioCodecMessage(name: "opus16k", rawValue: nil),
      isEncrypted: true
    )
  }

  private func settingsMessage() -> BotaConnectionSettingsMessage {
    BotaConnectionSettingsMessage(
      enabledConnections: BotaEnabledConnectionsMessage(wifi: true, cellular: true),
      heartbeatEnabledConnections: BotaEnabledConnectionsMessage(wifi: true, cellular: false),
      heartbeatUnknownMask: 0,
      uploadNetworkPreference: [BotaConnectionTypeMessage(name: "wifi", rawValue: nil)],
      powerManagement: BotaPowerManagementMessage(
        wifiIdleTimeoutMillis: 180_000,
        cellularIdleTimeoutMillis: 120_000
      ),
      streamingEnabled: true,
      streamingFlushIntervalMillis: 60_000
    )
  }

  private func id(_ value: Int) -> String { String(format: "%032x", value) }

  private func eventually(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    _ predicate: @escaping () -> Bool
  ) async throws {
    let start = ContinuousClock.now
    while !predicate() {
      if ContinuousClock.now - start > .nanoseconds(Int64(timeoutNanoseconds)) {
        XCTFail("condition did not become true")
        return
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
}

private final class AdapterTestFlutterApi: BotaFlutterApiProtocol, @unchecked Sendable {
  enum ResponseMode: Equatable {
    case valid
    case wrongID
    case wrongMaterialKind
  }

  private let lock = NSLock()
  private let responseMode: ResponseMode
  private var storedEvents: [BotaEventMessage] = []
  private var storedMaterialKinds: [String] = []
  private var storedCallbackKinds: [String] = []
  private var storedPersistedResetCommands: [String] = []

  var events: [BotaEventMessage] { lock.withLock { storedEvents } }
  var materialKinds: [String] { lock.withLock { storedMaterialKinds } }
  var callbackKinds: [String] { lock.withLock { storedCallbackKinds } }
  var persistedResetCommands: [String] { lock.withLock { storedPersistedResetCommands } }

  init(responseMode: ResponseMode = .valid) {
    self.responseMode = responseMode
  }

  func onEvent(event: BotaEventMessage) async throws {
    lock.withLock { storedEvents.append(event) }
  }

  func requestMaterial(
    request: BotaMaterialRequestMessage,
    completion: @escaping (Result<BotaMaterialResponseMessage, PigeonError>) -> Void
  ) {
    switch request {
    case let request as BotaProvisioningMaterialRequestMessage:
      lock.withLock { storedMaterialKinds.append("provisioning") }
      if responseMode == .wrongMaterialKind {
        completion(
          .success(
            BotaFactoryResetGrantResponseMessage(
              requestId: request.requestId,
              encodedGrant: .init(bytes: Data([1]))
            )))
        return
      }
      completion(
        .success(
          BotaProvisioningMaterialResponseMessage(
            requestId: responseID(request.requestId),
            apiEndpoint: .init(bytes: Data("https://api.bota.dev".utf8)),
            deviceToken: .init(bytes: Data("token".utf8)),
            mtu: 247
          )))
    case let request as BotaFactoryResetGrantRequestMessage:
      lock.withLock { storedMaterialKinds.append("factoryReset") }
      completion(
        .success(
          BotaFactoryResetGrantResponseMessage(
            requestId: responseID(request.requestId),
            encodedGrant: .init(bytes: Data([1, 2, 3]))
          )))
    default:
      completion(
        .failure(
          PigeonError(
            code: "wrong_kind",
            message: nil,
            details: nil
          )))
    }
  }

  func requestFirmware(
    request: BotaFirmwareRequestMessage,
    completion: @escaping (Result<BotaFirmwareSourceMessage, PigeonError>) -> Void
  ) {
    lock.withLock { storedCallbackKinds.append("firmware") }
    completion(
      .success(
        BotaFirmwareSourceMessage(
          requestId: responseID(request.requestId),
          url: "https://example.com/firmware.bin",
          headers: ["Authorization": "redacted"]
        )))
  }

  func requestUploadDestination(
    request: BotaUploadDestinationRequestMessage,
    completion: @escaping (Result<BotaUploadDestinationMessage, PigeonError>) -> Void
  ) {
    lock.withLock { storedCallbackKinds.append("upload") }
    completion(
      .success(
        BotaUploadDestinationMessage(
          requestId: responseID(request.requestId),
          url: "https://example.com/upload",
          method: .put,
          headers: [:]
        )))
  }

  func persistFactoryResetResult(
    request: BotaFactoryResetResultRequestMessage,
    completion:
      @escaping (Result<BotaFactoryResetResultAcknowledgementMessage, PigeonError>) -> Void
  ) {
    lock.withLock { storedPersistedResetCommands.append(request.commandId) }
    completion(
      .success(
        BotaFactoryResetResultAcknowledgementMessage(
          requestId: responseID(request.requestId)
        )))
  }

  private func responseID(_ requestID: String) -> String {
    responseMode == .wrongID ? String(repeating: "f", count: 32) : requestID
  }
}

private actor AdapterTestClient: BotaAppleClientProtocol {
  private(set) var invocations: [String] = []
  private(set) var destroyCount = 0
  private(set) var deviceCancellationCount = 0
  private var readStatusError: Error?
  private let useHangingScan: Bool

  init(useHangingScan: Bool = false) { self.useHangingScan = useHangingScan }

  func setReadStatusError(_ error: Error) { readStatusError = error }
  func configure(applicationSupportDirectory: URL) async throws { invocations.append("configure") }
  func destroy() async {
    destroyCount += 1
    invocations.append("destroy")
  }

  func connect(_ device: DiscoveredDevice, serialNumber: String?) async throws -> ConnectedDevice {
    invocations.append("connect")
    return connected(serialNumber: serialNumber ?? "BP-001")
  }

  func reconnect(serialNumber: String, hint: DeviceReconnectHint) async throws -> ConnectedDevice {
    invocations.append("reconnect")
    return connected(serialNumber: serialNumber)
  }

  func disconnect() async throws { invocations.append("disconnect") }
  func readDeviceStatus() async throws -> DeviceStatus {
    invocations.append("readDeviceStatus")
    if let readStatusError { throw readStatusError }
    return status()
  }
  func cancelDeviceOperation() async throws {
    deviceCancellationCount += 1
    invocations.append("cancelDeviceOperation")
  }
  func startRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    invocations.append("startRecording")
  }
  func stopRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    invocations.append("stopRecording")
  }
  func readRecordingState(_ device: ConnectedDevice) async throws -> RecordingState {
    invocations.append("readRecordingState")
    return RecordingState(active: true, recordingID: "recording-1", initiatedBy: .remote)
  }
  func provision(
    _ device: ConnectedDevice,
    materialID: String,
    using provider: @escaping ProvisioningMaterialProvider
  ) async throws {
    invocations.append("provision")
    _ = try await provider(
      ProvisioningMaterialRequest(
        serialNumber: device.serialNumber,
        nonce: Data([1]),
        devicePublicKey: Data([2])
      ))
  }
  func readConnectionSettings(_ device: ConnectedDevice) async throws -> DeviceConnectionSettings {
    invocations.append("readConnectionSettings")
    return settings()
  }
  func writeConnectionSettings(_ settings: DeviceConnectionSettings, to device: ConnectedDevice)
    async throws
  {
    invocations.append("writeConnectionSettings")
  }
  func deprovision(_ device: ConnectedDevice, grantBlob: String) async throws -> DeprovisionResult {
    invocations.append("deprovision")
    return DeprovisionResult(success: true)
  }
  func cancelProvisioningOperation() async throws {
    invocations.append("cancelProvisioningOperation")
  }
  func factoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    grantID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister,
    using provider: @escaping FactoryResetGrantProvider
  ) async throws -> FactoryResetCompletion {
    invocations.append("factoryReset")
    _ = try await provider(
      FactoryResetGrantRequest(
        serialNumber: device.serialNumber,
        nonce: Data([3]),
        commandID: commandID,
        bindingGeneration: bindingGeneration
      ))
    try await persistResult(.init(localRecordingsDeleted: 2))
    return FactoryResetCompletion(commandID: commandID, bindingGeneration: bindingGeneration)
  }
  func resumePendingFactoryReset(
    _ device: ConnectedDevice,
    currentBindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion? {
    invocations.append("resumePendingFactoryReset")
    try await persistResult(.init(localRecordingsDeleted: 2))
    return FactoryResetCompletion(
      commandID: "command-1", bindingGeneration: currentBindingGeneration)
  }
  func resumeUnjournaledFactoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion {
    invocations.append("resumeUnjournaledFactoryReset")
    try await persistResult(.init(localRecordingsDeleted: 2))
    return FactoryResetCompletion(commandID: commandID, bindingGeneration: bindingGeneration)
  }
  func cancelFactoryResetOperation() async throws {
    invocations.append("cancelFactoryResetOperation")
  }
  func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
    invocations.append("listRecordings")
    return [recording()]
  }
  func takeTransferMetadata(sinkID: String) async -> RecordingTransferMetadata? {
    invocations.append("takeTransferMetadata")
    return RecordingTransferMetadata(isE2EEncrypted: true, contentSHA256Hex: "abc")
  }
  func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
    invocations.append("confirmRecording")
  }
  func cancelRecordingOperation() async throws { invocations.append("cancelRecordingOperation") }
  func cancelOtaOperation() async throws { invocations.append("cancelOtaOperation") }
  func stopLogs() async throws { invocations.append("stopLogs") }
  func configureWifi(
    _ device: ConnectedDevice,
    ssid: String,
    password: String,
    grantBlob: String
  ) async throws -> WiFiConfigResult {
    invocations.append("configureWifi")
    return .success
  }
  func disconnectWifi(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
    invocations.append("disconnectWifi")
    return .success
  }
  func readWifiStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
    invocations.append("readWifiStatus")
    return wifiStatus()
  }
  func scanWifi(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
    invocations.append("scanWifi")
    return DeviceWiFiScanResult(
      networks: [.init(ssid: "Bota", quality: 80, isCurrent: true, isOpen: false)],
      currentSSID: "Bota"
    )
  }
  func cancelWifiOperation() async { invocations.append("cancelWifiOperation") }

  func scanStream(timeoutMilliseconds: UInt64, allowDuplicates: Bool) async throws
    -> AsyncThrowingStream<DiscoveredDevice, Error>
  {
    invocations.append("scanStream")
    if useHangingScan { return AsyncThrowingStream { _ in } }
    return throwingStream(discovered())
  }
  func connectionStream() async -> AsyncStream<ConnectedDevice?> {
    invocations.append("connectionStream")
    return AsyncStream { continuation in
      continuation.yield(connected())
      continuation.finish()
    }
  }
  func deviceStatusStream() async throws -> AsyncThrowingStream<DeviceStatus, Error> {
    invocations.append("deviceStatusStream")
    return throwingStream(status())
  }
  func recordingStateStream(_ device: ConnectedDevice) async throws
    -> AsyncThrowingStream<RecordingState, Error>
  {
    invocations.append("recordingStateStream")
    return throwingStream(
      RecordingState(active: true, recordingID: "recording-1", initiatedBy: .remote))
  }
  func recordingSyncStream(
    _ device: ConnectedDevice,
    recording: DeviceRecording,
    sinkID: String,
    confirmOnCompletion: Bool
  ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
    invocations.append("recordingSyncStream")
    return AsyncThrowingStream { continuation in
      continuation.yield(.progress(.init(completedBytes: 256, totalBytes: 512)))
      continuation.yield(.completed(URL(fileURLWithPath: "/tmp/recording.ogg")))
      continuation.finish()
    }
  }
  func uploadOwnershipStream(
    _ device: ConnectedDevice,
    recordingUUID: String,
    uploadID: String,
    destinationID: String
  ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
    invocations.append("uploadOwnershipStream")
    return AsyncThrowingStream { continuation in
      continuation.yield(.progress(.init(completedBytes: 512, totalBytes: 512)))
      continuation.yield(.result(.deviceUploadCompleted))
      continuation.finish()
    }
  }
  func firmwareStream(_ device: ConnectedDevice, image: FirmwareImage) async throws
    -> AsyncThrowingStream<FirmwareUpdateProgress, Error>
  {
    invocations.append("firmwareStream")
    return throwingStream(.init(phase: .complete, completedBytes: 512, totalBytes: 512))
  }
  func logStream(_ device: ConnectedDevice) async throws -> AsyncThrowingStream<
    DeviceLogLine, Error
  > {
    invocations.append("logStream")
    return throwingStream(.init(message: "ready", isBacklog: false))
  }
  func wifiStatusStream(_ device: ConnectedDevice) async throws
    -> AsyncThrowingStream<WiFiStatusInfo, Error>
  {
    invocations.append("wifiStatusStream")
    return throwingStream(wifiStatus())
  }

  private func connected(serialNumber: String = "BP-001") -> ConnectedDevice {
    ConnectedDevice(
      id: "peripheral-1",
      serialNumber: serialNumber,
      deviceType: .botaPin,
      firmwareVersion: "1.0.0",
      isProvisioned: true,
      connectionState: .connected,
      mtu: 247
    )
  }
  private func discovered() -> DiscoveredDevice {
    DiscoveredDevice(
      id: "peripheral-1",
      name: "Bota Pin",
      deviceType: .botaPin,
      firmwareVersion: "1.0.0",
      macAddress: "AA:BB:CC:DD:EE:FF",
      pairingState: .paired,
      rssi: -42,
      discoveredAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }
  private func status() -> DeviceStatus {
    DeviceStatus(
      batteryLevel: 80,
      storageTotalMb: 8_192,
      storageUsedMb: 256,
      state: .known(.idle),
      pendingRecordings: 1,
      lastTimeSyncAt: Date(timeIntervalSince1970: 1_700_000_000),
      signalStrength: -50,
      flags: .init(
        charging: false,
        lowBattery: false,
        storageFull: false,
        wifiConnected: true,
        lteConnected: false,
        syncActive: false
      ),
      timestamp: 123,
      lteStatus: .unknown(99),
      wifiStatus: .known(.connected)
    )
  }
  private func settings() -> DeviceConnectionSettings {
    DeviceConnectionSettings(
      enabledConnections: .init(wifi: true, cellular: true),
      heartbeatEnabledConnections: .init(wifi: true, cellular: false),
      uploadNetworkPreference: [.wifi],
      powerManagement: .init(wifiIdleTimeoutSeconds: 180, cellularIdleTimeoutSeconds: 120),
      streamingEnabled: true,
      streamingFlushIntervalSeconds: 60
    )
  }
  private func recording() -> DeviceRecording {
    DeviceRecording(
      uuid: "recording-1",
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      durationMs: 2_000,
      fileSizeBytes: 512,
      codec: .known(.opus16k),
      isEncrypted: true
    )
  }
  private func wifiStatus() -> WiFiStatusInfo {
    WiFiStatusInfo(status: .connected, signalStrength: 80, ssid: "Bota")
  }
}

private func throwingStream<Element: Sendable>(_ element: Element) -> AsyncThrowingStream<
  Element, Error
> {
  AsyncThrowingStream { continuation in
    continuation.yield(element)
    continuation.finish()
  }
}
