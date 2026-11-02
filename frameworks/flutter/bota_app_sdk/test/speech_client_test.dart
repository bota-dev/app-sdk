import 'dart:async';

import 'package:bota_app_sdk/src/generated/bota_api.g.dart';
import 'package:bota_app_sdk/src/speech/client.dart';
import 'package:bota_app_sdk/src/speech/models.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('legacy Pigeon device metadata retains its wire identity', () {
    final codec = BotaHostApi.pigeonChannelCodec;
    List<int> bytes(Object value) {
      final data = codec.encodeMessage(value)!;
      return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    }

    expect(bytes(BotaDeviceTypeMessage(name: 'n')), [131, 12, 2, 7, 1, 110, 0]);
    expect(bytes(BotaDeviceReferenceMessage(id: 'd')), [146, 12, 1, 7, 1, 100]);
  });

  test(
    'generated Pigeon channels carry typed controls, captions and finish results',
    () async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final codec = BotaSpeechHostApi.pigeonChannelCodec;
      const prefix = 'dev.flutter.pigeon.bota_flutter_sdk.BotaSpeechHostApi.';
      final channels = <BasicMessageChannel<Object?>>[];
      String? connectionId;
      void route(String method, Object? Function(List<Object?>) body) {
        final channel = BasicMessageChannel<Object?>('$prefix$method', codec);
        channels.add(channel);
        messenger.setMockDecodedMessageHandler<Object?>(
          channel,
          (message) async => [
            body(message == null ? [] : message as List<Object?>),
          ],
        );
      }

      route('start', (args) {
        connectionId = args[0] as String;
        expect(args[1], 'host-session');
        return state();
      });
      route('finishInput', (args) {
        expect(args.single, connectionId);
        return BotaSpeechFinishMessage(
          status: 'completed',
          holdPublication: false,
          source: BotaSpeechFinishedSourceMessage(
            id: 'source',
            epoch: '18446744073709551615',
            participantId: 'speaker',
            memberGeneration: 1,
            trackSid: 'track',
            state: 'finished',
            finishState: 'completed',
            workerGeneration: 2,
            sequence: '18446744073709551614',
            samples: '3200',
          ),
        );
      });
      route(
        'recoverCaptions',
        (_) => BotaSpeechRecoveryMessage(status: 'unavailable', hasMore: false),
      );
      route('destroy', (_) => null);
      addTearDown(() {
        for (final channel in channels) {
          messenger.setMockDecodedMessageHandler<Object?>(channel, null);
        }
      });
      final captions = <BotaSpeechCaption>[];
      final client = BotaSpeechClient();
      final session = await client.start(
        'host-session',
        observer: BotaSpeechObserver(onCaption: captions.add),
      );
      final acknowledged = Completer<Object?>();
      ServicesBinding.instance.channelBuffers.push(
        'dev.flutter.pigeon.bota_flutter_sdk.BotaSpeechFlutterApi.onEvent',
        BotaSpeechFlutterApi.pigeonChannelCodec.encodeMessage([
          BotaSpeechEventMessage(
            connectionId: connectionId!,
            caption: caption(),
          ),
        ]),
        (data) {
          acknowledged.complete(
            BotaSpeechFlutterApi.pigeonChannelCodec.decodeMessage(data),
          );
        },
      );
      expect(
        await acknowledged.future.timeout(const Duration(seconds: 5)),
        isEmpty,
      );
      expect(captions.single.text, 'private caption');
      final finished = await session.finishInput();
      expect(finished.source!.epoch, '18446744073709551615');
      expect(finished.source!.sequence, '18446744073709551614');
      expect((await session.recoverCaptions()).status, 'unavailable');
      await client.destroy();
    },
  );

  test('close retires a pending start and joins native cleanup', () async {
    final host = FakeSpeechHost();
    final client = BotaSpeechClient(hostApi: host);
    var states = 0;
    final starting = client.start(
      'host-session',
      observer: BotaSpeechObserver(onState: (_) => states++),
    );
    final rejected = expectLater(
      starting,
      throwsA(
        isA<BotaSpeechException>().having((e) => e.code, 'code', 'closed'),
      ),
    );
    final closing = client.close();
    var closed = false;
    unawaited(closing.then((_) => closed = true));
    client.onEvent(
      BotaSpeechEventMessage(connectionId: host.connectionId!, state: state()),
    );
    host.starting.complete(state());
    await rejected;
    expect(states, 0);
    expect(closed, isFalse);
    host.closing.complete();
    await closing;
    expect(host.closeCalls, 1);
    await client.destroy();
  });

  test(
    'native controls remain independent and captions retain identity',
    () async {
      final host = FakeSpeechHost()..starting.complete(state());
      final captions = <BotaSpeechCaption>[];
      final client = BotaSpeechClient(hostApi: host);
      final session = await client.start(
        'host-session',
        observer: BotaSpeechObserver(onCaption: captions.add),
      );
      await session.setInput(true);
      await session.setListening(false);
      await session.changeSubscription(
        const BotaSpeechSelection(
          targetLanguage: 'ja',
          mode: BotaSpeechListeningMode.translated,
          sourceParticipantIds: ['other'],
        ),
      );
      expect(host.controls, [
        'input:true',
        'listening:false',
        'selection:ja:translated:other',
      ]);
      client.onEvent(
        BotaSpeechEventMessage(
          connectionId: host.connectionId!,
          caption: caption(),
        ),
      );
      expect(captions.single.sourceEpoch, '18446744073709551615');
      expect(captions.single.sourceFirstSeq, '18446744073709551614');
      expect(captions.single.text, 'private caption');
      expect(captions.single.toString(), isNot(contains('private caption')));
      host.closing.complete();
      await client.destroy();
    },
  );

  test('destroy is terminal, shared and preserves cleanup failure', () async {
    final host = FakeSpeechHost()..starting.complete(state());
    final client = BotaSpeechClient(hostApi: host);
    await client.start('host-session');
    final first = client.destroy();
    final second = client.destroy();
    expect(identical(first, second), isTrue);
    final failure = expectLater(
      first,
      throwsA(
        isA<BotaSpeechException>().having(
          (e) => e.code,
          'code',
          'cleanupFailed',
        ),
      ),
    );
    host.closing.completeError(
      PlatformException(code: 'cleanupFailed', message: 'PRIVATE_TOKEN'),
    );
    await failure;
    await expectLater(
      client.start('another'),
      throwsA(
        isA<BotaSpeechException>().having((e) => e.code, 'code', 'closed'),
      ),
    );
    expect(host.destroyCalls, 1);
  });

  test(
    'old events cannot reach a replacement and callback failures close',
    () async {
      final host = FakeSpeechHost()
        ..starting.complete(state())
        ..closing.complete();
      final client = BotaSpeechClient(hostApi: host);
      await client.start('first');
      final retired = host.connectionId!;
      await client.close();
      var captions = 0;
      final replacement = await client.start(
        'second',
        observer: BotaSpeechObserver(
          onCaption: (_) {
            captions++;
            throw StateError('PRIVATE_TEXT');
          },
        ),
      );
      client.onEvent(
        BotaSpeechEventMessage(connectionId: retired, caption: caption()),
      );
      expect(captions, 0);
      client.onEvent(
        BotaSpeechEventMessage(
          connectionId: host.connectionId!,
          caption: caption(),
        ),
      );
      expect(captions, 1);
      await expectLater(
        replacement.setInput(true),
        throwsA(isA<BotaSpeechException>()),
      );
      await client.close();
      expect(host.closeCalls, 2);
      await client.destroy();
    },
  );

  test('bridge failures redact arbitrary native error details', () async {
    final host = FakeSpeechHost();
    final client = BotaSpeechClient(hostApi: host);
    final starting = client.start('host-session');
    final failed = expectLater(
      starting,
      throwsA(
        isA<BotaSpeechException>().having(
          (e) => e.toString(),
          'description',
          isNot(contains('PRIVATE_TOKEN')),
        ),
      ),
    );
    host.starting.completeError(
      PlatformException(
        code: 'unknown_PRIVATE_TOKEN',
        message: 'PRIVATE_TOKEN',
        details: 'PRIVATE_TOKEN',
      ),
    );
    host.closing.complete();
    await failed;
    await client.destroy();
  });
}

BotaSpeechStateMessage state() => BotaSpeechStateMessage(
  connected: true,
  disconnect: false,
  canCapture: false,
  canPlay: false,
  subscriptionRevision: 1,
  changeId: 0,
  clearGeneration: 0,
  clearPlayback: false,
  expiresAtMs: 5000,
  gap: false,
  tracks: [],
  recovery: BotaSpeechRecoveryMessage(status: 'idle', hasMore: false),
  sourceFinish: BotaSpeechFinishMessage(status: 'idle', holdPublication: false),
);

BotaSpeechCaptionMessage caption() => BotaSpeechCaptionMessage(
  key: 'key',
  origin: 'original',
  isFinal: true,
  subscriptionRevision: 1,
  sourceId: 'source',
  sourceEpoch: '18446744073709551615',
  sourceParticipantId: 'other',
  sourceMemberGeneration: 1,
  unitId: 'unit',
  sourceFirstSeq: '18446744073709551614',
  sourceLastSeq: '18446744073709551615',
  startMs: 0,
  endMs: 100,
  sourceLanguage: 'en',
  text: 'private caption',
);

class FakeSpeechHost extends BotaSpeechHostApi {
  final starting = Completer<BotaSpeechStateMessage>();
  final closing = Completer<void>();
  final controls = <String>[];
  String? connectionId;
  int closeCalls = 0;
  int destroyCalls = 0;
  @override
  Future<BotaSpeechStateMessage> start(String connectionId, String sessionId) {
    this.connectionId = connectionId;
    return starting.future;
  }

  @override
  Future<void> close(String connectionId) {
    closeCalls++;
    return closing.future;
  }

  @override
  Future<void> destroy() {
    destroyCalls++;
    return closing.future;
  }

  @override
  Future<void> setInput(String connectionId, bool enabled) async {
    controls.add('input:$enabled');
  }

  @override
  Future<void> setListening(String connectionId, bool enabled) async {
    controls.add('listening:$enabled');
  }

  @override
  Future<void> changeSubscription(
    String connectionId,
    BotaSpeechSelectionMessage selection,
  ) async {
    controls.add(
      'selection:${selection.targetLanguage}:${selection.mode}:${selection.sourceParticipantIds.join(',')}',
    );
  }
}
