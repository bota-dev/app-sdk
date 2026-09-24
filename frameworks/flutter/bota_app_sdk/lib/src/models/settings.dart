import 'package:flutter/foundation.dart';

import 'device.dart';

final class BotaConnectionType {
  const BotaConnectionType._(this.name, [this.rawValue]);
  const BotaConnectionType.unknown(int rawValue) : this._('unknown', rawValue);

  static const wifi = BotaConnectionType._('wifi');
  static const ble = BotaConnectionType._('ble');
  static const cellular = BotaConnectionType._('cellular');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaConnectionType &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaEnabledConnections {
  const BotaEnabledConnections({required this.wifi, required this.cellular});

  final bool wifi;
  final bool cellular;

  @override
  bool operator ==(Object other) =>
      other is BotaEnabledConnections &&
      wifi == other.wifi &&
      cellular == other.cellular;
  @override
  int get hashCode => Object.hash(wifi, cellular);
}

final class BotaPowerManagement {
  const BotaPowerManagement({
    this.wifiIdleTimeout = const Duration(seconds: 180),
    this.cellularIdleTimeout = const Duration(seconds: 180),
  });

  final Duration wifiIdleTimeout;
  final Duration cellularIdleTimeout;

  @override
  bool operator ==(Object other) =>
      other is BotaPowerManagement &&
      wifiIdleTimeout == other.wifiIdleTimeout &&
      cellularIdleTimeout == other.cellularIdleTimeout;
  @override
  int get hashCode => Object.hash(wifiIdleTimeout, cellularIdleTimeout);
}

final class BotaConnectionSettings {
  BotaConnectionSettings({
    required this.enabledConnections,
    BotaEnabledConnections? heartbeatEnabledConnections,
    this.heartbeatUnknownMask = 0,
    required List<BotaConnectionType> uploadNetworkPreference,
    this.powerManagement = const BotaPowerManagement(),
    this.streamingEnabled = true,
    this.streamingFlushInterval = const Duration(seconds: 60),
  }) : heartbeatEnabledConnections =
           heartbeatEnabledConnections ?? enabledConnections,
       _uploadNetworkPreference = List<BotaConnectionType>.unmodifiable(
         uploadNetworkPreference,
       );

  final BotaEnabledConnections enabledConnections;
  final BotaEnabledConnections heartbeatEnabledConnections;
  final int heartbeatUnknownMask;
  final List<BotaConnectionType> _uploadNetworkPreference;
  final BotaPowerManagement powerManagement;
  final bool streamingEnabled;
  final Duration streamingFlushInterval;

  List<BotaConnectionType> get uploadNetworkPreference =>
      _uploadNetworkPreference;

  BotaConnectionSettings normalizedFor(BotaDeviceType deviceType) {
    if (deviceType != BotaDeviceType.botaNote) return this;
    return BotaConnectionSettings(
      enabledConnections: BotaEnabledConnections(
        wifi: enabledConnections.wifi,
        cellular: false,
      ),
      heartbeatEnabledConnections: BotaEnabledConnections(
        wifi: heartbeatEnabledConnections.wifi,
        cellular: false,
      ),
      heartbeatUnknownMask: heartbeatUnknownMask,
      uploadNetworkPreference: _uploadNetworkPreference
          .where((value) => value != BotaConnectionType.cellular)
          .toList(),
      powerManagement: powerManagement,
      streamingEnabled: streamingEnabled,
      streamingFlushInterval: streamingFlushInterval,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is BotaConnectionSettings &&
      enabledConnections == other.enabledConnections &&
      heartbeatEnabledConnections == other.heartbeatEnabledConnections &&
      heartbeatUnknownMask == other.heartbeatUnknownMask &&
      listEquals(_uploadNetworkPreference, other._uploadNetworkPreference) &&
      powerManagement == other.powerManagement &&
      streamingEnabled == other.streamingEnabled &&
      streamingFlushInterval == other.streamingFlushInterval;
  @override
  int get hashCode => Object.hash(
    enabledConnections,
    heartbeatEnabledConnections,
    heartbeatUnknownMask,
    Object.hashAll(_uploadNetworkPreference),
    powerManagement,
    streamingEnabled,
    streamingFlushInterval,
  );
}
