import 'managers.dart';
import 'client_presence.dart';
import 'models/device.dart';
import 'models/security.dart';
import 'pigeon_platform.dart';
import 'platform.dart';

final class BotaConfiguration {
  const BotaConfiguration({
    this.applicationSupportNamespace = 'bota_app_sdk',
    this.callbacks = const BotaApplicationCallbacks(),
  });

  final String applicationSupportNamespace;
  final BotaApplicationCallbacks callbacks;

  @override
  bool operator ==(Object other) =>
      other is BotaConfiguration &&
      applicationSupportNamespace == other.applicationSupportNamespace &&
      callbacks == other.callbacks;

  @override
  int get hashCode => Object.hash(applicationSupportNamespace, callbacks);
}

/// Public entry point for one Flutter engine's Bota SDK facade.
final class BotaDeviceClient {
  factory BotaDeviceClient() => _defaultInstance;

  BotaDeviceClient._(BotaPlatform platform)
    : _platform = platform,
      _managers = BotaManagerBundle(platform);

  BotaDeviceClient.forTesting(BotaPlatform platform) : this._(platform);

  static final BotaDeviceClient _defaultInstance = BotaDeviceClient._(
    PigeonBotaPlatform(),
  );

  final BotaPlatform _platform;
  final BotaManagerBundle _managers;

  Set<BotaCapability> get capabilities =>
      Set<BotaCapability>.unmodifiable(_platform.capabilities);
  BotaDeviceManager get devices => _managers.devices;
  late final BotaClientPresence clientPresence = BotaClientPresence(_platform);
  BotaControlManager get controls => _managers.controls;
  BotaProvisioningManager get provisioning => _managers.provisioning;
  BotaFactoryResetManager get factoryReset => _managers.factoryReset;
  BotaRecordingManager get recordings => _managers.recordings;
  BotaOtaManager get ota => _managers.ota;
  BotaLogManager get logs => _managers.logs;
  BotaWifiManager get wifi => _managers.wifi;

  Future<void> configure([
    BotaConfiguration configuration = const BotaConfiguration(),
  ]) => _platform.configure(configuration);

  Future<void> destroy() => _platform.destroy();
}
