import 'dart:io';

import 'package:bota_flutter_sdk/src/generated/bota_api.g.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late String schema;

  setUpAll(() {
    schema = File('pigeons/bota_api.dart').readAsStringSync();
  });

  test('every public operation has one asynchronous host route', () {
    const Set<String> expectedMethods = <String>{
      'configure',
      'destroy',
      'connect',
      'reconnect',
      'disconnect',
      'readDeviceStatus',
      'cancelDeviceOperation',
      'startRecording',
      'stopRecording',
      'readRecordingState',
      'provision',
      'readConnectionSettings',
      'writeConnectionSettings',
      'deprovision',
      'cancelProvisioningOperation',
      'factoryReset',
      'resumePendingFactoryReset',
      'resumeUnjournaledFactoryReset',
      'cancelFactoryResetOperation',
      'listRecordings',
      'takeTransferMetadata',
      'confirmRecording',
      'cancelRecordingOperation',
      'cancelOtaOperation',
      'stopLogs',
      'configureWifi',
      'disconnectWifi',
      'readWifiStatus',
      'scanWifi',
      'cancelWifiOperation',
      'startSubscription',
      'cancelSubscription',
    };
    final String body = _classBody(schema, 'BotaHostApi');

    expect(_asyncMethods(body, '@async'), expectedMethods);
    for (final String method in expectedMethods) {
      expect(
        _firstParameterName(body, method),
        method.endsWith('Subscription') ? 'subscriptionId' : 'operationId',
        reason: method,
      );
    }
  });

  test('every public stream has a typed subscription request', () {
    const Set<String> expectedSubscriptions = <String>{
      'BotaScanSubscriptionMessage',
      'BotaConnectionSubscriptionMessage',
      'BotaDeviceStatusSubscriptionMessage',
      'BotaRecordingStateSubscriptionMessage',
      'BotaRecordingSyncSubscriptionMessage',
      'BotaUploadOwnershipSubscriptionMessage',
      'BotaFirmwareUpdateSubscriptionMessage',
      'BotaLogSubscriptionMessage',
      'BotaWifiStatusSubscriptionMessage',
    };
    final Set<String> subscriptions = RegExp(
      r'class\s+(\w+)\s+extends\s+BotaSubscriptionRequestMessage',
    ).allMatches(schema).map((RegExpMatch match) => match.group(1)!).toSet();

    expect(subscriptions, expectedSubscriptions);
    expect(
      _methodReturnType(_classBody(schema, 'BotaHostApi'), 'startSubscription'),
      'void',
    );
    expect(
      _methodReturnType(
        _classBody(schema, 'BotaHostApi'),
        'cancelSubscription',
      ),
      'void',
    );
  });

  test('native callbacks have one request-bound Flutter route per kind', () {
    final String body = _classBody(schema, 'BotaFlutterApi');

    expect(_declaredMethods(body), <String>{
      'onEvent',
      'requestMaterial',
      'requestFirmware',
      'requestUploadDestination',
      'persistFactoryResetResult',
    });
    expect(_asyncMethods(body, '@asyncCallback'), <String>{
      'requestMaterial',
      'requestFirmware',
      'requestUploadDestination',
      'persistFactoryResetResult',
    });
  });

  test('open enum values remain typed by their public domain', () {
    const Set<String> expectedValueTypes = <String>{
      'BotaDeviceTypeMessage',
      'BotaPairingStateMessage',
      'BotaDeviceStateValueMessage',
      'BotaLteStateMessage',
      'BotaWifiRadioStateMessage',
      'BotaConnectionTypeMessage',
      'BotaAudioCodecMessage',
      'BotaRecordingInitiatorMessage',
      'BotaFirmwarePhaseMessage',
      'BotaWifiConfigResultMessage',
      'BotaWifiStateMessage',
      'BotaProvisioningFailureMessage',
      'BotaErrorCodeMessage',
      'BotaOperationMessage',
    };

    for (final String type in expectedValueTypes) {
      expect(schema, contains('class $type {'), reason: type);
    }
    expect(schema, isNot(contains('class BotaWireValueMessage')));
  });

  test('event messages contain bounded values and no sensitive bodies', () {
    const Set<String> eventClasses = <String>{
      'BotaEventMessage',
      'BotaEventPayloadMessage',
      'BotaDiscoveredDeviceEventMessage',
      'BotaConnectionEventMessage',
      'BotaDeviceStatusEventMessage',
      'BotaRecordingStateEventMessage',
      'BotaRecordingSyncProgressEventMessage',
      'BotaRecordingSyncCompletedEventMessage',
      'BotaUploadOwnershipProgressEventMessage',
      'BotaUploadOwnershipResolvedEventMessage',
      'BotaFirmwareProgressEventMessage',
      'BotaDeviceLogEventMessage',
      'BotaWifiStatusEventMessage',
      'BotaSubscriptionErrorEventMessage',
      'BotaSubscriptionCompleteEventMessage',
      'BotaDiscoveredDeviceMessage',
      'BotaConnectedDeviceMessage',
      'BotaDeviceStatusMessage',
      'BotaDeviceFlagsMessage',
      'BotaModemInfoMessage',
      'BotaRecordingStateMessage',
      'BotaRecordingTransferProgressMessage',
      'BotaUploadOwnershipResultMessage',
      'BotaFirmwareProgressMessage',
      'BotaDeviceLogLineMessage',
      'BotaWifiStatusMessage',
      'BotaErrorMessage',
      'BotaDeviceTypeMessage',
      'BotaPairingStateMessage',
      'BotaDeviceStateValueMessage',
      'BotaLteStateMessage',
      'BotaWifiRadioStateMessage',
      'BotaRecordingInitiatorMessage',
      'BotaFirmwarePhaseMessage',
      'BotaWifiStateMessage',
      'BotaErrorCodeMessage',
      'BotaOperationMessage',
    };
    final RegExp forbiddenField = RegExp(
      r'\b(?:Object|String|int|bool|double|Uint8List|\w+Message)\??\s+'
      r'(?:bytes|body|chunk|packet|password|grant|privateKey)\s*[;=]',
    );

    for (final String className in eventClasses) {
      final String body = _classBody(schema, className);
      expect(body, isNot(contains('Uint8List')), reason: className);
      expect(forbiddenField.hasMatch(body), isFalse, reason: className);
    }
  });

  test(
    'bridge-owned identifiers are exactly 32 lowercase hexadecimal digits',
    () {
      final RegExp pattern = RegExp(botaBridgeIdPattern);

      expect(pattern.hasMatch('0123456789abcdef0123456789abcdef'), isTrue);
      expect(pattern.hasMatch('0123456789ABCDEF0123456789ABCDEF'), isFalse);
      expect(pattern.hasMatch('0123456789abcdef0123456789abcde'), isFalse);
      expect(pattern.hasMatch('g123456789abcdef0123456789abcdef'), isFalse);
    },
  );
}

String _classBody(String source, String className) {
  final RegExpMatch declaration = RegExp(
    '(?:abstract\\s+|sealed\\s+)?class\\s+$className(?:\\s+extends\\s+\\w+)?\\s*\\{',
  ).firstMatch(source)!;
  final int start = declaration.end;
  var depth = 1;
  for (var index = start; index < source.length; index += 1) {
    if (source[index] == '{') depth += 1;
    if (source[index] == '}') depth -= 1;
    if (depth == 0) return source.substring(start, index);
  }
  throw StateError('Unclosed class $className');
}

Set<String> _asyncMethods(String body, String annotation) => RegExp(
  '${RegExp.escape(annotation)}\\s+[\\w<>,? ]+\\s+(\\w+)\\s*\\(',
).allMatches(body).map((RegExpMatch match) => match.group(1)!).toSet();

Set<String> _declaredMethods(String body) => RegExp(
  r'(?:^|\n)\s*[\w<>,? ]+\s+(\w+)\s*\(',
).allMatches(body).map((RegExpMatch match) => match.group(1)!).toSet();

String _firstParameterName(String body, String method) {
  final RegExpMatch match = RegExp(
    '[\\w<>,? ]+\\s+${RegExp.escape(method)}\\s*\\(\\s*String\\s+(\\w+)',
  ).firstMatch(body)!;
  return match.group(1)!;
}

String _methodReturnType(String body, String method) {
  final RegExpMatch match = RegExp(
    '([\\w<>,?]+)\\s+${RegExp.escape(method)}\\s*\\(',
  ).firstMatch(body)!;
  return match.group(1)!;
}
