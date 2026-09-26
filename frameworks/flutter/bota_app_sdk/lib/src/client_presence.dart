import 'platform.dart';

/// SDK-owned metadata only, never a durable client identifier.
final class SdkClientContext {
  const SdkClientContext({
    required this.schemaVersion,
    required this.sessionId,
    required this.sequence,
    required this.platform,
    required this.sdkPackage,
    required this.sdkVersion,
  });

  final int schemaVersion;
  final String sessionId;
  final int sequence;
  final String platform;
  final String sdkPackage;
  final String sdkVersion;
}

/// The host explicitly relays reports through its authenticated heartbeat.
final class BotaClientPresence {
  const BotaClientPresence(this._platform);
  final BotaPlatform _platform;
  Future<SdkClientContext?> nextReport(String deviceId) =>
      _platform.nextClientPresence(deviceId);
}
