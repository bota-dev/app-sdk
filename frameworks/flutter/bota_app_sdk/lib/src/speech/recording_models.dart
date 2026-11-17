import '../generated/bota_api.g.dart';

final class BotaRecordingSpeechException implements Exception {
  BotaRecordingSpeechException(this.code);
  final String code;
  @override
  String toString() => 'BotaRecordingSpeechException($code)';
}

final class BotaRecordingSpeechObserver {
  const BotaRecordingSpeechObserver({this.onCaption, this.onStatus});
  final void Function(BotaRecordingSpeechCaption)? onCaption;
  final void Function(String)? onStatus;
}

/// Provisional live caption. Revision and source interval remain attached to the
/// original target; a later target change must not relabel an earlier caption.
final class BotaRecordingSpeechCaption {
  BotaRecordingSpeechCaption.fromMessage(
    BotaRecordingSpeechCaptionMessage value,
  ) : unitId = value.unitId,
      sourceId = value.sourceId,
      sourceEpoch = value.sourceEpoch,
      revision = value.revision,
      startSample = value.startSample,
      endSample = value.endSample,
      sourceLanguage = value.sourceLanguage,
      targetLanguage = value.targetLanguage,
      text = value.text,
      isFinal = value.isFinal;
  final String unitId, sourceId, sourceLanguage, text;
  final String? targetLanguage;
  final int sourceEpoch, revision, startSample, endSample;
  final bool isFinal;
  @override
  String toString() => 'BotaRecordingSpeechCaption(content redacted)';
}
