import 'dart:async';
import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:bota_app_sdk/src/generated/bota_api.g.dart';
import 'package:flutter_test/flutter_test.dart';
import '../lib/controller.dart';

class NativeHost extends CompanionNativeHost {
  Completer<Map<Object?, Object?>>? pending;
  Completer<bool>? permission;
  int leaves = 0;
  @override
  Future<Map<Object?, Object?>> prepare() async => pending == null
      ? {
          'sessionId': 'session',
          'role': 'a',
          'peerRole': 'b',
          'peerId': 'peer',
          'languages': ['en', 'zh', 'ja'],
          'language': 'zh',
          'mode': 'translated',
        }
      : await pending!.future;
  @override
  Future<bool> requestMicrophone() async =>
      permission == null ? true : await permission!.future;
  @override
  Future<void> leave() async {
    leaves++;
  }
}

class SpeechHost extends BotaSpeechHostApi {
  String? id;
  int starts = 0;
  final input = <bool>[];
  bool closeFails = false;
  int revision = 1;
  BotaSpeechOriginalMessage original = BotaSpeechOriginalMessage(
    enabled: false,
    capturing: false,
    finished: false,
    rtcAvailable: true,
    status: '',
    passages: [],
  );
  @override
  Future<BotaSpeechOriginalMessage> originalView(String connectionId) async =>
      original;
  @override
  Future<void> finishOriginal(String connectionId) async {
    original.capturing = false;
    original.finished = true;
  }

  @override
  Future<BotaSpeechStateMessage> start(
    String connectionId,
    String sessionId,
  ) async {
    id = connectionId;
    starts++;
    return state();
  }

  BotaSpeechStateMessage state() => BotaSpeechStateMessage(
    connected: true,
    disconnect: false,
    canCapture: true,
    canPlay: true,
    subscriptionRevision: revision,
    changeId: 0,
    clearGeneration: 0,
    clearPlayback: false,
    expiresAtMs: 5000,
    gap: false,
    tracks: [],
    recovery: BotaSpeechRecoveryMessage(status: 'idle', hasMore: false),
    sourceFinish: BotaSpeechFinishMessage(
      status: 'idle',
      holdPublication: false,
    ),
  );
  @override
  Future<void> setInput(String connectionId, bool enabled) async {
    input.add(enabled);
  }

  @override
  Future<void> setListening(String connectionId, bool enabled) async {}
  @override
  Future<void> changeSubscription(
    String connectionId,
    BotaSpeechSelectionMessage value,
  ) async {
    revision++;
  }

  @override
  Future<BotaSpeechFinishMessage> finishInput(String connectionId) async =>
      BotaSpeechFinishMessage(status: 'completed', holdPublication: false);
  @override
  Future<void> close(String connectionId) async {
    if (closeFails) throw StateError('private cleanup details');
  }

  @override
  Future<void> destroy() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'RTC failure preserves original controls and blocks a second join',
    () async {
      final host = SpeechHost();
      host.original.enabled = true;
      host.original.capturing = true;
      final native = NativeHost();
      final client = BotaSpeechClient.forTesting(hostApi: host);
      final app = CompanionController(speech: client, native: native);
      await app.join();
      host.original.rtcAvailable = false;
      final ended = host.state()..disconnect = true;
      await client.onEvent(
        BotaSpeechEventMessage(connectionId: host.id!, state: ended),
      );
      await Future<void>.delayed(Duration.zero);
      expect(app.connected, isFalse);
      expect(app.active, isTrue);
      expect(app.input, isTrue);
      expect(native.leaves, 0);
      await app.join();
      expect(host.starts, 1);
      await app.finishOriginal();
      expect(app.original!.finished, isTrue);
      expect(app.input, isFalse);
      await app.leave();
      expect(native.leaves, 1);
      app.dispose();
      await client.destroy();
    },
  );
  test(
    'late native preparation cannot start a departed Dart session',
    () async {
      final native = NativeHost()..pending = Completer();
      final host = SpeechHost();
      final client = BotaSpeechClient.forTesting(hostApi: host);
      final app = CompanionController(speech: client, native: native);
      final joining = app.join();
      await app.leave();
      native.pending!.complete({'sessionId': 'late'});
      await joining;
      expect(host.starts, 0);
      expect(app.connected, isFalse);
      expect(native.leaves, 1);
      app.dispose();
      await client.destroy();
    },
  );
  test(
    'permission after departure cannot start input; finishing retains listening',
    () async {
      final native = NativeHost();
      final host = SpeechHost();
      final client = BotaSpeechClient.forTesting(hostApi: host);
      final app = CompanionController(speech: client, native: native);
      await app.join();
      await app.setListening(true);
      await app.setInput(true);
      await app.finish();
      expect(app.listening, isTrue);
      expect(app.input, isFalse);
      native.permission = Completer<bool>();
      final enabling = app.setInput(true);
      await app.leave();
      native.permission!.complete(true);
      await enabling;
      expect(host.input, [true]);
      expect(app.connected, isFalse);
      app.dispose();
      await client.destroy();
    },
  );
  test('failed native cleanup prevents another preparation', () async {
    final native = NativeHost();
    final host = SpeechHost();
    final client = BotaSpeechClient.forTesting(hostApi: host);
    final app = CompanionController(speech: client, native: native);
    await app.join();
    host.closeFails = true;
    await app.leave();
    await app.join();
    expect(app.cleanupFailed, isTrue);
    expect(host.starts, 1);
    expect(app.notice, isNot(contains('private cleanup details')));
    app.dispose();
    await client.destroy().catchError((Object _) {});
  });
  test(
    'paired captions are bounded, final and retired before language changes',
    () async {
      final host = SpeechHost();
      final client = BotaSpeechClient.forTesting(hostApi: host);
      final app = CompanionController(speech: client, native: NativeHost());
      await app.join();
      Future<void> caption(
        int unit, {
        String? target,
        bool finalText = true,
        String text = 'Original',
        int revision = 1,
      }) => client.onEvent(
        BotaSpeechEventMessage(
          connectionId: host.id!,
          caption: BotaSpeechCaptionMessage(
            key: '$unit/$target',
            origin: 'live',
            isFinal: finalText,
            subscriptionRevision: revision,
            sourceId: 'source',
            sourceEpoch: '18446744073709551615',
            sourceParticipantId: 'peer',
            sourceMemberGeneration: 1,
            unitId: '$unit',
            sourceFirstSeq: '$unit',
            sourceLastSeq: '$unit',
            startMs: 0,
            endMs: 100,
            sourceLanguage: 'en',
            targetLanguage: target,
            text: text,
          ),
        ),
      );
      await caption(1);
      await caption(1, target: 'zh', text: 'Translation');
      await caption(1, finalText: false, text: 'Late draft');
      expect(app.pairs.single.original, 'Original');
      expect(app.pairs.single.translation, 'Translation');
      for (var index = 2; index <= 101; index++) {
        await caption(index);
      }
      expect(app.pairs.length, 100);
      expect(app.pairs.first.key, endsWith('/2'));
      await app.select('ja', BotaSpeechListeningMode.translated);
      await caption(102);
      expect(app.pairs, isEmpty);
      await client.onEvent(
        BotaSpeechEventMessage(connectionId: host.id!, state: host.state()),
      );
      await caption(103, revision: 2, target: 'ja', text: 'New translation');
      expect(app.pairs.single.translation, 'New translation');
      await app.leave();
      expect(app.pairs, isEmpty);
      app.dispose();
      await client.destroy();
    },
  );
}
