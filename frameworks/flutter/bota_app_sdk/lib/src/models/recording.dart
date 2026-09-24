final class BotaAudioCodec {
  const BotaAudioCodec._(this.name, [this.rawValue]);
  const BotaAudioCodec.unknown(int rawValue) : this._('unknown', rawValue);

  static const pcm16k = BotaAudioCodec._('pcm16k');
  static const pcm8k = BotaAudioCodec._('pcm8k');
  static const opus16k = BotaAudioCodec._('opus16k');
  static const opus8k = BotaAudioCodec._('opus8k');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaAudioCodec &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaDeviceRecording {
  const BotaDeviceRecording({
    required this.recordingId,
    required this.startedAt,
    required this.duration,
    required this.fileSizeBytes,
    required this.codec,
    required this.isEncrypted,
  });

  final String recordingId;
  final DateTime startedAt;
  final Duration duration;
  final int fileSizeBytes;
  final BotaAudioCodec codec;
  final bool isEncrypted;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceRecording &&
      recordingId == other.recordingId &&
      startedAt == other.startedAt &&
      duration == other.duration &&
      fileSizeBytes == other.fileSizeBytes &&
      codec == other.codec &&
      isEncrypted == other.isEncrypted;
  @override
  int get hashCode => Object.hash(
    recordingId,
    startedAt,
    duration,
    fileSizeBytes,
    codec,
    isEncrypted,
  );
}

final class BotaRecordingInitiator {
  const BotaRecordingInitiator._(this.name, [this.rawValue]);
  const BotaRecordingInitiator.unknown(int rawValue)
    : this._('unknown', rawValue);

  static const local = BotaRecordingInitiator._('local');
  static const remote = BotaRecordingInitiator._('remote');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingInitiator &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaRecordingState {
  const BotaRecordingState({
    required this.active,
    this.recordingId,
    this.initiatedBy = BotaRecordingInitiator.local,
  });

  final bool active;
  final String? recordingId;
  final BotaRecordingInitiator initiatedBy;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingState &&
      active == other.active &&
      recordingId == other.recordingId &&
      initiatedBy == other.initiatedBy;
  @override
  int get hashCode => Object.hash(active, recordingId, initiatedBy);
}

final class BotaRecordingTransferProgress {
  const BotaRecordingTransferProgress({
    required this.completedBytes,
    required this.totalBytes,
  });

  final int completedBytes;
  final int totalBytes;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingTransferProgress &&
      completedBytes == other.completedBytes &&
      totalBytes == other.totalBytes;
  @override
  int get hashCode => Object.hash(completedBytes, totalBytes);
}

sealed class BotaRecordingSyncEvent {
  const BotaRecordingSyncEvent();
}

final class BotaRecordingSyncProgress extends BotaRecordingSyncEvent {
  const BotaRecordingSyncProgress(this.progress);

  final BotaRecordingTransferProgress progress;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingSyncProgress && progress == other.progress;
  @override
  int get hashCode => progress.hashCode;
}

final class BotaRecordingSyncCompleted extends BotaRecordingSyncEvent {
  const BotaRecordingSyncCompleted({required this.localPath});

  final String localPath;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingSyncCompleted && localPath == other.localPath;
  @override
  int get hashCode => localPath.hashCode;
}

final class BotaRecordingTransferMetadata {
  const BotaRecordingTransferMetadata({
    required this.isE2EEncrypted,
    this.contentSha256Hex,
  });

  final bool isE2EEncrypted;
  final String? contentSha256Hex;

  @override
  bool operator ==(Object other) =>
      other is BotaRecordingTransferMetadata &&
      isE2EEncrypted == other.isE2EEncrypted &&
      contentSha256Hex == other.contentSha256Hex;
  @override
  int get hashCode => Object.hash(isE2EEncrypted, contentSha256Hex);
}

sealed class BotaUploadOwnershipResult {
  const BotaUploadOwnershipResult();
}

final class BotaDeviceUploadCompleted extends BotaUploadOwnershipResult {
  const BotaDeviceUploadCompleted();

  @override
  bool operator ==(Object other) => other is BotaDeviceUploadCompleted;
  @override
  int get hashCode => runtimeType.hashCode;
}

final class BotaDeviceUploadPreserved extends BotaUploadOwnershipResult {
  const BotaDeviceUploadPreserved({required this.uploadId});

  final String uploadId;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceUploadPreserved && uploadId == other.uploadId;
  @override
  int get hashCode => uploadId.hashCode;
}

final class BotaBluetoothFallback extends BotaUploadOwnershipResult {
  const BotaBluetoothFallback({
    required this.recordingId,
    required this.uploadId,
    required this.destinationId,
  });

  final String recordingId;
  final String uploadId;
  final String destinationId;

  @override
  bool operator ==(Object other) =>
      other is BotaBluetoothFallback &&
      recordingId == other.recordingId &&
      uploadId == other.uploadId &&
      destinationId == other.destinationId;
  @override
  int get hashCode => Object.hash(recordingId, uploadId, destinationId);
}

sealed class BotaUploadOwnershipEvent {
  const BotaUploadOwnershipEvent();
}

final class BotaUploadOwnershipProgress extends BotaUploadOwnershipEvent {
  const BotaUploadOwnershipProgress(this.progress);

  final BotaRecordingTransferProgress progress;

  @override
  bool operator ==(Object other) =>
      other is BotaUploadOwnershipProgress && progress == other.progress;
  @override
  int get hashCode => progress.hashCode;
}

final class BotaUploadOwnershipResolved extends BotaUploadOwnershipEvent {
  const BotaUploadOwnershipResolved(this.result);

  final BotaUploadOwnershipResult result;

  @override
  bool operator ==(Object other) =>
      other is BotaUploadOwnershipResolved && result == other.result;
  @override
  int get hashCode => result.hashCode;
}
