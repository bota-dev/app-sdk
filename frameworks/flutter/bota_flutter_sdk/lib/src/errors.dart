/// Stable SDK error category.
final class BotaErrorCode {
  const BotaErrorCode._(this.name, [this.rawValue]);

  const BotaErrorCode.unknown(int rawValue) : this._('unknown', rawValue);

  static const invalidInput = BotaErrorCode._('invalidInput');
  static const truncatedPacket = BotaErrorCode._('truncatedPacket');
  static const unknownPacket = BotaErrorCode._('unknownPacket');
  static const payloadTooLarge = BotaErrorCode._('payloadTooLarge');
  static const unsupportedCapability = BotaErrorCode._('unsupportedCapability');
  static const unsupportedOperation = BotaErrorCode._('unsupportedOperation');
  static const featureUnavailable = BotaErrorCode._('featureUnavailable');
  static const operationInProgress = BotaErrorCode._('operationInProgress');
  static const unexpectedEvent = BotaErrorCode._('unexpectedEvent');
  static const deviceNotFound = BotaErrorCode._('deviceNotFound');
  static const identityMismatch = BotaErrorCode._('identityMismatch');
  static const connectionFailed = BotaErrorCode._('connectionFailed');
  static const persistenceFailed = BotaErrorCode._('persistenceFailed');
  static const notConnected = BotaErrorCode._('notConnected');
  static const timeout = BotaErrorCode._('timeout');
  static const cancelled = BotaErrorCode._('cancelled');
  static const protocolRejected = BotaErrorCode._('protocolRejected');
  static const integrityFailed = BotaErrorCode._('integrityFailed');
  static const uploadOwnershipUnknown = BotaErrorCode._(
    'uploadOwnershipUnknown',
  );
  static const downloadFailed = BotaErrorCode._('downloadFailed');
  static const internal = BotaErrorCode._('internal');
  static const clientDestroyed = BotaErrorCode._('client_destroyed');
  static const configurationConflict = BotaErrorCode._(
    'configuration_conflict',
  );

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaErrorCode &&
      name == other.name &&
      rawValue == other.rawValue;

  @override
  int get hashCode => Object.hash(name, rawValue);

  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

/// Stable operation associated with an SDK error.
final class BotaOperation {
  const BotaOperation._(this.name, [this.rawValue]);

  const BotaOperation.unknown(int rawValue) : this._('unknown', rawValue);

  static const validate = BotaOperation._('validate');
  static const decode = BotaOperation._('decode');
  static const encode = BotaOperation._('encode');
  static const discover = BotaOperation._('discover');
  static const connect = BotaOperation._('connect');
  static const reconnect = BotaOperation._('reconnect');
  static const readStatus = BotaOperation._('readStatus');
  static const provision = BotaOperation._('provision');
  static const transferRecording = BotaOperation._('transferRecording');
  static const upload = BotaOperation._('upload');
  static const updateFirmware = BotaOperation._('updateFirmware');
  static const readDeviceLogs = BotaOperation._('readDeviceLogs');
  static const factoryReset = BotaOperation._('factoryReset');

  final String name;
  final int? rawValue;

  @override
  bool operator ==(Object other) =>
      other is BotaOperation &&
      name == other.name &&
      rawValue == other.rawValue;

  @override
  int get hashCode => Object.hash(name, rawValue);

  @override
  String toString() => rawValue == null ? name : '$name($rawValue)';
}

/// A stable, structured SDK failure.
final class BotaSdkException implements Exception {
  const BotaSdkException({
    required this.code,
    required this.operation,
    required this.retryable,
    this.protocolStatus,
    required this.detail,
  });

  final BotaErrorCode code;
  final BotaOperation operation;
  final bool retryable;
  final int? protocolStatus;

  /// Diagnostic text. Applications must not branch on this value.
  final String detail;

  @override
  bool operator ==(Object other) =>
      other is BotaSdkException &&
      code == other.code &&
      operation == other.operation &&
      retryable == other.retryable &&
      protocolStatus == other.protocolStatus &&
      detail == other.detail;

  @override
  int get hashCode =>
      Object.hash(code, operation, retryable, protocolStatus, detail);

  @override
  String toString() =>
      'BotaSdkException(code: $code, operation: $operation, '
      'retryable: $retryable, protocolStatus: $protocolStatus)';
}
