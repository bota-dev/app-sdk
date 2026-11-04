import '../generated/bota_api.g.dart';

enum BotaSpeechListeningMode { translated, original, captionsOnly }

/// Bounded native display snapshot. Original upload and reconciliation remain
/// native and independent from RTC. Passages contain final text and capture times;
/// use the authorized backend transcript endpoint for the complete export.
final class BotaSpeechOriginalView {
  BotaSpeechOriginalView.fromMessage(BotaSpeechOriginalMessage value)
    : enabled = value.enabled,
      capturing = value.capturing,
      finished = value.finished,
      rtcAvailable = value.rtcAvailable,
      status = value.status,
      passages = List.unmodifiable(value.passages);
  final bool enabled, capturing, finished, rtcAvailable;
  final String status;
  final List<String> passages;
  @override
  String toString() => 'BotaSpeechOriginalView(content redacted)';
}

final class BotaSpeechSelection {
  const BotaSpeechSelection({
    required this.targetLanguage,
    required this.mode,
    required this.sourceParticipantIds,
  });
  final String targetLanguage;
  final BotaSpeechListeningMode mode;
  final List<String> sourceParticipantIds;
}

/// Content-free errors. Native exception messages and details are never exposed.
final class BotaSpeechException implements Exception {
  BotaSpeechException(String code)
    : code = _codes.contains(code) ? code : 'unavailable';
  final String code;
  static const _codes = {
    'invalidInput',
    'closed',
    'superseded',
    'mediaFailed',
    'mediaTimeout',
    'subscriptionUnavailable',
    'authorizationUnavailable',
    'playbackBlocked',
    'cleanupFailed',
    'captionRecoveryUnavailable',
    'captionRecoveryStale',
    'sourceFinishUnavailable',
    'sourceFinishStale',
    'sourceFinishPending',
    'unavailable',
    'busy',
    'bridgeOverflow',
    'bridgeUnavailable',
    'observerFailed',
  };
  @override
  String toString() => 'BotaSpeechException($code)';
}

/// Callbacks run synchronously when an acknowledged native message arrives.
/// Keep them short, upsert captions by key, and never log private text. Throwing
/// from a callback closes this session. There is no unbounded Dart stream queue.
final class BotaSpeechObserver {
  const BotaSpeechObserver({this.onState, this.onCaption, this.onError});
  final void Function(BotaSpeechState)? onState;
  final void Function(BotaSpeechCaption)? onCaption;
  final void Function(BotaSpeechException)? onError;
}

final class BotaSpeechTrack {
  BotaSpeechTrack.fromMessage(BotaSpeechTrackMessage value)
    : mediaTrackSid = value.mediaTrackSid,
      sourceId = value.sourceId,
      sourceEpoch = value.sourceEpoch,
      sourceParticipantId = value.sourceParticipantId,
      origin = value.origin,
      outputId = value.outputId;
  final String mediaTrackSid,
      sourceId,
      sourceEpoch,
      sourceParticipantId,
      origin;
  final String? outputId;
}

/// Recovery requests and opaque pagination cursors remain inside native code.
final class BotaSpeechRecovery {
  BotaSpeechRecovery.fromMessage(BotaSpeechRecoveryMessage value)
    : status = value.status,
      hasMore = value.hasMore;
  final String status;
  final bool hasMore;
}

final class BotaSpeechFinishedSource {
  BotaSpeechFinishedSource.fromMessage(BotaSpeechFinishedSourceMessage value)
    : id = value.id,
      epoch = value.epoch,
      participantId = value.participantId,
      memberGeneration = value.memberGeneration,
      trackSid = value.trackSid,
      state = value.state,
      finishState = value.finishState,
      workerGeneration = value.workerGeneration,
      sequence = value.sequence,
      samples = value.samples;
  final String id, epoch, participantId, trackSid, state, finishState;
  final int memberGeneration, workerGeneration;
  final String? sequence, samples;
}

final class BotaSpeechSourceFinish {
  BotaSpeechSourceFinish.fromMessage(BotaSpeechFinishMessage value)
    : status = value.status,
      holdPublication = value.holdPublication,
      trackSid = value.trackSid,
      source = value.source == null
          ? null
          : BotaSpeechFinishedSource.fromMessage(value.source!);
  final String status;
  final bool holdPublication;
  final String? trackSid;
  final BotaSpeechFinishedSource? source;
}

/// Snapshot of native Rust-owned policy, without credentials or caption text.
final class BotaSpeechState {
  BotaSpeechState.fromMessage(BotaSpeechStateMessage value)
    : connected = value.connected,
      disconnect = value.disconnect,
      canCapture = value.canCapture,
      canPlay = value.canPlay,
      subscriptionRevision = value.subscriptionRevision,
      changeId = value.changeId,
      clearGeneration = value.clearGeneration,
      clearPlayback = value.clearPlayback,
      expiresAtMs = value.expiresAtMs,
      gap = value.gap,
      tracks = List.unmodifiable(value.tracks.map(BotaSpeechTrack.fromMessage)),
      recovery = BotaSpeechRecovery.fromMessage(value.recovery),
      sourceFinish = BotaSpeechSourceFinish.fromMessage(value.sourceFinish);
  final bool connected, disconnect, canCapture, canPlay, clearPlayback, gap;
  final int subscriptionRevision, changeId, clearGeneration, expiresAtMs;
  final List<BotaSpeechTrack> tracks;
  final BotaSpeechRecovery recovery;
  final BotaSpeechSourceFinish sourceFinish;
}

/// Private caption content. Sequence/epoch strings preserve full unsigned values.
/// Upsert by [key]; never replace a final caption with a late draft.
final class BotaSpeechCaption {
  BotaSpeechCaption.fromMessage(BotaSpeechCaptionMessage value)
    : key = value.key,
      origin = value.origin,
      isFinal = value.isFinal,
      subscriptionRevision = value.subscriptionRevision,
      sequence = value.sequence,
      sourceId = value.sourceId,
      sourceEpoch = value.sourceEpoch,
      sourceParticipantId = value.sourceParticipantId,
      sourceMemberGeneration = value.sourceMemberGeneration,
      unitId = value.unitId,
      sourceFirstSeq = value.sourceFirstSeq,
      sourceLastSeq = value.sourceLastSeq,
      startMs = value.startMs,
      endMs = value.endMs,
      sourceLanguage = value.sourceLanguage,
      targetLanguage = value.targetLanguage,
      text = value.text;
  final String key, origin, sourceId, sourceEpoch, sourceParticipantId, unitId;
  final String sourceFirstSeq, sourceLastSeq, sourceLanguage, text;
  final String? sequence, targetLanguage;
  final bool isFinal;
  final int subscriptionRevision, sourceMemberGeneration;
  final double startMs, endMs;
  @override
  String toString() => 'BotaSpeechCaption(content redacted)';
}
