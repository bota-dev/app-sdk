import 'package:flutter/foundation.dart';

final class BotaProvisioningMaterialRequest {
  BotaProvisioningMaterialRequest({
    required this.requestId,
    required this.serialNumber,
    required List<int> nonce,
    required List<int> devicePublicKey,
  }) : _nonce = List<int>.of(nonce),
       _devicePublicKey = List<int>.of(devicePublicKey);

  final String requestId;
  final String serialNumber;
  final List<int> _nonce;
  final List<int> _devicePublicKey;

  List<int> get nonce => List<int>.of(_nonce);
  List<int> get devicePublicKey => List<int>.of(_devicePublicKey);

  @override
  bool operator ==(Object other) =>
      other is BotaProvisioningMaterialRequest &&
      requestId == other.requestId &&
      serialNumber == other.serialNumber &&
      listEquals(_nonce, other._nonce) &&
      listEquals(_devicePublicKey, other._devicePublicKey);
  @override
  int get hashCode => Object.hash(
    requestId,
    serialNumber,
    Object.hashAll(_nonce),
    Object.hashAll(_devicePublicKey),
  );
}

final class BotaProvisioningMaterial {
  BotaProvisioningMaterial({
    required this.requestId,
    required List<int> apiEndpoint,
    required List<int> deviceToken,
    required this.mtu,
  }) : _apiEndpoint = List<int>.of(apiEndpoint),
       _deviceToken = List<int>.of(deviceToken);

  final String requestId;
  final List<int> _apiEndpoint;
  final List<int> _deviceToken;
  final int mtu;

  List<int> get apiEndpoint => List<int>.of(_apiEndpoint);
  List<int> get deviceToken => List<int>.of(_deviceToken);

  @override
  bool operator ==(Object other) =>
      other is BotaProvisioningMaterial &&
      requestId == other.requestId &&
      listEquals(_apiEndpoint, other._apiEndpoint) &&
      listEquals(_deviceToken, other._deviceToken) &&
      mtu == other.mtu;
  @override
  int get hashCode => Object.hash(
    requestId,
    Object.hashAll(_apiEndpoint),
    Object.hashAll(_deviceToken),
    mtu,
  );
}

final class BotaProvisioningFailure {
  const BotaProvisioningFailure._(this.name, [this.rawValue]);
  const BotaProvisioningFailure.unknown(int rawValue)
    : this._('unknown', rawValue);

  static const invalidToken = BotaProvisioningFailure._('invalidToken');
  static const storageError = BotaProvisioningFailure._('storageError');
  static const chunkError = BotaProvisioningFailure._('chunkError');
  static const alreadyPaired = BotaProvisioningFailure._('alreadyPaired');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaProvisioningFailure &&
      name == other.name &&
      rawValue == other.rawValue;
  @override
  int get hashCode => Object.hash(name, rawValue);
  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

final class BotaDeprovisionResult {
  const BotaDeprovisionResult({required this.success, this.error});

  final bool success;
  final BotaProvisioningFailure? error;

  @override
  bool operator ==(Object other) =>
      other is BotaDeprovisionResult &&
      success == other.success &&
      error == other.error;
  @override
  int get hashCode => Object.hash(success, error);
}

final class BotaFactoryResetCommand {
  const BotaFactoryResetCommand({
    required this.commandId,
    required this.bindingGeneration,
  });

  final String commandId;
  final int bindingGeneration;

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetCommand &&
      commandId == other.commandId &&
      bindingGeneration == other.bindingGeneration;
  @override
  int get hashCode => Object.hash(commandId, bindingGeneration);
}

final class BotaFactoryResetGrantRequest {
  BotaFactoryResetGrantRequest({
    required this.requestId,
    required this.serialNumber,
    required List<int> nonce,
    required this.commandId,
    required this.bindingGeneration,
  }) : _nonce = List<int>.of(nonce);

  final String requestId;
  final String serialNumber;
  final List<int> _nonce;
  final String commandId;
  final int bindingGeneration;

  List<int> get nonce => List<int>.of(_nonce);

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetGrantRequest &&
      requestId == other.requestId &&
      serialNumber == other.serialNumber &&
      listEquals(_nonce, other._nonce) &&
      commandId == other.commandId &&
      bindingGeneration == other.bindingGeneration;
  @override
  int get hashCode => Object.hash(
    requestId,
    serialNumber,
    Object.hashAll(_nonce),
    commandId,
    bindingGeneration,
  );
}

final class BotaFactoryResetGrant {
  BotaFactoryResetGrant({required this.requestId, required List<int> grant})
    : _grant = List<int>.of(grant);

  final String requestId;
  final List<int> _grant;

  List<int> get grant => List<int>.of(_grant);

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetGrant &&
      requestId == other.requestId &&
      listEquals(_grant, other._grant);
  @override
  int get hashCode => Object.hash(requestId, Object.hashAll(_grant));
}

final class BotaFactoryResetResultRequest {
  const BotaFactoryResetResultRequest({
    required this.requestId,
    required this.commandId,
    required this.bindingGeneration,
    required this.localRecordingsDeleted,
  });

  final String requestId;
  final String commandId;
  final int bindingGeneration;
  final int localRecordingsDeleted;

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetResultRequest &&
      requestId == other.requestId &&
      commandId == other.commandId &&
      bindingGeneration == other.bindingGeneration &&
      localRecordingsDeleted == other.localRecordingsDeleted;
  @override
  int get hashCode => Object.hash(
    requestId,
    commandId,
    bindingGeneration,
    localRecordingsDeleted,
  );
}

final class BotaFactoryResetResultAcknowledgement {
  const BotaFactoryResetResultAcknowledgement({required this.requestId});

  final String requestId;

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetResultAcknowledgement &&
      requestId == other.requestId;
  @override
  int get hashCode => requestId.hashCode;
}

final class BotaFactoryResetCompletion {
  const BotaFactoryResetCompletion({
    required this.commandId,
    required this.bindingGeneration,
  });

  final String commandId;
  final int bindingGeneration;

  @override
  bool operator ==(Object other) =>
      other is BotaFactoryResetCompletion &&
      commandId == other.commandId &&
      bindingGeneration == other.bindingGeneration;
  @override
  int get hashCode => Object.hash(commandId, bindingGeneration);
}

final class BotaFirmwareRequest {
  const BotaFirmwareRequest({
    required this.requestId,
    required this.sourceId,
    required this.version,
    required this.sizeBytes,
    required this.crc32,
  });

  final String requestId;
  final String sourceId;
  final String version;
  final int sizeBytes;
  final int crc32;

  @override
  bool operator ==(Object other) =>
      other is BotaFirmwareRequest &&
      requestId == other.requestId &&
      sourceId == other.sourceId &&
      version == other.version &&
      sizeBytes == other.sizeBytes &&
      crc32 == other.crc32;
  @override
  int get hashCode =>
      Object.hash(requestId, sourceId, version, sizeBytes, crc32);
}

final class BotaFirmwareSource {
  BotaFirmwareSource({
    required this.requestId,
    required this.url,
    Map<String, String> headers = const {},
  }) : headers = Map<String, String>.unmodifiable(headers);

  final String requestId;
  final Uri url;
  final Map<String, String> headers;

  @override
  bool operator ==(Object other) =>
      other is BotaFirmwareSource &&
      requestId == other.requestId &&
      url == other.url &&
      mapEquals(headers, other.headers);
  @override
  int get hashCode => Object.hash(requestId, url, _headersHash(headers));
}

int _headersHash(Map<String, String> headers) => Object.hashAllUnordered(
  headers.entries.map((entry) => Object.hash(entry.key, entry.value)),
);

typedef BotaProvisioningMaterialCallback =
    Future<BotaProvisioningMaterial> Function(
      BotaProvisioningMaterialRequest request,
    );
typedef BotaFactoryResetGrantCallback =
    Future<BotaFactoryResetGrant> Function(
      BotaFactoryResetGrantRequest request,
    );
typedef BotaFactoryResetResultCallback =
    Future<BotaFactoryResetResultAcknowledgement> Function(
      BotaFactoryResetResultRequest request,
    );
typedef BotaFirmwareCallback =
    Future<BotaFirmwareSource> Function(BotaFirmwareRequest request);

final class BotaApplicationCallbacks {
  const BotaApplicationCallbacks({
    this.provisioningMaterial,
    this.factoryResetGrant,
    this.persistFactoryResetResult,
    this.firmware,
  });

  final BotaProvisioningMaterialCallback? provisioningMaterial;
  final BotaFactoryResetGrantCallback? factoryResetGrant;
  final BotaFactoryResetResultCallback? persistFactoryResetResult;
  final BotaFirmwareCallback? firmware;

  @override
  bool operator ==(Object other) =>
      other is BotaApplicationCallbacks &&
      provisioningMaterial == other.provisioningMaterial &&
      factoryResetGrant == other.factoryResetGrant &&
      persistFactoryResetResult == other.persistFactoryResetResult &&
      firmware == other.firmware;

  @override
  int get hashCode => Object.hash(
    provisioningMaterial,
    factoryResetGrant,
    persistFactoryResetResult,
    firmware,
  );
}
