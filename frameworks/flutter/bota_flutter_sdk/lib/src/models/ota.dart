final class BotaFirmwareImage {
  const BotaFirmwareImage({
    required this.sourceId,
    required this.version,
    required this.sizeBytes,
    required this.crc32,
  });

  /// Opaque application identifier resolved by the firmware callback.
  final String sourceId;
  final String version;
  final int sizeBytes;
  final int crc32;

  @override
  bool operator ==(Object other) =>
      other is BotaFirmwareImage &&
      sourceId == other.sourceId &&
      version == other.version &&
      sizeBytes == other.sizeBytes &&
      crc32 == other.crc32;
  @override
  int get hashCode => Object.hash(sourceId, version, sizeBytes, crc32);
}

final class BotaFirmwarePhase {
  const BotaFirmwarePhase._(this.name, [this.rawValue]);
  const BotaFirmwarePhase.unknown(int rawValue) : this._('unknown', rawValue);

  static const downloading = BotaFirmwarePhase._('downloading');
  static const awaitingDevice = BotaFirmwarePhase._('awaitingDevice');
  static const transferring = BotaFirmwarePhase._('transferring');
  static const verifying = BotaFirmwarePhase._('verifying');
  static const rebooting = BotaFirmwarePhase._('rebooting');
  static const reconnecting = BotaFirmwarePhase._('reconnecting');
  static const complete = BotaFirmwarePhase._('complete');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaFirmwarePhase &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaFirmwareProgress {
  const BotaFirmwareProgress({
    required this.phase,
    required this.completedBytes,
    required this.totalBytes,
  });

  final BotaFirmwarePhase phase;
  final int completedBytes;
  final int totalBytes;

  @override
  bool operator ==(Object other) =>
      other is BotaFirmwareProgress &&
      phase == other.phase &&
      completedBytes == other.completedBytes &&
      totalBytes == other.totalBytes;
  @override
  int get hashCode => Object.hash(phase, completedBytes, totalBytes);
}
