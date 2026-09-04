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
      'persistFactoryResetResult',
    });
    expect(_asyncMethods(body, '@asyncCallback'), <String>{
      'requestMaterial',
      'requestFirmware',
      'persistFactoryResetResult',
    });
    expect(schema, isNot(contains('BotaUploadDestination')));
    expect(schema, isNot(contains('hasUploadDestinationCallback')));
    expect(schema, isNot(contains('BotaHttpMethodMessage')));
  });

  test('grant and durable-resume routes expose their binding arguments', () {
    final String host = _classBody(schema, 'BotaHostApi');

    expect(
      _methodDeclaration(host, 'startRecording'),
      contains('String grantBlob'),
    );
    expect(
      _methodDeclaration(host, 'stopRecording'),
      contains('String grantBlob'),
    );
    expect(
      _methodDeclaration(host, 'provision'),
      isNot(contains('materialId')),
    );
    expect(
      _methodDeclaration(host, 'deprovision'),
      contains('String grantBlob'),
    );
    expect(
      _methodDeclaration(host, 'resumePendingFactoryReset'),
      allOf(
        contains('BotaDeviceReferenceMessage device'),
        contains('int currentBindingGeneration'),
      ),
    );
    expect(
      _methodDeclaration(host, 'configureWifi'),
      contains('String grantBlob'),
    );
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

  test('event safety derives the transitive message closure from its root', () {
    expect(_eventSafetyViolations(schema), isEmpty);
  });

  test('event safety follows newly nested message types', () {
    final String mutated = schema
        .replaceFirst('sealed class BotaEventPayloadMessage {}', '''
class BotaNestedSensitiveMessage {
  BotaNestedSensitiveMessage({required this.password});

  String password;
}

sealed class BotaEventPayloadMessage {}''')
        .replaceFirst(
          'BotaDeviceStatusEventMessage({required this.status});',
          'BotaDeviceStatusEventMessage({\n'
              '    required this.status,\n'
              '    required this.nested,\n'
              '  });',
        )
        .replaceFirst(
          '  BotaDeviceStatusMessage status;\n}',
          '  BotaDeviceStatusMessage status;\n'
              '  BotaNestedSensitiveMessage nested;\n}',
        );

    expect(
      _eventSafetyViolations(mutated),
      contains('BotaNestedSensitiveMessage.password: forbidden field name'),
    );
  });

  test('event safety rejects direct List<int> and Uint8List fields', () {
    for (final String byteArrayType in <String>['List<int>', 'Uint8List']) {
      final String mutated = schema
          .replaceFirst(
            'BotaEventMessage({required this.subscriptionId, required this.payload});',
            'BotaEventMessage({\n'
                '    required this.subscriptionId,\n'
                '    required this.payload,\n'
                '    required this.payloadData,\n'
                '  });',
          )
          .replaceFirst(
            '  BotaEventPayloadMessage payload;\n}',
            '  BotaEventPayloadMessage payload;\n'
                '  $byteArrayType payloadData;\n}',
          );

      expect(
        _eventSafetyViolations(mutated),
        contains('BotaEventMessage.payloadData: forbidden byte-array type'),
        reason: byteArrayType,
      );
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

String _methodDeclaration(String body, String method) {
  final RegExpMatch match = RegExp(
    '[\\w<>,? ]+\\s+${RegExp.escape(method)}\\s*\\([\\s\\S]*?\\);',
  ).firstMatch(body)!;
  return match.group(0)!;
}

List<String> _eventSafetyViolations(String source) {
  const Set<String> forbiddenFieldNames = <String>{
    'bytes',
    'body',
    'chunk',
    'packet',
    'password',
    'grant',
    'privateKey',
  };
  final Map<String, _SchemaClass> classes = _parseSchemaClasses(source);
  final Map<String, Set<String>> subclasses = <String, Set<String>>{};
  for (final _SchemaClass declaration in classes.values) {
    final String? superclass = declaration.superclass;
    if (superclass != null) {
      subclasses
          .putIfAbsent(superclass, () => <String>{})
          .add(declaration.name);
    }
  }

  final Set<String> reachable = <String>{};
  final List<String> pending = <String>['BotaEventMessage'];
  while (pending.isNotEmpty) {
    final String className = pending.removeLast();
    if (!reachable.add(className)) continue;
    final _SchemaClass? declaration = classes[className];
    if (declaration == null) {
      throw StateError('Unknown event-reachable class $className');
    }

    pending.addAll(subclasses[className] ?? const <String>{});
    for (final _SchemaField field in declaration.fields) {
      for (final RegExpMatch reference in RegExp(
        r'\b[A-Za-z_]\w*\b',
      ).allMatches(field.type)) {
        final String referencedType = reference.group(0)!;
        if (classes.containsKey(referencedType)) pending.add(referencedType);
      }
    }
  }

  final List<String> violations = <String>[];
  for (final String className in reachable) {
    for (final _SchemaField field in classes[className]!.fields) {
      if (forbiddenFieldNames.contains(field.name)) {
        violations.add('$className.${field.name}: forbidden field name');
      }
      if (_isByteArrayType(field.type)) {
        violations.add('$className.${field.name}: forbidden byte-array type');
      }
    }
  }
  return violations..sort();
}

Map<String, _SchemaClass> _parseSchemaClasses(String source) {
  final Map<String, _SchemaClass> classes = <String, _SchemaClass>{};
  final RegExp declarations = RegExp(
    r'(?:^|\n)\s*(?:abstract\s+|sealed\s+)?class\s+'
    r'([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_]\w*))?\s*\{',
  );
  for (final RegExpMatch match in declarations.allMatches(source)) {
    final String name = match.group(1)!;
    classes[name] = _SchemaClass(
      name: name,
      superclass: match.group(2),
      fields: _parseSchemaFields(_bodyAfterDeclaration(source, match.end)),
    );
  }
  return classes;
}

List<_SchemaField> _parseSchemaFields(String body) {
  final RegExp declaration = RegExp(
    r'^\s*(.+?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*$',
    multiLine: true,
  );
  return declaration
      .allMatches(body)
      .map(
        (RegExpMatch match) =>
            _SchemaField(type: match.group(1)!.trim(), name: match.group(2)!),
      )
      .toList(growable: false);
}

String _bodyAfterDeclaration(String source, int start) {
  var depth = 1;
  for (var index = start; index < source.length; index += 1) {
    if (source[index] == '{') depth += 1;
    if (source[index] == '}') depth -= 1;
    if (depth == 0) return source.substring(start, index);
  }
  throw StateError('Unclosed class declaration');
}

bool _isByteArrayType(String type) {
  if (RegExp(r'\bUint8List\b').hasMatch(type)) return true;
  final String compact = type.replaceAll(RegExp(r'\s+|\?'), '');
  return RegExp(r'(^|[<,])List<int>(?=[>,]|$)').hasMatch(compact);
}

final class _SchemaClass {
  const _SchemaClass({
    required this.name,
    required this.superclass,
    required this.fields,
  });

  final String name;
  final String? superclass;
  final List<_SchemaField> fields;
}

final class _SchemaField {
  const _SchemaField({required this.type, required this.name});

  final String type;
  final String name;
}
