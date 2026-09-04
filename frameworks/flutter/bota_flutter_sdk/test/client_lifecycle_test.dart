import 'dart:async';

import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/generated/bota_api.g.dart';
import 'package:bota_flutter_sdk/src/pigeon_platform.dart';
import 'package:bota_flutter_sdk/src/request_ids.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/in_memory_bota_host_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('request IDs are unique lowercase 128-bit hexadecimal values', () {
    final Set<String> ids = List<String>.generate(
      256,
      (_) => RequestId.next(),
    ).toSet();

    expect(ids, hasLength(256));
    expect(ids, everyElement(matches(RegExp(r'^[0-9a-f]{32}$'))));
    expect(ids.every(RequestId.isValid), isTrue);
    expect(RequestId.isValid('0123456789ABCDEF0123456789ABCDEF'), isFalse);
  });

  test(
    'equivalent configure calls coalesce and conflicts fail locally',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final Completer<void> configureCompleter = Completer<void>();
      host.configureCompleter = configureCompleter;
      final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      const BotaConfiguration configuration = BotaConfiguration(
        applicationSupportNamespace: 'test-app',
      );

      final Future<void> first = client.configure(configuration);
      final Future<void> second = client.configure(configuration);

      expect(host.methodNames, <String>['configure']);
      configureCompleter.complete();
      await Future.wait(<Future<void>>[first, second]);
      await client.configure(configuration);
      expect(host.methodNames, <String>['configure']);

      await expectLater(
        client.configure(
          const BotaConfiguration(applicationSupportNamespace: 'other-app'),
        ),
        throwsA(
          isA<BotaSdkException>().having(
            (BotaSdkException error) => error.code,
            'code',
            BotaErrorCode.configurationConflict,
          ),
        ),
      );

      await client.destroy();
    },
  );

  test(
    'destroy rejects pending operations and invokes the host once',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final Completer<BotaConnectedDeviceMessage> connectCompleter =
          Completer<BotaConnectedDeviceMessage>();
      host.connectCompleter = connectCompleter;
      final BotaDeviceClient client = BotaDeviceClient.forTesting(
        PigeonBotaPlatform(hostApi: host),
      );
      await client.configure();

      final Future<BotaConnectedDevice> pending = client.devices.connect(
        discoveredDevice,
      );
      final Future<void> pendingExpectation = expectLater(
        pending,
        throwsA(
          isA<BotaSdkException>()
              .having(
                (BotaSdkException error) => error.code,
                'code',
                BotaErrorCode.clientDestroyed,
              )
              .having(
                (BotaSdkException error) => error.operation,
                'operation',
                BotaOperation.connect,
              ),
        ),
      );

      final Future<void> firstDestroy = client.destroy();
      final Future<void> secondDestroy = client.destroy();
      await Future.wait(<Future<void>>[firstDestroy, secondDestroy]);
      await pendingExpectation;

      connectCompleter.complete(connectedDeviceMessage(id: 'late-device'));
      await Future<void>.delayed(Duration.zero);

      expect(
        host.methodNames.where((String method) => method == 'destroy'),
        hasLength(1),
      );
      await expectLater(
        client.devices.disconnect(),
        throwsA(
          isA<BotaSdkException>().having(
            (BotaSdkException error) => error.code,
            'code',
            BotaErrorCode.clientDestroyed,
          ),
        ),
      );
    },
  );

  test('native structured errors become stable SDK exceptions', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    host.connectError = PlatformException(
      code: 'native_error',
      message: 'platform wrapper text',
      details: BotaErrorMessage(
        code: BotaErrorCodeMessage(name: 'timeout'),
        operation: BotaOperationMessage(name: 'connect'),
        retryable: true,
        protocolStatus: 7,
        detail: 'safe diagnostic detail',
      ),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(
      PigeonBotaPlatform(hostApi: host),
    );
    await client.configure();

    final Object error = await _captureError(
      client.devices.connect(discoveredDevice),
    );

    expect(
      error,
      isA<BotaSdkException>()
          .having(
            (BotaSdkException value) => value.code,
            'code',
            BotaErrorCode.timeout,
          )
          .having(
            (BotaSdkException value) => value.operation,
            'operation',
            BotaOperation.connect,
          )
          .having(
            (BotaSdkException value) => value.retryable,
            'retryable',
            isTrue,
          )
          .having(
            (BotaSdkException value) => value.protocolStatus,
            'protocolStatus',
            7,
          )
          .having(
            (BotaSdkException value) => value.detail,
            'detail',
            'safe diagnostic detail',
          ),
    );
    expect(error.toString(), isNot(contains('safe diagnostic detail')));

    await client.destroy();
  });

  test('malformed native errors fail closed without stranding work', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    host.connectError = PlatformException(
      code: 'native-secret-code',
      message: 'native-secret-message',
      details: BotaErrorMessage(
        code: BotaErrorCodeMessage(name: 'futureErrorWithoutRawValue'),
        operation: BotaOperationMessage(name: 'connect'),
        retryable: false,
        detail: 'native-secret-detail',
      ),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(
      PigeonBotaPlatform(hostApi: host),
    );
    await client.configure();

    final Object error = await _captureError(
      client.devices
          .connect(discoveredDevice)
          .timeout(const Duration(seconds: 1)),
    );

    expect(
      error,
      isA<BotaSdkException>().having(
        (BotaSdkException value) => value.code,
        'code',
        BotaErrorCode.internal,
      ),
    );
    expect(error.toString(), isNot(contains('native-secret')));

    await client.destroy();
  });

  test(
    'every one-shot manager operation uses its generated host route',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final BotaDeviceClient client = BotaDeviceClient.forTesting(
        PigeonBotaPlatform(hostApi: host),
      );
      await client.configure();

      await client.devices.connect(discoveredDevice, serialNumber: 'BP0001');
      await client.devices.reconnect('BP0001');
      await client.devices.disconnect();
      expect(await client.devices.readStatus(), isA<BotaDeviceStatus>());
      await client.devices.cancelCurrentOperation();
      await client.controls.startRecording(connectedDevice, requestId: 'start');
      await client.controls.stopRecording(connectedDevice, requestId: 'stop');
      expect(
        await client.controls.readRecordingState(connectedDevice),
        isA<BotaRecordingState>(),
      );
      await client.provisioning.provision(
        connectedDevice,
        materialId: 'material',
      );
      final BotaConnectionSettings settings = await client.provisioning
          .readConnectionSettings(connectedDevice);
      await client.provisioning.writeConnectionSettings(
        connectedDevice,
        settings,
      );
      expect(
        await client.provisioning.deprovision(
          connectedDevice,
          materialId: 'deprovision-material',
        ),
        const BotaDeprovisionResult(success: true),
      );
      await client.provisioning.cancelCurrentOperation();
      await client.factoryReset.reset(connectedDevice, resetCommand);
      await client.factoryReset.resumePending();
      await client.factoryReset.resumeUnjournaled(
        connectedDevice,
        resetCommand,
      );
      await client.factoryReset.cancelCurrentOperation();
      expect(await client.recordings.list(connectedDevice), hasLength(1));
      expect(
        await client.recordings.takeTransferMetadata('sink'),
        const BotaRecordingTransferMetadata(
          isE2EEncrypted: true,
          contentSha256Hex: 'ab',
        ),
      );
      await client.recordings.confirm(connectedDevice, 'recording');
      await client.recordings.cancelCurrentOperation();
      await client.ota.cancelCurrentOperation();
      await client.logs.stop();
      expect(
        await client.wifi.configure(
          connectedDevice,
          wifiCredentials,
          materialId: 'wifi-material',
        ),
        BotaWifiConfigResult.success,
      );
      expect(
        await client.wifi.disconnect(connectedDevice),
        BotaWifiConfigResult.success,
      );
      expect(
        await client.wifi.readStatus(connectedDevice),
        isA<BotaWifiStatus>(),
      );
      expect(
        await client.wifi.scan(connectedDevice),
        isA<BotaWifiScanResult>(),
      );
      await client.wifi.cancelCurrentOperation();
      await client.destroy();

      expect(host.methodNames, <String>[
        'configure',
        'connect',
        'reconnect',
        'disconnect',
        'readDeviceStatus',
        'cancelDeviceOperation',
        'startRecording',
        'stopRecording',
        'readRecordingState',
        'provision',
        'readConnectionSettings',
        'writeConnectionSettings',
        'deprovision',
        'cancelProvisioningOperation',
        'factoryReset',
        'resumePendingFactoryReset',
        'resumeUnjournaledFactoryReset',
        'cancelFactoryResetOperation',
        'listRecordings',
        'takeTransferMetadata',
        'confirmRecording',
        'cancelRecordingOperation',
        'cancelOtaOperation',
        'stopLogs',
        'configureWifi',
        'disconnectWifi',
        'readWifiStatus',
        'scanWifi',
        'cancelWifiOperation',
        'destroy',
      ]);
      expect(
        host.calls.map((HostCall call) => call.id),
        everyElement(matches(RegExp(r'^[0-9a-f]{32}$'))),
      );
    },
  );
}

Future<Object> _captureError(Future<Object?> future) async {
  try {
    await future;
  } on Object catch (error) {
    return error;
  }
  throw StateError('Expected the future to fail.');
}

final BotaDiscoveredDevice discoveredDevice = BotaDiscoveredDevice(
  id: 'peripheral',
  name: 'Bota Pin',
  deviceType: BotaDeviceType.botaPin,
  firmwareVersion: '1.2.0',
  pairingState: BotaPairingState.paired,
  rssi: -42,
  discoveredAt: DateTime.fromMillisecondsSinceEpoch(1700000000000, isUtc: true),
);

const BotaConnectedDevice connectedDevice = BotaConnectedDevice(
  id: 'peripheral',
  serialNumber: 'BP0001',
  deviceType: BotaDeviceType.botaPin,
  firmwareVersion: '1.2.0',
  isProvisioned: true,
  connectionState: BotaConnectionState.connected,
  mtu: 256,
);

const BotaFactoryResetCommand resetCommand = BotaFactoryResetCommand(
  commandId: 'reset-command',
  bindingGeneration: 3,
);

const BotaWifiCredentials wifiCredentials = BotaWifiCredentials(
  ssid: 'Bota Lab',
  password: 'password',
);
