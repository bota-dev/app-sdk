import 'package:flutter/foundation.dart';

final class BotaDeviceType {
  const BotaDeviceType._(this.name, [this.rawValue]);
  const BotaDeviceType.unknown(int rawValue) : this._('unknown', rawValue);

  static const botaPin = BotaDeviceType._('botaPin');
  static const botaPin4G = BotaDeviceType._('botaPin4G');
  static const botaNote = BotaDeviceType._('botaNote');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceType &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaPairingState {
  const BotaPairingState._(this.name, [this.rawValue]);
  const BotaPairingState.unknown(int rawValue) : this._('unknown', rawValue);

  static const unpaired = BotaPairingState._('unpaired');
  static const pairing = BotaPairingState._('pairing');
  static const paired = BotaPairingState._('paired');
  static const error = BotaPairingState._('error');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaPairingState &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

enum BotaConnectionState {
  disconnected,
  connecting,
  bonding,
  discovering,
  connected,
  disconnecting,
}

final class BotaDeviceState {
  const BotaDeviceState._(this.name, [this.rawValue]);
  const BotaDeviceState.unknown(int rawValue) : this._('unknown', rawValue);

  static const idle = BotaDeviceState._('idle');
  static const recording = BotaDeviceState._('recording');
  static const syncing = BotaDeviceState._('syncing');
  static const uploading = BotaDeviceState._('uploading');
  static const charging = BotaDeviceState._('charging');
  static const lowBattery = BotaDeviceState._('lowBattery');
  static const storageFull = BotaDeviceState._('storageFull');
  static const error = BotaDeviceState._('error');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceState &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaLteState {
  const BotaLteState._(this.name, [this.rawValue]);
  const BotaLteState.unknown(int rawValue) : this._('unknown', rawValue);

  static const off = BotaLteState._('off');
  static const searching = BotaLteState._('searching');
  static const registered = BotaLteState._('registered');
  static const connected = BotaLteState._('connected');
  static const denied = BotaLteState._('denied');
  static const noSim = BotaLteState._('noSim');
  static const error = BotaLteState._('error');
  static const lowVoltage = BotaLteState._('lowVoltage');
  static const disabled = BotaLteState._('disabled');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaLteState && name == other.name && rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaWifiRadioState {
  const BotaWifiRadioState._(this.name, [this.rawValue]);
  const BotaWifiRadioState.unknown(int rawValue) : this._('unknown', rawValue);

  static const off = BotaWifiRadioState._('off');
  static const scanning = BotaWifiRadioState._('scanning');
  static const connecting = BotaWifiRadioState._('connecting');
  static const connected = BotaWifiRadioState._('connected');
  static const connectFailed = BotaWifiRadioState._('connectFailed');
  static const noCredentials = BotaWifiRadioState._('noCredentials');
  static const disabled = BotaWifiRadioState._('disabled');
  static const error = BotaWifiRadioState._('error');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaWifiRadioState &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaDeviceFlags {
  const BotaDeviceFlags({
    required this.charging,
    required this.lowBattery,
    required this.storageFull,
    required this.wifiConnected,
    required this.lteConnected,
    required this.syncActive,
  });

  final bool charging;
  final bool lowBattery;
  final bool storageFull;
  final bool wifiConnected;
  final bool lteConnected;
  final bool syncActive;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceFlags &&
      charging == other.charging &&
      lowBattery == other.lowBattery &&
      storageFull == other.storageFull &&
      wifiConnected == other.wifiConnected &&
      lteConnected == other.lteConnected &&
      syncActive == other.syncActive;
  @override
  int get hashCode => Object.hash(
    charging,
    lowBattery,
    storageFull,
    wifiConnected,
    lteConnected,
    syncActive,
  );
}

final class BotaModemInfo {
  const BotaModemInfo({
    this.imei,
    this.iccid,
    this.operatorName,
    this.rat,
    this.band,
    this.apn,
    this.simStatus,
    this.csq,
    this.ipAddress,
    this.modemVoltage,
    this.modemFirmware,
    this.roaming,
  });

  final String? imei;
  final String? iccid;
  final String? operatorName;
  final String? rat;
  final String? band;
  final String? apn;
  final String? simStatus;
  final int? csq;
  final String? ipAddress;
  final int? modemVoltage;
  final String? modemFirmware;
  final bool? roaming;

  @override
  bool operator ==(Object other) =>
      other is BotaModemInfo &&
      imei == other.imei &&
      iccid == other.iccid &&
      operatorName == other.operatorName &&
      rat == other.rat &&
      band == other.band &&
      apn == other.apn &&
      simStatus == other.simStatus &&
      csq == other.csq &&
      ipAddress == other.ipAddress &&
      modemVoltage == other.modemVoltage &&
      modemFirmware == other.modemFirmware &&
      roaming == other.roaming;
  @override
  int get hashCode => Object.hash(
    imei,
    iccid,
    operatorName,
    rat,
    band,
    apn,
    simStatus,
    csq,
    ipAddress,
    modemVoltage,
    modemFirmware,
    roaming,
  );
}

final class BotaDeviceStatus {
  const BotaDeviceStatus({
    required this.batteryLevel,
    this.batteryMillivolts,
    required this.storageTotalMegabytes,
    required this.storageUsedMegabytes,
    required this.state,
    required this.pendingRecordings,
    this.lastTimeSyncAt,
    this.signalStrength = 0,
    required this.flags,
    required this.timestamp,
    required this.lteState,
    this.lteSignalQuality,
    this.wifiState,
    this.modemInfo,
  });

  final int batteryLevel;
  final int? batteryMillivolts;
  final int storageTotalMegabytes;
  final int storageUsedMegabytes;
  final BotaDeviceState state;
  final int pendingRecordings;
  final DateTime? lastTimeSyncAt;
  final int signalStrength;
  final BotaDeviceFlags flags;
  final int timestamp;
  final BotaLteState lteState;
  final int? lteSignalQuality;
  final BotaWifiRadioState? wifiState;
  final BotaModemInfo? modemInfo;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceStatus &&
      batteryLevel == other.batteryLevel &&
      batteryMillivolts == other.batteryMillivolts &&
      storageTotalMegabytes == other.storageTotalMegabytes &&
      storageUsedMegabytes == other.storageUsedMegabytes &&
      state == other.state &&
      pendingRecordings == other.pendingRecordings &&
      lastTimeSyncAt == other.lastTimeSyncAt &&
      signalStrength == other.signalStrength &&
      flags == other.flags &&
      timestamp == other.timestamp &&
      lteState == other.lteState &&
      lteSignalQuality == other.lteSignalQuality &&
      wifiState == other.wifiState &&
      modemInfo == other.modemInfo;
  @override
  int get hashCode => Object.hash(
    batteryLevel,
    batteryMillivolts,
    storageTotalMegabytes,
    storageUsedMegabytes,
    state,
    pendingRecordings,
    lastTimeSyncAt,
    signalStrength,
    flags,
    timestamp,
    lteState,
    lteSignalQuality,
    wifiState,
    modemInfo,
  );
}

final class BotaDiscoveredDevice {
  BotaDiscoveredDevice({
    required this.id,
    this.name,
    this.deviceType,
    this.firmwareVersion,
    this.macAddress,
    this.pairingState,
    required this.rssi,
    List<int>? manufacturerData,
    required this.discoveredAt,
  }) : _manufacturerData = manufacturerData == null
           ? null
           : List<int>.of(manufacturerData);

  final String id;
  final String? name;
  final BotaDeviceType? deviceType;
  final String? firmwareVersion;
  final String? macAddress;
  final BotaPairingState? pairingState;
  final int rssi;
  final List<int>? _manufacturerData;
  final DateTime discoveredAt;

  List<int>? get manufacturerData =>
      _manufacturerData == null ? null : List<int>.of(_manufacturerData);

  @override
  bool operator ==(Object other) =>
      other is BotaDiscoveredDevice &&
      id == other.id &&
      name == other.name &&
      deviceType == other.deviceType &&
      firmwareVersion == other.firmwareVersion &&
      macAddress == other.macAddress &&
      pairingState == other.pairingState &&
      rssi == other.rssi &&
      listEquals(_manufacturerData, other._manufacturerData) &&
      discoveredAt == other.discoveredAt;
  @override
  int get hashCode => Object.hash(
    id,
    name,
    deviceType,
    firmwareVersion,
    macAddress,
    pairingState,
    rssi,
    Object.hashAll(_manufacturerData ?? const <int>[]),
    discoveredAt,
  );
}

final class BotaConnectedDevice {
  const BotaConnectedDevice({
    required this.id,
    required this.serialNumber,
    required this.deviceType,
    required this.firmwareVersion,
    this.hardwareRevision,
    required this.isProvisioned,
    required this.connectionState,
    required this.mtu,
  });

  final String id;
  final String serialNumber;
  final BotaDeviceType deviceType;
  final String firmwareVersion;
  final String? hardwareRevision;
  final bool isProvisioned;
  final BotaConnectionState connectionState;
  final int mtu;

  @override
  bool operator ==(Object other) =>
      other is BotaConnectedDevice &&
      id == other.id &&
      serialNumber == other.serialNumber &&
      deviceType == other.deviceType &&
      firmwareVersion == other.firmwareVersion &&
      hardwareRevision == other.hardwareRevision &&
      isProvisioned == other.isProvisioned &&
      connectionState == other.connectionState &&
      mtu == other.mtu;
  @override
  int get hashCode => Object.hash(
    id,
    serialNumber,
    deviceType,
    firmwareVersion,
    hardwareRevision,
    isProvisioned,
    connectionState,
    mtu,
  );
}

final class BotaReconnectHint {
  const BotaReconnectHint({
    this.storedPeripheralId,
    this.advertisedAddress,
    this.storedName,
    this.scanTimeout = const Duration(seconds: 10),
    this.connectionTimeout = const Duration(seconds: 10),
  });

  final String? storedPeripheralId;
  final String? advertisedAddress;
  final String? storedName;
  final Duration scanTimeout;
  final Duration connectionTimeout;

  @override
  bool operator ==(Object other) =>
      other is BotaReconnectHint &&
      storedPeripheralId == other.storedPeripheralId &&
      advertisedAddress == other.advertisedAddress &&
      storedName == other.storedName &&
      scanTimeout == other.scanTimeout &&
      connectionTimeout == other.connectionTimeout;
  @override
  int get hashCode => Object.hash(
    storedPeripheralId,
    advertisedAddress,
    storedName,
    scanTimeout,
    connectionTimeout,
  );
}

enum BotaCapability {
  discovery,
  connection,
  deviceStatus,
  recordingControl,
  provisioning,
  connectionSettings,
  factoryReset,
  recordingTransfer,
  uploadOwnership,
  firmwareUpdate,
  deviceLogs,
  wifi,
}

abstract final class BotaCapabilities {
  static const Set<BotaCapability> firstBeta = {
    BotaCapability.discovery,
    BotaCapability.connection,
    BotaCapability.deviceStatus,
    BotaCapability.recordingControl,
    BotaCapability.provisioning,
    BotaCapability.connectionSettings,
    BotaCapability.factoryReset,
    BotaCapability.recordingTransfer,
    BotaCapability.uploadOwnership,
    BotaCapability.firmwareUpdate,
    BotaCapability.deviceLogs,
    BotaCapability.wifi,
  };
}

final class BotaDeviceLogLine {
  const BotaDeviceLogLine({required this.message, required this.isBacklog});

  final String message;
  final bool isBacklog;

  @override
  bool operator ==(Object other) =>
      other is BotaDeviceLogLine &&
      message == other.message &&
      isBacklog == other.isBacklog;
  @override
  int get hashCode => Object.hash(message, isBacklog);
}
