import 'dart:typed_data';

import 'client.dart';
import 'errors.dart';
import 'generated/bota_api.g.dart';
import 'models/device.dart';
import 'models/ota.dart';
import 'models/recording.dart';
import 'models/security.dart';
import 'models/settings.dart';
import 'models/wifi.dart';

/// Pure conversions between the public Dart API and generated bridge values.
abstract final class BridgeMapper {
  static BotaConfigurationMessage configuration(
    BotaConfiguration configuration,
  ) => BotaConfigurationMessage(
    applicationSupportNamespace: configuration.applicationSupportNamespace,
    hasProvisioningMaterialCallback:
        configuration.callbacks.provisioningMaterial != null,
    hasFactoryResetGrantCallback:
        configuration.callbacks.factoryResetGrant != null,
    hasFactoryResetResultCallback:
        configuration.callbacks.persistFactoryResetResult != null,
    hasUploadDestinationCallback:
        configuration.callbacks.uploadDestination != null,
    hasFirmwareCallback: configuration.callbacks.firmware != null,
  );

  static BotaDeviceReferenceMessage deviceReference(
    BotaConnectedDevice device,
  ) => BotaDeviceReferenceMessage(id: device.id);

  static BotaDiscoveredDeviceMessage discoveredDeviceMessage(
    BotaDiscoveredDevice device,
  ) => BotaDiscoveredDeviceMessage(
    id: device.id,
    name: device.name,
    deviceType: device.deviceType == null
        ? null
        : BotaDeviceTypeMessage(
            name: device.deviceType!.name,
            rawValue: device.deviceType!.rawValue,
          ),
    firmwareVersion: device.firmwareVersion,
    macAddress: device.macAddress,
    pairingState: device.pairingState == null
        ? null
        : BotaPairingStateMessage(
            name: device.pairingState!.name,
            rawValue: device.pairingState!.rawValue,
          ),
    rssi: device.rssi,
    discoveredAtMillis: device.discoveredAt.millisecondsSinceEpoch,
  );

  static BotaDiscoveredDevice discoveredDevice(
    BotaDiscoveredDeviceMessage device,
  ) => BotaDiscoveredDevice(
    id: device.id,
    name: device.name,
    deviceType: device.deviceType == null
        ? null
        : _deviceType(device.deviceType!),
    firmwareVersion: device.firmwareVersion,
    macAddress: device.macAddress,
    pairingState: device.pairingState == null
        ? null
        : _pairingState(device.pairingState!),
    rssi: device.rssi,
    discoveredAt: DateTime.fromMillisecondsSinceEpoch(
      device.discoveredAtMillis,
      isUtc: true,
    ),
  );

  static BotaConnectedDevice connectedDevice(
    BotaConnectedDeviceMessage device,
  ) => BotaConnectedDevice(
    id: device.id,
    serialNumber: device.serialNumber,
    deviceType: _deviceType(device.deviceType),
    firmwareVersion: device.firmwareVersion,
    hardwareRevision: device.hardwareRevision,
    isProvisioned: device.isProvisioned,
    connectionState: switch (device.connectionState) {
      BotaConnectionStateMessage.disconnected =>
        BotaConnectionState.disconnected,
      BotaConnectionStateMessage.connecting => BotaConnectionState.connecting,
      BotaConnectionStateMessage.bonding => BotaConnectionState.bonding,
      BotaConnectionStateMessage.discovering => BotaConnectionState.discovering,
      BotaConnectionStateMessage.connected => BotaConnectionState.connected,
      BotaConnectionStateMessage.disconnecting =>
        BotaConnectionState.disconnecting,
    },
    mtu: device.mtu,
  );

  static BotaReconnectHintMessage reconnectHint(BotaReconnectHint hint) =>
      BotaReconnectHintMessage(
        storedPeripheralId: hint.storedPeripheralId,
        advertisedAddress: hint.advertisedAddress,
        storedName: hint.storedName,
        scanTimeoutMillis: hint.scanTimeout.inMilliseconds,
        connectionTimeoutMillis: hint.connectionTimeout.inMilliseconds,
      );

  static BotaDeviceStatus deviceStatus(BotaDeviceStatusMessage status) =>
      BotaDeviceStatus(
        batteryLevel: status.batteryLevel,
        batteryMillivolts: status.batteryMillivolts,
        storageTotalMegabytes: status.storageTotalMegabytes,
        storageUsedMegabytes: status.storageUsedMegabytes,
        state: _deviceState(status.state),
        pendingRecordings: status.pendingRecordings,
        lastTimeSyncAt: status.lastTimeSyncAtMillis == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch(
                status.lastTimeSyncAtMillis!,
                isUtc: true,
              ),
        signalStrength: status.signalStrength,
        flags: BotaDeviceFlags(
          charging: status.flags.charging,
          lowBattery: status.flags.lowBattery,
          storageFull: status.flags.storageFull,
          wifiConnected: status.flags.wifiConnected,
          lteConnected: status.flags.lteConnected,
          syncActive: status.flags.syncActive,
        ),
        timestamp: status.timestamp,
        lteState: _lteState(status.lteState),
        lteSignalQuality: status.lteSignalQuality,
        wifiState: status.wifiState == null
            ? null
            : _wifiRadioState(status.wifiState!),
        modemInfo: status.modemInfo == null
            ? null
            : BotaModemInfo(
                imei: status.modemInfo!.imei,
                iccid: status.modemInfo!.iccid,
                operatorName: status.modemInfo!.operatorName,
                rat: status.modemInfo!.rat,
                band: status.modemInfo!.band,
                apn: status.modemInfo!.apn,
                simStatus: status.modemInfo!.simStatus,
                csq: status.modemInfo!.csq,
                ipAddress: status.modemInfo!.ipAddress,
                modemVoltage: status.modemInfo!.modemVoltage,
                modemFirmware: status.modemInfo!.modemFirmware,
                roaming: status.modemInfo!.roaming,
              ),
      );

  static BotaConnectionSettings connectionSettings(
    BotaConnectionSettingsMessage settings,
  ) => BotaConnectionSettings(
    enabledConnections: BotaEnabledConnections(
      wifi: settings.enabledConnections.wifi,
      cellular: settings.enabledConnections.cellular,
    ),
    heartbeatEnabledConnections: BotaEnabledConnections(
      wifi: settings.heartbeatEnabledConnections.wifi,
      cellular: settings.heartbeatEnabledConnections.cellular,
    ),
    heartbeatUnknownMask: settings.heartbeatUnknownMask,
    uploadNetworkPreference: settings.uploadNetworkPreference
        .map(_connectionType)
        .toList(growable: false),
    powerManagement: BotaPowerManagement(
      wifiIdleTimeout: Duration(
        milliseconds: settings.powerManagement.wifiIdleTimeoutMillis,
      ),
      cellularIdleTimeout: Duration(
        milliseconds: settings.powerManagement.cellularIdleTimeoutMillis,
      ),
    ),
    streamingEnabled: settings.streamingEnabled,
    streamingFlushInterval: Duration(
      milliseconds: settings.streamingFlushIntervalMillis,
    ),
  );

  static BotaConnectionSettingsMessage connectionSettingsMessage(
    BotaConnectionSettings settings,
  ) => BotaConnectionSettingsMessage(
    enabledConnections: BotaEnabledConnectionsMessage(
      wifi: settings.enabledConnections.wifi,
      cellular: settings.enabledConnections.cellular,
    ),
    heartbeatEnabledConnections: BotaEnabledConnectionsMessage(
      wifi: settings.heartbeatEnabledConnections.wifi,
      cellular: settings.heartbeatEnabledConnections.cellular,
    ),
    heartbeatUnknownMask: settings.heartbeatUnknownMask,
    uploadNetworkPreference: settings.uploadNetworkPreference
        .map(
          (BotaConnectionType value) => BotaConnectionTypeMessage(
            name: value.name,
            rawValue: value.rawValue,
          ),
        )
        .toList(growable: false),
    powerManagement: BotaPowerManagementMessage(
      wifiIdleTimeoutMillis:
          settings.powerManagement.wifiIdleTimeout.inMilliseconds,
      cellularIdleTimeoutMillis:
          settings.powerManagement.cellularIdleTimeout.inMilliseconds,
    ),
    streamingEnabled: settings.streamingEnabled,
    streamingFlushIntervalMillis:
        settings.streamingFlushInterval.inMilliseconds,
  );

  static BotaDeprovisionResult deprovisionResult(
    BotaDeprovisionResultMessage result,
  ) => BotaDeprovisionResult(
    success: result.success,
    error: result.error == null ? null : _provisioningFailure(result.error!),
  );

  static BotaFactoryResetCommandMessage factoryResetCommand(
    BotaFactoryResetCommand command,
  ) => BotaFactoryResetCommandMessage(
    commandId: command.commandId,
    bindingGeneration: command.bindingGeneration,
  );

  static BotaFactoryResetCompletion factoryResetCompletion(
    BotaFactoryResetCompletionMessage completion,
  ) => BotaFactoryResetCompletion(
    commandId: completion.commandId,
    bindingGeneration: completion.bindingGeneration,
  );

  static BotaRecordingState recordingState(BotaRecordingStateMessage state) =>
      BotaRecordingState(
        active: state.active,
        recordingId: state.recordingId,
        initiatedBy: switch (state.initiatedBy.name) {
          'local' => BotaRecordingInitiator.local,
          'remote' => BotaRecordingInitiator.remote,
          _ => BotaRecordingInitiator.unknown(
            _rawValue(state.initiatedBy.name, state.initiatedBy.rawValue),
          ),
        },
      );

  static BotaDeviceRecordingMessage deviceRecordingMessage(
    BotaDeviceRecording recording,
  ) => BotaDeviceRecordingMessage(
    recordingId: recording.recordingId,
    startedAtMillis: recording.startedAt.millisecondsSinceEpoch,
    durationMillis: recording.duration.inMilliseconds,
    fileSizeBytes: recording.fileSizeBytes,
    codec: BotaAudioCodecMessage(
      name: recording.codec.name,
      rawValue: recording.codec.rawValue,
    ),
    isEncrypted: recording.isEncrypted,
  );

  static BotaDeviceRecording deviceRecording(
    BotaDeviceRecordingMessage recording,
  ) => BotaDeviceRecording(
    recordingId: recording.recordingId,
    startedAt: DateTime.fromMillisecondsSinceEpoch(
      recording.startedAtMillis,
      isUtc: true,
    ),
    duration: Duration(milliseconds: recording.durationMillis),
    fileSizeBytes: recording.fileSizeBytes,
    codec: _audioCodec(recording.codec),
    isEncrypted: recording.isEncrypted,
  );

  static BotaRecordingTransferProgress recordingProgress(
    BotaRecordingTransferProgressMessage progress,
  ) => BotaRecordingTransferProgress(
    completedBytes: progress.completedBytes,
    totalBytes: progress.totalBytes,
  );

  static BotaRecordingTransferMetadata recordingTransferMetadata(
    BotaRecordingTransferMetadataMessage metadata,
  ) => BotaRecordingTransferMetadata(
    isE2EEncrypted: metadata.isE2EEncrypted,
    contentSha256Hex: metadata.contentSha256Hex,
  );

  static BotaUploadOwnershipResult uploadOwnershipResult(
    BotaUploadOwnershipResultMessage result,
  ) => switch (result.kind) {
    BotaUploadOwnershipResultKindMessage.deviceUploadCompleted =>
      const BotaDeviceUploadCompleted(),
    BotaUploadOwnershipResultKindMessage.deviceUploadPreserved =>
      BotaDeviceUploadPreserved(
        uploadId: _required(result.uploadId, 'uploadId'),
      ),
    BotaUploadOwnershipResultKindMessage.bluetoothFallback =>
      BotaBluetoothFallback(
        recordingId: _required(result.recordingId, 'recordingId'),
        uploadId: _required(result.uploadId, 'uploadId'),
        destinationId: _required(result.destinationId, 'destinationId'),
      ),
  };

  static BotaFirmwareImageMessage firmwareImageMessage(
    BotaFirmwareImage image,
  ) => BotaFirmwareImageMessage(
    sourceId: image.sourceId,
    version: image.version,
    sizeBytes: image.sizeBytes,
    crc32: image.crc32,
  );

  static BotaFirmwareProgress firmwareProgress(
    BotaFirmwareProgressMessage progress,
  ) => BotaFirmwareProgress(
    phase: switch (progress.phase.name) {
      'downloading' => BotaFirmwarePhase.downloading,
      'awaitingDevice' => BotaFirmwarePhase.awaitingDevice,
      'transferring' => BotaFirmwarePhase.transferring,
      'verifying' => BotaFirmwarePhase.verifying,
      'rebooting' => BotaFirmwarePhase.rebooting,
      'reconnecting' => BotaFirmwarePhase.reconnecting,
      'complete' => BotaFirmwarePhase.complete,
      _ => BotaFirmwarePhase.unknown(
        _rawValue(progress.phase.name, progress.phase.rawValue),
      ),
    },
    completedBytes: progress.completedBytes,
    totalBytes: progress.totalBytes,
  );

  static BotaDeviceLogLine deviceLogLine(BotaDeviceLogLineMessage line) =>
      BotaDeviceLogLine(message: line.message, isBacklog: line.isBacklog);

  static BotaWifiStatus wifiStatus(BotaWifiStatusMessage status) =>
      BotaWifiStatus(
        state: switch (status.state.name) {
          'idle' => BotaWifiState.idle,
          'connecting' => BotaWifiState.connecting,
          'connected' => BotaWifiState.connected,
          'failed' => BotaWifiState.failed,
          'disconnected' => BotaWifiState.disconnected,
          _ => BotaWifiState.unknown(
            _rawValue(status.state.name, status.state.rawValue),
          ),
        },
        signalStrength: status.signalStrength,
        ssid: status.ssid,
        lastError: status.lastError,
      );

  static BotaWifiCredentialsMessage wifiCredentials(
    BotaWifiCredentials credentials,
  ) => BotaWifiCredentialsMessage(
    ssid: credentials.ssid,
    password: credentials.password,
  );

  static BotaWifiConfigResult wifiConfigResult(
    BotaWifiConfigResultMessage result,
  ) => switch (result.name) {
    'success' => BotaWifiConfigResult.success,
    'invalidGrant' => BotaWifiConfigResult.invalidGrant,
    'grantExpired' => BotaWifiConfigResult.grantExpired,
    'decryptionError' => BotaWifiConfigResult.decryptionError,
    'storageError' => BotaWifiConfigResult.storageError,
    _ => BotaWifiConfigResult.unknown(_rawValue(result.name, result.rawValue)),
  };

  static BotaWifiScanResult wifiScanResult(BotaWifiScanResultMessage result) =>
      BotaWifiScanResult(
        networks: result.networks
            .map(
              (BotaWifiNetworkMessage network) => BotaWifiNetwork(
                ssid: network.ssid,
                quality: network.quality,
                isCurrent: network.isCurrent,
                isOpen: network.isOpen,
              ),
            )
            .toList(growable: false),
        currentSsid: result.currentSsid,
      );

  static BotaSdkException error(BotaErrorMessage error) => BotaSdkException(
    code: _errorCode(error.code),
    operation: _operation(error.operation),
    retryable: error.retryable,
    protocolStatus: error.protocolStatus,
    detail: error.detail,
  );

  static BotaProvisioningMaterialRequest provisioningMaterialRequest(
    BotaProvisioningMaterialRequestMessage request,
  ) => BotaProvisioningMaterialRequest(
    requestId: request.requestId,
    serialNumber: request.serialNumber,
    nonce: request.nonce,
    devicePublicKey: request.devicePublicKey,
  );

  static BotaProvisioningMaterialResponseMessage provisioningMaterialResponse(
    BotaProvisioningMaterial material,
  ) => BotaProvisioningMaterialResponseMessage(
    requestId: material.requestId,
    apiEndpoint: Uint8List.fromList(material.apiEndpoint),
    deviceToken: Uint8List.fromList(material.deviceToken),
    mtu: material.mtu,
  );

  static BotaFactoryResetGrantRequest factoryResetGrantRequest(
    BotaFactoryResetGrantRequestMessage request,
  ) => BotaFactoryResetGrantRequest(
    requestId: request.requestId,
    serialNumber: request.serialNumber,
    nonce: request.nonce,
    commandId: request.commandId,
    bindingGeneration: request.bindingGeneration,
  );

  static BotaFactoryResetGrantResponseMessage factoryResetGrantResponse(
    BotaFactoryResetGrant grant,
  ) => BotaFactoryResetGrantResponseMessage(
    requestId: grant.requestId,
    encodedGrant: Uint8List.fromList(grant.grant),
  );

  static BotaFirmwareRequest firmwareRequest(
    BotaFirmwareRequestMessage request,
  ) => BotaFirmwareRequest(
    requestId: request.requestId,
    sourceId: request.sourceId,
    version: request.version,
    sizeBytes: request.sizeBytes,
    crc32: request.crc32,
  );

  static BotaFirmwareSourceMessage firmwareSource(BotaFirmwareSource source) =>
      BotaFirmwareSourceMessage(
        requestId: source.requestId,
        url: source.url.toString(),
        headers: Map<String, String>.of(source.headers),
      );

  static BotaUploadDestinationRequest uploadDestinationRequest(
    BotaUploadDestinationRequestMessage request,
  ) => BotaUploadDestinationRequest(
    requestId: request.requestId,
    destinationId: request.destinationId,
    recordingId: request.recordingId,
    uploadId: request.uploadId,
  );

  static BotaUploadDestinationMessage uploadDestination(
    BotaUploadDestination destination,
  ) => BotaUploadDestinationMessage(
    requestId: destination.requestId,
    url: destination.url.toString(),
    method: switch (destination.method) {
      BotaHttpMethod.get => BotaHttpMethodMessage.get,
      BotaHttpMethod.put => BotaHttpMethodMessage.put,
      BotaHttpMethod.post => BotaHttpMethodMessage.post,
    },
    headers: Map<String, String>.of(destination.headers),
  );

  static BotaFactoryResetResultRequest factoryResetResultRequest(
    BotaFactoryResetResultRequestMessage request,
  ) => BotaFactoryResetResultRequest(
    requestId: request.requestId,
    commandId: request.commandId,
    bindingGeneration: request.bindingGeneration,
    localRecordingsDeleted: request.localRecordingsDeleted,
  );

  static BotaFactoryResetResultAcknowledgementMessage
  factoryResetResultAcknowledgement(
    BotaFactoryResetResultAcknowledgement acknowledgement,
  ) => BotaFactoryResetResultAcknowledgementMessage(
    requestId: acknowledgement.requestId,
  );

  static BotaDeviceType _deviceType(BotaDeviceTypeMessage value) =>
      switch (value.name) {
        'botaPin' => BotaDeviceType.botaPin,
        'botaPin4G' => BotaDeviceType.botaPin4G,
        'botaNote' => BotaDeviceType.botaNote,
        _ => BotaDeviceType.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaPairingState _pairingState(BotaPairingStateMessage value) =>
      switch (value.name) {
        'unpaired' => BotaPairingState.unpaired,
        'pairing' => BotaPairingState.pairing,
        'paired' => BotaPairingState.paired,
        'error' => BotaPairingState.error,
        _ => BotaPairingState.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaDeviceState _deviceState(BotaDeviceStateValueMessage value) =>
      switch (value.name) {
        'idle' => BotaDeviceState.idle,
        'recording' => BotaDeviceState.recording,
        'syncing' => BotaDeviceState.syncing,
        'uploading' => BotaDeviceState.uploading,
        'charging' => BotaDeviceState.charging,
        'lowBattery' => BotaDeviceState.lowBattery,
        'storageFull' => BotaDeviceState.storageFull,
        'error' => BotaDeviceState.error,
        _ => BotaDeviceState.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaLteState _lteState(BotaLteStateMessage value) =>
      switch (value.name) {
        'off' => BotaLteState.off,
        'searching' => BotaLteState.searching,
        'registered' => BotaLteState.registered,
        'connected' => BotaLteState.connected,
        'denied' => BotaLteState.denied,
        'noSim' => BotaLteState.noSim,
        'error' => BotaLteState.error,
        'lowVoltage' => BotaLteState.lowVoltage,
        'disabled' => BotaLteState.disabled,
        _ => BotaLteState.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaWifiRadioState _wifiRadioState(BotaWifiRadioStateMessage value) =>
      switch (value.name) {
        'off' => BotaWifiRadioState.off,
        'scanning' => BotaWifiRadioState.scanning,
        'connecting' => BotaWifiRadioState.connecting,
        'connected' => BotaWifiRadioState.connected,
        'connectFailed' => BotaWifiRadioState.connectFailed,
        'noCredentials' => BotaWifiRadioState.noCredentials,
        'disabled' => BotaWifiRadioState.disabled,
        'error' => BotaWifiRadioState.error,
        _ => BotaWifiRadioState.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaConnectionType _connectionType(BotaConnectionTypeMessage value) =>
      switch (value.name) {
        'wifi' => BotaConnectionType.wifi,
        'ble' => BotaConnectionType.ble,
        'cellular' => BotaConnectionType.cellular,
        _ => BotaConnectionType.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaAudioCodec _audioCodec(BotaAudioCodecMessage value) =>
      switch (value.name) {
        'pcm16k' => BotaAudioCodec.pcm16k,
        'pcm8k' => BotaAudioCodec.pcm8k,
        'opus16k' => BotaAudioCodec.opus16k,
        'opus8k' => BotaAudioCodec.opus8k,
        _ => BotaAudioCodec.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaProvisioningFailure _provisioningFailure(
    BotaProvisioningFailureMessage value,
  ) => switch (value.name) {
    'invalidToken' => BotaProvisioningFailure.invalidToken,
    'storageError' => BotaProvisioningFailure.storageError,
    'chunkError' => BotaProvisioningFailure.chunkError,
    'alreadyPaired' => BotaProvisioningFailure.alreadyPaired,
    _ => BotaProvisioningFailure.unknown(_rawValue(value.name, value.rawValue)),
  };

  static BotaErrorCode _errorCode(BotaErrorCodeMessage value) =>
      switch (value.name) {
        'invalidInput' => BotaErrorCode.invalidInput,
        'truncatedPacket' => BotaErrorCode.truncatedPacket,
        'unknownPacket' => BotaErrorCode.unknownPacket,
        'payloadTooLarge' => BotaErrorCode.payloadTooLarge,
        'unsupportedCapability' => BotaErrorCode.unsupportedCapability,
        'unsupportedOperation' => BotaErrorCode.unsupportedOperation,
        'featureUnavailable' => BotaErrorCode.featureUnavailable,
        'operationInProgress' => BotaErrorCode.operationInProgress,
        'unexpectedEvent' => BotaErrorCode.unexpectedEvent,
        'deviceNotFound' => BotaErrorCode.deviceNotFound,
        'identityMismatch' => BotaErrorCode.identityMismatch,
        'connectionFailed' => BotaErrorCode.connectionFailed,
        'persistenceFailed' => BotaErrorCode.persistenceFailed,
        'notConnected' => BotaErrorCode.notConnected,
        'timeout' => BotaErrorCode.timeout,
        'cancelled' => BotaErrorCode.cancelled,
        'protocolRejected' => BotaErrorCode.protocolRejected,
        'integrityFailed' => BotaErrorCode.integrityFailed,
        'uploadOwnershipUnknown' => BotaErrorCode.uploadOwnershipUnknown,
        'downloadFailed' => BotaErrorCode.downloadFailed,
        'internal' => BotaErrorCode.internal,
        _ => BotaErrorCode.unknown(_rawValue(value.name, value.rawValue)),
      };

  static BotaOperation _operation(BotaOperationMessage value) =>
      switch (value.name) {
        'validate' => BotaOperation.validate,
        'decode' => BotaOperation.decode,
        'encode' => BotaOperation.encode,
        'discover' => BotaOperation.discover,
        'connect' => BotaOperation.connect,
        'reconnect' => BotaOperation.reconnect,
        'readStatus' => BotaOperation.readStatus,
        'provision' => BotaOperation.provision,
        'transferRecording' => BotaOperation.transferRecording,
        'upload' => BotaOperation.upload,
        'updateFirmware' => BotaOperation.updateFirmware,
        'readDeviceLogs' => BotaOperation.readDeviceLogs,
        'factoryReset' => BotaOperation.factoryReset,
        _ => BotaOperation.unknown(_rawValue(value.name, value.rawValue)),
      };

  static int _rawValue(String name, int? rawValue) {
    if (rawValue != null) return rawValue;
    throw FormatException('Unknown bridge value for $name has no raw value.');
  }

  static String _required(String? value, String field) {
    if (value != null) return value;
    throw FormatException('Bridge response omitted $field.');
  }
}
