import 'dart:async';

import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:bota_app_sdk/src/generated/bota_api.g.dart';
import 'package:bota_app_sdk/src/pigeon_platform.dart';
import 'package:bota_app_sdk/src/request_ids.dart';
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
    'queued configure success cannot restore callbacks after destroy',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final Completer<void> configureCompleter = Completer<void>.sync();
      host.configureCompleter = configureCompleter;
      final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      var callbackCalls = 0;
      final Future<void> configure = client.configure(
        BotaConfiguration(
          callbacks: BotaApplicationCallbacks(
            provisioningMaterial:
                (BotaProvisioningMaterialRequest request) async {
                  callbackCalls += 1;
                  return BotaProvisioningMaterial(
                    requestId: request.requestId,
                    apiEndpoint: const <int>[1],
                    deviceToken: const <int>[2],
                    mtu: 256,
                  );
                },
          ),
        ),
      );

      configureCompleter.complete();
      final Future<void> destroy = client.destroy();
      await Future.wait(<Future<void>>[configure, destroy]);

      await expectLater(
        platform.requestMaterial(
          BotaProvisioningMaterialRequestMessage(
            requestId: '00000000000000000000000000000001',
            serialNumber: 'BP0001',
            nonce: Uint8List.fromList(const <int>[1, 2]),
            devicePublicKey: Uint8List.fromList(const <int>[3, 4]),
          ),
        ),
        throwsA(
          isA<PlatformException>().having(
            (PlatformException error) => error.code,
            'code',
            'callback_unavailable',
          ),
        ),
      );
      expect(callbackCalls, 0);
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
      code: 'bota_sdk_error',
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

  test(
    'bridge-only errors preserve stable code and public operation',
    () async {
      final List<
        ({
          String outerCode,
          BotaErrorCode expectedCode,
          BotaOperation expectedOperation,
          bool duringConfigure,
        })
      >
      cases =
          <
            ({
              String outerCode,
              BotaErrorCode expectedCode,
              BotaOperation expectedOperation,
              bool duringConfigure,
            })
          >[
            (
              outerCode: 'configuration_conflict',
              expectedCode: BotaErrorCode.configurationConflict,
              expectedOperation: BotaOperation.validate,
              duringConfigure: true,
            ),
            (
              outerCode: 'operation_not_owned',
              expectedCode: BotaErrorCode.operationNotOwned,
              expectedOperation: BotaOperation.connect,
              duringConfigure: false,
            ),
            (
              outerCode: 'device_not_found',
              expectedCode: BotaErrorCode.deviceNotFound,
              expectedOperation: BotaOperation.connect,
              duringConfigure: false,
            ),
            (
              outerCode: 'engine_detached',
              expectedCode: BotaErrorCode.clientDestroyed,
              expectedOperation: BotaOperation.connect,
              duringConfigure: false,
            ),
          ];

      for (final testCase in cases) {
        final InMemoryBotaHostApi host = InMemoryBotaHostApi();
        final PlatformException bridgeFailure = PlatformException(
          code: testCase.outerCode,
          message: 'native-secret-message-${testCase.outerCode}',
          details: BotaErrorMessage(
            code: BotaErrorCodeMessage(name: 'invalidInput'),
            operation: BotaOperationMessage(name: 'validate'),
            retryable: false,
            detail: 'native-secret-detail-${testCase.outerCode}',
          ),
        );
        if (testCase.duringConfigure) {
          host.configureError = bridgeFailure;
        } else {
          host.connectError = bridgeFailure;
        }
        final BotaDeviceClient client = BotaDeviceClient.forTesting(
          PigeonBotaPlatform(hostApi: host),
        );

        final Object error;
        if (testCase.duringConfigure) {
          error = await _captureError(client.configure());
        } else {
          await client.configure();
          error = await _captureError(client.devices.connect(discoveredDevice));
        }

        expect(
          error,
          isA<BotaSdkException>()
              .having(
                (BotaSdkException value) => value.code,
                'code',
                testCase.expectedCode,
              )
              .having(
                (BotaSdkException value) => value.operation,
                'operation',
                testCase.expectedOperation,
              )
              .having(
                (BotaSdkException value) => value.detail,
                'detail',
                isNot(contains('native-secret')),
              ),
          reason: testCase.outerCode,
        );
        expect(error.toString(), isNot(contains('native-secret')));
        await client.destroy();
      }
    },
  );

  test('malformed and unknown native errors fail closed', () async {
    final List<PlatformException> failures = <PlatformException>[
      PlatformException(
        code: 'bota_sdk_error',
        message: 'native-secret-message-malformed',
        details: BotaErrorMessage(
          code: BotaErrorCodeMessage(name: 'futureErrorWithoutRawValue'),
          operation: BotaOperationMessage(name: 'connect'),
          retryable: false,
          detail: 'native-secret-detail-malformed',
        ),
      ),
      PlatformException(
        code: 'future_bridge_code',
        message: 'native-secret-message-unknown',
        details: BotaErrorMessage(
          code: BotaErrorCodeMessage(name: 'timeout'),
          operation: BotaOperationMessage(name: 'validate'),
          retryable: true,
          detail: 'native-secret-detail-unknown',
        ),
      ),
    ];

    for (final PlatformException failure in failures) {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi()
        ..connectError = failure;
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
        isA<BotaSdkException>()
            .having(
              (BotaSdkException value) => value.code,
              'code',
              BotaErrorCode.internal,
            )
            .having(
              (BotaSdkException value) => value.operation,
              'operation',
              BotaOperation.connect,
            )
            .having(
              (BotaSdkException value) => value.detail,
              'detail',
              isNot(contains('native-secret')),
            ),
        reason: failure.code,
      );
      expect(error.toString(), isNot(contains('native-secret')));

      await client.destroy();
    }
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
      await client.controls.startRecording(
        connectedDevice,
        grantBlob: 'start-grant',
      );
      await client.controls.stopRecording(
        connectedDevice,
        grantBlob: 'stop-grant',
      );
      expect(
        await client.controls.readRecordingState(connectedDevice),
        isA<BotaRecordingState>(),
      );
      await client.provisioning.provision(connectedDevice);
      final BotaConnectionSettings settings = await client.provisioning
          .readConnectionSettings(connectedDevice);
      await client.provisioning.writeConnectionSettings(
        connectedDevice,
        settings,
      );
      expect(
        await client.provisioning.deprovision(
          connectedDevice,
          grantBlob: 'deprovision-grant',
        ),
        const BotaDeprovisionResult(success: true),
      );
      await client.provisioning.cancelCurrentOperation();
      await client.factoryReset.reset(connectedDevice, resetCommand);
      await client.factoryReset.resumePending(
        connectedDevice,
        currentBindingGeneration: 4,
      );
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
          grantBlob: 'wifi-grant',
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
