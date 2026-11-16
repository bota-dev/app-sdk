import 'dart:async';
import 'package:flutter/services.dart';

import '../generated/bota_api.g.dart';
import '../request_ids.dart';
import 'recording_models.dart';

/// One native speech bridge per Flutter engine. The native App installs a scoped
/// factory before [start]. No credential, audio buffer or native handle enters Dart.
/// Close each session and await [destroy] before discarding the engine.
final class BotaRecordingSpeechClient implements BotaRecordingSpeechFlutterApi {
  factory BotaRecordingSpeechClient() => _defaultInstance;

  /// Isolated host/channel seam for tests; application code uses the shared owner.
  BotaRecordingSpeechClient.forTesting({
    required BotaRecordingSpeechHostApi hostApi,
    BinaryMessenger? binaryMessenger,
  }) : this._(hostApi: hostApi, binaryMessenger: binaryMessenger);

  static final BotaRecordingSpeechClient _defaultInstance =
      BotaRecordingSpeechClient._();

  BotaRecordingSpeechClient._({
    BotaRecordingSpeechHostApi? hostApi,
    BinaryMessenger? binaryMessenger,
  }) : _host =
           hostApi ??
           BotaRecordingSpeechHostApi(binaryMessenger: binaryMessenger),
       _messenger = binaryMessenger {
    BotaRecordingSpeechFlutterApi.setUp(this, binaryMessenger: binaryMessenger);
  }
  final BotaRecordingSpeechHostApi _host;
  final BinaryMessenger? _messenger;
  BotaRecordingSpeechSession? _current;
  Future<void>? _lastClose, _destroyFuture;
  bool _destroyed = false, _cleanupFailed = false;

  Future<BotaRecordingSpeechSession> start(
    String activityId, {
    BotaRecordingSpeechObserver observer = const BotaRecordingSpeechObserver(),
  }) {
    if (_destroyed) return Future.error(BotaRecordingSpeechException('closed'));
    if (_cleanupFailed) {
      return Future.error(BotaRecordingSpeechException('cleanupFailed'));
    }
    if (_current != null) {
      return Future.error(BotaRecordingSpeechException('busy'));
    }
    final session = BotaRecordingSpeechSession._(
      this,
      RequestId.next(),
      observer,
    );
    _current = session;
    return _start(session, activityId);
  }

  Future<BotaRecordingSpeechSession> _start(
    BotaRecordingSpeechSession session,
    String activityId,
  ) async {
    try {
      await _host.start(session._id, activityId);
      _active(session);
      session._ready = true;
      return session;
    } catch (error) {
      if (session._active && identical(_current, session)) await close();
      throw _error(error);
    }
  }

  Future<void> close() =>
      _current == null ? _lastClose ?? Future<void>.value() : _close(_current!);

  Future<void> _close(BotaRecordingSpeechSession session) {
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

  Future<void> _performClose(BotaRecordingSpeechSession session) async {
    try {
      await _host.close(session._id);
    } catch (_) {
      _cleanupFailed = true;
      throw BotaRecordingSpeechException('cleanupFailed');
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
      throw BotaRecordingSpeechException('cleanupFailed');
    } finally {
      _current = null;
      BotaRecordingSpeechFlutterApi.setUp(null, binaryMessenger: _messenger);
    }
  }

  void _active(BotaRecordingSpeechSession session) {
    if (_destroyed || !session._active || !identical(_current, session)) {
      throw BotaRecordingSpeechException('closed');
    }
  }

  Future<T> _call<T>(
    BotaRecordingSpeechSession session,
    Future<T> Function() body,
  ) async {
    _active(session);
    if (!session._ready) throw BotaRecordingSpeechException('busy');
    try {
      final result = await body();
      _active(session);
      return result;
    } catch (error) {
      throw _error(error);
    }
  }

  static BotaRecordingSpeechException _error(Object error) {
    if (error is BotaRecordingSpeechException) return error;
    return BotaRecordingSpeechException(
      error is PlatformException ? error.code : 'unavailable',
    );
  }

  @override
  Future<void> onEvent(BotaRecordingSpeechEventMessage event) async {
    final session = _current;
    if (_destroyed ||
        session == null ||
        !session._active ||
        session._id != event.connectionId) {
      return;
    }
    try {
      if ([
            event.caption,
            event.status,
          ].where((value) => value != null).length !=
          1) {
        throw BotaRecordingSpeechException('invalidInput');
      }
      if (event.caption != null) {
        session._observer.onCaption?.call(
          BotaRecordingSpeechCaption.fromMessage(event.caption!),
        );
      } else {
        session._observer.onStatus?.call(event.status!);
        if (event.status == 'bridgeOverflow' ||
            event.status == 'bridgeUnavailable') {
          unawaited(_close(session).catchError((Object _) {}));
        }
      }
    } catch (_) {
      // Never send arbitrary application exception content back through Pigeon.
      unawaited(_close(session).catchError((Object _) {}));
    }
  }
}

/// Controls for one native direct activity. No original audio or grant crosses Dart.
final class BotaRecordingSpeechSession {
  BotaRecordingSpeechSession._(this._client, this._id, this._observer);
  final BotaRecordingSpeechClient _client;
  final String _id;
  final BotaRecordingSpeechObserver _observer;
  bool _active = true, _ready = false;
  Future<void>? _closeFuture;
  bool get isClosed => !_active;
  Future<void> changeTarget(String language) => _client._call(
    this,
    () => _client._host.changeTarget(_id, language, RequestId.next()),
  );
  Future<bool> qualifyHeadphones() =>
      _client._call(this, () => _client._host.qualifyHeadphones(_id));
  Future<void> finish() => _client._call(this, () => _client._host.finish(_id));
  Future<void> close() => _client._close(this);
}
