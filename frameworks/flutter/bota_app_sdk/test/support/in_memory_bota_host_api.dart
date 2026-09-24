import 'dart:async';

import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:bota_app_sdk/src/generated/bota_api.g.dart';

final class HostCall {
  const HostCall(this.method, this.id, [this.value]);

  final String method;
  final String id;
  final Object? value;
}

final class InMemoryBotaHostApi extends BotaHostApi {
  final List<HostCall> calls = <HostCall>[];
  final Map<String, BotaSubscriptionRequestMessage> subscriptions =
      <String, BotaSubscriptionRequestMessage>{};
  final List<String> cancelledSubscriptions = <String>[];

  Completer<void>? configureCompleter;
  Object? configureError;
  Completer<BotaConnectedDeviceMessage>? connectCompleter;
  Object? connectError;
  StackTrace? connectErrorStack;

  List<String> get methodNames =>
      calls.map((HostCall call) => call.method).toList(growable: false);

  void _record(String method, String id, [Object? value]) {
    calls.add(HostCall(method, id, value));
  }

  @override
  Future<void> configure(
    String operationId,
    BotaConfigurationMessage configuration,
  ) {
    _record('configure', operationId, configuration);
    final Object? error = configureError;
    if (error != null) {
      return Future<void>.error(error, StackTrace.current);
    }
    return configureCompleter?.future ?? Future<void>.value();
  }

  @override
  Future<void> destroy(String operationId) async {
    _record('destroy', operationId);
  }

  @override
  Future<BotaConnectedDeviceMessage> connect(
    String operationId,
    BotaDiscoveredDeviceMessage device,
    String? serialNumber,
  ) {
    _record('connect', operationId, <Object?>[device, serialNumber]);
    final Object? error = connectError;
    if (error != null) {
      return Future<BotaConnectedDeviceMessage>.error(
        error,
        connectErrorStack ?? StackTrace.current,
      );
    }
    return connectCompleter?.future ?? Future.value(connectedDeviceMessage());
  }

  @override
  Future<BotaConnectedDeviceMessage> reconnect(
    String operationId,
    String serialNumber,
    BotaReconnectHintMessage hint,
  ) async {
    _record('reconnect', operationId, <Object>[serialNumber, hint]);
    return connectedDeviceMessage();
  }

  @override
  Future<void> disconnect(String operationId) async {
    _record('disconnect', operationId);
  }

  @override
  Future<BotaDeviceStatusMessage> readDeviceStatus(String operationId) async {
    _record('readDeviceStatus', operationId);
    return deviceStatusMessage();
  }

  @override
  Future<void> cancelDeviceOperation(String operationId) async {
    _record('cancelDeviceOperation', operationId);
  }

  @override
  Future<void> startRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  ) async {
    _record('startRecording', operationId, <Object>[device, grantBlob]);
  }

  @override
  Future<void> stopRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  ) async {
    _record('stopRecording', operationId, <Object>[device, grantBlob]);
  }

  @override
  Future<BotaRecordingStateMessage> readRecordingState(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('readRecordingState', operationId, device);
    return recordingStateMessage();
  }

  @override
  Future<void> provision(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('provision', operationId, device);
  }

  @override
  Future<BotaConnectionSettingsMessage> readConnectionSettings(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('readConnectionSettings', operationId, device);
    return connectionSettingsMessage();
  }

  @override
  Future<void> writeConnectionSettings(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaConnectionSettingsMessage settings,
  ) async {
    _record('writeConnectionSettings', operationId, <Object>[device, settings]);
  }

  @override
  Future<BotaDeprovisionResultMessage> deprovision(
    String operationId,
    BotaDeviceReferenceMessage device,
    String grantBlob,
  ) async {
    _record('deprovision', operationId, <Object>[device, grantBlob]);
    return BotaDeprovisionResultMessage(success: true);
  }

  @override
  Future<void> cancelProvisioningOperation(String operationId) async {
    _record('cancelProvisioningOperation', operationId);
  }

  @override
  Future<BotaFactoryResetCompletionMessage> factoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaFactoryResetCommandMessage command,
  ) async {
    _record('factoryReset', operationId, <Object>[device, command]);
    return BotaFactoryResetCompletionMessage(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    );
  }

  @override
  Future<BotaFactoryResetCompletionMessage?> resumePendingFactoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    int currentBindingGeneration,
  ) async {
    _record('resumePendingFactoryReset', operationId, <Object>[
      device,
      currentBindingGeneration,
    ]);
    return BotaFactoryResetCompletionMessage(
      commandId: 'pending-command',
      bindingGeneration: currentBindingGeneration,
    );
  }

  @override
  Future<BotaFactoryResetCompletionMessage> resumeUnjournaledFactoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaFactoryResetCommandMessage command,
  ) async {
    _record('resumeUnjournaledFactoryReset', operationId, <Object>[
      device,
      command,
    ]);
    return BotaFactoryResetCompletionMessage(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    );
  }

  @override
  Future<void> cancelFactoryResetOperation(String operationId) async {
    _record('cancelFactoryResetOperation', operationId);
  }

  @override
  Future<List<BotaDeviceRecordingMessage>> listRecordings(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('listRecordings', operationId, device);
    return <BotaDeviceRecordingMessage>[deviceRecordingMessage()];
  }

  @override
  Future<BotaRecordingTransferMetadataMessage?> takeTransferMetadata(
    String operationId,
    String sinkId,
  ) async {
    _record('takeTransferMetadata', operationId, sinkId);
    return BotaRecordingTransferMetadataMessage(
      isE2EEncrypted: true,
      contentSha256Hex: 'ab',
    );
  }

  @override
  Future<void> confirmRecording(
    String operationId,
    BotaDeviceReferenceMessage device,
    String recordingId,
  ) async {
    _record('confirmRecording', operationId, <Object>[device, recordingId]);
  }

  @override
  Future<void> cancelRecordingOperation(String operationId) async {
    _record('cancelRecordingOperation', operationId);
  }

  @override
  Future<void> cancelOtaOperation(String operationId) async {
    _record('cancelOtaOperation', operationId);
  }

  @override
  Future<void> stopLogs(String operationId) async {
    _record('stopLogs', operationId);
  }

  @override
  Future<BotaWifiConfigResultMessage> configureWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaWifiCredentialsMessage credentials,
    String grantBlob,
  ) async {
    _record('configureWifi', operationId, <Object>[
      device,
      credentials,
      grantBlob,
    ]);
    return BotaWifiConfigResultMessage(name: 'success');
  }

  @override
  Future<BotaWifiConfigResultMessage> disconnectWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('disconnectWifi', operationId, device);
    return BotaWifiConfigResultMessage(name: 'success');
  }

  @override
  Future<BotaWifiStatusMessage> readWifiStatus(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('readWifiStatus', operationId, device);
    return wifiStatusMessage();
  }

  @override
  Future<BotaWifiScanResultMessage> scanWifi(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) async {
    _record('scanWifi', operationId, device);
    return BotaWifiScanResultMessage(
      networks: <BotaWifiNetworkMessage>[
        BotaWifiNetworkMessage(
          ssid: 'Bota Lab',
          quality: 80,
          isCurrent: true,
          isOpen: false,
        ),
      ],
      currentSsid: 'Bota Lab',
    );
  }

  @override
  Future<void> cancelWifiOperation(String operationId) async {
    _record('cancelWifiOperation', operationId);
  }

  @override
  Future<void> startSubscription(
    String subscriptionId,
    BotaSubscriptionRequestMessage request,
  ) async {
    _record('startSubscription', subscriptionId, request);
    subscriptions[subscriptionId] = request;
  }

  @override
  Future<void> cancelSubscription(String subscriptionId) async {
    _record('cancelSubscription', subscriptionId);
    cancelledSubscriptions.add(subscriptionId);
    subscriptions.remove(subscriptionId);
  }
}

BotaDiscoveredDeviceMessage discoveredDeviceMessage({
  String id = 'peripheral',
}) => BotaDiscoveredDeviceMessage(
  id: id,
  name: 'Bota Pin',
  deviceType: BotaDeviceTypeMessage(name: 'botaPin'),
  firmwareVersion: '1.2.0',
  pairingState: BotaPairingStateMessage(name: 'paired'),
  rssi: -42,
  discoveredAtMillis: 1700000000000,
);

BotaConnectedDeviceMessage connectedDeviceMessage({String id = 'peripheral'}) =>
    BotaConnectedDeviceMessage(
      id: id,
      serialNumber: 'BP0001',
      deviceType: BotaDeviceTypeMessage(name: 'botaPin'),
      firmwareVersion: '1.2.0',
      isProvisioned: true,
      connectionState: BotaConnectionStateMessage.connected,
      mtu: 256,
    );

BotaDeviceStatusMessage deviceStatusMessage() => BotaDeviceStatusMessage(
  batteryLevel: 80,
  storageTotalMegabytes: 1024,
  storageUsedMegabytes: 128,
  state: BotaDeviceStateValueMessage(name: 'idle'),
  pendingRecordings: 1,
  signalStrength: -42,
  flags: BotaDeviceFlagsMessage(
    charging: false,
    lowBattery: false,
    storageFull: false,
    wifiConnected: true,
    lteConnected: false,
    syncActive: false,
  ),
  timestamp: 123,
  lteState: BotaLteStateMessage(name: 'off'),
  wifiState: BotaWifiRadioStateMessage(name: 'connected'),
);

BotaConnectionSettingsMessage connectionSettingsMessage() =>
    BotaConnectionSettingsMessage(
      enabledConnections: BotaEnabledConnectionsMessage(
        wifi: true,
        cellular: false,
      ),
      heartbeatEnabledConnections: BotaEnabledConnectionsMessage(
        wifi: true,
        cellular: true,
      ),
      heartbeatUnknownMask: 0,
      uploadNetworkPreference: <BotaConnectionTypeMessage>[
        BotaConnectionTypeMessage(name: 'wifi'),
      ],
      powerManagement: BotaPowerManagementMessage(
        wifiIdleTimeoutMillis: 180000,
        cellularIdleTimeoutMillis: 180000,
      ),
      streamingEnabled: true,
      streamingFlushIntervalMillis: 60000,
    );

BotaDeviceRecordingMessage deviceRecordingMessage() =>
    BotaDeviceRecordingMessage(
      recordingId: 'recording',
      startedAtMillis: 1700000000000,
      durationMillis: 3000,
      fileSizeBytes: 4096,
      codec: BotaAudioCodecMessage(name: 'opus16k'),
      isEncrypted: true,
    );

BotaRecordingStateMessage recordingStateMessage() => BotaRecordingStateMessage(
  active: true,
  recordingId: 'recording',
  initiatedBy: BotaRecordingInitiatorMessage(name: 'remote'),
);

BotaWifiStatusMessage wifiStatusMessage() => BotaWifiStatusMessage(
  state: BotaWifiStateMessage(name: 'connected'),
  signalStrength: -35,
  ssid: 'Bota Lab',
);

final BotaDiscoveredDevice testDiscoveredDevice = BotaDiscoveredDevice(
  id: 'peripheral',
  name: 'Bota Pin',
  deviceType: BotaDeviceType.botaPin,
  firmwareVersion: '1.2.0',
  pairingState: BotaPairingState.paired,
  rssi: -42,
  discoveredAt: DateTime.fromMillisecondsSinceEpoch(1700000000000, isUtc: true),
);

const BotaConnectedDevice testConnectedDevice = BotaConnectedDevice(
  id: 'peripheral',
  serialNumber: 'BP0001',
  deviceType: BotaDeviceType.botaPin,
  firmwareVersion: '1.2.0',
  isProvisioned: true,
  connectionState: BotaConnectionState.connected,
  mtu: 256,
);

final BotaDeviceRecording testDeviceRecording = BotaDeviceRecording(
  recordingId: 'recording',
  startedAt: DateTime.fromMillisecondsSinceEpoch(1700000000000, isUtc: true),
  duration: const Duration(seconds: 3),
  fileSizeBytes: 4096,
  codec: BotaAudioCodec.opus16k,
  isEncrypted: true,
);

const BotaFirmwareImage testFirmwareImage = BotaFirmwareImage(
  sourceId: 'firmware-source',
  version: '1.2.0',
  sizeBytes: 8192,
  crc32: 1234,
);
