import 'client.dart';
import 'models/device.dart';
import 'models/ota.dart';
import 'models/recording.dart';
import 'models/security.dart';
import 'models/settings.dart';
import 'models/wifi.dart';

/// Internal typed boundary implemented by the generated bridge runtime.
abstract interface class BotaPlatform {
  Set<BotaCapability> get capabilities;

  Future<void> configure(BotaConfiguration configuration);
  Future<void> destroy();

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
  Future<void> cancelDeviceOperation();

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
  Future<void> cancelProvisioningOperation();

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
  Future<void> cancelFactoryResetOperation();

  Future<List<BotaDeviceRecording>> listRecordings(BotaConnectedDevice device);
  Stream<BotaRecordingSyncEvent> syncRecording(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  });
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(String sinkId);
  Future<void> confirmRecording(BotaConnectedDevice device, String recordingId);
  Stream<BotaUploadOwnershipEvent> observeUploadOwnership(
    BotaConnectedDevice device, {
    required String recordingId,
    required String uploadId,
    required String destinationId,
  });
  Future<void> cancelRecordingOperation();

  Stream<BotaFirmwareProgress> updateFirmware(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  );
  Future<void> cancelOtaOperation();

  Stream<BotaDeviceLogLine> streamLogs(BotaConnectedDevice device);
  Future<void> stopLogs();

  Future<BotaWifiConfigResult> configureWifi(
    BotaConnectedDevice device,
    BotaWifiCredentials credentials, {
    required String grantBlob,
  });
  Future<BotaWifiConfigResult> disconnectWifi(BotaConnectedDevice device);
  Future<BotaWifiStatus> readWifiStatus(BotaConnectedDevice device);
  Stream<BotaWifiStatus> wifiStatus(BotaConnectedDevice device);
  Future<BotaWifiScanResult> scanWifi(BotaConnectedDevice device);
  Future<void> cancelWifiOperation();
}
