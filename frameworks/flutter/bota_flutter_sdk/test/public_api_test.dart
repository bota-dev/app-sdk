import 'dart:async';
import 'dart:io';

import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the public barrel uses only explicit documented exports', () {
    final barrel = File('lib/bota_flutter_sdk.dart').readAsStringSync();
    final exportDirectives = RegExp(
      r"export\s+'[^']+'[\s\S]*?;",
    ).allMatches(barrel).toList();
    final shownExports = RegExp(
      r"export\s+'[^']+'\s+show\s+([\s\S]*?);",
    ).allMatches(barrel).toList();
    final parsedSymbols = shownExports
        .expand(
          (directive) =>
              directive.group(1)!.split(',').map((symbol) => symbol.trim()),
        )
        .where((symbol) => symbol.isNotEmpty)
        .toList();

    expect(shownExports, hasLength(exportDirectives.length));
    expect(parsedSymbols.toSet(), _documentedBarrelExports);
    expect(parsedSymbols, hasLength(_documentedBarrelExports.length));
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

    await client.recordings.confirm(_connectedDevice, 'recording');

    expect(platform.calls, ['confirm:recording']);
  });

  test('recording controls route start and stop independently', () async {
    final platform = _FakePlatform();
    final controls = BotaDeviceClient.forTesting(platform).controls;

    await controls.startRecording(_connectedDevice, requestId: 'start-request');
    await controls.stopRecording(_connectedDevice, requestId: 'stop-request');

    expect(platform.calls, [
      'startRecording:start-request',
      'stopRecording:stop-request',
    ]);
  });

  test(
    'factory reset routes reset and unjournaled resume independently',
    () async {
      final platform = _FakePlatform();
      final factoryReset = BotaDeviceClient.forTesting(platform).factoryReset;
      const reset = BotaFactoryResetCommand(
        commandId: 'reset-command',
        bindingGeneration: 1,
      );
      const resume = BotaFactoryResetCommand(
        commandId: 'resume-command',
        bindingGeneration: 2,
      );

      expect(
        await factoryReset.reset(_connectedDevice, reset),
        const BotaFactoryResetCompletion(
          commandId: 'reset-command',
          bindingGeneration: 1,
        ),
      );
      expect(
        await factoryReset.resumeUnjournaled(_connectedDevice, resume),
        const BotaFactoryResetCompletion(
          commandId: 'resume-command',
          bindingGeneration: 2,
        ),
      );

      expect(platform.calls, [
        'reset:reset-command',
        'resumeUnjournaled:resume-command',
      ]);
    },
  );

  test('manager cancellation methods route to their native owners', () async {
    final platform = _FakePlatform();
    final client = BotaDeviceClient.forTesting(platform);

    await client.devices.cancelCurrentOperation();
    await client.provisioning.cancelCurrentOperation();
    await client.factoryReset.cancelCurrentOperation();
    await client.recordings.cancelCurrentOperation();
    await client.ota.cancelCurrentOperation();
    await client.wifi.cancelCurrentOperation();

    expect(platform.calls, [
      'cancelDevice',
      'cancelProvisioning',
      'cancelFactoryReset',
      'cancelRecording',
      'cancelOta',
      'cancelWifi',
    ]);
  });
}

const _connectedDevice = BotaConnectedDevice(
  id: 'device',
  serialNumber: 'serial',
  deviceType: BotaDeviceType.botaPin,
  firmwareVersion: '1.0.0',
  isProvisioned: true,
  connectionState: BotaConnectionState.connected,
  mtu: 256,
);

const _documentedBarrelExports = <String>{
  'BotaApplicationCallbacks',
  'BotaAudioCodec',
  'BotaBluetoothFallback',
  'BotaCapabilities',
  'BotaCapability',
  'BotaConfiguration',
  'BotaConnectedDevice',
  'BotaConnectionSettings',
  'BotaConnectionState',
  'BotaConnectionType',
  'BotaControlManager',
  'BotaDeprovisionResult',
  'BotaDeviceClient',
  'BotaDeviceFlags',
  'BotaDeviceLogLine',
  'BotaDeviceManager',
  'BotaDeviceRecording',
  'BotaDeviceState',
  'BotaDeviceStatus',
  'BotaDeviceType',
  'BotaDeviceUploadCompleted',
  'BotaDeviceUploadPreserved',
  'BotaDiscoveredDevice',
  'BotaEnabledConnections',
  'BotaErrorCode',
  'BotaFactoryResetCommand',
  'BotaFactoryResetCompletion',
  'BotaFactoryResetGrant',
  'BotaFactoryResetGrantCallback',
  'BotaFactoryResetGrantRequest',
  'BotaFactoryResetManager',
  'BotaFactoryResetResultAcknowledgement',
  'BotaFactoryResetResultCallback',
  'BotaFactoryResetResultRequest',
  'BotaFirmwareCallback',
  'BotaFirmwareImage',
  'BotaFirmwarePhase',
  'BotaFirmwareProgress',
  'BotaFirmwareRequest',
  'BotaFirmwareSource',
  'BotaHttpMethod',
  'BotaLogManager',
  'BotaLteState',
  'BotaModemInfo',
  'BotaOperation',
  'BotaOtaManager',
  'BotaPairingState',
  'BotaPowerManagement',
  'BotaProvisioningFailure',
  'BotaProvisioningManager',
  'BotaProvisioningMaterial',
  'BotaProvisioningMaterialCallback',
  'BotaProvisioningMaterialRequest',
  'BotaReconnectHint',
  'BotaRecordingInitiator',
  'BotaRecordingManager',
  'BotaRecordingState',
  'BotaRecordingSyncCompleted',
  'BotaRecordingSyncEvent',
  'BotaRecordingSyncProgress',
  'BotaRecordingTransferMetadata',
  'BotaRecordingTransferProgress',
  'BotaSdkException',
  'BotaUploadDestination',
  'BotaUploadDestinationCallback',
  'BotaUploadDestinationRequest',
  'BotaUploadOwnershipEvent',
  'BotaUploadOwnershipProgress',
  'BotaUploadOwnershipResolved',
  'BotaUploadOwnershipResult',
  'BotaWifiConfigResult',
  'BotaWifiCredentials',
  'BotaWifiManager',
  'BotaWifiNetwork',
  'BotaWifiRadioState',
  'BotaWifiScanResult',
  'BotaWifiState',
  'BotaWifiStatus',
};

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
  Future<void> cancelDeviceOperation() async {
    calls.add('cancelDevice');
  }

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
  }) async {
    calls.add('stopRecording:$requestId');
  }

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
  Future<void> cancelProvisioningOperation() async {
    calls.add('cancelProvisioning');
  }

  @override
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) async {
    calls.add('reset:${command.commandId}');
    return BotaFactoryResetCompletion(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    );
  }

  @override
  Future<BotaFactoryResetCompletion?> resumePending() async => null;

  @override
  Future<BotaFactoryResetCompletion> resumeUnjournaled(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) async {
    calls.add('resumeUnjournaled:${command.commandId}');
    return BotaFactoryResetCompletion(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    );
  }

  @override
  Future<void> cancelFactoryResetOperation() async {
    calls.add('cancelFactoryReset');
  }

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
  Future<void> cancelRecordingOperation() async {
    calls.add('cancelRecording');
  }

  @override
  Stream<BotaFirmwareProgress> updateFirmware(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  ) => const Stream.empty();

  @override
  Future<void> cancelOtaOperation() async {
    calls.add('cancelOta');
  }

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
