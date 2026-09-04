import BotaAppleSDK
import Foundation

extension BotaErrorMessage: @unchecked Sendable {}

enum BotaAppleMapper {
  static func discoveredDevice(_ value: DiscoveredDevice) throws -> BotaDiscoveredDeviceMessage {
    BotaDiscoveredDeviceMessage(
      id: value.id,
      name: value.name,
      deviceType: try value.deviceType.map(deviceType),
      firmwareVersion: value.firmwareVersion,
      macAddress: value.macAddress,
      pairingState: try value.pairingState.map(pairingState),
      rssi: Int64(value.rssi),
      discoveredAtMillis: try milliseconds(value.discoveredAt)
    )
  }

  static func discoveredDevice(_ value: BotaDiscoveredDeviceMessage) throws -> DiscoveredDevice {
    DiscoveredDevice(
      id: value.id,
      name: value.name,
      deviceType: try value.deviceType.map(deviceType),
      firmwareVersion: value.firmwareVersion,
      macAddress: value.macAddress,
      pairingState: try value.pairingState.map(pairingState),
      rssi: try int(value.rssi),
      discoveredAt: Date(timeIntervalSince1970: TimeInterval(value.discoveredAtMillis) / 1_000)
    )
  }

  static func connectedDevice(_ value: ConnectedDevice) throws -> BotaConnectedDeviceMessage {
    BotaConnectedDeviceMessage(
      id: value.id,
      serialNumber: value.serialNumber,
      deviceType: try deviceType(value.deviceType),
      firmwareVersion: value.firmwareVersion,
      hardwareRevision: value.hardwareRevision,
      isProvisioned: value.isProvisioned,
      connectionState: connectionState(value.connectionState),
      mtu: Int64(value.mtu)
    )
  }

  static func reconnectHint(_ value: BotaReconnectHintMessage) throws -> DeviceReconnectHint {
    DeviceReconnectHint(
      storedPeripheralID: value.storedPeripheralId,
      advertisedAddress: value.advertisedAddress,
      storedName: value.storedName,
      scanTimeoutMilliseconds: try uint64(value.scanTimeoutMillis),
      connectionTimeoutMilliseconds: try uint64(value.connectionTimeoutMillis)
    )
  }

  static func deviceStatus(_ value: DeviceStatus) throws -> BotaDeviceStatusMessage {
    BotaDeviceStatusMessage(
      batteryLevel: Int64(value.batteryLevel),
      batteryMillivolts: value.batteryMv.map(Int64.init),
      storageTotalMegabytes: Int64(value.storageTotalMb),
      storageUsedMegabytes: Int64(value.storageUsedMb),
      state: try deviceState(value.state),
      pendingRecordings: Int64(value.pendingRecordings),
      lastTimeSyncAtMillis: try value.lastTimeSyncAt.map(milliseconds),
      signalStrength: Int64(value.signalStrength),
      flags: deviceFlags(value.flags),
      timestamp: Int64(value.timestamp),
      lteState: try lteState(value.lteStatus),
      lteSignalQuality: value.lteSignalQuality.map(Int64.init),
      wifiState: try value.wifiStatus.map(wifiRadioState),
      modemInfo: value.modemInfo.map(modemInfo)
    )
  }

  static func connectionSettings(
    _ value: DeviceConnectionSettings
  ) throws -> BotaConnectionSettingsMessage {
    BotaConnectionSettingsMessage(
      enabledConnections: enabledConnections(value.enabledConnections),
      heartbeatEnabledConnections: enabledConnections(value.heartbeatEnabledConnections),
      heartbeatUnknownMask: Int64(value.heartbeatUnknownMask),
      uploadNetworkPreference: value.uploadNetworkPreference.map(connectionType),
      powerManagement: BotaPowerManagementMessage(
        wifiIdleTimeoutMillis: try milliseconds(
          seconds: value.powerManagement.wifiIdleTimeoutSeconds
        ),
        cellularIdleTimeoutMillis: try milliseconds(
          seconds: value.powerManagement.cellularIdleTimeoutSeconds
        )
      ),
      streamingEnabled: value.streamingEnabled,
      streamingFlushIntervalMillis: try milliseconds(
        seconds: value.streamingFlushIntervalSeconds
      )
    )
  }

  static func connectionSettings(
    _ value: BotaConnectionSettingsMessage
  ) throws -> DeviceConnectionSettings {
    DeviceConnectionSettings(
      enabledConnections: enabledConnections(value.enabledConnections),
      heartbeatEnabledConnections: enabledConnections(value.heartbeatEnabledConnections),
      heartbeatUnknownMask: try uint8(value.heartbeatUnknownMask),
      uploadNetworkPreference: try value.uploadNetworkPreference.map(connectionType),
      powerManagement: .init(
        wifiIdleTimeoutSeconds: try timeoutSeconds(
          value.powerManagement.wifiIdleTimeoutMillis
        ),
        cellularIdleTimeoutSeconds: try timeoutSeconds(
          value.powerManagement.cellularIdleTimeoutMillis
        )
      ),
      streamingEnabled: value.streamingEnabled,
      streamingFlushIntervalSeconds: try durationSeconds(value.streamingFlushIntervalMillis)
    )
  }

  static func recording(_ value: DeviceRecording) throws -> BotaDeviceRecordingMessage {
    BotaDeviceRecordingMessage(
      recordingId: value.uuid,
      startedAtMillis: try milliseconds(value.startedAt),
      durationMillis: try int64(value.durationMs),
      fileSizeBytes: try int64(value.fileSizeBytes),
      codec: try audioCodec(value.codec),
      isEncrypted: value.isEncrypted
    )
  }

  static func recording(_ value: BotaDeviceRecordingMessage) throws -> DeviceRecording {
    DeviceRecording(
      uuid: value.recordingId,
      startedAt: Date(timeIntervalSince1970: TimeInterval(value.startedAtMillis) / 1_000),
      durationMs: try uint64(value.durationMillis),
      fileSizeBytes: try uint64(value.fileSizeBytes),
      codec: try audioCodec(value.codec),
      isEncrypted: value.isEncrypted
    )
  }

  static func recordingState(_ value: RecordingState) -> BotaRecordingStateMessage {
    BotaRecordingStateMessage(
      active: value.active,
      recordingId: value.recordingID,
      initiatedBy: BotaRecordingInitiatorMessage(
        name: value.initiatedBy == .local ? "local" : "remote"
      )
    )
  }

  static func recordingProgress(
    _ value: RecordingTransferProgress
  ) throws -> BotaRecordingTransferProgressMessage {
    BotaRecordingTransferProgressMessage(
      completedBytes: try int64(value.completedBytes),
      totalBytes: try int64(value.totalBytes)
    )
  }

  static func transferMetadata(
    _ value: RecordingTransferMetadata
  ) -> BotaRecordingTransferMetadataMessage {
    BotaRecordingTransferMetadataMessage(
      isE2EEncrypted: value.isE2EEncrypted,
      contentSha256Hex: value.contentSHA256Hex
    )
  }

  static func uploadOwnership(_ value: UploadOwnershipResult) -> BotaUploadOwnershipResultMessage {
    switch value {
    case .deviceUploadCompleted:
      return BotaUploadOwnershipResultMessage(kind: .deviceUploadCompleted)
    case .deviceUploadPreserved(let uploadID):
      return BotaUploadOwnershipResultMessage(
        kind: .deviceUploadPreserved,
        uploadId: uploadID
      )
    case .bluetoothFallback(let recordingUUID, let uploadID, let destinationID):
      return BotaUploadOwnershipResultMessage(
        kind: .bluetoothFallback,
        recordingId: recordingUUID,
        uploadId: uploadID,
        destinationId: destinationID
      )
    }
  }

  static func firmwareProgress(_ value: FirmwareUpdateProgress) throws
    -> BotaFirmwareProgressMessage
  {
    BotaFirmwareProgressMessage(
      phase: firmwarePhase(value.phase),
      completedBytes: try int64(value.completedBytes),
      totalBytes: try int64(value.totalBytes)
    )
  }

  static func logLine(_ value: DeviceLogLine) -> BotaDeviceLogLineMessage {
    BotaDeviceLogLineMessage(message: value.message, isBacklog: value.isBacklog)
  }

  static func wifiConfigResult(_ value: WiFiConfigResult) -> BotaWifiConfigResultMessage {
    switch value {
    case .success: return .init(name: "success")
    case .invalidGrant: return .init(name: "invalidGrant")
    case .grantExpired: return .init(name: "grantExpired")
    case .decryptionError: return .init(name: "decryptionError")
    case .storageError: return .init(name: "storageError")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  static func wifiStatus(_ value: WiFiStatusInfo) -> BotaWifiStatusMessage {
    BotaWifiStatusMessage(
      state: wifiState(value.status),
      signalStrength: value.signalStrength.map(Int64.init),
      ssid: value.ssid,
      lastError: value.lastError
    )
  }

  static func wifiScan(_ value: DeviceWiFiScanResult) -> BotaWifiScanResultMessage {
    BotaWifiScanResultMessage(
      networks: value.networks.map {
        BotaWifiNetworkMessage(
          ssid: $0.ssid,
          quality: Int64($0.quality),
          isCurrent: $0.isCurrent,
          isOpen: $0.isOpen
        )
      },
      currentSsid: value.currentSSID
    )
  }

  static func deprovisionResult(_ value: DeprovisionResult) -> BotaDeprovisionResultMessage {
    BotaDeprovisionResultMessage(
      success: value.success,
      error: value.error.map(provisioningFailure)
    )
  }

  static func factoryResetCompletion(
    _ value: FactoryResetCompletion
  ) throws -> BotaFactoryResetCompletionMessage {
    BotaFactoryResetCompletionMessage(
      commandId: value.commandID,
      bindingGeneration: try int64(value.bindingGeneration)
    )
  }

  static func deviceType(_ value: DeviceType) throws -> BotaDeviceTypeMessage {
    switch value {
    case .botaPin: return .init(name: "botaPin")
    case .botaPin4G: return .init(name: "botaPin4G")
    case .botaNote: return .init(name: "botaNote")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  static func deviceType(_ value: BotaDeviceTypeMessage) throws -> DeviceType {
    switch value.name {
    case "botaPin": return .botaPin
    case "botaPin4G": return .botaPin4G
    case "botaNote": return .botaNote
    default: return .unknown(try uint8(requiredRaw(value.rawValue)))
    }
  }

  static func error(_ value: Error) -> BotaErrorMessage {
    if let bridge = value as? BotaBridgeError {
      return BotaErrorMessage(
        code: .init(name: bridge.errorName),
        operation: .init(name: bridge.operation),
        retryable: false,
        detail: bridge.detail
      )
    }
    guard let native = value as? BotaSDKError else {
      return BotaErrorMessage(
        code: .init(name: "internal"),
        operation: .init(name: "unknown"),
        retryable: false,
        detail: "native operation failed"
      )
    }
    return BotaErrorMessage(
      code: errorCode(native.code),
      operation: operation(native.operation),
      retryable: native.retryable,
      protocolStatus: native.protocolStatus.map(Int64.init),
      detail: native.detail
    )
  }

  static func pigeonError(_ value: Error) -> PigeonError {
    if let pigeon = value as? PigeonError { return pigeon }
    if let bridge = value as? BotaBridgeError {
      return PigeonError(code: bridge.code, message: nil, details: error(bridge))
    }
    return PigeonError(code: "bota_sdk_error", message: nil, details: error(value))
  }

  private static func pairingState(_ value: PairingState) throws -> BotaPairingStateMessage {
    switch value {
    case .unpaired: return .init(name: "unpaired")
    case .pairing: return .init(name: "pairing")
    case .paired: return .init(name: "paired")
    case .error: return .init(name: "error")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  private static func pairingState(_ value: BotaPairingStateMessage) throws -> PairingState {
    switch value.name {
    case "unpaired": return .unpaired
    case "pairing": return .pairing
    case "paired": return .paired
    case "error": return .error
    default: return .unknown(try uint8(requiredRaw(value.rawValue)))
    }
  }

  private static func connectionState(_ value: ConnectionState) -> BotaConnectionStateMessage {
    switch value {
    case .disconnected: return .disconnected
    case .connecting: return .connecting
    case .bonding: return .bonding
    case .discovering: return .discovering
    case .connected: return .connected
    case .disconnecting: return .disconnecting
    }
  }

  private static func deviceState(_ value: WireValue<DeviceState>) throws
    -> BotaDeviceStateValueMessage
  {
    switch value {
    case .unknown(let raw): return .init(name: "unknown", rawValue: try int64(raw))
    case .known(let state):
      switch state {
      case .idle: return .init(name: "idle")
      case .recording: return .init(name: "recording")
      case .syncing: return .init(name: "syncing")
      case .uploading: return .init(name: "uploading")
      case .charging: return .init(name: "charging")
      case .lowBattery: return .init(name: "lowBattery")
      case .storageFull: return .init(name: "storageFull")
      case .error: return .init(name: "error")
      }
    }
  }

  private static func lteState(_ value: WireValue<LteStatus>) throws -> BotaLteStateMessage {
    switch value {
    case .unknown(let raw): return .init(name: "unknown", rawValue: try int64(raw))
    case .known(let state):
      switch state {
      case .off: return .init(name: "off")
      case .searching: return .init(name: "searching")
      case .registered: return .init(name: "registered")
      case .connected: return .init(name: "connected")
      case .denied: return .init(name: "denied")
      case .noSim: return .init(name: "noSim")
      case .error: return .init(name: "error")
      case .lowVoltage: return .init(name: "lowVoltage")
      case .disabled: return .init(name: "disabled")
      }
    }
  }

  private static func wifiRadioState(
    _ value: WireValue<WifiRadioStatus>
  ) throws -> BotaWifiRadioStateMessage {
    switch value {
    case .unknown(let raw): return .init(name: "unknown", rawValue: try int64(raw))
    case .known(let state):
      switch state {
      case .off: return .init(name: "off")
      case .scanning: return .init(name: "scanning")
      case .connecting: return .init(name: "connecting")
      case .connected: return .init(name: "connected")
      case .connectFailed: return .init(name: "connectFailed")
      case .noCredentials: return .init(name: "noCredentials")
      case .disabled: return .init(name: "disabled")
      case .error: return .init(name: "error")
      }
    }
  }

  private static func connectionType(_ value: ConnectionType) -> BotaConnectionTypeMessage {
    switch value {
    case .wifi: return .init(name: "wifi")
    case .ble: return .init(name: "ble")
    case .cellular: return .init(name: "cellular")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  private static func connectionType(_ value: BotaConnectionTypeMessage) throws -> ConnectionType {
    switch value.name {
    case "wifi": return .wifi
    case "ble": return .ble
    case "cellular": return .cellular
    default: return .unknown(try uint8(requiredRaw(value.rawValue)))
    }
  }

  private static func audioCodec(_ value: WireValue<AudioCodec>) throws -> BotaAudioCodecMessage {
    switch value {
    case .unknown(let raw): return .init(name: "unknown", rawValue: try int64(raw))
    case .known(let codec):
      switch codec {
      case .pcm16k: return .init(name: "pcm16k")
      case .pcm8k: return .init(name: "pcm8k")
      case .opus16k: return .init(name: "opus16k")
      case .opus8k: return .init(name: "opus8k")
      }
    }
  }

  private static func audioCodec(_ value: BotaAudioCodecMessage) throws -> WireValue<AudioCodec> {
    switch value.name {
    case "pcm16k": return .known(.pcm16k)
    case "pcm8k": return .known(.pcm8k)
    case "opus16k": return .known(.opus16k)
    case "opus8k": return .known(.opus8k)
    default: return .unknown(try uint64(requiredRaw(value.rawValue)))
    }
  }

  private static func firmwarePhase(_ value: FirmwareUpdatePhase) -> BotaFirmwarePhaseMessage {
    switch value {
    case .downloading: return .init(name: "downloading")
    case .awaitingDevice: return .init(name: "awaitingDevice")
    case .transferring: return .init(name: "transferring")
    case .verifying: return .init(name: "verifying")
    case .rebooting: return .init(name: "rebooting")
    case .reconnecting: return .init(name: "reconnecting")
    case .complete: return .init(name: "complete")
    }
  }

  private static func wifiState(_ value: WiFiConnectionStatus) -> BotaWifiStateMessage {
    switch value {
    case .idle: return .init(name: "idle")
    case .connecting: return .init(name: "connecting")
    case .connected: return .init(name: "connected")
    case .failed: return .init(name: "failed")
    case .disconnected: return .init(name: "disconnected")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  private static func provisioningFailure(_ value: ProvisioningFailure)
    -> BotaProvisioningFailureMessage
  {
    switch value {
    case .invalidToken: return .init(name: "invalidToken")
    case .storageError: return .init(name: "storageError")
    case .chunkError: return .init(name: "chunkError")
    case .alreadyPaired: return .init(name: "alreadyPaired")
    case .unknown: return .init(name: "unknown", rawValue: 0)
    }
  }

  private static func deviceFlags(_ value: DeviceFlags) -> BotaDeviceFlagsMessage {
    BotaDeviceFlagsMessage(
      charging: value.charging,
      lowBattery: value.lowBattery,
      storageFull: value.storageFull,
      wifiConnected: value.wifiConnected,
      lteConnected: value.lteConnected,
      syncActive: value.syncActive
    )
  }

  private static func modemInfo(_ value: ModemInfo) -> BotaModemInfoMessage {
    BotaModemInfoMessage(
      imei: value.imei,
      iccid: value.iccid,
      operatorName: value.operator,
      rat: value.rat,
      band: value.band,
      apn: value.apn,
      simStatus: value.simStatus,
      csq: value.csq.map(Int64.init),
      ipAddress: value.ipAddress,
      modemVoltage: value.modemVoltage.map(Int64.init),
      modemFirmware: value.modemFirmware,
      roaming: value.roaming
    )
  }

  private static func enabledConnections(
    _ value: DeviceConnectionSettings.EnabledConnections
  ) -> BotaEnabledConnectionsMessage {
    BotaEnabledConnectionsMessage(wifi: value.wifi, cellular: value.cellular)
  }

  private static func enabledConnections(
    _ value: BotaEnabledConnectionsMessage
  ) -> DeviceConnectionSettings.EnabledConnections {
    .init(wifi: value.wifi, cellular: value.cellular)
  }

  private static func errorCode(_ value: BotaSDKErrorCode) -> BotaErrorCodeMessage {
    switch value {
    case .invalidInput: return .init(name: "invalidInput")
    case .truncatedPacket: return .init(name: "truncatedPacket")
    case .unknownPacket: return .init(name: "unknownPacket")
    case .payloadTooLarge: return .init(name: "payloadTooLarge")
    case .unsupportedCapability: return .init(name: "unsupportedCapability")
    case .unsupportedOperation: return .init(name: "unsupportedOperation")
    case .featureUnavailable: return .init(name: "featureUnavailable")
    case .operationInProgress: return .init(name: "operationInProgress")
    case .unexpectedEvent: return .init(name: "unexpectedEvent")
    case .deviceNotFound: return .init(name: "deviceNotFound")
    case .identityMismatch: return .init(name: "identityMismatch")
    case .connectionFailed: return .init(name: "connectionFailed")
    case .persistenceFailed: return .init(name: "persistenceFailed")
    case .notConnected: return .init(name: "notConnected")
    case .timeout: return .init(name: "timeout")
    case .cancelled: return .init(name: "cancelled")
    case .protocolRejected: return .init(name: "protocolRejected")
    case .integrityFailed: return .init(name: "integrityFailed")
    case .uploadOwnershipUnknown: return .init(name: "uploadOwnershipUnknown")
    case .downloadFailed: return .init(name: "downloadFailed")
    case .internal: return .init(name: "internal")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  private static func operation(_ value: BotaOperation) -> BotaOperationMessage {
    switch value {
    case .validate: return .init(name: "validate")
    case .decode: return .init(name: "decode")
    case .encode: return .init(name: "encode")
    case .discover: return .init(name: "discover")
    case .connect: return .init(name: "connect")
    case .reconnect: return .init(name: "reconnect")
    case .readStatus: return .init(name: "readStatus")
    case .provision: return .init(name: "provision")
    case .transferRecording: return .init(name: "transferRecording")
    case .upload: return .init(name: "upload")
    case .updateFirmware: return .init(name: "updateFirmware")
    case .readDeviceLogs: return .init(name: "readDeviceLogs")
    case .factoryReset: return .init(name: "factoryReset")
    case .unknown(let raw): return .init(name: "unknown", rawValue: Int64(raw))
    }
  }

  private static func milliseconds(_ value: Date) throws -> Int64 {
    let milliseconds = value.timeIntervalSince1970 * 1_000
    guard milliseconds.isFinite,
      milliseconds >= Double(Int64.min),
      milliseconds <= Double(Int64.max)
    else { throw payloadError("date is outside the supported range") }
    return Int64(milliseconds.rounded(.towardZero))
  }

  private static func timeoutSeconds(_ milliseconds: Int64) throws -> Int {
    guard milliseconds >= -1_000, milliseconds.isMultiple(of: 1_000) else {
      throw inputError("timeout must be -1000 or a non-negative whole number of seconds")
    }
    return try int(milliseconds / 1_000)
  }

  private static func durationSeconds(_ milliseconds: Int64) throws -> Int {
    guard milliseconds >= 0, milliseconds.isMultiple(of: 1_000) else {
      throw inputError("millisecond duration must be a non-negative whole number of seconds")
    }
    return try int(milliseconds / 1_000)
  }

  private static func milliseconds(seconds: Int) throws -> Int64 {
    let (value, overflow) = Int64(seconds).multipliedReportingOverflow(by: 1_000)
    guard !overflow else { throw payloadError("seconds value exceeds the millisecond range") }
    return value
  }

  private static func requiredRaw(_ value: Int64?) throws -> Int64 {
    guard let value else { throw inputError("unknown enum value requires rawValue") }
    return value
  }

  static func int64(_ value: UInt64) throws -> Int64 {
    guard value <= UInt64(Int64.max) else { throw payloadError("value exceeds Int64.max") }
    return Int64(value)
  }

  static func uint64(_ value: Int64) throws -> UInt64 {
    guard value >= 0 else { throw inputError("value must be non-negative") }
    return UInt64(value)
  }

  static func uint32(_ value: Int64) throws -> UInt32 {
    guard value >= 0, value <= Int64(UInt32.max) else {
      throw inputError("value is outside the UInt32 range")
    }
    return UInt32(value)
  }

  static func uint16(_ value: Int64) throws -> UInt16 {
    guard value >= 0, value <= Int64(UInt16.max) else {
      throw inputError("value is outside the UInt16 range")
    }
    return UInt16(value)
  }

  static func uint8(_ value: Int64) throws -> UInt8 {
    guard value >= 0, value <= Int64(UInt8.max) else {
      throw inputError("value is outside the UInt8 range")
    }
    return UInt8(value)
  }

  private static func int(_ value: Int64) throws -> Int {
    guard let converted = Int(exactly: value) else { throw payloadError("value exceeds Int range") }
    return converted
  }

  private static func inputError(_ detail: String) -> BotaSDKError {
    BotaSDKError(
      code: .invalidInput,
      operation: .validate,
      retryable: false,
      detail: detail
    )
  }

  private static func payloadError(_ detail: String) -> BotaSDKError {
    BotaSDKError(
      code: .payloadTooLarge,
      operation: .encode,
      retryable: false,
      detail: detail
    )
  }
}

struct BotaBridgeError: Error, Sendable {
  let code: String
  let errorName: String
  let operation: String
  let detail: String

  init(
    code: String,
    errorName: String = "invalidInput",
    operation: String = "validate",
    detail: String
  ) {
    self.code = code
    self.errorName = errorName
    self.operation = operation
    self.detail = detail
  }
}
