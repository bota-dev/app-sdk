import 'dart:async';
import 'package:bota_app_sdk/src/generated/bota_api.g.dart';
import 'package:bota_app_sdk/src/speech/recording_client.dart';
import 'package:bota_app_sdk/src/speech/recording_models.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'real Pigeon channels keep admission native and preserve caption target revisions',
    () async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final codec = BotaRecordingSpeechHostApi.pigeonChannelCodec;
      final channels = <BasicMessageChannel<Object?>>[];
      String? owner;
      final controls = <String>[];
      void route(String method, Object? Function(List<Object?>) body) {
        final channel = BasicMessageChannel<Object?>(
          'dev.flutter.pigeon.bota_flutter_sdk.BotaRecordingSpeechHostApi.$method',
          codec,
        );
        channels.add(channel);
        messenger.setMockDecodedMessageHandler<Object?>(
          channel,
          (message) async => [body(message as List<Object?>? ?? [])],
        );
      }

      route('start', (args) {
        owner = args[0] as String;
        expect(args[1], 'activity');
        expect(args.length, 2);
        return null;
      });
      route('changeTarget', (args) {
        expect(args[0], owner);
        expect(args[2], matches(RegExp(r'^[0-9a-f]{32}$')));
        controls.add('target:${args[1]}');
        return null;
      });
      route('qualifyHeadphones', (_) => true);
      route('finish', (_) {
        controls.add('finish');
        return null;
      });
      route('close', (_) {
        controls.add('close');
        return null;
      });
      route('destroy', (_) => null);
      addTearDown(() {
        for (final channel in channels) {
          messenger.setMockDecodedMessageHandler<Object?>(channel, null);
        }
      });
      final captions = <BotaRecordingSpeechCaption>[];
      final client = BotaRecordingSpeechClient.forTesting(
        hostApi: BotaRecordingSpeechHostApi(),
      );
      final session = await client.start(
        'activity',
        observer: BotaRecordingSpeechObserver(onCaption: captions.add),
      );
      await session.changeTarget('ja');
      await client.onEvent(
        BotaRecordingSpeechEventMessage(
          connectionId: owner!,
          caption: BotaRecordingSpeechCaptionMessage(
            unitId: 'unit',
            sourceId: 'source',
            sourceEpoch: 1,
            revision: 1,
            startSample: 0,
            endSample: 480,
            sourceLanguage: 'en',
            targetLanguage: 'de',
            text: 'earlier target',
            isFinal: true,
          ),
        ),
      );
      expect(captions.single.targetLanguage, 'de');
      expect(captions.single.revision, 1);
      expect(await session.qualifyHeadphones(), true);
      await session.finish();
      await session.close();
      await client.onEvent(
        BotaRecordingSpeechEventMessage(
          connectionId: owner!,
          status: 'interrupted',
        ),
      );
      expect(controls, ['target:ja', 'finish', 'close']);
      await client.destroy();
    },
  );
  test(
    'close during native admission fences start and subsequent controls',
    () async {
      final host = DelayedHost();
      final client = BotaRecordingSpeechClient.forTesting(hostApi: host);
      final starting = client.start('activity');
      final failed = expectLater(
        starting,
        throwsA(
          isA<BotaRecordingSpeechException>().having(
            (e) => e.code,
            'code',
            'closed',
          ),
        ),
      );
      await client.close();
      host.admitted.complete();
      await failed;
      expect(host.closes, 1);
      await client.destroy();
    },
  );
}

class DelayedHost extends BotaRecordingSpeechHostApi {
  final admitted = Completer<void>();
  int closes = 0;
  @override
  Future<void> start(String connectionId, String activityId) => admitted.future;
  @override
  Future<void> close(String connectionId) async {
    closes++;
  }

  @override
  Future<void> destroy() async {}
}
