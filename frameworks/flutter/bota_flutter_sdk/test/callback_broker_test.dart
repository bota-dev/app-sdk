import 'dart:async';

import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/generated/bota_api.g.dart';
import 'package:bota_flutter_sdk/src/pigeon_platform.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/in_memory_bota_host_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('all callback kinds map request-bound responses', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial:
              (BotaProvisioningMaterialRequest request) async {
                expect(request.requestId, provisioningId);
                expect(request.nonce, <int>[1, 2]);
                expect(request.devicePublicKey, <int>[3, 4]);
                return BotaProvisioningMaterial(
                  requestId: request.requestId,
                  apiEndpoint: <int>[5, 6],
                  deviceToken: <int>[7, 8],
                  mtu: 256,
                );
              },
          factoryResetGrant: (BotaFactoryResetGrantRequest request) async {
            expect(request.requestId, resetId);
            return BotaFactoryResetGrant(
              requestId: request.requestId,
              grant: <int>[9, 10],
            );
          },
          persistFactoryResetResult:
              (BotaFactoryResetResultRequest request) async {
                expect(request.requestId, resetResultId);
                return BotaFactoryResetResultAcknowledgement(
                  requestId: request.requestId,
                );
              },
          firmware: (BotaFirmwareRequest request) async {
            expect(request.requestId, firmwareId);
            return BotaFirmwareSource(
              requestId: request.requestId,
              url: Uri.parse('https://download.example.test/firmware'),
              headers: const <String, String>{'x-bota': 'firmware'},
            );
          },
        ),
      ),
    );

    final BotaMaterialResponseMessage provisioning = await platform
        .requestMaterial(
          BotaProvisioningMaterialRequestMessage(
            requestId: provisioningId,
            serialNumber: 'BP0001',
            nonce: Uint8List.fromList(<int>[1, 2]),
            devicePublicKey: Uint8List.fromList(<int>[3, 4]),
          ),
        );
    final BotaMaterialResponseMessage reset = await platform.requestMaterial(
      BotaFactoryResetGrantRequestMessage(
        requestId: resetId,
        serialNumber: 'BP0001',
        nonce: Uint8List.fromList(<int>[11, 12]),
        commandId: 'reset-command',
        bindingGeneration: 3,
      ),
    );
    final BotaFirmwareSourceMessage firmware = await platform.requestFirmware(
      BotaFirmwareRequestMessage(
        requestId: firmwareId,
        sourceId: 'firmware-source',
        version: '1.2.0',
        sizeBytes: 8192,
        crc32: 1234,
      ),
    );
    final BotaFactoryResetResultAcknowledgementMessage result = await platform
        .persistFactoryResetResult(
          BotaFactoryResetResultRequestMessage(
            requestId: resetResultId,
            commandId: 'reset-command',
            bindingGeneration: 3,
            localRecordingsDeleted: 4,
          ),
        );

    expect(
      provisioning,
      isA<BotaProvisioningMaterialResponseMessage>()
          .having(
            (BotaProvisioningMaterialResponseMessage value) => value.requestId,
            'requestId',
            provisioningId,
          )
          .having(
            (BotaProvisioningMaterialResponseMessage value) =>
                value.deviceToken,
            'deviceToken',
            orderedEquals(<int>[7, 8]),
          ),
    );
    expect(
      reset,
      isA<BotaFactoryResetGrantResponseMessage>().having(
        (BotaFactoryResetGrantResponseMessage value) => value.encodedGrant,
        'encodedGrant',
        orderedEquals(<int>[9, 10]),
      ),
    );
    expect(firmware.requestId, firmwareId);
    expect(firmware.url, 'https://download.example.test/firmware');
    expect(result.requestId, resetResultId);

    await client.destroy();
  });

  test('invalid and mismatched response IDs are rejected', () async {
    var callbackCalls = 0;
    final PigeonBotaPlatform invalidPlatform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient invalidClient = BotaDeviceClient.forTesting(
      invalidPlatform,
    );
    await invalidClient.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial:
              (BotaProvisioningMaterialRequest request) async {
                callbackCalls += 1;
                return BotaProvisioningMaterial(
                  requestId: request.requestId,
                  apiEndpoint: const <int>[],
                  deviceToken: const <int>[],
                  mtu: 256,
                );
              },
        ),
      ),
    );

    await expectLater(
      invalidPlatform.requestMaterial(_provisioningRequest('INVALID')),
      throwsA(_platformError('invalid_callback_request')),
    );
    expect(callbackCalls, 0);
    await invalidClient.destroy();

    final PigeonBotaPlatform mismatchPlatform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient mismatchClient = BotaDeviceClient.forTesting(
      mismatchPlatform,
    );
    await mismatchClient.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial: (_) async => BotaProvisioningMaterial(
            requestId: resetId,
            apiEndpoint: const <int>[101, 110, 100, 112, 111, 105, 110, 116],
            deviceToken: const <int>[115, 101, 99, 114, 101, 116],
            mtu: 256,
          ),
        ),
      ),
    );

    final Object mismatch = await _captureError(
      mismatchPlatform.requestMaterial(_provisioningRequest(provisioningId)),
    );
    expect(mismatch, _platformError('callback_id_mismatch'));
    expect(mismatch.toString(), isNot(contains('endpoint')));
    expect(mismatch.toString(), isNot(contains('secret')));
    await mismatchClient.destroy();
  });

  test('duplicate and wrong-kind active IDs are rejected', () async {
    final Completer<BotaProvisioningMaterial> material =
        Completer<BotaProvisioningMaterial>();
    final PigeonBotaPlatform platform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial: (_) => material.future,
          firmware: (BotaFirmwareRequest request) async => BotaFirmwareSource(
            requestId: request.requestId,
            url: Uri.parse('https://download.example.test/firmware'),
          ),
        ),
      ),
    );

    final Future<BotaMaterialResponseMessage> first = platform.requestMaterial(
      _provisioningRequest(provisioningId),
    );
    await expectLater(
      platform.requestMaterial(_provisioningRequest(provisioningId)),
      throwsA(_platformError('duplicate_callback_request')),
    );
    await expectLater(
      platform.requestFirmware(
        BotaFirmwareRequestMessage(
          requestId: provisioningId,
          sourceId: 'firmware-source',
          version: '1.2.0',
          sizeBytes: 8192,
          crc32: 1234,
        ),
      ),
      throwsA(_platformError('callback_kind_mismatch')),
    );

    material.complete(
      BotaProvisioningMaterial(
        requestId: provisioningId,
        apiEndpoint: const <int>[1],
        deviceToken: const <int>[2],
        mtu: 256,
      ),
    );
    expect(await first, isA<BotaProvisioningMaterialResponseMessage>());

    await client.destroy();
  });

  test(
    'successful callback IDs reject same-kind and cross-kind replay',
    () async {
      var materialCalls = 0;
      var firmwareCalls = 0;
      final PigeonBotaPlatform platform = PigeonBotaPlatform(
        hostApi: InMemoryBotaHostApi(),
      );
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      await client.configure(
        BotaConfiguration(
          callbacks: BotaApplicationCallbacks(
            provisioningMaterial:
                (BotaProvisioningMaterialRequest request) async {
                  materialCalls += 1;
                  return BotaProvisioningMaterial(
                    requestId: request.requestId,
                    apiEndpoint: const <int>[1],
                    deviceToken: const <int>[2],
                    mtu: 256,
                  );
                },
            firmware: (BotaFirmwareRequest request) async {
              firmwareCalls += 1;
              return BotaFirmwareSource(
                requestId: request.requestId,
                url: Uri.parse('https://download.example.test/firmware'),
              );
            },
          ),
        ),
      );

      await platform.requestMaterial(_provisioningRequest(provisioningId));
      await expectLater(
        platform.requestMaterial(_provisioningRequest(provisioningId)),
        throwsA(_platformError('duplicate_callback_request')),
      );
      await expectLater(
        platform.requestFirmware(_firmwareRequest(provisioningId)),
        throwsA(_platformError('callback_kind_mismatch')),
      );

      expect(materialCalls, 1);
      expect(firmwareCalls, 0);
      await client.destroy();
    },
  );

  test('failed callback IDs reject same-kind and cross-kind replay', () async {
    var materialCalls = 0;
    var firmwareCalls = 0;
    final PigeonBotaPlatform platform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial: (_) async {
            materialCalls += 1;
            throw StateError('callback failed');
          },
          firmware: (BotaFirmwareRequest request) async {
            firmwareCalls += 1;
            return BotaFirmwareSource(
              requestId: request.requestId,
              url: Uri.parse('https://download.example.test/firmware'),
            );
          },
        ),
      ),
    );

    await expectLater(
      platform.requestMaterial(_provisioningRequest(provisioningId)),
      throwsA(_platformError('callback_failed')),
    );
    await expectLater(
      platform.requestMaterial(_provisioningRequest(provisioningId)),
      throwsA(_platformError('duplicate_callback_request')),
    );
    await expectLater(
      platform.requestFirmware(_firmwareRequest(provisioningId)),
      throwsA(_platformError('callback_kind_mismatch')),
    );

    expect(materialCalls, 1);
    expect(firmwareCalls, 0);
    await client.destroy();
  });

  test(
    'destroy expires pending callbacks before late results arrive',
    () async {
      final Completer<BotaProvisioningMaterial> material =
          Completer<BotaProvisioningMaterial>();
      final PigeonBotaPlatform platform = PigeonBotaPlatform(
        hostApi: InMemoryBotaHostApi(),
      );
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      await client.configure(
        BotaConfiguration(
          callbacks: BotaApplicationCallbacks(
            provisioningMaterial: (_) => material.future,
          ),
        ),
      );
      final Future<BotaMaterialResponseMessage> pending = platform
          .requestMaterial(_provisioningRequest(provisioningId));
      final Future<void> rejected = expectLater(
        pending,
        throwsA(_platformError('client_destroyed')),
      );

      await client.destroy();
      await rejected;
      material.complete(
        BotaProvisioningMaterial(
          requestId: provisioningId,
          apiEndpoint: const <int>[115, 101, 99, 114, 101, 116],
          deviceToken: const <int>[116, 111, 107, 101, 110],
          mtu: 256,
        ),
      );
      await Future<void>.delayed(Duration.zero);
    },
  );

  test('destroy releases configured callback routes', () async {
    var callbackCalls = 0;
    final PigeonBotaPlatform platform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure(
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

    await client.destroy();

    await expectLater(
      platform.requestMaterial(_provisioningRequest(provisioningId)),
      throwsA(_platformError('callback_unavailable')),
    );
    expect(callbackCalls, 0);
  });

  test('application callback failures never expose payload text', () async {
    final PigeonBotaPlatform platform = PigeonBotaPlatform(
      hostApi: InMemoryBotaHostApi(),
    );
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure(
      BotaConfiguration(
        callbacks: BotaApplicationCallbacks(
          provisioningMaterial: (_) async {
            throw StateError('deviceToken=super-secret-callback-value');
          },
        ),
      ),
    );

    final Object error = await _captureError(
      platform.requestMaterial(_provisioningRequest(provisioningId)),
    );

    expect(error, _platformError('callback_failed'));
    expect(error.toString(), isNot(contains('super-secret-callback-value')));
    expect(error.toString(), isNot(contains('deviceToken')));

    await client.destroy();
  });
}

BotaProvisioningMaterialRequestMessage _provisioningRequest(String requestId) =>
    BotaProvisioningMaterialRequestMessage(
      requestId: requestId,
      serialNumber: 'BP0001',
      nonce: Uint8List.fromList(const <int>[1, 2]),
      devicePublicKey: Uint8List.fromList(const <int>[3, 4]),
    );

BotaFirmwareRequestMessage _firmwareRequest(String requestId) =>
    BotaFirmwareRequestMessage(
      requestId: requestId,
      sourceId: 'firmware-source',
      version: '1.2.0',
      sizeBytes: 8192,
      crc32: 1234,
    );

Matcher _platformError(String code) => isA<PlatformException>().having(
  (PlatformException error) => error.code,
  'code',
  code,
);

Future<Object> _captureError(Future<Object?> future) async {
  try {
    await future;
  } on Object catch (error) {
    return error;
  }
  throw StateError('Expected the future to fail.');
}

const String provisioningId = '00000000000000000000000000000001';
const String resetId = '00000000000000000000000000000002';
const String firmwareId = '00000000000000000000000000000003';
const String resetResultId = '00000000000000000000000000000005';
