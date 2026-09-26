import BotaAppSDK
import Foundation

#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#endif

private final class PendingFlutterCallback<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?

  func install(_ continuation: CheckedContinuation<Value, Error>) {
    lock.lock()
    self.continuation = continuation
    lock.unlock()
  }

  func resume(with result: Result<Value, Error>) {
    lock.lock()
    let continuation = self.continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume(with: result)
  }
}

private struct PendingCallbackCancellation: Sendable {
  let category: NativeOperationCategory
  let cancel: @Sendable () -> Void
}

protocol BotaAppleClientProtocol: NativeLeaseClientProtocol {
  func connect(_ device: DiscoveredDevice, serialNumber: String?) async throws -> ConnectedDevice
  func reconnect(serialNumber: String, hint: DeviceReconnectHint) async throws -> ConnectedDevice
  func disconnect() async throws
  func readDeviceStatus() async throws -> DeviceStatus
  func nextClientPresence(deviceID: String) async throws -> SDKClientContext?
  func cancelDeviceOperation() async throws
  func startRecording(_ device: ConnectedDevice, grantBlob: String) async throws
  func stopRecording(_ device: ConnectedDevice, grantBlob: String) async throws
  func readRecordingState(_ device: ConnectedDevice) async throws -> RecordingState
  func provision(
    _ device: ConnectedDevice,
    materialID: String,
    using provider: @escaping ProvisioningMaterialProvider
  ) async throws
  func readConnectionSettings(_ device: ConnectedDevice) async throws -> DeviceConnectionSettings
  func writeConnectionSettings(
    _ settings: DeviceConnectionSettings,
    to device: ConnectedDevice
  ) async throws
  func deprovision(_ device: ConnectedDevice, grantBlob: String) async throws -> DeprovisionResult
  func cancelProvisioningOperation() async throws
  func factoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    grantID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister,
    using provider: @escaping FactoryResetGrantProvider
  ) async throws -> FactoryResetCompletion
  func resumePendingFactoryReset(
    _ device: ConnectedDevice,
    currentBindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion?
  func resumeUnjournaledFactoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion
  func cancelFactoryResetOperation() async throws
  func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording]
  func takeTransferMetadata(sinkID: String) async -> RecordingTransferMetadata?
  func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws
  func cancelRecordingOperation() async throws
  func cancelOtaOperation() async throws
  func stopLogs() async throws
  func configureWifi(
    _ device: ConnectedDevice,
    ssid: String,
    password: String,
    grantBlob: String
  ) async throws -> WiFiConfigResult
  func disconnectWifi(_ device: ConnectedDevice) async throws -> WiFiConfigResult
  func readWifiStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo
  func scanWifi(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult
  func cancelWifiOperation() async
  func scanStream(
    timeoutMilliseconds: UInt64,
    allowDuplicates: Bool
  ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error>
  func connectionStream() async -> AsyncStream<ConnectedDevice?>
  func deviceStatusStream() async throws -> AsyncThrowingStream<DeviceStatus, Error>
  func recordingStateStream(
    _ device: ConnectedDevice
  ) async throws -> AsyncThrowingStream<RecordingState, Error>
  func recordingSyncStream(
    _ device: ConnectedDevice,
    recording: DeviceRecording,
    sinkID: String,
    confirmOnCompletion: Bool
  ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error>
  func uploadOwnershipStream(
    _ device: ConnectedDevice,
    recordingUUID: String,
    uploadID: String,
    destinationID: String
  ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error>
  func firmwareStream(
    _ device: ConnectedDevice,
    image: FirmwareImage
  ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error>
  func logStream(_ device: ConnectedDevice) async throws -> AsyncThrowingStream<
    DeviceLogLine, Error
  >
  func wifiStatusStream(
    _ device: ConnectedDevice
  ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error>
}

final class BotaAppleNativeClient: BotaAppleClientProtocol, @unchecked Sendable {
  static let shared = BotaAppleNativeClient(client: .shared)

  private let client: BotaDeviceClient

  init(client: BotaDeviceClient) {
    self.client = client
  }

  func configure(applicationSupportDirectory: URL) async throws {
    try await client.configure(.init(applicationSupportDirectory: applicationSupportDirectory))
  }

  func destroy() async { await client.destroy() }

  func connect(_ device: DiscoveredDevice, serialNumber: String?) async throws -> ConnectedDevice {
    if let serialNumber {
      return try await client.devices.connect(serialNumber: serialNumber, device: device)
    }
    return try await client.devices.connect(device: device)
  }

  func reconnect(serialNumber: String, hint: DeviceReconnectHint) async throws -> ConnectedDevice {
    try await client.devices.reconnect(serialNumber: serialNumber, hint: hint)
  }

  func disconnect() async throws { try await client.devices.disconnect() }
  func readDeviceStatus() async throws -> DeviceStatus { try await client.devices.readStatus() }
  func nextClientPresence(deviceID: String) async throws -> SDKClientContext? {
    try await client.clientPresence.nextReport(deviceID: deviceID)
  }
  func cancelDeviceOperation() async throws { try await client.devices.cancelCurrentOperation() }

  func startRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    let result = try await client.controls.requestStartRecording(device, grantBlob: grantBlob)
    try validate(result)
  }

  func stopRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    let result = try await client.controls.requestStopRecording(device, grantBlob: grantBlob)
    try validate(result)
  }

  func readRecordingState(_ device: ConnectedDevice) async throws -> RecordingState {
    try await client.controls.readRecordingState(from: device)
  }

  func provision(
    _ device: ConnectedDevice,
    materialID: String,
    using provider: @escaping ProvisioningMaterialProvider
  ) async throws {
    try await client.provisioning.provision(device, materialID: materialID, using: provider)
  }

  func readConnectionSettings(_ device: ConnectedDevice) async throws -> DeviceConnectionSettings {
    try await client.provisioning.readConnectionSettings(from: device)
  }

  func writeConnectionSettings(
    _ settings: DeviceConnectionSettings,
    to device: ConnectedDevice
  ) async throws {
    try await client.provisioning.writeConnectionSettings(settings, to: device)
  }

  func deprovision(_ device: ConnectedDevice, grantBlob: String) async throws -> DeprovisionResult {
    try await client.provisioning.deprovision(device, grantBlob: grantBlob)
  }

  func cancelProvisioningOperation() async throws {
    try await client.provisioning.cancelCurrentOperation()
  }

  func factoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    grantID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister,
    using provider: @escaping FactoryResetGrantProvider
  ) async throws -> FactoryResetCompletion {
    try await client.factoryReset.factoryReset(
      device,
      commandID: commandID,
      grantID: grantID,
      bindingGeneration: bindingGeneration,
      persistResult: persistResult,
      using: provider
    )
  }

  func resumePendingFactoryReset(
    _ device: ConnectedDevice,
    currentBindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion? {
    try await client.factoryReset.resumePendingFactoryReset(
      device,
      currentBindingGeneration: currentBindingGeneration,
      persistResult: persistResult
    )
  }

  func resumeUnjournaledFactoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion {
    try await client.factoryReset.resumeUnjournaledFactoryReset(
      device,
      commandID: commandID,
      bindingGeneration: bindingGeneration,
      persistResult: persistResult
    )
  }

  func cancelFactoryResetOperation() async throws {
    try await client.factoryReset.cancelCurrentOperation()
  }

  func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
    try await client.recordings.listRecordings(device)
  }

  func takeTransferMetadata(sinkID: String) async -> RecordingTransferMetadata? {
    await client.recordings.transferMetadata(sinkID: sinkID)
  }

  func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
    try await client.recordings.confirmRecording(device, recordingUUID: recordingUUID)
  }

  func cancelRecordingOperation() async throws {
    try await client.recordings.cancelCurrentOperation()
  }

  func cancelOtaOperation() async throws { try await client.ota.cancelCurrentOperation() }
  func stopLogs() async throws { try await client.logs.stop() }

  func configureWifi(
    _ device: ConnectedDevice,
    ssid: String,
    password: String,
    grantBlob: String
  ) async throws -> WiFiConfigResult {
    try await client.wifi.configure(device, ssid: ssid, password: password, grantBlob: grantBlob)
  }

  func disconnectWifi(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
    try await client.wifi.disconnect(device)
  }

  func readWifiStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
    try await client.wifi.readStatus(device)
  }

  func scanWifi(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
    try await client.wifi.scanNetworks(device)
  }

  func cancelWifiOperation() async { await client.wifi.cancelCurrentOperation() }

  func scanStream(
    timeoutMilliseconds: UInt64,
    allowDuplicates: Bool
  ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error> {
    try await client.devices.startScan(
      timeoutMilliseconds: timeoutMilliseconds,
      allowDuplicates: allowDuplicates
    )
  }

  func connectionStream() async -> AsyncStream<ConnectedDevice?> {
    await client.devices.connectionUpdates()
  }

  func deviceStatusStream() async throws -> AsyncThrowingStream<DeviceStatus, Error> {
    try await client.devices.statusUpdates()
  }

  func recordingStateStream(
    _ device: ConnectedDevice
  ) async throws -> AsyncThrowingStream<RecordingState, Error> {
    try await client.controls.recordingStateUpdates(for: device)
  }

  func recordingSyncStream(
    _ device: ConnectedDevice,
    recording: DeviceRecording,
    sinkID: String,
    confirmOnCompletion: Bool
  ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
    try await client.recordings.syncRecording(
      device,
      recording: recording,
      sinkID: sinkID,
      confirmOnCompletion: confirmOnCompletion
    )
  }

  func uploadOwnershipStream(
    _ device: ConnectedDevice,
    recordingUUID: String,
    uploadID: String,
    destinationID: String
  ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
    try await client.recordings.observeUploadOwnership(
      device,
      recordingUUID: recordingUUID,
      uploadID: uploadID,
      destinationID: destinationID
    )
  }

  func firmwareStream(
    _ device: ConnectedDevice,
    image: FirmwareImage
  ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error> {
    try await client.ota.updateFirmware(device, image: image)
  }

  func logStream(_ device: ConnectedDevice) async throws -> AsyncThrowingStream<
    DeviceLogLine, Error
  > {
    try await client.logs.streamLogs(device)
  }

  func wifiStatusStream(
    _ device: ConnectedDevice
  ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error> {
    try await client.wifi.statusUpdates(device)
  }

  private func validate(_ result: RecordingControlResult) throws {
    guard !result.success else { return }
    throw BotaSDKError(
      code: .protocolRejected,
      operation: .validate,
      retryable: false,
      detail: result.error?.rawValue ?? "recording command was rejected"
    )
  }
}

@MainActor
final class BotaAppleAdapter: @preconcurrency BotaHostApi {
  private enum SubscriptionOwner: Sendable {
    case deviceOperation
    case connection
    case deviceStatus
    case recordingState
    case recordingOperation
    case ota
    case logs
    case wifi

    var category: NativeOperationCategory? {
      switch self {
      case .deviceOperation: return .device
      case .recordingOperation: return .recording
      case .ota: return .ota
      case .logs: return .logs
      case .wifi: return .wifi
      case .connection, .deviceStatus, .recordingState: return nil
      }
    }
  }

  private struct Subscription: Sendable {
    let owner: SubscriptionOwner
    let task: Task<Void, Never>
  }

  private typealias SubscriptionConsumer = @Sendable () async -> Void

  private struct StartingSubscription: Sendable {
    let owner: SubscriptionOwner
    let task: Task<SubscriptionConsumer, Error>
  }

  private enum OperationOutcome: @unchecked Sendable {
    case success(Any)
    case failure(Error)
  }

  private struct InFlightOperation {
    let category: NativeOperationCategory
    let task: Task<OperationOutcome, Never>
  }

  private let engineID: String
  private let client: any BotaAppleClientProtocol
  private let leaseCoordinator: NativeLeaseCoordinator
  private let flutterApi: any BotaFlutterApiProtocol
  private let applicationSupportRoot: URL
  private var configuration: BotaConfigurationMessage?
  private var discoveredDevices: [String: DiscoveredDevice] = [:]
  private var connectedDevices: [String: ConnectedDevice] = [:]
  private var activeIdentifiers: Set<String> = []
  private var consumedIdentifiers: Set<String> = []
  private var startingSubscriptionIDs: Set<String> = []
  private var startingSubscriptions: [String: StartingSubscription] = [:]
  private var subscriptions: [String: Subscription] = [:]
  private var inFlightOperations: [String: InFlightOperation] = [:]
  private var pendingCallbackCancellations: [String: PendingCallbackCancellation] = [:]
  private var detached = false
  private var destroying = false
  private var callbackRegistrationClosed = false
  private var releaseTask: Task<Void, Never>?
  private var released = false

  init(
    engineID: String,
    client: any BotaAppleClientProtocol,
    leaseCoordinator: NativeLeaseCoordinator,
    flutterApi: any BotaFlutterApiProtocol,
    applicationSupportRoot: URL
  ) {
    self.engineID = engineID
    self.client = client
    self.leaseCoordinator = leaseCoordinator
    self.flutterApi = flutterApi
    self.applicationSupportRoot = applicationSupportRoot
  }

  var activeSubscriptionCount: Int { subscriptions.count + startingSubscriptionIDs.count }

  func configure(operationId: String, configuration: BotaConfigurationMessage) async throws {
    do {
      try beginIdentifier(operationId, requiresConfiguration: false)
      defer { finishIdentifier(operationId) }
      guard !detached else { throw bridgeError("engine_detached", "engine is detached") }
      let namespace = configuration.applicationSupportNamespace
      guard !namespace.isEmpty,
        namespace != ".",
        namespace != "..",
        !namespace.contains("/")
      else { throw bridgeError("invalid_configuration", "namespace must be one path component") }
      let directory = applicationSupportRoot.appendingPathComponent(namespace, isDirectory: true)
      let lease = NativeLeaseConfiguration(
        applicationSupportDirectory: directory,
        applicationSupportNamespace: namespace,
        hasProvisioningMaterialCallback: configuration.hasProvisioningMaterialCallback,
        hasFactoryResetGrantCallback: configuration.hasFactoryResetGrantCallback,
        hasFactoryResetResultCallback: configuration.hasFactoryResetResultCallback,
        hasFirmwareCallback: configuration.hasFirmwareCallback
      )
      do {
        try await leaseCoordinator.acquire(engineID: engineID, configuration: lease)
      } catch NativeLeaseError.configurationConflict {
        throw bridgeError("configuration_conflict", "native client is configured differently")
      } catch NativeLeaseError.acquisitionCancelled {
        throw bridgeError("engine_detached", "engine is detached")
      }
      try requireAttached()
      self.configuration = configuration
    } catch {
      throw BotaAppleMapper.pigeonError(error)
    }
  }

  func destroy(operationId: String) async throws {
    do {
      try beginIdentifier(operationId, requiresConfiguration: true)
      destroying = true
      callbackRegistrationClosed = true
      await self.releaseEngine()
      detached = true
      destroying = false
      finishIdentifier(operationId)
    } catch {
      throw BotaAppleMapper.pigeonError(mapLeaseError(error))
    }
  }

  func connect(
    operationId: String,
    device: BotaDiscoveredDeviceMessage,
    serialNumber: String?
  ) async throws -> BotaConnectedDeviceMessage {
    try await perform(operationId, category: .device) {
      guard let native = self.discoveredDevices[device.id] else {
        throw self.bridgeError("device_not_found", "device was not discovered by this engine")
      }
      let connected = try await self.client.connect(native, serialNumber: serialNumber)
      try self.requireAttached()
      self.store(connected)
      return try BotaAppleMapper.connectedDevice(connected)
    }
  }

  func reconnect(
    operationId: String,
    serialNumber: String,
    hint: BotaReconnectHintMessage
  ) async throws -> BotaConnectedDeviceMessage {
    try await perform(operationId, category: .device) {
      let connected = try await self.client.reconnect(
        serialNumber: serialNumber,
        hint: try BotaAppleMapper.reconnectHint(hint)
      )
      try self.requireAttached()
      self.store(connected)
      return try BotaAppleMapper.connectedDevice(connected)
    }
  }

  func disconnect(operationId: String) async throws {
    try await perform(operationId, category: .device) {
      try await self.client.disconnect()
      try self.requireAttached()
      self.connectedDevices.removeAll()
    }
  }

  func readDeviceStatus(operationId: String) async throws -> BotaDeviceStatusMessage {
    try await perform(operationId, category: .device) {
      try BotaAppleMapper.deviceStatus(try await self.client.readDeviceStatus())
    }
  }

  func nextClientPresence(operationId: String, deviceId: String) async throws -> BotaClientContextMessage? {
    try await perform(operationId, category: .device) {
      guard let report = try await self.client.nextClientPresence(deviceID: deviceId) else { return nil }
      return BotaClientContextMessage(schemaVersion: Int64(report.schemaVersion),
        sessionId: report.sessionID, sequence: report.sequence, platform: report.platform,
        sdkPackage: report.sdkPackage, sdkVersion: report.sdkVersion)
    }
  }

  func cancelDeviceOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .device) {
      try await client.cancelDeviceOperation()
    }
  }

  func startRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    grantBlob: String
  ) async throws {
    try await perform(operationId, category: .recording) {
      guard !grantBlob.isEmpty else {
        throw self.bridgeError("invalid_request", "recording grant is required")
      }
      try await self.client.startRecording(try self.device(device), grantBlob: grantBlob)
    }
  }

  func stopRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    grantBlob: String
  ) async throws {
    try await perform(operationId, category: .recording) {
      guard !grantBlob.isEmpty else {
        throw self.bridgeError("invalid_request", "recording grant is required")
      }
      try await self.client.stopRecording(try self.device(device), grantBlob: grantBlob)
    }
  }

  func readRecordingState(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaRecordingStateMessage {
    try await perform(operationId, category: .recording) {
      BotaAppleMapper.recordingState(
        try await self.client.readRecordingState(try self.device(device))
      )
    }
  }

  func provision(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws {
    try await perform(operationId, category: .provisioning) {
      try self.requireCallback(\.hasProvisioningMaterialCallback, name: "provisioning material")
      try await self.client.provision(
        try self.device(device),
        materialID: self.callbackID()
      ) { [weak self] request in
        guard let self else { throw CancellationError() }
        return try await self.provisioningMaterial(request)
      }
    }
  }

  func readConnectionSettings(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaConnectionSettingsMessage {
    try await perform(operationId, category: .provisioning) {
      try BotaAppleMapper.connectionSettings(
        try await self.client.readConnectionSettings(try self.device(device))
      )
    }
  }

  func writeConnectionSettings(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    settings: BotaConnectionSettingsMessage
  ) async throws {
    try await perform(operationId, category: .provisioning) {
      try await self.client.writeConnectionSettings(
        try BotaAppleMapper.connectionSettings(settings),
        to: try self.device(device)
      )
    }
  }

  func deprovision(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    grantBlob: String
  ) async throws -> BotaDeprovisionResultMessage {
    try await perform(operationId, category: .provisioning) {
      guard !grantBlob.isEmpty else {
        throw self.bridgeError("invalid_request", "deprovision grant is required")
      }
      return BotaAppleMapper.deprovisionResult(
        try await self.client.deprovision(try self.device(device), grantBlob: grantBlob)
      )
    }
  }

  func cancelProvisioningOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .provisioning) {
      try await client.cancelProvisioningOperation()
    }
  }

  func factoryReset(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    command: BotaFactoryResetCommandMessage
  ) async throws -> BotaFactoryResetCompletionMessage {
    try await perform(operationId, category: .factoryReset) {
      try self.requireCallback(\.hasFactoryResetGrantCallback, name: "factory reset grant")
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      let nativeDevice = try self.device(device)
      let generation = try BotaAppleMapper.uint64(command.bindingGeneration)
      let completion = try await self.client.factoryReset(
        nativeDevice,
        commandID: command.commandId,
        grantID: operationId,
        bindingGeneration: generation,
        persistResult: { [weak self] result in
          guard let self else { throw CancellationError() }
          try await self.persistReset(result)
        },
        using: { [weak self] request in
          guard let self else { throw CancellationError() }
          return try await self.factoryResetGrant(request)
        }
      )
      return try BotaAppleMapper.factoryResetCompletion(completion)
    }
  }

  func resumePendingFactoryReset(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    currentBindingGeneration: Int64
  ) async throws -> BotaFactoryResetCompletionMessage? {
    try await perform(operationId, category: .factoryReset) {
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      let nativeDevice = try self.device(device)
      let generation = try BotaAppleMapper.uint64(currentBindingGeneration)
      let completion = try await self.client.resumePendingFactoryReset(
        nativeDevice,
        currentBindingGeneration: generation
      ) { [weak self] result in
        guard let self else { throw CancellationError() }
        try await self.persistReset(result)
      }
      return try completion.map(BotaAppleMapper.factoryResetCompletion)
    }
  }

  func resumeUnjournaledFactoryReset(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    command: BotaFactoryResetCommandMessage
  ) async throws -> BotaFactoryResetCompletionMessage {
    try await perform(operationId, category: .factoryReset) {
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      let nativeDevice = try self.device(device)
      let generation = try BotaAppleMapper.uint64(command.bindingGeneration)
      let completion = try await self.client.resumeUnjournaledFactoryReset(
        nativeDevice,
        commandID: command.commandId,
        bindingGeneration: generation
      ) { [weak self] result in
        guard let self else { throw CancellationError() }
        try await self.persistReset(result)
      }
      return try BotaAppleMapper.factoryResetCompletion(completion)
    }
  }

  func cancelFactoryResetOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .factoryReset) {
      try await client.cancelFactoryResetOperation()
    }
  }

  func listRecordings(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> [BotaDeviceRecordingMessage] {
    try await perform(operationId, category: .recording) {
      try await self.client.listRecordings(try self.device(device)).map(BotaAppleMapper.recording)
    }
  }

  func takeTransferMetadata(
    operationId: String,
    sinkId: String
  ) async throws -> BotaRecordingTransferMetadataMessage? {
    try await perform(operationId, category: .recording) {
      await self.client.takeTransferMetadata(sinkID: sinkId).map(BotaAppleMapper.transferMetadata)
    }
  }

  func confirmRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    recordingId: String
  ) async throws {
    try await perform(operationId, category: .recording) {
      try await self.client.confirmRecording(
        try self.device(device),
        recordingUUID: recordingId
      )
    }
  }

  func cancelRecordingOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .recording) {
      try await client.cancelRecordingOperation()
    }
  }

  func cancelOtaOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .ota) {
      try await client.cancelOtaOperation()
    }
  }

  func stopLogs(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .logs) {
      try await client.stopLogs()
    }
  }

  func configureWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    credentials: BotaWifiCredentialsMessage,
    grantBlob: String
  ) async throws -> BotaWifiConfigResultMessage {
    try await perform(operationId, category: .wifi) {
      guard !grantBlob.isEmpty else {
        throw self.bridgeError("invalid_request", "WiFi grant is required")
      }
      return BotaAppleMapper.wifiConfigResult(
        try await self.client.configureWifi(
          try self.device(device),
          ssid: credentials.ssid,
          password: credentials.password,
          grantBlob: grantBlob
        )
      )
    }
  }

  func disconnectWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiConfigResultMessage {
    try await perform(operationId, category: .wifi) {
      BotaAppleMapper.wifiConfigResult(
        try await self.client.disconnectWifi(try self.device(device))
      )
    }
  }

  func readWifiStatus(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiStatusMessage {
    try await perform(operationId, category: .wifi) {
      BotaAppleMapper.wifiStatus(
        try await self.client.readWifiStatus(try self.device(device))
      )
    }
  }

  func scanWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiScanResultMessage {
    try await perform(operationId, category: .wifi) {
      BotaAppleMapper.wifiScan(try await self.client.scanWifi(try self.device(device)))
    }
  }

  func cancelWifiOperation(operationId: String) async throws {
    let client = self.client
    try await cancel(operationId, category: .wifi) {
      await client.cancelWifiOperation()
    }
  }

  func startSubscription(
    subscriptionId: String,
    request: BotaSubscriptionRequestMessage
  ) async throws {
    do {
      try reserveSubscription(subscriptionId)
      let owner = try subscriptionOwner(request)
      let startTask = Task { @MainActor [weak self] () throws -> SubscriptionConsumer in
        guard let self else { throw CancellationError() }
        try Task.checkCancellation()
        if let category = owner.category {
          try await self.leaseCoordinator.beginOperation(
            engineID: self.engineID,
            category: category,
            operationID: subscriptionId
          )
          do {
            try Task.checkCancellation()
            return try await self.prepareSubscription(subscriptionId, request: request)
          } catch {
            await self.leaseCoordinator.finishOperation(
              engineID: self.engineID,
              category: category,
              operationID: subscriptionId
            )
            throw error
          }
        }
        try Task.checkCancellation()
        return try await self.prepareSubscription(subscriptionId, request: request)
      }
      startingSubscriptions[subscriptionId] = StartingSubscription(owner: owner, task: startTask)
      let consume = try await startTask.value
      guard !startTask.isCancelled else {
        if detached || destroying {
          throw bridgeError("engine_detached", "engine is detached")
        }
        throw bridgeError("cancelled", "subscription start was cancelled")
      }
      guard startingSubscriptions.removeValue(forKey: subscriptionId) != nil else {
        throw bridgeError("engine_detached", "engine is detached")
      }
      try install(subscriptionId, owner: owner, consume: consume)
    } catch {
      startingSubscriptions.removeValue(forKey: subscriptionId)
      startingSubscriptionIDs.remove(subscriptionId)
      finishIdentifier(subscriptionId)
      let mapped =
        detached || destroying
        ? bridgeError("engine_detached", "engine is detached")
        : mapLeaseError(error)
      throw BotaAppleMapper.pigeonError(mapped)
    }
  }

  func cancelSubscription(subscriptionId: String) async throws {
    do {
      try validateID(subscriptionId)
      if let starting = startingSubscriptions[subscriptionId] {
        starting.task.cancel()
        let startResult = await starting.task.result
        guard case .success = startResult else { return }
        if let category = starting.owner.category {
          try await leaseCoordinator.cancelOperation(
            engineID: engineID,
            category: category
          ) { [weak self] in
            guard let self else { return }
            try await self.stop(starting.owner)
          }
        } else {
          try await stop(starting.owner)
        }
        return
      }
      guard let subscription = subscriptions.removeValue(forKey: subscriptionId) else {
        throw bridgeError("subscription_not_found", "subscription is not active")
      }
      finishIdentifier(subscriptionId)
      subscription.task.cancel()
      if let category = subscription.owner.category {
        do {
          try await leaseCoordinator.cancelOperation(
            engineID: engineID,
            category: category
          ) { [weak self] in
            guard let self else { return }
            var stopError: Error?
            do {
              try await self.stop(subscription.owner)
            } catch {
              stopError = error
            }
            await subscription.task.value
            if let stopError { throw stopError }
          }
        } catch {
          throw error
        }
        await leaseCoordinator.finishOperation(
          engineID: engineID,
          category: category,
          operationID: subscriptionId
        )
      } else {
        try await stop(subscription.owner)
        await subscription.task.value
      }
    } catch {
      throw BotaAppleMapper.pigeonError(mapLeaseError(error))
    }
  }

  func detach() async {
    if detached {
      if let releaseTask { await releaseTask.value }
      return
    }
    detached = true
    callbackRegistrationClosed = true
    await releaseEngine()
  }

  private func perform<T>(
    _ operationID: String,
    category: NativeOperationCategory,
    _ body: @escaping @MainActor () async throws -> T
  ) async throws -> T {
    var ownsNativeOperation = false
    var didBeginIdentifier = false
    do {
      try beginIdentifier(operationID, requiresConfiguration: true)
      didBeginIdentifier = true
      try await leaseCoordinator.beginOperation(
        engineID: engineID,
        category: category,
        operationID: operationID
      )
      ownsNativeOperation = true
      try requireAttached()
      let task = Task { @MainActor in
        do {
          try Task.checkCancellation()
          return OperationOutcome.success(try await body())
        } catch {
          return OperationOutcome.failure(error)
        }
      }
      inFlightOperations[operationID] = InFlightOperation(category: category, task: task)
      let outcome = await task.value
      inFlightOperations.removeValue(forKey: operationID)
      switch outcome {
      case .success(let result):
        try requireAttached()
        await leaseCoordinator.finishOperation(
          engineID: engineID,
          category: category,
          operationID: operationID
        )
        if didBeginIdentifier { finishIdentifier(operationID) }
        guard let result = result as? T else {
          preconditionFailure("operation result type changed while in flight")
        }
        return result
      case .failure(let error):
        throw error
      }
    } catch {
      inFlightOperations.removeValue(forKey: operationID)
      if ownsNativeOperation {
        await leaseCoordinator.finishOperation(
          engineID: engineID,
          category: category,
          operationID: operationID
        )
      }
      if didBeginIdentifier { finishIdentifier(operationID) }
      let mapped =
        detached || destroying
        ? bridgeError("engine_detached", "engine is detached")
        : mapLeaseError(error)
      throw BotaAppleMapper.pigeonError(mapped)
    }
  }

  private func cancel(
    _ operationID: String,
    category: NativeOperationCategory,
    body: @escaping @Sendable () async throws -> Void
  ) async throws {
    var didBeginIdentifier = false
    do {
      try beginIdentifier(operationID, requiresConfiguration: true)
      didBeginIdentifier = true
      let ownedOperation = inFlightOperations.first { $0.value.category == category }
      if let ownedOperation {
        inFlightOperations.removeValue(forKey: ownedOperation.key)
      }
      try await leaseCoordinator.cancelOperation(
        engineID: engineID,
        category: category
      ) {
        ownedOperation?.value.task.cancel()
        var cancellationError: Error?
        do {
          try await body()
        } catch {
          cancellationError = error
        }
        if let ownedOperation { _ = await ownedOperation.value.task.value }
        if let cancellationError { throw cancellationError }
      }
      try requireAttached()
      if didBeginIdentifier { finishIdentifier(operationID) }
    } catch {
      if didBeginIdentifier { finishIdentifier(operationID) }
      throw BotaAppleMapper.pigeonError(mapLeaseError(error))
    }
  }

  private func beginIdentifier(_ id: String, requiresConfiguration: Bool) throws {
    try validateID(id)
    guard !activeIdentifiers.contains(id), !consumedIdentifiers.contains(id) else {
      throw bridgeError("duplicate_identifier", "operation or subscription ID was reused")
    }
    try requireAttached()
    if requiresConfiguration, configuration == nil {
      throw bridgeError("not_configured", "adapter is not configured")
    }
    activeIdentifiers.insert(id)
  }

  private func finishIdentifier(_ id: String) {
    guard activeIdentifiers.remove(id) != nil else { return }
    consumedIdentifiers.insert(id)
  }

  private func validateID(_ id: String) throws {
    guard id.utf8.count == 32,
      id.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) })
    else {
      throw bridgeError("invalid_operation_id", "ID must be 32 lowercase hexadecimal characters")
    }
  }

  private func reserveSubscription(_ id: String) throws {
    try beginIdentifier(id, requiresConfiguration: true)
    startingSubscriptionIDs.insert(id)
  }

  private func prepareSubscription(
    _ id: String,
    request: BotaSubscriptionRequestMessage
  ) async throws -> SubscriptionConsumer {
    switch request {
    case let request as BotaScanSubscriptionMessage:
      let stream = try await client.scanStream(
        timeoutMilliseconds: BotaAppleMapper.uint64(request.timeoutMillis),
        allowDuplicates: request.allowDuplicates
      )
      return { await self.consumeScan(id, stream: stream) }
    case is BotaConnectionSubscriptionMessage:
      let stream = await client.connectionStream()
      return { await self.consumeConnection(id, stream: stream) }
    case is BotaDeviceStatusSubscriptionMessage:
      let stream = try await client.deviceStatusStream()
      return { await self.consumeStatus(id, stream: stream) }
    case let request as BotaRecordingStateSubscriptionMessage:
      let stream = try await client.recordingStateStream(try device(request.device))
      return { await self.consumeRecordingState(id, stream: stream) }
    case let request as BotaRecordingSyncSubscriptionMessage:
      let stream = try await client.recordingSyncStream(
        try device(request.device),
        recording: try BotaAppleMapper.recording(request.recording),
        sinkID: request.sinkId,
        confirmOnCompletion: request.confirmOnCompletion
      )
      return { await self.consumeRecordingSync(id, stream: stream) }
    case let request as BotaUploadOwnershipSubscriptionMessage:
      let stream = try await client.uploadOwnershipStream(
        try device(request.device),
        recordingUUID: request.recordingId,
        uploadID: request.uploadId,
        destinationID: request.destinationId
      )
      return { await self.consumeUploadOwnership(id, stream: stream) }
    case let request as BotaFirmwareUpdateSubscriptionMessage:
      try requireCallback(\.hasFirmwareCallback, name: "firmware")
      let stream = try await client.firmwareStream(
        try device(request.device),
        image: try await firmwareImage(request.image)
      )
      return { await self.consumeFirmware(id, stream: stream) }
    case let request as BotaLogSubscriptionMessage:
      let stream = try await client.logStream(try device(request.device))
      return { await self.consumeLogs(id, stream: stream) }
    case let request as BotaWifiStatusSubscriptionMessage:
      let stream = try await client.wifiStatusStream(try device(request.device))
      return { await self.consumeWifi(id, stream: stream) }
    default:
      throw bridgeError("unsupported_subscription", "subscription kind is not supported")
    }
  }

  private func install(
    _ id: String,
    owner: SubscriptionOwner,
    consume: @escaping @Sendable () async -> Void
  ) throws {
    try requireAttached()
    guard startingSubscriptionIDs.contains(id) else {
      throw bridgeError("engine_detached", "engine is detached")
    }
    let task = Task { await consume() }
    subscriptions[id] = Subscription(owner: owner, task: task)
    startingSubscriptionIDs.remove(id)
  }

  private func completeSubscription(_ id: String) async {
    guard let subscription = subscriptions.removeValue(forKey: id) else { return }
    finishIdentifier(id)
    if let category = subscription.owner.category {
      do {
        try await leaseCoordinator.cancelOperation(engineID: engineID, category: category) {
          [weak self] in
          guard let self else { return }
          try await self.stop(subscription.owner)
        }
        await leaseCoordinator.finishOperation(
          engineID: engineID,
          category: category,
          operationID: id
        )
      } catch {
        // Collector completion does not prove shared native work stopped.
      }
    }
    guard !detached else { return }
    await emit(id, BotaSubscriptionCompleteEventMessage())
  }

  private func failSubscription(_ id: String, error: Error) async {
    guard subscriptions[id] != nil else { return }
    await emit(id, BotaSubscriptionErrorEventMessage(error: BotaAppleMapper.error(error)))
    await completeSubscription(id)
  }

  private func emit(_ id: String, _ payload: BotaEventPayloadMessage) async {
    guard !detached, !destroying else { return }
    try? await flutterApi.onEvent(event: BotaEventMessage(subscriptionId: id, payload: payload))
  }

  private func consumeScan(
    _ id: String,
    stream: AsyncThrowingStream<DiscoveredDevice, Error>
  ) async {
    do {
      for try await value in stream {
        guard !detached, subscriptions[id] != nil else { return }
        discoveredDevices[value.id] = value
        await emit(
          id, BotaDiscoveredDeviceEventMessage(device: try BotaAppleMapper.discoveredDevice(value)))
      }
      await completeSubscription(id)
    } catch is CancellationError {
    } catch { await failSubscription(id, error: error) }
  }

  private func consumeConnection(_ id: String, stream: AsyncStream<ConnectedDevice?>) async {
    for await value in stream {
      guard !detached, subscriptions[id] != nil else { return }
      do {
        if let value {
          store(value)
        } else {
          connectedDevices.removeAll()
        }
        await emit(
          id,
          BotaConnectionEventMessage(device: try value.map(BotaAppleMapper.connectedDevice))
        )
      } catch {
        await failSubscription(id, error: error)
        return
      }
    }
    await completeSubscription(id)
  }

  private func consumeStatus(
    _ id: String,
    stream: AsyncThrowingStream<DeviceStatus, Error>
  ) async {
    await consume(stream, id: id) {
      BotaDeviceStatusEventMessage(status: try BotaAppleMapper.deviceStatus($0))
    }
  }

  private func consumeRecordingState(
    _ id: String,
    stream: AsyncThrowingStream<RecordingState, Error>
  ) async {
    await consume(stream, id: id) {
      BotaRecordingStateEventMessage(state: BotaAppleMapper.recordingState($0))
    }
  }

  private func consumeRecordingSync(
    _ id: String,
    stream: AsyncThrowingStream<RecordingSyncEvent, Error>
  ) async {
    await consume(stream, id: id) { value in
      switch value {
      case .progress(let progress):
        return BotaRecordingSyncProgressEventMessage(
          progress: try BotaAppleMapper.recordingProgress(progress)
        )
      case .completed(let url):
        return BotaRecordingSyncCompletedEventMessage(localPath: url.path)
      }
    }
  }

  private func consumeUploadOwnership(
    _ id: String,
    stream: AsyncThrowingStream<UploadOwnershipEvent, Error>
  ) async {
    await consume(stream, id: id) { value in
      switch value {
      case .progress(let progress):
        return BotaUploadOwnershipProgressEventMessage(
          progress: try BotaAppleMapper.recordingProgress(progress)
        )
      case .result(let result):
        return BotaUploadOwnershipResolvedEventMessage(
          result: BotaAppleMapper.uploadOwnership(result)
        )
      }
    }
  }

  private func consumeFirmware(
    _ id: String,
    stream: AsyncThrowingStream<FirmwareUpdateProgress, Error>
  ) async {
    await consume(stream, id: id) {
      BotaFirmwareProgressEventMessage(progress: try BotaAppleMapper.firmwareProgress($0))
    }
  }

  private func consumeLogs(
    _ id: String,
    stream: AsyncThrowingStream<DeviceLogLine, Error>
  ) async {
    await consume(stream, id: id) {
      BotaDeviceLogEventMessage(line: BotaAppleMapper.logLine($0))
    }
  }

  private func consumeWifi(
    _ id: String,
    stream: AsyncThrowingStream<WiFiStatusInfo, Error>
  ) async {
    await consume(stream, id: id) {
      BotaWifiStatusEventMessage(status: BotaAppleMapper.wifiStatus($0))
    }
  }

  private func consume<Element: Sendable>(
    _ stream: AsyncThrowingStream<Element, Error>,
    id: String,
    map: (Element) throws -> BotaEventPayloadMessage
  ) async {
    do {
      for try await value in stream {
        guard !detached, subscriptions[id] != nil else { return }
        await emit(id, try map(value))
      }
      await completeSubscription(id)
    } catch is CancellationError {
    } catch { await failSubscription(id, error: error) }
  }

  private func releaseEngine() async {
    callbackRegistrationClosed = true
    if released { return }
    if let releaseTask {
      await releaseTask.value
      return
    }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.cleanUpEngine()
    }
    releaseTask = task
    await task.value
    released = true
    releaseTask = nil
  }

  private func cleanUpEngine() async {
    let rejectedCallbackCategories = rejectPendingCallbacks()

    let operations = inFlightOperations
    let starting = startingSubscriptions
    let activeSubscriptions = subscriptions
    subscriptions.removeAll()
    for subscription in starting.values { subscription.task.cancel() }
    let startingByCategory = Dictionary(
      uniqueKeysWithValues: starting.values.compactMap { subscription in
        subscription.owner.category.map { ($0, subscription) }
      })
    let operationsByCategory = Dictionary(
      uniqueKeysWithValues: operations.values.map { ($0.category, $0) }
    )
    let ownedOperations = await leaseCoordinator.beginCancellingOperations(
      engineID: engineID
    ) { [weak self] category in
      guard let self else { return }
      if rejectedCallbackCategories.contains(category),
        let operation = operationsByCategory[category]
      {
        operation.task.cancel()
        _ = await operation.task.value
      }
      if let subscription = startingByCategory[category] {
        guard case .success = await subscription.task.result else { return }
      }
      try await self.stop(category)
    }
    for operation in operations.values { operation.task.cancel() }
    for subscription in activeSubscriptions.values { subscription.task.cancel() }
    await leaseCoordinator.waitForOperationCancellations(
      engineID: engineID,
      operations: ownedOperations
    )
    for operation in operations.values { _ = await operation.task.value }
    for subscription in starting.values { _ = await subscription.task.result }
    for subscription in activeSubscriptions.values { await subscription.task.value }
    let terminalOperationIDs = Set(operations.keys)
    await leaseCoordinator.finishCancelledOperations(
      engineID: engineID,
      operations: ownedOperations,
      terminalOperationIDs: terminalOperationIDs
    )
    for id in operations.keys {
      inFlightOperations.removeValue(forKey: id)
      finishIdentifier(id)
    }
    for id in activeSubscriptions.keys { finishIdentifier(id) }
    startingSubscriptions.removeAll()
    for id in startingSubscriptionIDs { finishIdentifier(id) }
    startingSubscriptionIDs.removeAll()
    connectedDevices.removeAll()
    discoveredDevices.removeAll()
    configuration = nil
    await leaseCoordinator.release(engineID: engineID)
  }

  private func stop(_ owner: SubscriptionOwner) async throws {
    switch owner {
    case .deviceOperation: try await client.cancelDeviceOperation()
    case .recordingOperation: try await client.cancelRecordingOperation()
    case .ota: try await client.cancelOtaOperation()
    case .logs: try await client.stopLogs()
    case .wifi: await client.cancelWifiOperation()
    case .connection, .deviceStatus, .recordingState: break
    }
  }

  private func stop(_ category: NativeOperationCategory) async throws {
    switch category {
    case .device: try await client.cancelDeviceOperation()
    case .provisioning: try await client.cancelProvisioningOperation()
    case .factoryReset: try await client.cancelFactoryResetOperation()
    case .recording: try await client.cancelRecordingOperation()
    case .ota: try await client.cancelOtaOperation()
    case .logs: try await client.stopLogs()
    case .wifi: await client.cancelWifiOperation()
    }
  }

  private func subscriptionOwner(
    _ request: BotaSubscriptionRequestMessage
  ) throws -> SubscriptionOwner {
    switch request {
    case is BotaScanSubscriptionMessage: return .deviceOperation
    case is BotaConnectionSubscriptionMessage: return .connection
    case is BotaDeviceStatusSubscriptionMessage: return .deviceStatus
    case is BotaRecordingStateSubscriptionMessage: return .recordingState
    case is BotaRecordingSyncSubscriptionMessage,
      is BotaUploadOwnershipSubscriptionMessage:
      return .recordingOperation
    case is BotaFirmwareUpdateSubscriptionMessage: return .ota
    case is BotaLogSubscriptionMessage: return .logs
    case is BotaWifiStatusSubscriptionMessage: return .wifi
    default: throw bridgeError("unsupported_subscription", "subscription kind is not supported")
    }
  }

  private func store(_ device: ConnectedDevice) {
    connectedDevices[device.id] = device
  }

  private func requireAttached() throws {
    guard !detached, !destroying else {
      throw bridgeError("engine_detached", "engine is detached")
    }
  }

  private func mapLeaseError(_ error: Error) -> Error {
    guard let error = error as? NativeLeaseError else { return error }
    switch error {
    case .configurationConflict:
      return bridgeError("configuration_conflict", "native client is configured differently")
    case .acquisitionCancelled:
      return bridgeError("engine_detached", "engine is detached")
    case .operationInProgress:
      return bridgeError("operation_in_progress", "another engine owns this native operation")
    case .operationNotOwned:
      return bridgeError("operation_not_owned", "native operation belongs to another engine")
    }
  }

  private func device(_ reference: BotaDeviceReferenceMessage) throws -> ConnectedDevice {
    guard let device = connectedDevices[reference.id] else {
      throw bridgeError("device_not_found", "device is not registered with this engine")
    }
    return device
  }

  private func requireCallback(
    _ keyPath: KeyPath<BotaConfigurationMessage, Bool>,
    name: String
  ) throws {
    guard configuration?[keyPath: keyPath] == true else {
      throw bridgeError("callback_unavailable", "\(name) callback is unavailable")
    }
  }

  private func provisioningMaterial(
    _ request: ProvisioningMaterialRequest
  ) async throws -> ProvisioningMaterial {
    let id = callbackID()
    let response = try await requestMaterial(
      BotaProvisioningMaterialRequestMessage(
        requestId: id,
        serialNumber: request.serialNumber,
        nonce: FlutterStandardTypedData(bytes: request.nonce),
        devicePublicKey: FlutterStandardTypedData(bytes: request.devicePublicKey)
      ),
      id: id,
      category: .provisioning
    )
    guard response.requestId == id else { throw callbackIDMismatch() }
    guard let response = response as? BotaProvisioningMaterialResponseMessage else {
      throw callbackKindMismatch()
    }
    return ProvisioningMaterial(
      apiEndpoint: response.apiEndpoint.data,
      deviceToken: response.deviceToken.data,
      mtu: try BotaAppleMapper.uint64(response.mtu)
    )
  }

  private func factoryResetGrant(_ request: FactoryResetGrantRequest) async throws -> Data {
    let id = callbackID()
    let response = try await requestMaterial(
      BotaFactoryResetGrantRequestMessage(
        requestId: id,
        serialNumber: request.serialNumber,
        nonce: FlutterStandardTypedData(bytes: request.nonce),
        commandId: request.commandID,
        bindingGeneration: try BotaAppleMapper.int64(request.bindingGeneration)
      ),
      id: id,
      category: .factoryReset
    )
    guard response.requestId == id else { throw callbackIDMismatch() }
    guard let response = response as? BotaFactoryResetGrantResponseMessage else {
      throw callbackKindMismatch()
    }
    return response.encodedGrant.data
  }

  private func firmwareImage(_ image: BotaFirmwareImageMessage) async throws -> FirmwareImage {
    let id = callbackID()
    let response = try await requestFirmware(
      BotaFirmwareRequestMessage(
        requestId: id,
        sourceId: image.sourceId,
        version: image.version,
        sizeBytes: image.sizeBytes,
        crc32: image.crc32
      ),
      id: id,
      category: .ota
    )
    guard response.requestId == id else { throw callbackIDMismatch() }
    guard let url = URL(string: response.url), url.scheme != nil else {
      throw bridgeError("invalid_callback_response", "firmware URL is invalid")
    }
    var request = URLRequest(url: url)
    for (name, value) in response.headers { request.setValue(value, forHTTPHeaderField: name) }
    return FirmwareImage(
      version: image.version,
      sizeBytes: try BotaAppleMapper.uint32(image.sizeBytes),
      crc32: try BotaAppleMapper.uint32(image.crc32),
      downloadID: stableID(image.sourceId),
      request: request
    )
  }

  private func persistReset(_ result: FactoryResetPersistenceResult) async throws {
    let id = callbackID()
    let response = try await persistFactoryResetResult(
      BotaFactoryResetResultRequestMessage(
        requestId: id,
        commandId: result.commandID,
        bindingGeneration: try BotaAppleMapper.int64(result.bindingGeneration),
        localRecordingsDeleted: Int64(result.localRecordingsDeleted)
      ),
      id: id,
      category: .factoryReset
    )
    guard response.requestId == id else { throw callbackIDMismatch() }
  }

  private func requestMaterial(
    _ request: BotaMaterialRequestMessage,
    id: String,
    category: NativeOperationCategory
  ) async throws -> BotaMaterialResponseMessage {
    try requireCallbackRegistrationOpen()
    let pending = PendingFlutterCallback<BotaMaterialResponseMessage>()
    pendingCallbackCancellations[id] = PendingCallbackCancellation(
      category: category,
      cancel: {
        pending.resume(
          with: .failure(
            BotaBridgeError(
              code: "engine_detached",
              detail: "engine is detached"
            )))
      })
    defer { pendingCallbackCancellations.removeValue(forKey: id) }
    return try await withCheckedThrowingContinuation { continuation in
      pending.install(continuation)
      flutterApi.requestMaterial(request: request) { result in
        pending.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func requestFirmware(
    _ request: BotaFirmwareRequestMessage,
    id: String,
    category: NativeOperationCategory
  ) async throws
    -> BotaFirmwareSourceMessage
  {
    try requireCallbackRegistrationOpen()
    let pending = PendingFlutterCallback<BotaFirmwareSourceMessage>()
    pendingCallbackCancellations[id] = PendingCallbackCancellation(
      category: category,
      cancel: {
        pending.resume(
          with: .failure(
            BotaBridgeError(
              code: "engine_detached",
              detail: "engine is detached"
            )))
      })
    defer { pendingCallbackCancellations.removeValue(forKey: id) }
    return try await withCheckedThrowingContinuation { continuation in
      pending.install(continuation)
      flutterApi.requestFirmware(request: request) { result in
        pending.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func persistFactoryResetResult(
    _ request: BotaFactoryResetResultRequestMessage,
    id: String,
    category: NativeOperationCategory
  ) async throws -> BotaFactoryResetResultAcknowledgementMessage {
    try requireCallbackRegistrationOpen()
    let pending = PendingFlutterCallback<BotaFactoryResetResultAcknowledgementMessage>()
    pendingCallbackCancellations[id] = PendingCallbackCancellation(
      category: category,
      cancel: {
        pending.resume(
          with: .failure(
            BotaBridgeError(
              code: "engine_detached",
              detail: "engine is detached"
            )))
      })
    defer { pendingCallbackCancellations.removeValue(forKey: id) }
    return try await withCheckedThrowingContinuation { continuation in
      pending.install(continuation)
      flutterApi.persistFactoryResetResult(request: request) { result in
        pending.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func rejectPendingCallbacks() -> Set<NativeOperationCategory> {
    let cancellations = pendingCallbackCancellations.values
    pendingCallbackCancellations.removeAll()
    for cancellation in cancellations { cancellation.cancel() }
    return Set(cancellations.map(\.category))
  }

  private func requireCallbackRegistrationOpen() throws {
    guard !callbackRegistrationClosed else {
      throw bridgeError("engine_detached", "engine is detached")
    }
  }

  private func callbackID() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  }

  private func callbackIDMismatch() -> BotaBridgeError {
    bridgeError("callback_id_mismatch", "callback response ID does not match its request")
  }

  private func callbackKindMismatch() -> BotaBridgeError {
    bridgeError("callback_kind_mismatch", "callback response kind is invalid")
  }

  private func bridgeError(_ code: String, _ detail: String) -> BotaBridgeError {
    BotaBridgeError(code: code, detail: detail)
  }

  private func stableID(_ value: String) -> UInt64 {
    value.utf8.reduce(14_695_981_039_346_656_037) {
      ($0 ^ UInt64($1)) &* 1_099_511_628_211
    }
  }
}

extension BotaMaterialResponseMessage {
  fileprivate var requestId: String {
    switch self {
    case let value as BotaProvisioningMaterialResponseMessage: return value.requestId
    case let value as BotaFactoryResetGrantResponseMessage: return value.requestId
    default: return ""
    }
  }
}
