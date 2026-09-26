import 'package:pigeon/pigeon.dart';

const String botaBridgeIdPattern = r'^[0-9a-f]{32}$';

enum BotaConnectionStateMessage {
  disconnected,
  connecting,
  bonding,
  discovering,
  connected,
  disconnecting,
}

enum BotaUploadOwnershipResultKindMessage {
  deviceUploadCompleted,
  deviceUploadPreserved,
  bluetoothFallback,
}

class BotaDeviceTypeMessage {
  BotaDeviceTypeMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaPairingStateMessage {
  BotaPairingStateMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaDeviceStateValueMessage {
  BotaDeviceStateValueMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaLteStateMessage {
  BotaLteStateMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaWifiRadioStateMessage {
  BotaWifiRadioStateMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaConnectionTypeMessage {
  BotaConnectionTypeMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaAudioCodecMessage {
  BotaAudioCodecMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaRecordingInitiatorMessage {
  BotaRecordingInitiatorMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaFirmwarePhaseMessage {
  BotaFirmwarePhaseMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaWifiConfigResultMessage {
  BotaWifiConfigResultMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaWifiStateMessage {
  BotaWifiStateMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaProvisioningFailureMessage {
  BotaProvisioningFailureMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaErrorCodeMessage {
  BotaErrorCodeMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaOperationMessage {
  BotaOperationMessage({required this.name, this.rawValue});
  String name;
  int? rawValue;
}

class BotaConfigurationMessage {
  BotaConfigurationMessage({
    required this.applicationSupportNamespace,
    required this.hasProvisioningMaterialCallback,
    required this.hasFactoryResetGrantCallback,
    required this.hasFactoryResetResultCallback,
    required this.hasFirmwareCallback,
  });

  String applicationSupportNamespace;
  bool hasProvisioningMaterialCallback;
  bool hasFactoryResetGrantCallback;
  bool hasFactoryResetResultCallback;
  bool hasFirmwareCallback;
}

class BotaDeviceReferenceMessage {
  BotaDeviceReferenceMessage({required this.id});

  String id;
}

class BotaDiscoveredDeviceMessage {
  BotaDiscoveredDeviceMessage({
    required this.id,
    this.name,
    this.deviceType,
    this.firmwareVersion,
    this.macAddress,
    this.pairingState,
    required this.rssi,
    required this.discoveredAtMillis,
  });

  String id;
  String? name;
  BotaDeviceTypeMessage? deviceType;
  String? firmwareVersion;
  String? macAddress;
  BotaPairingStateMessage? pairingState;
  int rssi;
  int discoveredAtMillis;
}

class BotaConnectedDeviceMessage {
  BotaConnectedDeviceMessage({
    required this.id,
    required this.serialNumber,
    required this.deviceType,
    required this.firmwareVersion,
    this.hardwareRevision,
    required this.isProvisioned,
    required this.connectionState,
    required this.mtu,
  });

  String id;
  String serialNumber;
  BotaDeviceTypeMessage deviceType;
  String firmwareVersion;
  String? hardwareRevision;
  bool isProvisioned;
  BotaConnectionStateMessage connectionState;
  int mtu;
}

class BotaReconnectHintMessage {
  BotaReconnectHintMessage({
    this.storedPeripheralId,
    this.advertisedAddress,
    this.storedName,
    required this.scanTimeoutMillis,
    required this.connectionTimeoutMillis,
  });

  String? storedPeripheralId;
  String? advertisedAddress;
  String? storedName;
  int scanTimeoutMillis;
  int connectionTimeoutMillis;
}

class BotaDeviceFlagsMessage {
  BotaDeviceFlagsMessage({
    required this.charging,
    required this.lowBattery,
    required this.storageFull,
    required this.wifiConnected,
    required this.lteConnected,
    required this.syncActive,
  });

  bool charging;
  bool lowBattery;
  bool storageFull;
  bool wifiConnected;
  bool lteConnected;
  bool syncActive;
}

class BotaModemInfoMessage {
  BotaModemInfoMessage({
    this.imei,
    this.iccid,
    this.operatorName,
    this.rat,
    this.band,
    this.apn,
    this.simStatus,
    this.csq,
    this.ipAddress,
    this.modemVoltage,
    this.modemFirmware,
    this.roaming,
  });

  String? imei;
  String? iccid;
  String? operatorName;
  String? rat;
  String? band;
  String? apn;
  String? simStatus;
  int? csq;
  String? ipAddress;
  int? modemVoltage;
  String? modemFirmware;
  bool? roaming;
}

class BotaDeviceStatusMessage {
  BotaDeviceStatusMessage({
    required this.batteryLevel,
    this.batteryMillivolts,
    required this.storageTotalMegabytes,
    required this.storageUsedMegabytes,
    required this.state,
    required this.pendingRecordings,
    this.lastTimeSyncAtMillis,
    required this.signalStrength,
    required this.flags,
    required this.timestamp,
    required this.lteState,
    this.lteSignalQuality,
    this.wifiState,
    this.modemInfo,
  });

  int batteryLevel;
  int? batteryMillivolts;
  int storageTotalMegabytes;
  int storageUsedMegabytes;
  BotaDeviceStateValueMessage state;
  int pendingRecordings;
  int? lastTimeSyncAtMillis;
  int signalStrength;
  BotaDeviceFlagsMessage flags;
  int timestamp;
  BotaLteStateMessage lteState;
  int? lteSignalQuality;
  BotaWifiRadioStateMessage? wifiState;
  BotaModemInfoMessage? modemInfo;
}

class BotaEnabledConnectionsMessage {
  BotaEnabledConnectionsMessage({required this.wifi, required this.cellular});

  bool wifi;
  bool cellular;
}

class BotaPowerManagementMessage {
  BotaPowerManagementMessage({
    required this.wifiIdleTimeoutMillis,
    required this.cellularIdleTimeoutMillis,
  });

  int wifiIdleTimeoutMillis;
  int cellularIdleTimeoutMillis;
}

class BotaConnectionSettingsMessage {
  BotaConnectionSettingsMessage({
    required this.enabledConnections,
    required this.heartbeatEnabledConnections,
    required this.heartbeatUnknownMask,
    required this.uploadNetworkPreference,
    required this.powerManagement,
    required this.streamingEnabled,
    required this.streamingFlushIntervalMillis,
  });

  BotaEnabledConnectionsMessage enabledConnections;
  BotaEnabledConnectionsMessage heartbeatEnabledConnections;
  int heartbeatUnknownMask;
  List<BotaConnectionTypeMessage> uploadNetworkPreference;
  BotaPowerManagementMessage powerManagement;
  bool streamingEnabled;
  int streamingFlushIntervalMillis;
}

class BotaDeviceRecordingMessage {
  BotaDeviceRecordingMessage({
    required this.recordingId,
    required this.startedAtMillis,
    required this.durationMillis,
    required this.fileSizeBytes,
    required this.codec,
    required this.isEncrypted,
  });

  String recordingId;
  int startedAtMillis;
  int durationMillis;
  int fileSizeBytes;
  BotaAudioCodecMessage codec;
  bool isEncrypted;
}

class BotaRecordingStateMessage {
  BotaRecordingStateMessage({
    required this.active,
    this.recordingId,
    required this.initiatedBy,
  });

  bool active;
  String? recordingId;
  BotaRecordingInitiatorMessage initiatedBy;
}

class BotaRecordingTransferProgressMessage {
  BotaRecordingTransferProgressMessage({
    required this.completedBytes,
    required this.totalBytes,
  });

  int completedBytes;
  int totalBytes;
}

class BotaRecordingTransferMetadataMessage {
  BotaRecordingTransferMetadataMessage({
    required this.isE2EEncrypted,
    this.contentSha256Hex,
  });

  bool isE2EEncrypted;
  String? contentSha256Hex;
}

class BotaUploadOwnershipResultMessage {
  BotaUploadOwnershipResultMessage({
    required this.kind,
    this.recordingId,
    this.uploadId,
    this.destinationId,
  });

  BotaUploadOwnershipResultKindMessage kind;
  String? recordingId;
  String? uploadId;
  String? destinationId;
}

class BotaFirmwareImageMessage {
  BotaFirmwareImageMessage({
    required this.sourceId,
    required this.version,
    required this.sizeBytes,
    required this.crc32,
  });

  String sourceId;
  String version;
  int sizeBytes;
  int crc32;
}

class BotaFirmwareProgressMessage {
  BotaFirmwareProgressMessage({
    required this.phase,
    required this.completedBytes,
    required this.totalBytes,
  });

  BotaFirmwarePhaseMessage phase;
  int completedBytes;
  int totalBytes;
}

class BotaDeviceLogLineMessage {
  BotaDeviceLogLineMessage({required this.message, required this.isBacklog});

  String message;
  bool isBacklog;
}

class BotaWifiCredentialsMessage {
  BotaWifiCredentialsMessage({required this.ssid, required this.password});

  String ssid;
  String password;
}

class BotaWifiStatusMessage {
  BotaWifiStatusMessage({
    required this.state,
    this.signalStrength,
    this.ssid,
    this.lastError,
  });

  BotaWifiStateMessage state;
  int? signalStrength;
  String? ssid;
  String? lastError;
}

class BotaWifiNetworkMessage {
  BotaWifiNetworkMessage({
    required this.ssid,
    required this.quality,
    required this.isCurrent,
    required this.isOpen,
  });

  String ssid;
  int quality;
  bool isCurrent;
  bool isOpen;
}

class BotaWifiScanResultMessage {
  BotaWifiScanResultMessage({required this.networks, this.currentSsid});

  List<BotaWifiNetworkMessage> networks;
  String? currentSsid;
}

class BotaDeprovisionResultMessage {
  BotaDeprovisionResultMessage({required this.success, this.error});

  bool success;
  BotaProvisioningFailureMessage? error;
}

class BotaFactoryResetCommandMessage {
  BotaFactoryResetCommandMessage({
    required this.commandId,
    required this.bindingGeneration,
  });

  String commandId;
  int bindingGeneration;
}

class BotaFactoryResetCompletionMessage {
  BotaFactoryResetCompletionMessage({
    required this.commandId,
    required this.bindingGeneration,
  });

  String commandId;
  int bindingGeneration;
}

class BotaErrorMessage {
  BotaErrorMessage({
    required this.code,
    required this.operation,
    required this.retryable,
    this.protocolStatus,
    required this.detail,
  });

  BotaErrorCodeMessage code;
  BotaOperationMessage operation;
  bool retryable;
  int? protocolStatus;
  String detail;
}

sealed class BotaMaterialRequestMessage {}

class BotaProvisioningMaterialRequestMessage
    extends BotaMaterialRequestMessage {
  BotaProvisioningMaterialRequestMessage({
    required this.requestId,
    required this.serialNumber,
    required this.nonce,
    required this.devicePublicKey,
  });

  String requestId;
  String serialNumber;
  Uint8List nonce;
  Uint8List devicePublicKey;
}

class BotaFactoryResetGrantRequestMessage extends BotaMaterialRequestMessage {
  BotaFactoryResetGrantRequestMessage({
    required this.requestId,
    required this.serialNumber,
    required this.nonce,
    required this.commandId,
    required this.bindingGeneration,
  });

  String requestId;
  String serialNumber;
  Uint8List nonce;
  String commandId;
  int bindingGeneration;
}

sealed class BotaMaterialResponseMessage {}

class BotaProvisioningMaterialResponseMessage
    extends BotaMaterialResponseMessage {
  BotaProvisioningMaterialResponseMessage({
    required this.requestId,
    required this.apiEndpoint,
    required this.deviceToken,
    required this.mtu,
  });

  String requestId;
  Uint8List apiEndpoint;
  Uint8List deviceToken;
  int mtu;
}

class BotaFactoryResetGrantResponseMessage extends BotaMaterialResponseMessage {
  BotaFactoryResetGrantResponseMessage({
    required this.requestId,
    required this.encodedGrant,
  });

  String requestId;
  Uint8List encodedGrant;
}

class BotaFirmwareRequestMessage {
  BotaFirmwareRequestMessage({
    required this.requestId,
    required this.sourceId,
    required this.version,
    required this.sizeBytes,
    required this.crc32,
  });

  String requestId;
  String sourceId;
  String version;
  int sizeBytes;
  int crc32;
}

class BotaFirmwareSourceMessage {
  BotaFirmwareSourceMessage({
    required this.requestId,
    required this.url,
    required this.headers,
  });

  String requestId;
  String url;
  Map<String, String> headers;
}

class BotaFactoryResetResultRequestMessage {
  BotaFactoryResetResultRequestMessage({
    required this.requestId,
    required this.commandId,
    required this.bindingGeneration,
    required this.localRecordingsDeleted,
  });

  String requestId;
  String commandId;
  int bindingGeneration;
  int localRecordingsDeleted;
}

class BotaFactoryResetResultAcknowledgementMessage {
  BotaFactoryResetResultAcknowledgementMessage({required this.requestId});

  String requestId;
}

sealed class BotaSubscriptionRequestMessage {}

class BotaScanSubscriptionMessage extends BotaSubscriptionRequestMessage {
  BotaScanSubscriptionMessage({
    required this.timeoutMillis,
    required this.allowDuplicates,
  });

  int timeoutMillis;
  bool allowDuplicates;
}

class BotaConnectionSubscriptionMessage extends BotaSubscriptionRequestMessage {
  BotaConnectionSubscriptionMessage();
}

class BotaDeviceStatusSubscriptionMessage
    extends BotaSubscriptionRequestMessage {
  BotaDeviceStatusSubscriptionMessage();
}

class BotaRecordingStateSubscriptionMessage
    extends BotaSubscriptionRequestMessage {
  BotaRecordingStateSubscriptionMessage({required this.device});

  BotaDeviceReferenceMessage device;
}

class BotaRecordingSyncSubscriptionMessage
    extends BotaSubscriptionRequestMessage {
  BotaRecordingSyncSubscriptionMessage({
    required this.device,
    required this.recording,
    required this.sinkId,
    required this.confirmOnCompletion,
  });

  BotaDeviceReferenceMessage device;
  BotaDeviceRecordingMessage recording;
  String sinkId;
  bool confirmOnCompletion;
}

class BotaUploadOwnershipSubscriptionMessage
    extends BotaSubscriptionRequestMessage {
  BotaUploadOwnershipSubscriptionMessage({
    required this.device,
    required this.recordingId,
    required this.uploadId,
    required this.destinationId,
  });

  BotaDeviceReferenceMessage device;
  String recordingId;
  String uploadId;
  String destinationId;
}

class BotaFirmwareUpdateSubscriptionMessage
    extends BotaSubscriptionRequestMessage {
  BotaFirmwareUpdateSubscriptionMessage({
    required this.device,
    required this.image,
  });

  BotaDeviceReferenceMessage device;
  BotaFirmwareImageMessage image;
}

class BotaLogSubscriptionMessage extends BotaSubscriptionRequestMessage {
  BotaLogSubscriptionMessage({required this.device});

  BotaDeviceReferenceMessage device;
}

class BotaWifiStatusSubscriptionMessage extends BotaSubscriptionRequestMessage {
  BotaWifiStatusSubscriptionMessage({required this.device});

  BotaDeviceReferenceMessage device;
}

sealed class BotaEventPayloadMessage {}

class BotaDiscoveredDeviceEventMessage extends BotaEventPayloadMessage {
  BotaDiscoveredDeviceEventMessage({required this.device});

  BotaDiscoveredDeviceMessage device;
}

class BotaConnectionEventMessage extends BotaEventPayloadMessage {
  BotaConnectionEventMessage({this.device});

  BotaConnectedDeviceMessage? device;
}

class BotaDeviceStatusEventMessage extends BotaEventPayloadMessage {
  BotaDeviceStatusEventMessage({required this.status});

  BotaDeviceStatusMessage status;
}

class BotaRecordingStateEventMessage extends BotaEventPayloadMessage {
  BotaRecordingStateEventMessage({required this.state});

  BotaRecordingStateMessage state;
}

class BotaRecordingSyncProgressEventMessage extends BotaEventPayloadMessage {
  BotaRecordingSyncProgressEventMessage({required this.progress});

  BotaRecordingTransferProgressMessage progress;
}

class BotaRecordingSyncCompletedEventMessage extends BotaEventPayloadMessage {
  BotaRecordingSyncCompletedEventMessage({required this.localPath});

  String localPath;
}

class BotaUploadOwnershipProgressEventMessage extends BotaEventPayloadMessage {
  BotaUploadOwnershipProgressEventMessage({required this.progress});

  BotaRecordingTransferProgressMessage progress;
}

class BotaUploadOwnershipResolvedEventMessage extends BotaEventPayloadMessage {
  BotaUploadOwnershipResolvedEventMessage({required this.result});

  BotaUploadOwnershipResultMessage result;
}

class BotaFirmwareProgressEventMessage extends BotaEventPayloadMessage {
  BotaFirmwareProgressEventMessage({required this.progress});

  BotaFirmwareProgressMessage progress;
}

class BotaDeviceLogEventMessage extends BotaEventPayloadMessage {
  BotaDeviceLogEventMessage({required this.line});

  BotaDeviceLogLineMessage line;
}

class BotaWifiStatusEventMessage extends BotaEventPayloadMessage {
  BotaWifiStatusEventMessage({required this.status});

  BotaWifiStatusMessage status;
}

class BotaSubscriptionErrorEventMessage extends BotaEventPayloadMessage {
  BotaSubscriptionErrorEventMessage({required this.error});

  BotaErrorMessage error;
}

class BotaSubscriptionCompleteEventMessage extends BotaEventPayloadMessage {
  BotaSubscriptionCompleteEventMessage();
}

class BotaEventMessage {
  BotaEventMessage({required this.subscriptionId, required this.payload});

  String subscriptionId;
  BotaEventPayloadMessage payload;
}

class BotaClientContextMessage {
  BotaClientContextMessage({
    required this.schemaVersion,
    required this.sessionId,
    required this.sequence,
    required this.platform,
    required this.sdkPackage,
    required this.sdkVersion,
  });
  int schemaVersion;
  String sessionId;
  int sequence;
  String platform;
  String sdkPackage;
  String sdkVersion;
}

@HostApi()
abstract class BotaHostApi {
  @async
  void configure(String operationId, BotaConfigurationMessage configuration);

  @async
  void destroy(String operationId);

  @async
  BotaConnectedDeviceMessage connect(
    String operationId,
    BotaDiscoveredDeviceMessage device,
    String? serialNumber,
  );

  @async
  BotaConnectedDeviceMessage reconnect(
    String operationId,
    String serialNumber,
    BotaReconnectHintMessage hint,
  );

  @async
  void disconnect(String operationId);

  @async
  BotaDeviceStatusMessage readDeviceStatus(String operationId);

  @async
  BotaClientContextMessage? nextClientPresence(
    String operationId,
    String deviceId,
  );

  @async
  void cancelDeviceOperation(String operationId);

  @async
  void startRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  );

  @async
  void stopRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  );

  @async
  BotaRecordingStateMessage readRecordingState(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  void provision(String operationId, BotaDeviceReferenceMessage device);

  @async
  BotaConnectionSettingsMessage readConnectionSettings(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  void writeConnectionSettings(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaConnectionSettingsMessage settings,
  );

  @async
  BotaDeprovisionResultMessage deprovision(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  );

  @async
  void cancelProvisioningOperation(String operationId);

  @async
  BotaFactoryResetCompletionMessage factoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaFactoryResetCommandMessage command,
  );

  @async
  BotaFactoryResetCompletionMessage? resumePendingFactoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    int currentBindingGeneration,
  );

  @async
  BotaFactoryResetCompletionMessage resumeUnjournaledFactoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaFactoryResetCommandMessage command,
  );

  @async
  void cancelFactoryResetOperation(String operationId);

  @async
  List<BotaDeviceRecordingMessage> listRecordings(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  BotaRecordingTransferMetadataMessage? takeTransferMetadata(
    String operationId,
    String sinkId,
  );

  @async
  void confirmRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String recordingId,
  );

  @async
  void cancelRecordingOperation(String operationId);

  @async
  void cancelOtaOperation(String operationId);

  @async
  void stopLogs(String operationId);

  @async
  BotaWifiConfigResultMessage configureWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaWifiCredentialsMessage credentials,
    String grantBlob,
  );

  @async
  BotaWifiConfigResultMessage disconnectWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  BotaWifiStatusMessage readWifiStatus(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  BotaWifiScanResultMessage scanWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
  );

  @async
  void cancelWifiOperation(String operationId);

  @async
  void startSubscription(
    String subscriptionId,
    BotaSubscriptionRequestMessage request,
  );

  @async
  void cancelSubscription(String subscriptionId);
}

@FlutterApi()
abstract class BotaFlutterApi {
  void onEvent(BotaEventMessage event);

  @asyncCallback
  BotaMaterialResponseMessage requestMaterial(
    BotaMaterialRequestMessage request,
  );

  @asyncCallback
  BotaFirmwareSourceMessage requestFirmware(BotaFirmwareRequestMessage request);

  @asyncCallback
  BotaFactoryResetResultAcknowledgementMessage persistFactoryResetResult(
    BotaFactoryResetResultRequestMessage request,
  );
}
