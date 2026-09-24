import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:bota_app_sdk/src/generated/bota_api.g.dart';
import 'package:bota_app_sdk/src/pigeon_platform.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/in_memory_bota_host_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final List<_WorkflowScenario> canonicalScenarios = _loadCanonicalScenarios();
  final List<_WorkflowScenario> supportedScenarios = canonicalScenarios
      .where(
        (_WorkflowScenario scenario) =>
            _expectedTypedTraces.containsKey(scenario.name),
      )
      .toList();

  test('classifies all 33 canonical traces without overstating support', () {
    expect(canonicalScenarios, hasLength(33));
    expect(
      supportedScenarios.map((_WorkflowScenario value) => value.name).toSet(),
      _expectedTypedTraces.keys.toSet(),
    );
    final List<_WorkflowScenario> unsupportedScenarios = canonicalScenarios
        .where(
          (_WorkflowScenario scenario) =>
              !_expectedTypedTraces.containsKey(scenario.name),
        )
        .toList();
    expect(
      unsupportedScenarios.map((_WorkflowScenario value) => value.name).toSet(),
      _unsupportedCanonicalTraces,
    );
    expect(
      unsupportedScenarios.map((_WorkflowScenario value) => value.command),
      everyElement('transfer_encrypted_recording'),
    );
  });

  for (final _WorkflowScenario scenario in supportedScenarios) {
    test('${scenario.workflow}/${scenario.name}', () async {
      final List<String> actual = await _replayThroughFakeHost(scenario);
      expect(actual, _expectedTypedTraces[scenario.name]);
    });
  }
}

Future<List<String>> _replayThroughFakeHost(_WorkflowScenario scenario) async {
  final List<String> sequence = <String>[];
  final _WorkflowHostApi host = _WorkflowHostApi(scenario, sequence);
  final PigeonBotaPlatform platform = PigeonBotaPlatform(hostApi: host);
  host.bind(platform);
  final BotaDeviceClient client = BotaDeviceClient.forTesting(platform);
  await client.configure();
  sequence.clear();

  if (_streamCommands.contains(scenario.command)) {
    await _runStreamScenario(client, scenario, sequence);
  } else {
    await _runFutureScenario(client, scenario, sequence);
  }

  await client.destroy();
  return sequence;
}

Future<void> _runFutureScenario(
  BotaDeviceClient client,
  _WorkflowScenario scenario,
  List<String> sequence,
) async {
  final Future<Object?> operation = switch (scenario.command) {
    'connect' => client.devices.connect(testDiscoveredDevice),
    'reconnect' => client.devices.reconnect('BP0001'),
    'provision' =>
      client.provisioning
          .provision(testConnectedDevice)
          .then<Object?>((_) => null),
    'factory_reset' => client.factoryReset.reset(
      testConnectedDevice,
      const BotaFactoryResetCommand(
        commandId: 'command-1',
        bindingGeneration: 7,
      ),
    ),
    'resume_factory_reset' => client.factoryReset.resumePending(
      testConnectedDevice,
      currentBindingGeneration: 7,
    ),
    _ => throw StateError('Unexpected future command ${scenario.command}'),
  };

  if (scenario.terminalStatus == 'running' && scenario.errorCode == null) {
    unawaited(operation.then<void>((_) {}, onError: (_, _) {}));
    await _flushEvents();
    return;
  }

  try {
    final Object? result = await operation;
    sequence.add(_typedResult(result));
  } on BotaSdkException catch (error) {
    sequence.add(_typedError(error));
  }
}

Future<void> _runStreamScenario(
  BotaDeviceClient client,
  _WorkflowScenario scenario,
  List<String> sequence,
) async {
  final Stream<Object?> stream = switch (scenario.command) {
    'transfer_recording' =>
      client.recordings
          .sync(
            testConnectedDevice,
            testDeviceRecording,
            sinkId: 'sink-1',
            confirmOnCompletion: false,
          )
          .cast<Object?>(),
    'upload_recording' =>
      client.recordings
          .observeUploadOwnership(
            testConnectedDevice,
            recordingId: 'recording',
            uploadId: 'upload-1',
            destinationId: 'destination-1',
          )
          .cast<Object?>(),
    'update_firmware' =>
      client.ota.update(testConnectedDevice, testFirmwareImage).cast<Object?>(),
    'read_device_logs' =>
      client.logs.stream(testConnectedDevice).cast<Object?>(),
    _ => throw StateError('Unexpected stream command ${scenario.command}'),
  };
  final Completer<void> done = Completer<void>();
  final StreamSubscription<Object?> subscription = stream.listen(
    (Object? event) => sequence.add(_typedEvent(event)),
    onError: (Object error) {
      sequence.add(_typedError(error as BotaSdkException));
    },
    onDone: () {
      sequence.add('complete');
      done.complete();
    },
  );

  if (scenario.terminalStatus == 'running' && scenario.errorCode == null) {
    await _flushEvents();
    await subscription.cancel();
    return;
  }

  await done.future;
  await subscription.cancel();
}

String _typedResult(Object? result) => switch (result) {
  null => 'complete:void',
  BotaConnectedDevice() => 'event:BotaConnectedDevice',
  BotaFactoryResetCompletion() => 'event:BotaFactoryResetCompletion',
  _ => 'event:${result.runtimeType}',
};

String _typedEvent(Object? event) => switch (event) {
  BotaRecordingSyncProgress() => 'event:BotaRecordingSyncProgress',
  BotaRecordingSyncCompleted() => 'event:BotaRecordingSyncCompleted',
  BotaUploadOwnershipResolved(result: BotaDeviceUploadCompleted()) =>
    'event:BotaUploadOwnershipResolved<BotaDeviceUploadCompleted>',
  BotaUploadOwnershipResolved(result: BotaBluetoothFallback()) =>
    'event:BotaUploadOwnershipResolved<BotaBluetoothFallback>',
  BotaFirmwareProgress(:final phase) =>
    'event:BotaFirmwareProgress<${phase.name}>',
  BotaDeviceLogLine() => 'event:BotaDeviceLogLine',
  _ => 'event:${event.runtimeType}',
};

String _typedError(BotaSdkException error) =>
    'error:${error.code.name}:${error.operation.name}';

Future<void> _flushEvents() => Future<void>.delayed(Duration.zero);

const Set<String> _streamCommands = <String>{
  'transfer_recording',
  'upload_recording',
  'update_firmware',
  'read_device_logs',
};

const Set<String> _unsupportedCanonicalTraces = <String>{
  'encrypted-upload-v2-success',
  'encrypted-upload-v2-mixed-profile-rejection',
  'encrypted-upload-v2-cancellation-retains-recording',
  'encrypted-upload-v2-checkpoint-resume',
};

final Map<String, List<String>> _expectedTypedTraces = <String, List<String>>{
  'connection-manual-success': <String>[
    'operation:connect',
    'event:BotaConnectedDevice',
  ],
  'connection-identity-rejection': <String>[
    'operation:connect',
    'error:identityMismatch:connect',
  ],
  'connection-cancellation': <String>[
    'operation:reconnect',
    'error:cancelled:reconnect',
  ],
  'connection-reconnect-resume': <String>['operation:reconnect'],
  'connection-owner-rejection': <String>[
    'operation:reconnect',
    'error:operationInProgress:reconnect',
  ],
  'device-logs-subscription-success': <String>[
    'operation:readDeviceLogs<BotaLogSubscriptionMessage>',
    'event:BotaDeviceLogLine',
  ],
  'device-logs-feature-rejection': <String>[
    'operation:readDeviceLogs<BotaLogSubscriptionMessage>',
    'error:featureUnavailable:readDeviceLogs',
    'complete',
  ],
  'device-logs-cancellation': <String>[
    'operation:readDeviceLogs<BotaLogSubscriptionMessage>',
    'error:cancelled:readDeviceLogs',
    'complete',
  ],
  'device-logs-restart-after-disconnect': <String>[
    'operation:readDeviceLogs<BotaLogSubscriptionMessage>',
    'error:notConnected:readDeviceLogs',
    'complete',
  ],
  'factory-reset-success': <String>[
    'operation:factoryReset',
    'event:BotaFactoryResetCompletion',
  ],
  'factory-reset-device-rejection': <String>[
    'operation:factoryReset',
    'error:protocolRejected:factoryReset',
  ],
  'factory-reset-cancellation': <String>[
    'operation:factoryReset',
    'error:cancelled:factoryReset',
  ],
  'factory-reset-durable-resume': <String>[
    'operation:resumePendingFactoryReset',
    'event:BotaFactoryResetCompletion',
  ],
  'firmware-update-success': <String>[
    'operation:updateFirmware<BotaFirmwareUpdateSubscriptionMessage>',
    'event:BotaFirmwareProgress<transferring>',
    'event:BotaFirmwareProgress<reconnecting>',
    'complete',
  ],
  'firmware-update-download-rejection': <String>[
    'operation:updateFirmware<BotaFirmwareUpdateSubscriptionMessage>',
    'error:downloadFailed:updateFirmware',
    'complete',
  ],
  'firmware-update-cancellation': <String>[
    'operation:updateFirmware<BotaFirmwareUpdateSubscriptionMessage>',
    'error:cancelled:updateFirmware',
    'complete',
  ],
  'firmware-update-checkpoint-resume': <String>[
    'operation:updateFirmware<BotaFirmwareUpdateSubscriptionMessage>',
    'event:BotaFirmwareProgress<transferring>',
  ],
  'provisioning-success': <String>['operation:provision', 'complete:void'],
  'provisioning-payload-rejection': <String>[
    'operation:provision',
    'error:payloadTooLarge:provision',
  ],
  'provisioning-cancellation': <String>[
    'operation:provision',
    'error:cancelled:provision',
  ],
  'provisioning-retry-after-disconnect': <String>[
    'operation:provision',
    'error:notConnected:provision',
  ],
  'recording-transfer-success': <String>[
    'operation:transferRecording<BotaRecordingSyncSubscriptionMessage>',
    'event:BotaRecordingSyncProgress',
    'event:BotaRecordingSyncCompleted',
    'complete',
  ],
  'recording-transfer-integrity-rejection': <String>[
    'operation:transferRecording<BotaRecordingSyncSubscriptionMessage>',
    'error:integrityFailed:transferRecording',
    'complete',
  ],
  'recording-transfer-cancellation': <String>[
    'operation:transferRecording<BotaRecordingSyncSubscriptionMessage>',
    'error:cancelled:transferRecording',
    'complete',
  ],
  'recording-transfer-checkpoint-resume': <String>[
    'operation:transferRecording<BotaRecordingSyncSubscriptionMessage>',
    'event:BotaRecordingSyncProgress',
  ],
  'upload-handoff-direct-success': <String>[
    'operation:upload<BotaUploadOwnershipSubscriptionMessage>',
    'event:BotaUploadOwnershipResolved<BotaDeviceUploadCompleted>',
    'complete',
  ],
  'upload-handoff-unknown-ownership-rejection': <String>[
    'operation:upload<BotaUploadOwnershipSubscriptionMessage>',
    'error:uploadOwnershipUnknown:upload',
    'complete',
  ],
  'upload-handoff-cancellation': <String>[
    'operation:upload<BotaUploadOwnershipSubscriptionMessage>',
    'error:cancelled:upload',
    'complete',
  ],
  'upload-handoff-restart-recovers-ownership': <String>[
    'operation:upload<BotaUploadOwnershipSubscriptionMessage>',
    'event:BotaUploadOwnershipResolved<BotaBluetoothFallback>',
    'complete',
  ],
};

final class _WorkflowHostApi extends BotaHostApi {
  _WorkflowHostApi(this.scenario, this.sequence);

  final _WorkflowScenario scenario;
  final List<String> sequence;
  late final PigeonBotaPlatform _platform;

  void bind(PigeonBotaPlatform platform) {
    _platform = platform;
  }

  @override
  Future<void> configure(
    String operationId,
    BotaConfigurationMessage configuration,
  ) async {}

  @override
  Future<void> destroy(String operationId) async {}

  @override
  Future<BotaConnectedDeviceMessage> connect(
    String operationId,
    BotaDiscoveredDeviceMessage device,
    String? serialNumber,
  ) => _respond('connect', connectedDeviceMessage());

  @override
  Future<BotaConnectedDeviceMessage> reconnect(
    String operationId,
    String serialNumber,
    BotaReconnectHintMessage hint,
  ) => _respond('reconnect', connectedDeviceMessage());

  @override
  Future<void> provision(
    String operationId,
    BotaDeviceReferenceMessage device,
  ) => _respond<void>('provision', null);

  @override
  Future<BotaFactoryResetCompletionMessage> factoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    BotaFactoryResetCommandMessage command,
  ) => _respond(
    'factoryReset',
    BotaFactoryResetCompletionMessage(
      commandId: command.commandId,
      bindingGeneration: command.bindingGeneration,
    ),
  );

  @override
  Future<BotaFactoryResetCompletionMessage?> resumePendingFactoryReset(
    String operationId,
    BotaDeviceReferenceMessage device,
    int currentBindingGeneration,
  ) => _respond(
    'resumePendingFactoryReset',
    BotaFactoryResetCompletionMessage(
      commandId: 'command-1',
      bindingGeneration: currentBindingGeneration,
    ),
  );

  @override
  Future<void> startSubscription(
    String subscriptionId,
    BotaSubscriptionRequestMessage request,
  ) async {
    final String operation = switch (request) {
      BotaRecordingSyncSubscriptionMessage() => 'transferRecording',
      BotaUploadOwnershipSubscriptionMessage() => 'upload',
      BotaFirmwareUpdateSubscriptionMessage() => 'updateFirmware',
      BotaLogSubscriptionMessage() => 'readDeviceLogs',
      _ => throw StateError('Unexpected subscription ${request.runtimeType}'),
    };
    sequence.add('operation:$operation<${request.runtimeType}>');
    scheduleMicrotask(() => _emit(subscriptionId, request));
  }

  @override
  Future<void> cancelSubscription(String subscriptionId) async {}

  Future<T> _respond<T>(String operation, T value) {
    sequence.add('operation:$operation');
    final String? errorCode = scenario.bridgeErrorCode;
    if (errorCode != null) {
      return Future<T>.error(_platformError(errorCode));
    }
    if (scenario.terminalStatus == 'running') {
      return Completer<T>().future;
    }
    return Future<T>.value(value);
  }

  void _emit(String subscriptionId, BotaSubscriptionRequestMessage request) {
    final String? errorCode = scenario.bridgeErrorCode;
    if (errorCode != null) {
      _platform.onEvent(
        BotaEventMessage(
          subscriptionId: subscriptionId,
          payload: BotaSubscriptionErrorEventMessage(
            error: _errorMessage(errorCode),
          ),
        ),
      );
      return;
    }

    switch (request) {
      case BotaRecordingSyncSubscriptionMessage():
        if (scenario.notifications.contains('progress')) {
          _event(
            subscriptionId,
            BotaRecordingSyncProgressEventMessage(
              progress: BotaRecordingTransferProgressMessage(
                completedBytes: 512,
                totalBytes: 1024,
              ),
            ),
          );
        }
        if (scenario.terminalStatus == 'completed') {
          _event(
            subscriptionId,
            BotaRecordingSyncCompletedEventMessage(
              localPath: '/tmp/recording.bota',
            ),
          );
        }
      case BotaUploadOwnershipSubscriptionMessage():
        if (scenario.terminalStatus == 'completed') {
          final bool fallback = scenario.notifications.contains(
            'ble_fallback_ready',
          );
          _event(
            subscriptionId,
            BotaUploadOwnershipResolvedEventMessage(
              result: BotaUploadOwnershipResultMessage(
                kind: fallback
                    ? BotaUploadOwnershipResultKindMessage.bluetoothFallback
                    : BotaUploadOwnershipResultKindMessage
                          .deviceUploadCompleted,
                recordingId: fallback ? 'recording' : null,
                uploadId: fallback ? 'upload-1' : null,
                destinationId: fallback ? 'destination-1' : null,
              ),
            ),
          );
        }
      case BotaFirmwareUpdateSubscriptionMessage():
        if (scenario.notifications.contains('firmware_progress')) {
          _event(
            subscriptionId,
            _firmwareEvent('transferring', completedBytes: 512),
          );
        }
        if (scenario.notifications.contains('connection_established')) {
          _event(
            subscriptionId,
            _firmwareEvent('reconnecting', completedBytes: 1024),
          );
        }
      case BotaLogSubscriptionMessage():
        if (scenario.notifications.contains('device_log')) {
          _event(
            subscriptionId,
            BotaDeviceLogEventMessage(
              line: BotaDeviceLogLineMessage(
                message: 'device ready',
                isBacklog: false,
              ),
            ),
          );
        }
      default:
        throw StateError('Unexpected subscription ${request.runtimeType}');
    }

    if (scenario.terminalStatus == 'completed') {
      _event(subscriptionId, BotaSubscriptionCompleteEventMessage());
    }
  }

  BotaFirmwareProgressEventMessage _firmwareEvent(
    String phase, {
    required int completedBytes,
  }) => BotaFirmwareProgressEventMessage(
    progress: BotaFirmwareProgressMessage(
      phase: BotaFirmwarePhaseMessage(name: phase),
      completedBytes: completedBytes,
      totalBytes: 1024,
    ),
  );

  void _event(String subscriptionId, BotaEventPayloadMessage payload) {
    _platform.onEvent(
      BotaEventMessage(subscriptionId: subscriptionId, payload: payload),
    );
  }

  PlatformException _platformError(String code) =>
      PlatformException(code: 'bota_sdk_error', details: _errorMessage(code));

  BotaErrorMessage _errorMessage(String code) => BotaErrorMessage(
    code: BotaErrorCodeMessage(name: code),
    operation: BotaOperationMessage(name: scenario.dartOperation),
    retryable: false,
    detail: 'Canonical fake-host failure for ${scenario.name}.',
  );
}

List<_WorkflowScenario> _loadCanonicalScenarios() {
  final Directory directory = Directory('../../../protocol/workflows');
  final List<File> files =
      directory
          .listSync()
          .whereType<File>()
          .where((File file) => file.path.endsWith('.json'))
          .where((File file) => !file.path.endsWith('/schema.json'))
          .toList()
        ..sort((File left, File right) => left.path.compareTo(right.path));

  return <_WorkflowScenario>[
    for (final File file in files)
      ..._WorkflowScenario.fromSuite(
        jsonDecode(file.readAsStringSync()) as Map<String, Object?>,
      ),
  ];
}

final class _WorkflowScenario {
  const _WorkflowScenario({
    required this.workflow,
    required this.name,
    required this.classification,
    required this.command,
    required this.inputs,
    required this.effects,
    required this.notifications,
    required this.terminalStatus,
    required this.errorCode,
  });

  static List<_WorkflowScenario> fromSuite(Map<String, Object?> suite) {
    final String workflow = suite['workflow']! as String;
    return <_WorkflowScenario>[
      for (final Object? value in suite['scenarios']! as List<Object?>)
        _WorkflowScenario.fromJson(workflow, value! as Map<String, Object?>),
    ];
  }

  factory _WorkflowScenario.fromJson(
    String workflow,
    Map<String, Object?> scenario,
  ) {
    final Map<String, Object?> expected =
        scenario['expected']! as Map<String, Object?>;
    return _WorkflowScenario(
      workflow: workflow,
      name: scenario['name']! as String,
      classification: scenario['classification']! as String,
      command: scenario['command']! as String,
      inputs: List<String>.from(scenario['inputs']! as List<Object?>),
      effects: List<String>.from(expected['effects']! as List<Object?>),
      notifications: List<String>.from(
        expected['notifications']! as List<Object?>,
      ),
      terminalStatus: expected['terminalStatus']! as String,
      errorCode: expected['errorCode'] as String?,
    );
  }

  final String workflow;
  final String name;
  final String classification;
  final String command;

  // Inputs and effects cross the fixture boundary intact but remain opaque to
  // Dart. The native fake emits only the fixture's already-decided outcome.
  final List<String> inputs;
  final List<String> effects;
  final List<String> notifications;
  final String terminalStatus;
  final String? errorCode;

  String? get bridgeErrorCode {
    final String? explicit = errorCode;
    if (explicit != null) return _snakeToLowerCamel(explicit);
    if (terminalStatus == 'cancelled') return 'cancelled';
    return null;
  }

  String get dartOperation => switch (command) {
    'connect' => 'connect',
    'reconnect' => 'reconnect',
    'provision' => 'provision',
    'factory_reset' || 'resume_factory_reset' => 'factoryReset',
    'transfer_recording' => 'transferRecording',
    'upload_recording' => 'upload',
    'update_firmware' => 'updateFirmware',
    'read_device_logs' => 'readDeviceLogs',
    _ => throw StateError('Unknown canonical command $command'),
  };
}

String _snakeToLowerCamel(String value) => value.replaceAllMapped(
  RegExp(r'_([a-z])'),
  (Match match) => match.group(1)!.toUpperCase(),
);
