import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/platform.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// The maintained example is a nested package but runs in the SDK package gate.
// ignore: avoid_relative_lib_imports
import '../example/lib/main.dart';

const ValueKey<String> _scanKey = ValueKey<String>('device-console-scan');
const ValueKey<String> _connectKey = ValueKey<String>(
  'device-console-connect-device-1',
);
const ValueKey<String> _disconnectKey = ValueKey<String>(
  'device-console-disconnect',
);
const ValueKey<String> _statusKey = ValueKey<String>('device-console-status');
const ValueKey<String> _recordingsKey = ValueKey<String>(
  'device-console-recordings',
);
const ValueKey<String> _recordingRowKey = ValueKey<String>(
  'device-console-recording-recording-1',
);
const ValueKey<String> _syncKey = ValueKey<String>(
  'device-console-sync-recording-1',
);
const ValueKey<String> _serialKey = ValueKey<String>('device-console-serial');
const ValueKey<String> _connectedSerialKey = ValueKey<String>(
  'device-console-connected-serial',
);
const ValueKey<String> _wifiKey = ValueKey<String>('device-console-wifi');
const ValueKey<String> _provisionKey = ValueKey<String>(
  'device-console-provision',
);
const ValueKey<String> _otaKey = ValueKey<String>('device-console-ota');
const ValueKey<String> _removeKey = ValueKey<String>(
  'device-console-remove-only',
);
const ValueKey<String> _factoryResetKey = ValueKey<String>(
  'device-console-factory-reset',
);

void main() {
  testWidgets('confirmed recording disappears from the rendered list', (
    WidgetTester tester,
  ) async {
    final _ExamplePlatform platform = await _pumpConsole(tester);

    await _connectAndList(tester);
    expect(find.byKey(_recordingRowKey), findsOneWidget);

    await _tap(tester, _syncKey);

    expect(platform.confirmedRecordingIds, <String>['recording-1']);
    expect(find.byKey(_recordingRowKey), findsNothing);
    expect(find.text('Upload confirmed; device copy removed'), findsOneWidget);
  });

  testWidgets('disconnect removes device state and disables device actions', (
    WidgetTester tester,
  ) async {
    await _pumpConsole(tester);
    await _connectAndList(tester);
    await _tap(tester, _statusKey);
    expect(find.text('72%'), findsOneWidget);

    await _tap(tester, _disconnectKey);

    _expectDisconnected(tester);
    expect(find.text('72%'), findsNothing);
    expect(find.byKey(_recordingRowKey), findsNothing);
  });

  testWidgets('remove-only clears actions while retaining recording wording', (
    WidgetTester tester,
  ) async {
    final _ExamplePlatform platform = await _pumpConsole(tester);
    await _connectAndList(tester);

    await _tap(tester, _removeKey, settle: false);
    await tester.pumpAndSettle();
    expect(
      find.text('Recordings remain on the physical device.'),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();

    expect(platform.deprovisionGrants, <String>['deprovision-grant']);
    _expectDisconnected(tester, reconnectTargetsCleared: true);
    expect(find.text('Pairing removed; recordings retained'), findsOneWidget);
  });

  testWidgets('factory reset clears actions after destructive confirmation', (
    WidgetTester tester,
  ) async {
    final _ExamplePlatform platform = await _pumpConsole(tester);
    await _connectAndList(tester);

    await _tap(tester, _factoryResetKey, settle: false);
    await tester.pumpAndSettle();
    expect(
      find.text('This wipes every recording on the physical device.'),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
    await tester.pumpAndSettle();

    expect(platform.resetCommandIds, <String>['reset-command']);
    _expectDisconnected(tester, reconnectTargetsCleared: true);
    expect(find.text('Reset acknowledged for generation 7'), findsOneWidget);
  });
}

Future<_ExamplePlatform> _pumpConsole(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1000, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final _ExamplePlatform platform = _ExamplePlatform();
  await tester.pumpWidget(
    MaterialApp(
      home: DeviceConsoleScreen(
        client: BotaDeviceClient.forTesting(platform),
        uploadEncryptedBatch: (_, _) async {},
        deprovisionGrant: () async => 'deprovision-grant',
        factoryResetCommand: () async => const BotaFactoryResetCommand(
          commandId: 'reset-command',
          bindingGeneration: 7,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  expect(find.text('SDK ready'), findsOneWidget);
  return platform;
}

Future<void> _connectAndList(WidgetTester tester) async {
  await _tap(tester, _scanKey);
  await _tap(tester, _connectKey);
  await _tap(tester, _recordingsKey);
  expect(find.byKey(_connectedSerialKey), findsOneWidget);
}

Future<void> _tap(WidgetTester tester, Key key, {bool settle = true}) async {
  final Finder finder = find.byKey(key);
  expect(finder, findsOneWidget);
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  if (settle) await tester.pumpAndSettle();
}

void _expectDisconnected(
  WidgetTester tester, {
  bool reconnectTargetsCleared = false,
}) {
  expect(find.text('No device connected'), findsOneWidget);
  expect(find.byKey(_connectedSerialKey), findsNothing);
  expect(find.byKey(_recordingRowKey), findsNothing);
  expect(
    tester.widget<IconButton>(find.byKey(_disconnectKey)).onPressed,
    isNull,
  );
  for (final Key key in <Key>[
    _wifiKey,
    _provisionKey,
    _otaKey,
    _removeKey,
    _factoryResetKey,
  ]) {
    expect(tester.widget<ButtonStyleButton>(find.byKey(key)).onPressed, isNull);
  }
  if (reconnectTargetsCleared) {
    expect(find.byKey(_connectKey), findsNothing);
    expect(
      tester.widget<TextField>(find.byKey(_serialKey)).controller?.text,
      isEmpty,
    );
  }
}

final class _ExamplePlatform implements BotaPlatform {
  final List<String> confirmedRecordingIds = <String>[];
  final List<String> deprovisionGrants = <String>[];
  final List<String> resetCommandIds = <String>[];

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
  }) => Stream<BotaDiscoveredDevice>.value(
    BotaDiscoveredDevice(
      id: 'device-1',
      name: 'Test Bota',
      deviceType: BotaDeviceType.botaPin,
      firmwareVersion: '1.0.0',
      pairingState: BotaPairingState.paired,
      rssi: -42,
      discoveredAt: DateTime.utc(2026),
    ),
  );

  @override
  Future<BotaConnectedDevice> connect(
    BotaDiscoveredDevice device, {
    String? serialNumber,
  }) async => const BotaConnectedDevice(
    id: 'device-1',
    serialNumber: 'SN-TEST-1',
    deviceType: BotaDeviceType.botaPin,
    firmwareVersion: '1.0.0',
    isProvisioned: true,
    connectionState: BotaConnectionState.connected,
    mtu: 247,
  );

  @override
  Future<void> disconnect() async {}

  @override
  Future<BotaDeviceStatus> readStatus() async => BotaDeviceStatus(
    batteryLevel: 72,
    storageTotalMegabytes: 1024,
    storageUsedMegabytes: 128,
    state: BotaDeviceState.idle,
    pendingRecordings: 1,
    flags: const BotaDeviceFlags(
      charging: false,
      lowBattery: false,
      storageFull: false,
      wifiConnected: false,
      lteConnected: false,
      syncActive: false,
    ),
    timestamp: 1,
    lteState: BotaLteState.off,
  );

  @override
  Future<List<BotaDeviceRecording>> listRecordings(
    BotaConnectedDevice device,
  ) async => <BotaDeviceRecording>[
    BotaDeviceRecording(
      recordingId: 'recording-1',
      startedAt: DateTime.utc(2026),
      duration: const Duration(seconds: 10),
      fileSizeBytes: 4096,
      codec: BotaAudioCodec.opus16k,
      isEncrypted: true,
    ),
  ];

  @override
  Stream<BotaRecordingSyncEvent> syncRecording(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  }) => Stream<BotaRecordingSyncEvent>.value(
    const BotaRecordingSyncCompleted(localPath: '/tmp/recording-1.bota'),
  );

  @override
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(
    String sinkId,
  ) async => const BotaRecordingTransferMetadata(
    isE2EEncrypted: true,
    contentSha256Hex: 'abc123',
  );

  @override
  Future<void> confirmRecording(
    BotaConnectedDevice device,
    String recordingId,
  ) async {
    confirmedRecordingIds.add(recordingId);
  }

  @override
  Future<BotaDeprovisionResult> deprovision(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) async {
    deprovisionGrants.add(grantBlob);
    return const BotaDeprovisionResult(success: true);
  }

  @override
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) async {
    resetCommandIds.add(command.commandId);
    return BotaFactoryResetCompletion(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
