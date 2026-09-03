import 'package:flutter/foundation.dart';

final class BotaWifiCredentials {
  const BotaWifiCredentials({required this.ssid, required this.password});

  final String ssid;
  final String password;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiCredentials &&
      ssid == other.ssid &&
      password == other.password;
  @override
  int get hashCode => Object.hash(ssid, password);
}

final class BotaWifiConfigResult {
  const BotaWifiConfigResult._(this.name, [this.rawValue]);
  const BotaWifiConfigResult.unknown(int rawValue)
    : this._('unknown', rawValue);

  static const success = BotaWifiConfigResult._('success');
  static const invalidGrant = BotaWifiConfigResult._('invalidGrant');
  static const grantExpired = BotaWifiConfigResult._('grantExpired');
  static const decryptionError = BotaWifiConfigResult._('decryptionError');
  static const storageError = BotaWifiConfigResult._('storageError');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiConfigResult &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaWifiState {
  const BotaWifiState._(this.name, [this.rawValue]);
  const BotaWifiState.unknown(int rawValue) : this._('unknown', rawValue);

  static const idle = BotaWifiState._('idle');
  static const connecting = BotaWifiState._('connecting');
  static const connected = BotaWifiState._('connected');
  static const failed = BotaWifiState._('failed');
  static const disconnected = BotaWifiState._('disconnected');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiState &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaWifiStatus {
  const BotaWifiStatus({
    required this.state,
    this.signalStrength,
    this.ssid,
    this.lastError,
  });

  final BotaWifiState state;
  final int? signalStrength;
  final String? ssid;
  final String? lastError;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiStatus &&
      state == other.state &&
      signalStrength == other.signalStrength &&
      ssid == other.ssid &&
      lastError == other.lastError;
  @override
  int get hashCode => Object.hash(state, signalStrength, ssid, lastError);
}

final class BotaWifiNetwork {
  const BotaWifiNetwork({
    required this.ssid,
    required this.quality,
    required this.isCurrent,
    required this.isOpen,
  });

  final String ssid;
  final int quality;
  final bool isCurrent;
  final bool isOpen;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiNetwork &&
      ssid == other.ssid &&
      quality == other.quality &&
      isCurrent == other.isCurrent &&
      isOpen == other.isOpen;
  @override
  int get hashCode => Object.hash(ssid, quality, isCurrent, isOpen);
}

final class BotaWifiScanResult {
  BotaWifiScanResult({
    required List<BotaWifiNetwork> networks,
    this.currentSsid,
  }) : _networks = List<BotaWifiNetwork>.unmodifiable(networks);

  final List<BotaWifiNetwork> _networks;
  final String? currentSsid;

  List<BotaWifiNetwork> get networks => _networks;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiScanResult &&
      listEquals(_networks, other._networks) &&
      currentSsid == other.currentSsid;
  @override
  int get hashCode => Object.hash(Object.hashAll(_networks), currentSsid);
}
