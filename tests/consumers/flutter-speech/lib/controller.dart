import 'dart:async';
import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// App-only controls. Login, role codes, grants and permission remain native.
class CompanionNativeHost {
  static const _channel = MethodChannel('dev.bota.speech.companion/host');
  Future<Map<Object?, Object?>> prepare() async =>
      (await _channel.invokeMapMethod<Object?, Object?>('prepare'))!;
  Future<bool> requestMicrophone() async =>
      await _channel.invokeMethod<bool>('microphonePermission') ?? false;
  Future<void> leave() => _channel.invokeMethod<void>('leave');
}

class CaptionPair {
  CaptionPair(this.key, this.speaker);
  final String key, speaker;
  String original = '', translation = '';
  bool originalFinal = false, translationFinal = false;
}

/// Presentation state only. The SDK's native Rust policy owns media decisions.
class CompanionController extends ChangeNotifier {
  CompanionController({BotaSpeechClient? speech, CompanionNativeHost? native})
    : _speech = speech ?? BotaSpeechClient(),
      _native = native ?? CompanionNativeHost();
  final BotaSpeechClient _speech;
  final CompanionNativeHost _native;
  Object _owner = Object();
  BotaSpeechSession? _session;
  Future<void>? _retirement;
  Timer? _originalTimer;
  Future<void>? _originalRefresh;
  BotaSpeechOriginalView? original;
  bool get active => _session != null;
  bool _disposed = false;
  bool connected = false,
      joining = false,
      closing = false,
      cleanupFailed = false;
  bool input = false, listening = false;
  String notice =
      'Join your conversation, then choose when to speak and listen.';
  String language = 'zh', _peer = '', _peerRole = 'b', _role = 'a';
  List<String> languages = const ['en', 'zh', 'ja'];
  BotaSpeechListeningMode mode = BotaSpeechListeningMode.translated;
  BotaSpeechState? state;
  final busy = <String>{};
  final pairs = <CaptionPair>[];
  int _retiredCaptionRevision = 0;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> join() async {
    if (_disposed || joining || active || connected || closing || cleanupFailed)
      return;
    final owner = _owner = Object();
    joining = true;
    notice = 'Joining…';
    _changed();
    try {
      final display = await _native.prepare();
      if (!identical(owner, _owner)) return;
      final id = display['sessionId'] as String;
      _peer = display['peerId'] as String;
      _peerRole = display['peerRole'] as String;
      _role = display['role'] as String;
      languages = List<String>.unmodifiable(
        (display['languages'] as List).cast<String>(),
      );
      language = display['language'] as String;
      mode = BotaSpeechListeningMode.values.byName(display['mode'] as String);
      _retiredCaptionRevision = 0;
      final session = await _speech.start(
        id,
        observer: BotaSpeechObserver(
          onState: (value) {
            if (!identical(owner, _owner)) return;
            state = value;
            if (!value.canCapture && original?.enabled != true) input = false;
            if (value.disconnect) {
              if (_session != null) unawaited(_disconnected(owner));
            } else {
              _changed();
            }
          },
          onCaption: (value) {
            if (identical(owner, _owner)) _caption(value);
          },
          onError: (error) {
            if (!identical(owner, _owner)) return;
            if ([
              'authorizationUnavailable',
              'bridgeOverflow',
              'bridgeUnavailable',
            ].contains(error.code)) {
              unawaited(leave('The session ended. Join again.'));
            } else {
              notice = error.code == 'playbackBlocked'
                  ? 'Audio is paused. Select Resume audio.'
                  : 'A session action could not finish.';
              _changed();
            }
          },
        ),
      );
      if (!identical(owner, _owner)) return;
      _session = session;
      state = session.state;
      connected = true;
      joining = false;
      notice = 'Connected. Use headphones for your first session.';
      await _refreshOriginal(owner);
      if (!identical(owner, _owner)) return;
      if (state?.disconnect == true) await _disconnected(owner);
      _scheduleOriginal(owner);
      _changed();
    } catch (_) {
      if (identical(owner, _owner))
        await leave('Could not join. Check the role, code and active session.');
    }
  }

  Future<void> _refreshOriginal(Object owner) {
    final pending = _originalRefresh;
    if (pending != null) return pending;
    final session = _session;
    if (session == null) return Future.value();
    final operation = () async {
      final value = await session.originalView();
      if (!identical(owner, _owner)) return;
      original = value;
      if (value.enabled) input = value.capturing;
      _changed();
    }();
    _originalRefresh = operation;
    return operation.whenComplete(() {
      if (identical(operation, _originalRefresh)) _originalRefresh = null;
    });
  }

  void _scheduleOriginal(Object owner) {
    if (!identical(owner, _owner) || _session == null) return;
    _originalTimer?.cancel();
    _originalTimer = Timer(const Duration(seconds: 2), () async {
      try {
        await _refreshOriginal(owner);
      } catch (_) {
        if (identical(owner, _owner)) {
          notice =
              'Original status is unavailable. You can still stop or leave.';
          _changed();
        }
      }
      _scheduleOriginal(owner);
    });
  }

  Future<void> _disconnected(Object owner) async {
    try {
      await _refreshOriginal(owner);
    } catch (_) {}
    if (!identical(owner, _owner)) return;
    if (original?.enabled == true && original?.rtcAvailable == false) {
      connected = false;
      listening = false;
      input = original!.capturing;
      notice =
          'Realtime audio disconnected. Stop and save your original when ready.';
      _changed();
    } else {
      await leave('The session ended. Join again with current authorization.');
    }
  }

  Future<void> finishOriginal() async {
    final session = _session, owner = _owner;
    if (session == null || busy.contains('original')) return;
    busy.add('original');
    _changed();
    try {
      await session.finishOriginal();
      await _refreshOriginal(owner);
    } catch (_) {
      if (identical(owner, _owner))
        notice = 'Original capture needs recovery and remains on this phone.';
    } finally {
      if (identical(owner, _owner)) {
        busy.remove('original');
        _changed();
      }
    }
  }

  Future<void> leave([String message = 'Left the session.']) {
    if (_retirement != null) return _retirement!;
    _owner = Object();
    _originalTimer?.cancel();
    _originalTimer = null;
    final pendingOriginal = _originalRefresh;
    _session = null;
    connected = false;
    joining = false;
    closing = true;
    input = false;
    listening = false;
    state = null;
    original = null;
    pairs.clear();
    busy.clear();
    notice = message;
    _changed();
    final done = Completer<void>();
    _retirement = done.future;
    () async {
      try {
        await Future.wait([_speech.close(), _native.leave()]);
        try {
          await pendingOriginal;
        } catch (_) {}
      } catch (_) {
        cleanupFailed = true;
        notice =
            'Audio cleanup failed. Close and reopen this App before joining again.';
      } finally {
        closing = false;
        _retirement = null;
        _changed();
        done.complete();
      }
    }();
    return done.future;
  }

  Future<bool> _run(
    String operation,
    Future<void> Function(BotaSpeechSession) action,
  ) async {
    final session = _session;
    if (!connected || session == null || busy.contains(operation)) return false;
    final owner = _owner;
    busy.add(operation);
    _changed();
    try {
      await action(session);
      return identical(owner, _owner);
    } catch (_) {
      if (identical(owner, _owner)) {
        if (session.isClosed || session.state?.disconnect == true) {
          if (session.isClosed) {
            await leave('The session ended. Join again.');
          } else {
            await _disconnected(owner);
          }
        } else {
          notice =
              'The action could not finish. Try again or leave the session.';
        }
      }
      return false;
    } finally {
      if (identical(owner, _owner)) {
        busy.remove(operation);
        _changed();
      }
    }
  }

  Future<void> setInput(bool enabled) async {
    if (busy.contains('finish')) return;
    final owner = _owner;
    if (await _run('input', (session) async {
      if (enabled) {
        if (!await _native.requestMicrophone())
          throw BotaSpeechException('unavailable');
        if (!identical(owner, _owner)) throw BotaSpeechException('closed');
      }
      await session.setInput(enabled);
    })) {
      input = enabled;
      _changed();
    }
  }

  Future<void> setListening(bool enabled) async {
    if (await _run('listen', (session) => session.setListening(enabled))) {
      listening = enabled;
      _changed();
    }
  }

  Future<void> finish() async {
    if (busy.contains('input')) return;
    input = false;
    String result = 'unavailable';
    if (await _run('finish', (session) async {
      result = (await session.finishInput()).status;
    })) {
      notice = result == 'completed'
          ? 'Input finished. Listening remains available.'
          : result == 'no_source'
          ? 'No input was started.'
          : 'Input finish was interrupted. Listening remains available.';
      _changed();
    }
  }

  Future<void> select(String value, BotaSpeechListeningMode selected) async {
    if (_session == null ||
        busy.contains('selection') ||
        !languages.contains(value))
      return;
    final oldLanguage = language, oldMode = mode;
    _retiredCaptionRevision = _session!.state?.subscriptionRevision ?? 0;
    language = value;
    mode = selected;
    pairs.clear();
    _changed();
    if (!await _run(
          'selection',
          (session) => session.changeSubscription(
            BotaSpeechSelection(
              targetLanguage: value,
              mode: selected,
              sourceParticipantIds: [_peer],
            ),
          ),
        ) &&
        connected) {
      language = oldLanguage;
      mode = oldMode;
      notice = 'Preference update failed. Leave and join again to refresh it.';
      _changed();
    }
  }

  Future<void> resumeAudio() async {
    await _run('resume', (session) => session.resumeAudio());
  }

  Future<void> recoverCaptions() async {
    String result = '';
    if (await _run('recover', (session) async {
          result = (await session.recoverCaptions()).status;
        }) &&
        result == 'unavailable') {
      notice = 'This session does not retain caption history.';
      _changed();
    }
  }

  void _caption(BotaSpeechCaption value) {
    if (value.subscriptionRevision <= _retiredCaptionRevision ||
        value.subscriptionRevision !=
            (_session?.state ?? state)?.subscriptionRevision ||
        (value.targetLanguage != null && value.targetLanguage != language))
      return;
    final key = '${value.sourceId}/${value.sourceEpoch}/${value.unitId}';
    var index = pairs.indexWhere((pair) => pair.key == key);
    if (index < 0) {
      if (pairs.length == 100) pairs.removeAt(0);
      pairs.add(
        CaptionPair(
          key,
          'Speaker ${(value.sourceParticipantId == _peer ? _peerRole : _role).toUpperCase()}',
        ),
      );
      index = pairs.length - 1;
    }
    final pair = pairs[index];
    if (value.targetLanguage == null) {
      if (pair.originalFinal && !value.isFinal) return;
      pair.original = value.text;
      pair.originalFinal = value.isFinal;
    } else {
      if (pair.translationFinal && !value.isFinal) return;
      pair.translation = value.text;
      pair.translationFinal = value.isFinal;
    }
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(leave());
    super.dispose();
  }
}
