import 'dart:async';

import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:bota_flutter_sdk/src/generated/bota_api.g.dart';
import 'package:bota_flutter_sdk/src/pigeon_platform.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/in_memory_bota_host_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('each stream routes only events carrying its own valid ID', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure();
    final List<BotaDiscoveredDevice> firstEvents = <BotaDiscoveredDevice>[];
    final List<BotaDiscoveredDevice> secondEvents = <BotaDiscoveredDevice>[];

    final StreamSubscription<BotaDiscoveredDevice> first = client.devices
        .scan()
        .listen(firstEvents.add);
    final StreamSubscription<BotaDiscoveredDevice> second = client.devices
        .scan()
        .listen(secondEvents.add);
    await _flushEvents();
    final List<String> ids = _startedSubscriptionIds(host);

    expect(ids, hasLength(2));
    expect(ids.toSet(), hasLength(2));
    expect(ids, everyElement(matches(RegExp(r'^[0-9a-f]{32}$'))));

    platform.onEvent(
      BotaEventMessage(
        subscriptionId: ids[0],
        payload: BotaDiscoveredDeviceEventMessage(
          device: discoveredDeviceMessage(id: 'first'),
        ),
      ),
    );
    platform.onEvent(
      BotaEventMessage(
        subscriptionId: ids[1],
        payload: BotaDiscoveredDeviceEventMessage(
          device: discoveredDeviceMessage(id: 'second'),
        ),
      ),
    );
    await _flushEvents();

    expect(firstEvents.map((BotaDiscoveredDevice value) => value.id), <String>[
      'first',
    ]);
    expect(secondEvents.map((BotaDiscoveredDevice value) => value.id), <String>[
      'second',
    ]);

    await first.cancel();
    await second.cancel();
    platform.onEvent(
      BotaEventMessage(
        subscriptionId: ids[0],
        payload: BotaDiscoveredDeviceEventMessage(
          device: discoveredDeviceMessage(id: 'late'),
        ),
      ),
    );
    await _flushEvents();

    expect(firstEvents, hasLength(1));
    expect(secondEvents, hasLength(1));
    expect(host.cancelledSubscriptions, unorderedEquals(ids));
    expect(
      host.cancelledSubscriptions.where((String value) => value == ids[0]),
      hasLength(1),
    );

    await client.destroy();
  });

  test('all nine public streams use their typed generated request', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    final BotaDeviceClient client = BotaDeviceClient.forTesting(
      PigeonBotaPlatform(hostApi: host),
    );
    await client.configure();
    final List<StreamSubscription<Object?>> subscriptions =
        <StreamSubscription<Object?>>[
          client.devices.scan().listen((_) {}),
          client.devices.connections.listen((_) {}),
          client.devices.status.listen((_) {}),
          client.controls.recordingState(testConnectedDevice).listen((_) {}),
          client.recordings
              .sync(
                testConnectedDevice,
                testDeviceRecording,
                sinkId: 'sink',
                confirmOnCompletion: true,
              )
              .listen((_) {}),
          client.recordings
              .observeUploadOwnership(
                testConnectedDevice,
                recordingId: 'recording',
                uploadId: 'upload',
                destinationId: 'destination',
              )
              .listen((_) {}),
          client.ota
              .update(testConnectedDevice, testFirmwareImage)
              .listen((_) {}),
          client.logs.stream(testConnectedDevice).listen((_) {}),
          client.wifi.status(testConnectedDevice).listen((_) {}),
        ];
    await _flushEvents();

    final List<HostCall> starts = host.calls
        .where((HostCall call) => call.method == 'startSubscription')
        .toList();
    expect(starts.map((HostCall call) => call.value.runtimeType), <Type>[
      BotaScanSubscriptionMessage,
      BotaConnectionSubscriptionMessage,
      BotaDeviceStatusSubscriptionMessage,
      BotaRecordingStateSubscriptionMessage,
      BotaRecordingSyncSubscriptionMessage,
      BotaUploadOwnershipSubscriptionMessage,
      BotaFirmwareUpdateSubscriptionMessage,
      BotaLogSubscriptionMessage,
      BotaWifiStatusSubscriptionMessage,
    ]);
    expect(
      starts.map((HostCall call) => call.id),
      everyElement(matches(RegExp(r'^[0-9a-f]{32}$'))),
    );

    for (final StreamSubscription<Object?> subscription in subscriptions) {
      await subscription.cancel();
    }
    expect(host.cancelledSubscriptions, hasLength(9));
    expect(host.cancelledSubscriptions.toSet(), hasLength(9));

    await client.destroy();
  });

  test(
    'native stream errors cancel once and surface stable exceptions',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      await client.configure();
      final List<Object> errors = <Object>[];
      final Completer<void> done = Completer<void>();
      client.devices.scan().listen(
        (_) {},
        onError: errors.add,
        onDone: done.complete,
      );
      await _flushEvents();
      final String id = _startedSubscriptionIds(host).single;

      platform.onEvent(
        BotaEventMessage(
          subscriptionId: id,
          payload: BotaSubscriptionErrorEventMessage(
            error: BotaErrorMessage(
              code: BotaErrorCodeMessage(name: 'connectionFailed'),
              operation: BotaOperationMessage(name: 'discover'),
              retryable: true,
              detail: 'scan stopped',
            ),
          ),
        ),
      );
      await done.future;
      await _flushEvents();

      expect(errors, <Object>[
        isA<BotaSdkException>()
            .having(
              (BotaSdkException error) => error.code,
              'code',
              BotaErrorCode.connectionFailed,
            )
            .having(
              (BotaSdkException error) => error.operation,
              'operation',
              BotaOperation.discover,
            ),
      ]);
      expect(host.cancelledSubscriptions, <String>[id]);

      platform.onEvent(
        BotaEventMessage(
          subscriptionId: id,
          payload: BotaDiscoveredDeviceEventMessage(
            device: discoveredDeviceMessage(id: 'late'),
          ),
        ),
      );
      await _flushEvents();
      expect(host.cancelledSubscriptions, <String>[id]);

      await client.destroy();
    },
  );

  test('malformed native stream errors fail closed and cancel once', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
    final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
    await client.configure();
    final Completer<Object> errorCompleter = Completer<Object>();
    final Completer<void> done = Completer<void>();
    client.devices.scan().listen(
      (_) {},
      onError: errorCompleter.complete,
      onDone: done.complete,
    );
    await _flushEvents();
    final String id = _startedSubscriptionIds(host).single;
    final BotaEventMessage malformed = BotaEventMessage(
      subscriptionId: id,
      payload: BotaSubscriptionErrorEventMessage(
        error: BotaErrorMessage(
          code: BotaErrorCodeMessage(name: 'futureErrorWithoutRawValue'),
          operation: BotaOperationMessage(name: 'discover'),
          retryable: false,
          detail: 'native-secret-detail',
        ),
      ),
    );

    expect(() => platform.onEvent(malformed), returnsNormally);
    final Object error = await errorCompleter.future;
    await done.future;
    await _flushEvents();

    expect(
      error,
      isA<BotaSdkException>().having(
        (BotaSdkException value) => value.code,
        'code',
        BotaErrorCode.internal,
      ),
    );
    expect(error.toString(), isNot(contains('native-secret')));
    expect(host.cancelledSubscriptions, <String>[id]);

    expect(() => platform.onEvent(malformed), returnsNormally);
    await _flushEvents();
    expect(host.cancelledSubscriptions, <String>[id]);

    await client.destroy();
  });

  test(
    'wrong-kind events fail and cancel only their matching stream',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      await client.configure();
      final Completer<Object> errorCompleter = Completer<Object>();
      final Completer<void> done = Completer<void>();
      client.devices.scan().listen(
        (_) {},
        onError: errorCompleter.complete,
        onDone: done.complete,
      );
      await _flushEvents();
      final String id = _startedSubscriptionIds(host).single;

      platform.onEvent(
        BotaEventMessage(
          subscriptionId: id,
          payload: BotaWifiStatusEventMessage(status: wifiStatusMessage()),
        ),
      );

      expect(
        await errorCompleter.future,
        isA<BotaSdkException>().having(
          (BotaSdkException error) => error.code,
          'code',
          BotaErrorCode.unexpectedEvent,
        ),
      );
      await done.future;
      await _flushEvents();
      expect(host.cancelledSubscriptions, <String>[id]);

      await client.destroy();
    },
  );

  test(
    'destroy cancels every active stream once before host teardown',
    () async {
      final InMemoryBotaHostApi host = InMemoryBotaHostApi();
      final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
      final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
      await client.configure();
      final List<Object> errors = <Object>[];
      final List<Future<void>> dones = <Future<void>>[];
      final Completer<void> connectionDone = Completer<void>();
      final Completer<void> statusDone = Completer<void>();
      dones.addAll(<Future<void>>[connectionDone.future, statusDone.future]);
      client.devices.connections.listen(
        (_) {},
        onError: errors.add,
        onDone: connectionDone.complete,
      );
      client.devices.status.listen(
        (_) {},
        onError: errors.add,
        onDone: statusDone.complete,
      );
      await _flushEvents();
      final List<String> ids = _startedSubscriptionIds(host);

      await client.destroy();
      await Future.wait(dones);

      expect(host.cancelledSubscriptions, unorderedEquals(ids));
      expect(host.cancelledSubscriptions, hasLength(2));
      expect(
        errors,
        everyElement(
          isA<BotaSdkException>().having(
            (BotaSdkException error) => error.code,
            'code',
            BotaErrorCode.clientDestroyed,
          ),
        ),
      );
      expect(host.methodNames.last, 'destroy');

      for (final String id in ids) {
        platform.onEvent(
          BotaEventMessage(
            subscriptionId: id,
            payload: BotaSubscriptionCompleteEventMessage(),
          ),
        );
      }
      await _flushEvents();
      expect(host.cancelledSubscriptions, hasLength(2));
    },
  );

  test('a paused Dart listener cannot delay native destroy', () async {
    final InMemoryBotaHostApi host = InMemoryBotaHostApi();
    final BotaDeviceClient client = BotaDeviceClient.forTesting(
      PigeonBotaPlatform(hostApi: host),
    );
    await client.configure();
    final StreamSubscription<BotaConnectedDevice?> subscription = client
        .devices
        .connections
        .listen((_) {}, onError: (_) {});
    await _flushEvents();
    subscription.pause();

    final Future<void> destroy = client.destroy();
    await _flushEvents();
    final bool hostDestroyReached = host.methodNames.contains('destroy');
    subscription.resume();
    await destroy;

    expect(hostDestroyReached, isTrue);
    expect(host.cancelledSubscriptions, hasLength(1));
  });
}

List<String> _startedSubscriptionIds(InMemoryBotaHostApi host) => host.calls
    .where((HostCall call) => call.method == 'startSubscription')
    .map((HostCall call) => call.id)
    .toList(growable: false);

Future<void> _flushEvents() => Future<void>.delayed(Duration.zero);
