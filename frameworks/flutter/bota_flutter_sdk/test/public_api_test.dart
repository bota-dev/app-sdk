import 'dart:async';
import 'dart:io';

import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the public barrel uses only explicit documented exports', () {
    final barrel = File('lib/bota_flutter_sdk.dart').readAsStringSync();

    expect(barrel, isNot(contains("export 'src/platform.dart'")));
    expect(barrel, isNot(contains(' hide ')));
    expect(RegExp(r"export '.*';").allMatches(barrel), isEmpty);
    expect(barrel, matches(RegExp(r"export 'src/client.dart'\s+show")));
    expect(barrel, matches(RegExp(r"export 'src/managers.dart'\s+show")));
  });

  test('first beta capabilities contain supported operations only', () {
    expect(
      BotaCapabilities.firstBeta,
      containsAll(<BotaCapability>{
        BotaCapability.discovery,
        BotaCapability.connection,
        BotaCapability.deviceStatus,
        BotaCapability.recordingControl,
        BotaCapability.provisioning,
        BotaCapability.connectionSettings,
        BotaCapability.factoryReset,
        BotaCapability.recordingTransfer,
        BotaCapability.uploadOwnership,
        BotaCapability.firmwareUpdate,
        BotaCapability.deviceLogs,
        BotaCapability.wifi,
      }),
    );
    expect(BotaCapabilities.firstBeta.length, 12);
    expect(
      BotaCapabilities.firstBeta.map((capability) => capability.name),
      isNot(containsAll(<String>['liveStreaming', 'web', 'macos', 'windows'])),
    );
  });

  test('testing client exposes each native ownership manager', () {
    final client = BotaDeviceClient.forTesting(_FakePlatform());

    expect(client.devices, isA<BotaDeviceManager>());
    expect(client.controls, isA<BotaControlManager>());
    expect(client.provisioning, isA<BotaProvisioningManager>());
    expect(client.factoryReset, isA<BotaFactoryResetManager>());
    expect(client.recordings, isA<BotaRecordingManager>());
    expect(client.ota, isA<BotaOtaManager>());
    expect(client.logs, isA<BotaLogManager>());
    expect(client.wifi, isA<BotaWifiManager>());
  });

  test('managers are typed delegates over BotaPlatform', () async {
    final platform = _FakePlatform();
    final client = BotaDeviceClient.forTesting(platform);
    const connected = BotaConnectedDevice(
      id: 'device',
      serialNumber: 'serial',
      deviceType: BotaDeviceType.botaPin,
      firmwareVersion: '1.0.0',
      isProvisioned: true,
      connectionState: BotaConnectionState.connected,
      mtu: 256,
    );

    await client.controls.startRecording(connected, requestId: 'request');
    await client.recordings.confirm(connected, 'recording');
    await client.wifi.cancelCurrentOperation();

    expect(platform.calls, [
      'startRecording:request',
      'confirm:recording',
      'cancelWifi',
    ]);
  });
}

final class _FakePlatform implements BotaPlatform {
  final List<String> calls = [];

  @override
  Set<BotaCapability> get capabilities => BotaCapabilities.firstBeta;

  @override
  Future<void> configure(BotaConfiguration configuration) async {}

  @override
  Future<void> destroy() async {}

  @override
  Stream<BotaDiscoveredDevice> scan({
    Duration timeout = const Duration(seconds: 10),
    bool allowDuplicates = false,
  }) => const Stream.empty();

  @override
  Future<BotaConnectedDevice> connect(
    BotaDiscoveredDevice device, {
    String? serialNumber,
  }) => throw UnimplementedError();

  @override
  Future<BotaConnectedDevice> reconnect(
    String serialNumber, {
    BotaReconnectHint hint = const BotaReconnectHint(),
  }) => throw UnimplementedError();

  @override
  Future<void> disconnect() async {}

  @override
  Stream<BotaConnectedDevice?> get connections => const Stream.empty();

  @override
  Future<BotaDeviceStatus> readStatus() => throw UnimplementedError();

  @override
  Stream<BotaDeviceStatus> get status => const Stream.empty();

  @override
  Future<void> cancelDeviceOperation() async {}

  @override
  Future<void> startRecording(
    BotaConnectedDevice device, {
    String? requestId,
  }) async {
    calls.add('startRecording:$requestId');
  }

  @override
  Future<void> stopRecording(
    BotaConnectedDevice device, {
    String? requestId,
  }) async {}

  @override
  Future<BotaRecordingState> readRecordingState(BotaConnectedDevice device) =>
      throw UnimplementedError();

  @override
  Stream<BotaRecordingState> recordingState(BotaConnectedDevice device) =>
      const Stream.empty();

  @override
  Future<void> provision(
    BotaConnectedDevice device, {
    required String materialId,
  }) async {}

  @override
  Future<BotaConnectionSettings> readConnectionSettings(
    BotaConnectedDevice device,
  ) => throw UnimplementedError();

  @override
  Future<void> writeConnectionSettings(
    BotaConnectedDevice device,
    BotaConnectionSettings settings,
  ) async {}

  @override
  Future<BotaDeprovisionResult> deprovision(
    BotaConnectedDevice device, {
    required String materialId,
  }) => throw UnimplementedError();

  @override
  Future<void> cancelProvisioningOperation() async {}

  @override
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => throw UnimplementedError();

  @override
  Future<BotaFactoryResetCompletion?> resumePending() async => null;

  @override
  Future<BotaFactoryResetCompletion> resumeUnjournaled(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => throw UnimplementedError();

  @override
  Future<void> cancelFactoryResetOperation() async {}

  @override
  Future<List<BotaDeviceRecording>> listRecordings(
    BotaConnectedDevice device,
  ) async => const [];

  @override
  Stream<BotaRecordingSyncEvent> syncRecording(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  }) => const Stream.empty();

  @override
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(
    String sinkId,
  ) async => null;

  @override
  Future<void> confirmRecording(
    BotaConnectedDevice device,
    String recordingId,
  ) async {
    calls.add('confirm:$recordingId');
  }

  @override
  Stream<BotaUploadOwnershipEvent> observeUploadOwnership(
    BotaConnectedDevice device, {
    required String recordingId,
    required String uploadId,
    required String destinationId,
  }) => const Stream.empty();

  @override
  Future<void> cancelRecordingOperation() async {}

  @override
  Stream<BotaFirmwareProgress> updateFirmware(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  ) => const Stream.empty();

  @override
  Future<void> cancelOtaOperation() async {}

  @override
  Stream<BotaDeviceLogLine> streamLogs(BotaConnectedDevice device) =>
      const Stream.empty();

  @override
  Future<void> stopLogs() async {}

  @override
  Future<BotaWifiConfigResult> configureWifi(
    BotaConnectedDevice device,
    BotaWifiCredentials credentials, {
    required String materialId,
  }) => throw UnimplementedError();

  @override
  Future<BotaWifiConfigResult> disconnectWifi(BotaConnectedDevice device) =>
      throw UnimplementedError();

  @override
  Future<BotaWifiStatus> readWifiStatus(BotaConnectedDevice device) =>
      throw UnimplementedError();

  @override
  Stream<BotaWifiStatus> wifiStatus(BotaConnectedDevice device) =>
      const Stream.empty();

  @override
  Future<BotaWifiScanResult> scanWifi(BotaConnectedDevice device) =>
      throw UnimplementedError();

  @override
  Future<void> cancelWifiOperation() async {
    calls.add('cancelWifi');
  }
}
