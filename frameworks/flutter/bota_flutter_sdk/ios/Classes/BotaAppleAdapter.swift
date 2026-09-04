import BotaAppleSDK
import Foundation

#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#endif

protocol BotaAppleClientProtocol: NativeLeaseClientProtocol {
  func connect(_ device: DiscoveredDevice, serialNumber: String?) async throws -> ConnectedDevice
  func reconnect(serialNumber: String, hint: DeviceReconnectHint) async throws -> ConnectedDevice
  func disconnect() async throws
  func readDeviceStatus() async throws -> DeviceStatus
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

actor BotaAppleAdapter: BotaHostApi {
  private enum SubscriptionOwner {
    case deviceOperation
    case connection
    case deviceStatus
    case recordingState
    case recordingOperation
    case ota
    case logs
    case wifi
  }

  private struct Subscription {
    let owner: SubscriptionOwner
    let task: Task<Void, Never>
  }

  private let engineID: String
  private let client: any BotaAppleClientProtocol
  private let leaseCoordinator: NativeLeaseCoordinator
  private let flutterApi: any BotaFlutterApiProtocol
  private let applicationSupportRoot: URL
  private var configuration: BotaConfigurationMessage?
  private var discoveredDevices: [String: DiscoveredDevice] = [:]
  private var connectedDevices: [String: ConnectedDevice] = [:]
  private var currentDeviceID: String?
  private var resetGenerations: [String: UInt64] = [:]
  private var resetCommands: [String: String] = [:]
  private var activeOperationIDs: Set<String> = []
  private var consumedOperationIDs: Set<String> = []
  private var startingSubscriptionIDs: Set<String> = []
  private var subscriptions: [String: Subscription] = [:]
  private var consumedSubscriptionIDs: Set<String> = []
  private var detached = false

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
      try beginOperation(operationId, requiresConfiguration: false)
      defer { finishOperation(operationId) }
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
        hasUploadDestinationCallback: configuration.hasUploadDestinationCallback,
        hasFirmwareCallback: configuration.hasFirmwareCallback
      )
      do {
        try await leaseCoordinator.acquire(engineID: engineID, configuration: lease)
      } catch NativeLeaseError.configurationConflict {
        throw bridgeError("configuration_conflict", "native client is configured differently")
      }
      self.configuration = configuration
    } catch {
      throw BotaAppleMapper.pigeonError(error)
    }
  }

  func destroy(operationId: String) async throws {
    try await perform(operationId) {
      await self.cancelAllSubscriptions()
      self.discoveredDevices.removeAll()
      self.connectedDevices.removeAll()
      self.currentDeviceID = nil
      self.resetGenerations.removeAll()
      self.resetCommands.removeAll()
      self.configuration = nil
      await self.leaseCoordinator.release(engineID: self.engineID)
    }
  }

  func connect(
    operationId: String,
    device: BotaDiscoveredDeviceMessage,
    serialNumber: String?
  ) async throws -> BotaConnectedDeviceMessage {
    try await perform(operationId) {
      let native =
        try self.discoveredDevices[device.id]
        ?? BotaAppleMapper.discoveredDevice(device)
      let connected = try await self.client.connect(native, serialNumber: serialNumber)
      self.store(connected)
      return try BotaAppleMapper.connectedDevice(connected)
    }
  }

  func reconnect(
    operationId: String,
    serialNumber: String,
    hint: BotaReconnectHintMessage
  ) async throws -> BotaConnectedDeviceMessage {
    try await perform(operationId) {
      let connected = try await self.client.reconnect(
        serialNumber: serialNumber,
        hint: try BotaAppleMapper.reconnectHint(hint)
      )
      self.store(connected)
      return try BotaAppleMapper.connectedDevice(connected)
    }
  }

  func disconnect(operationId: String) async throws {
    try await perform(operationId) {
      try await self.client.disconnect()
      self.connectedDevices.removeAll()
      self.currentDeviceID = nil
    }
  }

  func readDeviceStatus(operationId: String) async throws -> BotaDeviceStatusMessage {
    try await perform(operationId) {
      try BotaAppleMapper.deviceStatus(try await self.client.readDeviceStatus())
    }
  }

  func cancelDeviceOperation(operationId: String) async throws {
    try await perform(operationId) { try await self.client.cancelDeviceOperation() }
  }

  func startRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    requestId: String?
  ) async throws {
    try await perform(operationId) {
      guard let requestId, !requestId.isEmpty else {
        throw self.bridgeError("invalid_request", "recording grant is required")
      }
      try await self.client.startRecording(try self.device(device), grantBlob: requestId)
    }
  }

  func stopRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    requestId: String?
  ) async throws {
    try await perform(operationId) {
      guard let requestId, !requestId.isEmpty else {
        throw self.bridgeError("invalid_request", "recording grant is required")
      }
      try await self.client.stopRecording(try self.device(device), grantBlob: requestId)
    }
  }

  func readRecordingState(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaRecordingStateMessage {
    try await perform(operationId) {
      BotaAppleMapper.recordingState(
        try await self.client.readRecordingState(try self.device(device))
      )
    }
  }

  func provision(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    materialId: String
  ) async throws {
    try await perform(operationId) {
      try self.requireCallback(\.hasProvisioningMaterialCallback, name: "provisioning material")
      try await self.client.provision(
        try self.device(device),
        materialID: materialId
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
    try await perform(operationId) {
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
    try await perform(operationId) {
      try await self.client.writeConnectionSettings(
        try BotaAppleMapper.connectionSettings(settings),
        to: try self.device(device)
      )
    }
  }

  func deprovision(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    materialId: String
  ) async throws -> BotaDeprovisionResultMessage {
    try await perform(operationId) {
      BotaAppleMapper.deprovisionResult(
        try await self.client.deprovision(try self.device(device), grantBlob: materialId)
      )
    }
  }

  func cancelProvisioningOperation(operationId: String) async throws {
    try await perform(operationId) { try await self.client.cancelProvisioningOperation() }
  }

  func factoryReset(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    command: BotaFactoryResetCommandMessage
  ) async throws -> BotaFactoryResetCompletionMessage {
    try await perform(operationId) {
      try self.requireCallback(\.hasFactoryResetGrantCallback, name: "factory reset grant")
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      let nativeDevice = try self.device(device)
      let generation = try BotaAppleMapper.uint64(command.bindingGeneration)
      self.resetGenerations[nativeDevice.id] = generation
      self.resetCommands[nativeDevice.id] = command.commandId
      let completion = try await self.client.factoryReset(
        nativeDevice,
        commandID: command.commandId,
        grantID: operationId,
        bindingGeneration: generation,
        persistResult: { [weak self] result in
          guard let self else { throw CancellationError() }
          try await self.persistReset(
            commandID: command.commandId,
            bindingGeneration: generation,
            result: result
          )
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
    operationId: String
  ) async throws -> BotaFactoryResetCompletionMessage? {
    try await perform(operationId) {
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      guard let deviceID = self.currentDeviceID,
        let nativeDevice = self.connectedDevices[deviceID],
        let generation = self.resetGenerations[deviceID],
        let commandID = self.resetCommands[deviceID]
      else {
        throw self.bridgeError("factory_reset_context_missing", "no reset context is available")
      }
      let completion = try await self.client.resumePendingFactoryReset(
        nativeDevice,
        currentBindingGeneration: generation
      ) { [weak self] result in
        guard let self else { throw CancellationError() }
        try await self.persistReset(
          commandID: commandID,
          bindingGeneration: generation,
          result: result
        )
      }
      return try completion.map(BotaAppleMapper.factoryResetCompletion)
    }
  }

  func resumeUnjournaledFactoryReset(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    command: BotaFactoryResetCommandMessage
  ) async throws -> BotaFactoryResetCompletionMessage {
    try await perform(operationId) {
      try self.requireCallback(\.hasFactoryResetResultCallback, name: "factory reset result")
      let nativeDevice = try self.device(device)
      let generation = try BotaAppleMapper.uint64(command.bindingGeneration)
      self.resetGenerations[nativeDevice.id] = generation
      self.resetCommands[nativeDevice.id] = command.commandId
      let completion = try await self.client.resumeUnjournaledFactoryReset(
        nativeDevice,
        commandID: command.commandId,
        bindingGeneration: generation
      ) { [weak self] result in
        guard let self else { throw CancellationError() }
        try await self.persistReset(
          commandID: command.commandId,
          bindingGeneration: generation,
          result: result
        )
      }
      return try BotaAppleMapper.factoryResetCompletion(completion)
    }
  }

  func cancelFactoryResetOperation(operationId: String) async throws {
    try await perform(operationId) { try await self.client.cancelFactoryResetOperation() }
  }

  func listRecordings(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> [BotaDeviceRecordingMessage] {
    try await perform(operationId) {
      try await self.client.listRecordings(try self.device(device)).map(BotaAppleMapper.recording)
    }
  }

  func takeTransferMetadata(
    operationId: String,
    sinkId: String
  ) async throws -> BotaRecordingTransferMetadataMessage? {
    try await perform(operationId) {
      await self.client.takeTransferMetadata(sinkID: sinkId).map(BotaAppleMapper.transferMetadata)
    }
  }

  func confirmRecording(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    recordingId: String
  ) async throws {
    try await perform(operationId) {
      try await self.client.confirmRecording(
        try self.device(device),
        recordingUUID: recordingId
      )
    }
  }

  func cancelRecordingOperation(operationId: String) async throws {
    try await perform(operationId) { try await self.client.cancelRecordingOperation() }
  }

  func cancelOtaOperation(operationId: String) async throws {
    try await perform(operationId) { try await self.client.cancelOtaOperation() }
  }

  func stopLogs(operationId: String) async throws {
    try await perform(operationId) { try await self.client.stopLogs() }
  }

  func configureWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage,
    credentials: BotaWifiCredentialsMessage,
    materialId: String
  ) async throws -> BotaWifiConfigResultMessage {
    try await perform(operationId) {
      BotaAppleMapper.wifiConfigResult(
        try await self.client.configureWifi(
          try self.device(device),
          ssid: credentials.ssid,
          password: credentials.password,
          grantBlob: materialId
        )
      )
    }
  }

  func disconnectWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiConfigResultMessage {
    try await perform(operationId) {
      BotaAppleMapper.wifiConfigResult(
        try await self.client.disconnectWifi(try self.device(device))
      )
    }
  }

  func readWifiStatus(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiStatusMessage {
    try await perform(operationId) {
      BotaAppleMapper.wifiStatus(
        try await self.client.readWifiStatus(try self.device(device))
      )
    }
  }

  func scanWifi(
    operationId: String,
    device: BotaDeviceReferenceMessage
  ) async throws -> BotaWifiScanResultMessage {
    try await perform(operationId) {
      BotaAppleMapper.wifiScan(try await self.client.scanWifi(try self.device(device)))
    }
  }

  func cancelWifiOperation(operationId: String) async throws {
    try await perform(operationId) { await self.client.cancelWifiOperation() }
  }

  func startSubscription(
    subscriptionId: String,
    request: BotaSubscriptionRequestMessage
  ) async throws {
    do {
      try reserveSubscription(subscriptionId)
      switch request {
      case let request as BotaScanSubscriptionMessage:
        let stream = try await client.scanStream(
          timeoutMilliseconds: BotaAppleMapper.uint64(request.timeoutMillis),
          allowDuplicates: request.allowDuplicates
        )
        install(subscriptionId, owner: .deviceOperation) {
          await self.consumeScan(subscriptionId, stream: stream)
        }
      case is BotaConnectionSubscriptionMessage:
        let stream = await client.connectionStream()
        install(subscriptionId, owner: .connection) {
          await self.consumeConnection(subscriptionId, stream: stream)
        }
      case is BotaDeviceStatusSubscriptionMessage:
        let stream = try await client.deviceStatusStream()
        install(subscriptionId, owner: .deviceStatus) {
          await self.consumeStatus(subscriptionId, stream: stream)
        }
      case let request as BotaRecordingStateSubscriptionMessage:
        let stream = try await client.recordingStateStream(try device(request.device))
        install(subscriptionId, owner: .recordingState) {
          await self.consumeRecordingState(subscriptionId, stream: stream)
        }
      case let request as BotaRecordingSyncSubscriptionMessage:
        let stream = try await client.recordingSyncStream(
          try device(request.device),
          recording: try BotaAppleMapper.recording(request.recording),
          sinkID: request.sinkId,
          confirmOnCompletion: request.confirmOnCompletion
        )
        install(subscriptionId, owner: .recordingOperation) {
          await self.consumeRecordingSync(subscriptionId, stream: stream)
        }
      case let request as BotaUploadOwnershipSubscriptionMessage:
        let stream = try await client.uploadOwnershipStream(
          try device(request.device),
          recordingUUID: request.recordingId,
          uploadID: request.uploadId,
          destinationID: request.destinationId
        )
        install(subscriptionId, owner: .recordingOperation) {
          await self.consumeUploadOwnership(subscriptionId, stream: stream)
        }
      case let request as BotaFirmwareUpdateSubscriptionMessage:
        try requireCallback(\.hasFirmwareCallback, name: "firmware")
        let stream = try await client.firmwareStream(
          try device(request.device),
          image: try await firmwareImage(request.image)
        )
        install(subscriptionId, owner: .ota) {
          await self.consumeFirmware(subscriptionId, stream: stream)
        }
      case let request as BotaLogSubscriptionMessage:
        let stream = try await client.logStream(try device(request.device))
        install(subscriptionId, owner: .logs) {
          await self.consumeLogs(subscriptionId, stream: stream)
        }
      case let request as BotaWifiStatusSubscriptionMessage:
        let stream = try await client.wifiStatusStream(try device(request.device))
        install(subscriptionId, owner: .wifi) {
          await self.consumeWifi(subscriptionId, stream: stream)
        }
      default:
        throw bridgeError("unsupported_subscription", "subscription kind is not supported")
      }
    } catch {
      startingSubscriptionIDs.remove(subscriptionId)
      consumedSubscriptionIDs.insert(subscriptionId)
      throw BotaAppleMapper.pigeonError(error)
    }
  }

  func cancelSubscription(subscriptionId: String) async throws {
    do {
      try validateID(subscriptionId)
      guard let subscription = subscriptions.removeValue(forKey: subscriptionId) else {
        throw bridgeError("subscription_not_found", "subscription is not active")
      }
      consumedSubscriptionIDs.insert(subscriptionId)
      subscription.task.cancel()
      try await stop(subscription.owner)
    } catch {
      throw BotaAppleMapper.pigeonError(error)
    }
  }

  func detach() async {
    guard !detached else { return }
    detached = true
    await cancelAllSubscriptions()
    connectedDevices.removeAll()
    discoveredDevices.removeAll()
    currentDeviceID = nil
    resetGenerations.removeAll()
    resetCommands.removeAll()
    configuration = nil
    await leaseCoordinator.release(engineID: engineID)
  }

  private func perform<T>(
    _ operationID: String,
    _ body: () async throws -> T
  ) async throws -> T {
    do {
      try beginOperation(operationID, requiresConfiguration: true)
      defer { finishOperation(operationID) }
      return try await body()
    } catch {
      throw BotaAppleMapper.pigeonError(error)
    }
  }

  private func beginOperation(_ id: String, requiresConfiguration: Bool) throws {
    try validateID(id)
    guard !activeOperationIDs.contains(id), !consumedOperationIDs.contains(id) else {
      throw BotaAppleMapper.pigeonError(
        bridgeError("duplicate_operation_id", "operation ID was reused"))
    }
    if requiresConfiguration, configuration == nil {
      throw BotaAppleMapper.pigeonError(bridgeError("not_configured", "adapter is not configured"))
    }
    guard !detached else {
      throw BotaAppleMapper.pigeonError(bridgeError("engine_detached", "engine is detached"))
    }
    activeOperationIDs.insert(id)
  }

  private func finishOperation(_ id: String) {
    activeOperationIDs.remove(id)
    consumedOperationIDs.insert(id)
  }

  private func validateID(_ id: String) throws {
    guard id.utf8.count == 32,
      id.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) })
    else {
      throw bridgeError("invalid_operation_id", "ID must be 32 lowercase hexadecimal characters")
    }
  }

  private func reserveSubscription(_ id: String) throws {
    try validateID(id)
    guard configuration != nil else {
      throw bridgeError("not_configured", "adapter is not configured")
    }
    guard !detached else { throw bridgeError("engine_detached", "engine is detached") }
    guard subscriptions[id] == nil,
      !startingSubscriptionIDs.contains(id),
      !consumedSubscriptionIDs.contains(id)
    else { throw bridgeError("duplicate_subscription_id", "subscription ID was reused") }
    startingSubscriptionIDs.insert(id)
  }

  private func install(
    _ id: String,
    owner: SubscriptionOwner,
    consume: @escaping @Sendable () async -> Void
  ) {
    let task = Task { await consume() }
    subscriptions[id] = Subscription(owner: owner, task: task)
    startingSubscriptionIDs.remove(id)
  }

  private func completeSubscription(_ id: String) async {
    guard subscriptions.removeValue(forKey: id) != nil else { return }
    consumedSubscriptionIDs.insert(id)
    await emit(id, BotaSubscriptionCompleteEventMessage())
  }

  private func failSubscription(_ id: String, error: Error) async {
    guard subscriptions[id] != nil else { return }
    await emit(id, BotaSubscriptionErrorEventMessage(error: BotaAppleMapper.error(error)))
    await completeSubscription(id)
  }

  private func emit(_ id: String, _ payload: BotaEventPayloadMessage) async {
    try? await flutterApi.onEvent(event: BotaEventMessage(subscriptionId: id, payload: payload))
  }

  private func consumeScan(
    _ id: String,
    stream: AsyncThrowingStream<DiscoveredDevice, Error>
  ) async {
    do {
      for try await value in stream {
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
      do {
        if let value {
          store(value)
        } else {
          connectedDevices.removeAll()
          currentDeviceID = nil
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
      for try await value in stream { await emit(id, try map(value)) }
      await completeSubscription(id)
    } catch is CancellationError {
    } catch { await failSubscription(id, error: error) }
  }

  private func cancelAllSubscriptions() async {
    let active = subscriptions
    subscriptions.removeAll()
    startingSubscriptionIDs.removeAll()
    for (id, subscription) in active {
      consumedSubscriptionIDs.insert(id)
      subscription.task.cancel()
      try? await stop(subscription.owner)
    }
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

  private func store(_ device: ConnectedDevice) {
    connectedDevices[device.id] = device
    currentDeviceID = device.id
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
      ))
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
      ))
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
      ))
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

  func requestUploadDestination(
    destinationID: String,
    recordingID: String,
    uploadID: String
  ) async throws -> URLRequest {
    try requireCallback(\.hasUploadDestinationCallback, name: "upload destination")
    let id = callbackID()
    let response = try await requestUploadDestinationMessage(
      BotaUploadDestinationRequestMessage(
        requestId: id,
        destinationId: destinationID,
        recordingId: recordingID,
        uploadId: uploadID
      ))
    guard response.requestId == id else { throw callbackIDMismatch() }
    guard let url = URL(string: response.url), url.scheme != nil else {
      throw bridgeError("invalid_callback_response", "upload URL is invalid")
    }
    var request = URLRequest(url: url)
    switch response.method {
    case .get: request.httpMethod = "GET"
    case .put: request.httpMethod = "PUT"
    case .post: request.httpMethod = "POST"
    }
    for (name, value) in response.headers { request.setValue(value, forHTTPHeaderField: name) }
    return request
  }

  private func persistReset(
    commandID: String,
    bindingGeneration: UInt64,
    result: FactoryResetPersistenceResult
  ) async throws {
    let id = callbackID()
    let response = try await persistFactoryResetResult(
      BotaFactoryResetResultRequestMessage(
        requestId: id,
        commandId: commandID,
        bindingGeneration: try BotaAppleMapper.int64(bindingGeneration),
        localRecordingsDeleted: Int64(result.localRecordingsDeleted)
      ))
    guard response.requestId == id else { throw callbackIDMismatch() }
  }

  private func requestMaterial(
    _ request: BotaMaterialRequestMessage
  ) async throws -> BotaMaterialResponseMessage {
    try await withCheckedThrowingContinuation { continuation in
      flutterApi.requestMaterial(request: request) { result in
        continuation.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func requestFirmware(_ request: BotaFirmwareRequestMessage) async throws
    -> BotaFirmwareSourceMessage
  {
    try await withCheckedThrowingContinuation { continuation in
      flutterApi.requestFirmware(request: request) { result in
        continuation.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func requestUploadDestinationMessage(
    _ request: BotaUploadDestinationRequestMessage
  ) async throws -> BotaUploadDestinationMessage {
    try await withCheckedThrowingContinuation { continuation in
      flutterApi.requestUploadDestination(request: request) { result in
        continuation.resume(with: result.mapError { $0 as Error })
      }
    }
  }

  private func persistFactoryResetResult(
    _ request: BotaFactoryResetResultRequestMessage
  ) async throws -> BotaFactoryResetResultAcknowledgementMessage {
    try await withCheckedThrowingContinuation { continuation in
      flutterApi.persistFactoryResetResult(request: request) { result in
        continuation.resume(with: result.mapError { $0 as Error })
      }
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
