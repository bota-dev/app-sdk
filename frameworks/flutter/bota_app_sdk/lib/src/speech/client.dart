import 'dart:async';
import 'package:flutter/services.dart';

import '../generated/bota_api.g.dart';
import '../request_ids.dart';
import 'models.dart';

/// One native speech bridge per Flutter engine. The native App installs a scoped
/// factory before [start]. No credential, audio buffer or native handle enters Dart.
/// Close each session and await [destroy] before discarding the engine.
final class BotaSpeechClient implements BotaSpeechFlutterApi {
  factory BotaSpeechClient() => _defaultInstance;

  /// Isolated host/channel seam for tests; application code uses the shared owner.
  BotaSpeechClient.forTesting({
    required BotaSpeechHostApi hostApi,
    BinaryMessenger? binaryMessenger,
  }) : this._(hostApi: hostApi, binaryMessenger: binaryMessenger);

  static final BotaSpeechClient _defaultInstance = BotaSpeechClient._();

  BotaSpeechClient._({
    BotaSpeechHostApi? hostApi,
    BinaryMessenger? binaryMessenger,
  }) : _host = hostApi ?? BotaSpeechHostApi(binaryMessenger: binaryMessenger),
       _messenger = binaryMessenger {
    BotaSpeechFlutterApi.setUp(this, binaryMessenger: binaryMessenger);
  }
  final BotaSpeechHostApi _host;
  final BinaryMessenger? _messenger;
  BotaSpeechSession? _current;
  Future<void>? _lastClose, _destroyFuture;
  bool _destroyed = false, _cleanupFailed = false;

  Future<BotaSpeechSession> start(
    String sessionId, {
    BotaSpeechObserver observer = const BotaSpeechObserver(),
  }) {
    if (_destroyed) return Future.error(BotaSpeechException('closed'));
    if (_cleanupFailed) {
      return Future.error(BotaSpeechException('cleanupFailed'));
    }
    if (_current != null) return Future.error(BotaSpeechException('busy'));
    final session = BotaSpeechSession._(this, RequestId.next(), observer);
    _current = session;
    return _start(session, sessionId);
  }

  Future<BotaSpeechSession> _start(
    BotaSpeechSession session,
    String sessionId,
  ) async {
    try {
      final result = await _host.start(session._id, sessionId);
      _active(session);
      session._state = BotaSpeechState.fromMessage(result);
      session._ready = true;
      return session;
    } catch (error) {
      if (session._active && identical(_current, session)) await close();
      throw _error(error);
    }
  }

  Future<void> close() =>
      _current == null ? _lastClose ?? Future<void>.value() : _close(_current!);

  Future<void> _close(BotaSpeechSession session) {
    final existing = session._closeFuture;
    if (existing != null) return existing;
    if (!identical(_current, session)) return Future<void>.value();
    session._active = false;
    final completer = Completer<void>();
    session._closeFuture = completer.future;
    _lastClose = completer.future;
    _performClose(
      session,
    ).then(completer.complete, onError: completer.completeError);
    return completer.future;
  }

  Future<void> _performClose(BotaSpeechSession session) async {
    try {
      await _host.close(session._id);
    } catch (_) {
      _cleanupFailed = true;
      throw BotaSpeechException('cleanupFailed');
    } finally {
      if (identical(_current, session)) _current = null;
    }
  }

  Future<void> destroy() {
    final existing = _destroyFuture;
    if (existing != null) return existing;
    _destroyed = true;
    _current?._active = false;
    final completer = Completer<void>();
    _destroyFuture = completer.future;
    _performDestroy().then(
      completer.complete,
      onError: completer.completeError,
    );
    return completer.future;
  }

  Future<void> _performDestroy() async {
    try {
      await _host.destroy();
      await _lastClose;
    } catch (_) {
      _cleanupFailed = true;
      throw BotaSpeechException('cleanupFailed');
    } finally {
      _current = null;
      BotaSpeechFlutterApi.setUp(null, binaryMessenger: _messenger);
    }
  }

  void _active(BotaSpeechSession session) {
    if (_destroyed || !session._active || !identical(_current, session)) {
      throw BotaSpeechException('closed');
    }
  }

  Future<T> _call<T>(
    BotaSpeechSession session,
    Future<T> Function() body,
  ) async {
    _active(session);
    if (!session._ready) throw BotaSpeechException('busy');
    try {
      final result = await body();
      _active(session);
      return result;
    } catch (error) {
      throw _error(error);
    }
  }

  static BotaSpeechException _error(Object error) {
    if (error is BotaSpeechException) return error;
    return BotaSpeechException(
      error is PlatformException ? error.code : 'unavailable',
    );
  }

  @override
  Future<void> onEvent(BotaSpeechEventMessage event) async {
    final session = _current;
    if (_destroyed ||
        session == null ||
        !session._active ||
        session._id != event.connectionId) {
      return;
    }
    try {
      if ([
            event.state,
            event.caption,
            event.errorCode,
          ].where((value) => value != null).length !=
          1) {
        throw BotaSpeechException('invalidInput');
      }
      if (event.state != null) {
        final state = BotaSpeechState.fromMessage(event.state!);
        session._state = state;
        session._observer.onState?.call(state);
      } else if (event.caption != null) {
        session._observer.onCaption?.call(
          BotaSpeechCaption.fromMessage(event.caption!),
        );
      } else {
        session._observer.onError?.call(BotaSpeechException(event.errorCode!));
        if (event.errorCode == 'bridgeOverflow' ||
            event.errorCode == 'bridgeUnavailable') {
          unawaited(_close(session).catchError((Object _) {}));
        }
      }
    } catch (_) {
      // Never send arbitrary application exception content back through Pigeon.
      unawaited(_close(session).catchError((Object _) {}));
    }
  }
}

/// Thin controls for one native owner. [state] is the latest native snapshot;
/// [isClosed] separately identifies retired Dart ownership.
final class BotaSpeechSession {
  BotaSpeechSession._(this._client, this._id, this._observer);
  final BotaSpeechClient _client;
  final String _id;
  final BotaSpeechObserver _observer;
  bool _active = true, _ready = false;
  BotaSpeechState? _state;
  Future<void>? _closeFuture;
  BotaSpeechState? get state => _state;
  bool get isClosed => !_active;
  Future<void> setInput(bool enabled) =>
      _client._call(this, () => _client._host.setInput(_id, enabled));
  Future<void> setListening(bool enabled) =>
      _client._call(this, () => _client._host.setListening(_id, enabled));
  Future<void> changeSubscription(BotaSpeechSelection selection) {
    final message = BotaSpeechSelectionMessage(
      targetLanguage: selection.targetLanguage,
      mode: switch (selection.mode) {
        BotaSpeechListeningMode.translated => 'translated',
        BotaSpeechListeningMode.original => 'original',
        BotaSpeechListeningMode.captionsOnly => 'captions_only',
      },
      sourceParticipantIds: List.of(selection.sourceParticipantIds),
    );
    return _client._call(
      this,
      () => _client._host.changeSubscription(_id, message),
    );
  }

  Future<void> resumeAudio() =>
      _client._call(this, () => _client._host.resumeAudio(_id));
  Future<BotaSpeechRecovery> recoverCaptions() => _client._call(
    this,
    () async => BotaSpeechRecovery.fromMessage(
      await _client._host.recoverCaptions(_id),
    ),
  );
  Future<BotaSpeechSourceFinish> finishInput() => _client._call(
    this,
    () async => BotaSpeechSourceFinish.fromMessage(
      await _client._host.finishInput(_id),
    ),
  );
  Future<void> close() => _client._close(this);
}
