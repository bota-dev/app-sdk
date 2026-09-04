import 'models/device.dart';
import 'models/ota.dart';
import 'models/recording.dart';
import 'models/security.dart';
import 'models/settings.dart';
import 'models/wifi.dart';
import 'platform.dart';

abstract interface class BotaDeviceManager {
  Stream<BotaDiscoveredDevice> scan({
    Duration timeout = const Duration(seconds: 10),
    bool allowDuplicates = false,
  });
  Future<BotaConnectedDevice> connect(
    BotaDiscoveredDevice device, {
    String? serialNumber,
  });
  Future<BotaConnectedDevice> reconnect(
    String serialNumber, {
    BotaReconnectHint hint = const BotaReconnectHint(),
  });
  Future<void> disconnect();
  Stream<BotaConnectedDevice?> get connections;
  Future<BotaDeviceStatus> readStatus();
  Stream<BotaDeviceStatus> get status;
  Future<void> cancelCurrentOperation();
}

abstract interface class BotaControlManager {
  Future<void> startRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  });
  Future<void> stopRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  });
  Future<BotaRecordingState> readRecordingState(BotaConnectedDevice device);
  Stream<BotaRecordingState> recordingState(BotaConnectedDevice device);
}

abstract interface class BotaProvisioningManager {
  Future<void> provision(BotaConnectedDevice device);
  Future<BotaConnectionSettings> readConnectionSettings(
    BotaConnectedDevice device,
  );
  Future<void> writeConnectionSettings(
    BotaConnectedDevice device,
    BotaConnectionSettings settings,
  );
  Future<BotaDeprovisionResult> deprovision(
    BotaConnectedDevice device, {
    required String grantBlob,
  });
  Future<void> cancelCurrentOperation();
}

abstract interface class BotaFactoryResetManager {
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  );
  Future<BotaFactoryResetCompletion?> resumePending(
    BotaConnectedDevice device, {
    required int currentBindingGeneration,
  });
  Future<BotaFactoryResetCompletion> resumeUnjournaled(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  );
  Future<void> cancelCurrentOperation();
}

abstract interface class BotaRecordingManager {
  Future<List<BotaDeviceRecording>> list(BotaConnectedDevice device);
  Stream<BotaRecordingSyncEvent> sync(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  });
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(String sinkId);
  Future<void> confirm(BotaConnectedDevice device, String recordingId);
  Stream<BotaUploadOwnershipEvent> observeUploadOwnership(
    BotaConnectedDevice device, {
    required String recordingId,
    required String uploadId,
    required String destinationId,
  });
  Future<void> cancelCurrentOperation();
}

abstract interface class BotaOtaManager {
  Stream<BotaFirmwareProgress> update(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  );
  Future<void> cancelCurrentOperation();
}

abstract interface class BotaLogManager {
  Stream<BotaDeviceLogLine> stream(BotaConnectedDevice device);
  Future<void> stop();
}

abstract interface class BotaWifiManager {
  Future<BotaWifiConfigResult> configure(
    BotaConnectedDevice device,
    BotaWifiCredentials credentials, {
    required String grantBlob,
  });
  Future<BotaWifiConfigResult> disconnect(BotaConnectedDevice device);
  Future<BotaWifiStatus> readStatus(BotaConnectedDevice device);
  Stream<BotaWifiStatus> status(BotaConnectedDevice device);
  Future<BotaWifiScanResult> scan(BotaConnectedDevice device);
  Future<void> cancelCurrentOperation();
}

/// Internal manager graph owned by one client.
final class BotaManagerBundle {
  BotaManagerBundle(BotaPlatform platform)
    : devices = _DeviceManager(platform),
      controls = _ControlManager(platform),
      provisioning = _ProvisioningManager(platform),
      factoryReset = _FactoryResetManager(platform),
      recordings = _RecordingManager(platform),
      ota = _OtaManager(platform),
      logs = _LogManager(platform),
      wifi = _WifiManager(platform);

  final BotaDeviceManager devices;
  final BotaControlManager controls;
  final BotaProvisioningManager provisioning;
  final BotaFactoryResetManager factoryReset;
  final BotaRecordingManager recordings;
  final BotaOtaManager ota;
  final BotaLogManager logs;
  final BotaWifiManager wifi;
}

final class _DeviceManager implements BotaDeviceManager {
  const _DeviceManager(this._platform);
  final BotaPlatform _platform;

  @override
  Stream<BotaDiscoveredDevice> scan({
    Duration timeout = const Duration(seconds: 10),
    bool allowDuplicates = false,
  }) => _platform.scan(timeout: timeout, allowDuplicates: allowDuplicates);
  @override
  Future<BotaConnectedDevice> connect(
    BotaDiscoveredDevice device, {
    String? serialNumber,
  }) => _platform.connect(device, serialNumber: serialNumber);
  @override
  Future<BotaConnectedDevice> reconnect(
    String serialNumber, {
    BotaReconnectHint hint = const BotaReconnectHint(),
  }) => _platform.reconnect(serialNumber, hint: hint);
  @override
  Future<void> disconnect() => _platform.disconnect();
  @override
  Stream<BotaConnectedDevice?> get connections => _platform.connections;
  @override
  Future<BotaDeviceStatus> readStatus() => _platform.readStatus();
  @override
  Stream<BotaDeviceStatus> get status => _platform.status;
  @override
  Future<void> cancelCurrentOperation() => _platform.cancelDeviceOperation();
}

final class _ControlManager implements BotaControlManager {
  const _ControlManager(this._platform);
  final BotaPlatform _platform;

  @override
  Future<void> startRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _platform.startRecording(device, grantBlob: grantBlob);
  @override
  Future<void> stopRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _platform.stopRecording(device, grantBlob: grantBlob);
  @override
  Future<BotaRecordingState> readRecordingState(BotaConnectedDevice device) =>
      _platform.readRecordingState(device);
  @override
  Stream<BotaRecordingState> recordingState(BotaConnectedDevice device) =>
      _platform.recordingState(device);
}

final class _ProvisioningManager implements BotaProvisioningManager {
  const _ProvisioningManager(this._platform);
  final BotaPlatform _platform;

  @override
  Future<void> provision(BotaConnectedDevice device) =>
      _platform.provision(device);
  @override
  Future<BotaConnectionSettings> readConnectionSettings(
    BotaConnectedDevice device,
  ) => _platform.readConnectionSettings(device);
  @override
  Future<void> writeConnectionSettings(
    BotaConnectedDevice device,
    BotaConnectionSettings settings,
  ) => _platform.writeConnectionSettings(device, settings);
  @override
  Future<BotaDeprovisionResult> deprovision(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _platform.deprovision(device, grantBlob: grantBlob);
  @override
  Future<void> cancelCurrentOperation() =>
      _platform.cancelProvisioningOperation();
}

final class _FactoryResetManager implements BotaFactoryResetManager {
  const _FactoryResetManager(this._platform);
  final BotaPlatform _platform;

  @override
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => _platform.reset(device, command);
  @override
  Future<BotaFactoryResetCompletion?> resumePending(
    BotaConnectedDevice device, {
    required int currentBindingGeneration,
  }) => _platform.resumePending(
    device,
    currentBindingGeneration: currentBindingGeneration,
  );
  @override
  Future<BotaFactoryResetCompletion> resumeUnjournaled(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => _platform.resumeUnjournaled(device, command);
  @override
  Future<void> cancelCurrentOperation() =>
      _platform.cancelFactoryResetOperation();
}

final class _RecordingManager implements BotaRecordingManager {
  const _RecordingManager(this._platform);
  final BotaPlatform _platform;

  @override
  Future<List<BotaDeviceRecording>> list(BotaConnectedDevice device) =>
      _platform.listRecordings(device);
  @override
  Stream<BotaRecordingSyncEvent> sync(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  }) => _platform.syncRecording(
    device,
    recording,
    sinkId: sinkId,
    confirmOnCompletion: confirmOnCompletion,
  );
  @override
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(String sinkId) =>
      _platform.takeTransferMetadata(sinkId);
  @override
  Future<void> confirm(BotaConnectedDevice device, String recordingId) =>
      _platform.confirmRecording(device, recordingId);
  @override
  Stream<BotaUploadOwnershipEvent> observeUploadOwnership(
    BotaConnectedDevice device, {
    required String recordingId,
    required String uploadId,
    required String destinationId,
  }) => _platform.observeUploadOwnership(
    device,
    recordingId: recordingId,
    uploadId: uploadId,
    destinationId: destinationId,
  );
  @override
  Future<void> cancelCurrentOperation() => _platform.cancelRecordingOperation();
}

final class _OtaManager implements BotaOtaManager {
  const _OtaManager(this._platform);
  final BotaPlatform _platform;

  @override
  Stream<BotaFirmwareProgress> update(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  ) => _platform.updateFirmware(device, image);
  @override
  Future<void> cancelCurrentOperation() => _platform.cancelOtaOperation();
}

final class _LogManager implements BotaLogManager {
  const _LogManager(this._platform);
  final BotaPlatform _platform;

  @override
  Stream<BotaDeviceLogLine> stream(BotaConnectedDevice device) =>
      _platform.streamLogs(device);
  @override
  Future<void> stop() => _platform.stopLogs();
}

final class _WifiManager implements BotaWifiManager {
  const _WifiManager(this._platform);
  final BotaPlatform _platform;

  @override
  Future<BotaWifiConfigResult> configure(
    BotaConnectedDevice device,
    BotaWifiCredentials credentials, {
    required String grantBlob,
  }) => _platform.configureWifi(device, credentials, grantBlob: grantBlob);
  @override
  Future<BotaWifiConfigResult> disconnect(BotaConnectedDevice device) =>
      _platform.disconnectWifi(device);
  @override
  Future<BotaWifiStatus> readStatus(BotaConnectedDevice device) =>
      _platform.readWifiStatus(device);
  @override
  Stream<BotaWifiStatus> status(BotaConnectedDevice device) =>
      _platform.wifiStatus(device);
  @override
  Future<BotaWifiScanResult> scan(BotaConnectedDevice device) =>
      _platform.scanWifi(device);
  @override
  Future<void> cancelCurrentOperation() => _platform.cancelWifiOperation();
}
