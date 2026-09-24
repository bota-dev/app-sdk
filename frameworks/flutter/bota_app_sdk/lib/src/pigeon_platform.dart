import 'dart:async';

import 'package:flutter/services.dart';

import 'bridge_mapper.dart';
import 'client.dart';
import 'errors.dart';
import 'generated/bota_api.g.dart';
import 'models/device.dart';
import 'models/ota.dart';
import 'models/recording.dart';
import 'models/security.dart';
import 'models/settings.dart';
import 'models/wifi.dart';
import 'platform.dart';
import 'request_ids.dart';

/// Pigeon-backed runtime owned by one Flutter engine.
final class PigeonBotaPlatform implements BotaPlatform, BotaFlutterApi {
  PigeonBotaPlatform({BotaHostApi? hostApi, BinaryMessenger? binaryMessenger})
    : _hostApi = hostApi ?? BotaHostApi(binaryMessenger: binaryMessenger),
      _binaryMessenger = binaryMessenger {
    BotaFlutterApi.setUp(this, binaryMessenger: binaryMessenger);
  }

  final BotaHostApi _hostApi;
  final BinaryMessenger? _binaryMessenger;
  final Map<String, _PendingOperation> _pendingOperations =
      <String, _PendingOperation>{};
  final Map<String, _ActiveStream> _activeStreams = <String, _ActiveStream>{};
  final Map<String, _PendingCallback> _pendingCallbacks =
      <String, _PendingCallback>{};
  final Map<String, _CallbackKind> _consumedCallbacks =
      <String, _CallbackKind>{};

  BotaConfiguration? _configuration;
  BotaConfiguration? _configuring;
  Future<void>? _configureFuture;
  Future<void>? _destroyFuture;
  bool _destroying = false;
  bool _destroyed = false;

  @override
  Set<BotaCapability> get capabilities => BotaCapabilities.firstBeta;

  @override
  Future<void> configure(BotaConfiguration configuration) {
    final BotaSdkException? lifecycleError = _lifecycleError(
      BotaOperation.validate,
    );
    if (lifecycleError != null) return Future<void>.error(lifecycleError);

    final BotaConfiguration? configured = _configuration;
    if (configured != null) {
      return configured == configuration
          ? Future<void>.value()
          : Future<void>.error(_configurationConflict());
    }

    final Future<void>? configuringFuture = _configureFuture;
    if (configuringFuture != null) {
      return _configuring == configuration
          ? configuringFuture
          : Future<void>.error(_configurationConflict());
    }

    _configuring = configuration;
    late final Future<void> result;
    result =
        _runVoid(
              BotaOperation.validate,
              (String operationId) => _hostApi.configure(
                operationId,
                BridgeMapper.configuration(configuration),
              ),
            )
            .then((_) {
              if (!_destroying && !_destroyed) {
                _configuration = configuration;
              }
            })
            .whenComplete(() {
              if (identical(_configureFuture, result)) {
                _configureFuture = null;
                _configuring = null;
              }
            });
    _configureFuture = result;
    return result;
  }

  @override
  Future<void> destroy() {
    final Future<void>? existing = _destroyFuture;
    if (existing != null) return existing;

    final Completer<void> completer = Completer<void>();
    _destroyFuture = completer.future;
    _destroying = true;
    _performDestroy().then(
      completer.complete,
      onError: completer.completeError,
    );
    return completer.future;
  }

  Future<void> _performDestroy() async {
    _configuration = null;
    _configuring = null;
    _configureFuture = null;
    _consumedCallbacks.clear();

    final List<_PendingOperation> pending = _pendingOperations.values.toList();
    _pendingOperations.clear();
    for (final _PendingOperation operation in pending) {
      operation.fail(_clientDestroyed(operation.operation), StackTrace.current);
    }
    final List<_PendingCallback> callbacks = _pendingCallbacks.values.toList();
    _pendingCallbacks.clear();
    for (final _PendingCallback callback in callbacks) {
      callback.reject(
        _callbackError(
          'client_destroyed',
          'The Bota client has been destroyed.',
        ),
        StackTrace.current,
      );
    }

    Object? firstError;
    StackTrace? firstStackTrace;
    final List<MapEntry<String, _ActiveStream>> streams = _activeStreams.entries
        .toList();
    _activeStreams.clear();
    for (final MapEntry<String, _ActiveStream> stream in streams) {
      stream.value.addError(_clientDestroyed(stream.value.operation));
      unawaited(stream.value.close());
      try {
        await _hostApi.cancelSubscription(stream.key);
      } on Object catch (error, stackTrace) {
        firstError ??= _stableError(error, stream.value.operation);
        firstStackTrace ??= stackTrace;
      }
    }

    try {
      await _hostApi.destroy(RequestId.next());
    } on Object catch (error, stackTrace) {
      firstError ??= _stableError(error, BotaOperation.validate);
      firstStackTrace ??= stackTrace;
    } finally {
      _destroyed = true;
      _destroying = false;
      BotaFlutterApi.setUp(null, binaryMessenger: _binaryMessenger);
    }

    if (firstError != null) {
      Error.throwWithStackTrace(firstError, firstStackTrace!);
    }
  }

  @override
  Future<BotaConnectedDevice> connect(
    BotaDiscoveredDevice device, {
    String? serialNumber,
  }) => _runOperation<BotaConnectedDevice>(
    BotaOperation.connect,
    (String operationId) async => BridgeMapper.connectedDevice(
      await _hostApi.connect(
        operationId,
        BridgeMapper.discoveredDeviceMessage(device),
        serialNumber,
      ),
    ),
  );

  @override
  Future<void> disconnect() =>
      _runVoid(BotaOperation.connect, _hostApi.disconnect);

  Future<T> _runOperation<T>(
    BotaOperation operation,
    Future<T> Function(String operationId) invoke,
  ) {
    final BotaSdkException? lifecycleError = _lifecycleError(operation);
    if (lifecycleError != null) return Future<T>.error(lifecycleError);

    final String operationId = RequestId.next();
    final Completer<T> completer = Completer<T>();
    final _PendingOperation pending = _PendingOperation(
      operation: operation,
      complete: (Object? value) => completer.complete(value as T),
      fail: completer.completeError,
    );
    _pendingOperations[operationId] = pending;
    Future<T>.sync(() => invoke(operationId)).then(
      (T value) {
        final _PendingOperation? active = _pendingOperations.remove(
          operationId,
        );
        active?.complete(value);
      },
      onError: (Object error, StackTrace stackTrace) {
        final _PendingOperation? active = _pendingOperations.remove(
          operationId,
        );
        active?.fail(_stableError(error, operation), stackTrace);
      },
    );
    return completer.future;
  }

  Future<void> _runVoid(
    BotaOperation operation,
    Future<void> Function(String operationId) invoke,
  ) => _runOperation<void>(operation, invoke);

  BotaSdkException? _lifecycleError(BotaOperation operation) =>
      _destroying || _destroyed ? _clientDestroyed(operation) : null;

  @override
  Stream<BotaDiscoveredDevice> scan({
    Duration timeout = const Duration(seconds: 10),
    bool allowDuplicates = false,
  }) => _stream<BotaDiscoveredDevice>(
    BotaOperation.discover,
    BotaScanSubscriptionMessage(
      timeoutMillis: timeout.inMilliseconds,
      allowDuplicates: allowDuplicates,
    ),
    (BotaEventPayloadMessage payload) {
      if (payload case BotaDiscoveredDeviceEventMessage(:final device)) {
        return BridgeMapper.discoveredDevice(device);
      }
      throw const FormatException('Unexpected discovery event.');
    },
  );

  @override
  Future<BotaConnectedDevice> reconnect(
    String serialNumber, {
    BotaReconnectHint hint = const BotaReconnectHint(),
  }) => _runOperation<BotaConnectedDevice>(
    BotaOperation.reconnect,
    (String operationId) async => BridgeMapper.connectedDevice(
      await _hostApi.reconnect(
        operationId,
        serialNumber,
        BridgeMapper.reconnectHint(hint),
      ),
    ),
  );

  @override
  Stream<BotaConnectedDevice?> get connections => _stream<BotaConnectedDevice?>(
    BotaOperation.connect,
    BotaConnectionSubscriptionMessage(),
    (BotaEventPayloadMessage payload) {
      if (payload case BotaConnectionEventMessage(:final device)) {
        return device == null ? null : BridgeMapper.connectedDevice(device);
      }
      throw const FormatException('Unexpected connection event.');
    },
  );

  @override
  Future<BotaDeviceStatus> readStatus() => _runOperation<BotaDeviceStatus>(
    BotaOperation.readStatus,
    (String operationId) async =>
        BridgeMapper.deviceStatus(await _hostApi.readDeviceStatus(operationId)),
  );

  @override
  Stream<BotaDeviceStatus> get status => _stream<BotaDeviceStatus>(
    BotaOperation.readStatus,
    BotaDeviceStatusSubscriptionMessage(),
    (BotaEventPayloadMessage payload) {
      if (payload case BotaDeviceStatusEventMessage(:final status)) {
        return BridgeMapper.deviceStatus(status);
      }
      throw const FormatException('Unexpected device-status event.');
    },
  );

  @override
  Future<void> cancelDeviceOperation() =>
      _runVoid(BotaOperation.connect, _hostApi.cancelDeviceOperation);

  @override
  Future<void> startRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _runVoid(
    BotaOperation.encode,
    (String operationId) => _hostApi.startRecording(
      operationId,
      BridgeMapper.deviceReference(device),
      grantBlob,
    ),
  );

  @override
  Future<void> stopRecording(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _runVoid(
    BotaOperation.encode,
    (String operationId) => _hostApi.stopRecording(
      operationId,
      BridgeMapper.deviceReference(device),
      grantBlob,
    ),
  );

  @override
  Future<BotaRecordingState> readRecordingState(BotaConnectedDevice device) =>
      _runOperation<BotaRecordingState>(
        BotaOperation.readStatus,
        (String operationId) async => BridgeMapper.recordingState(
          await _hostApi.readRecordingState(
            operationId,
            BridgeMapper.deviceReference(device),
          ),
        ),
      );

  @override
  Stream<BotaRecordingState> recordingState(BotaConnectedDevice device) =>
      _stream<BotaRecordingState>(
        BotaOperation.readStatus,
        BotaRecordingStateSubscriptionMessage(
          device: BridgeMapper.deviceReference(device),
        ),
        (BotaEventPayloadMessage payload) {
          if (payload case BotaRecordingStateEventMessage(:final state)) {
            return BridgeMapper.recordingState(state);
          }
          throw const FormatException('Unexpected recording-state event.');
        },
      );

  @override
  Future<void> provision(BotaConnectedDevice device) => _runVoid(
    BotaOperation.provision,
    (String operationId) =>
        _hostApi.provision(operationId, BridgeMapper.deviceReference(device)),
  );

  @override
  Future<BotaConnectionSettings> readConnectionSettings(
    BotaConnectedDevice device,
  ) => _runOperation<BotaConnectionSettings>(
    BotaOperation.provision,
    (String operationId) async => BridgeMapper.connectionSettings(
      await _hostApi.readConnectionSettings(
        operationId,
        BridgeMapper.deviceReference(device),
      ),
    ),
  );

  @override
  Future<void> writeConnectionSettings(
    BotaConnectedDevice device,
    BotaConnectionSettings settings,
  ) => _runVoid(
    BotaOperation.provision,
    (String operationId) => _hostApi.writeConnectionSettings(
      operationId,
      BridgeMapper.deviceReference(device),
      BridgeMapper.connectionSettingsMessage(settings),
    ),
  );

  @override
  Future<BotaDeprovisionResult> deprovision(
    BotaConnectedDevice device, {
    required String grantBlob,
  }) => _runOperation<BotaDeprovisionResult>(
    BotaOperation.provision,
    (String operationId) async => BridgeMapper.deprovisionResult(
      await _hostApi.deprovision(
        operationId,
        BridgeMapper.deviceReference(device),
        grantBlob,
      ),
    ),
  );

  @override
  Future<void> cancelProvisioningOperation() =>
      _runVoid(BotaOperation.provision, _hostApi.cancelProvisioningOperation);

  @override
  Future<BotaFactoryResetCompletion> reset(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => _runOperation<BotaFactoryResetCompletion>(
    BotaOperation.factoryReset,
    (String operationId) async => BridgeMapper.factoryResetCompletion(
      await _hostApi.factoryReset(
        operationId,
        BridgeMapper.deviceReference(device),
        BridgeMapper.factoryResetCommand(command),
      ),
    ),
  );

  @override
  Future<BotaFactoryResetCompletion?> resumePending(
    BotaConnectedDevice device, {
    required int currentBindingGeneration,
  }) => _runOperation<BotaFactoryResetCompletion?>(BotaOperation.factoryReset, (
    String operationId,
  ) async {
    final BotaFactoryResetCompletionMessage? completion = await _hostApi
        .resumePendingFactoryReset(
          operationId,
          BridgeMapper.deviceReference(device),
          currentBindingGeneration,
        );
    return completion == null
        ? null
        : BridgeMapper.factoryResetCompletion(completion);
  });

  @override
  Future<BotaFactoryResetCompletion> resumeUnjournaled(
    BotaConnectedDevice device,
    BotaFactoryResetCommand command,
  ) => _runOperation<BotaFactoryResetCompletion>(
    BotaOperation.factoryReset,
    (String operationId) async => BridgeMapper.factoryResetCompletion(
      await _hostApi.resumeUnjournaledFactoryReset(
        operationId,
        BridgeMapper.deviceReference(device),
        BridgeMapper.factoryResetCommand(command),
      ),
    ),
  );

  @override
  Future<void> cancelFactoryResetOperation() => _runVoid(
    BotaOperation.factoryReset,
    _hostApi.cancelFactoryResetOperation,
  );

  @override
  Future<List<BotaDeviceRecording>> listRecordings(
    BotaConnectedDevice device,
  ) => _runOperation<List<BotaDeviceRecording>>(
    BotaOperation.transferRecording,
    (String operationId) async => (await _hostApi.listRecordings(
      operationId,
      BridgeMapper.deviceReference(device),
    )).map(BridgeMapper.deviceRecording).toList(growable: false),
  );

  @override
  Stream<BotaRecordingSyncEvent> syncRecording(
    BotaConnectedDevice device,
    BotaDeviceRecording recording, {
    required String sinkId,
    bool confirmOnCompletion = false,
  }) => _stream<BotaRecordingSyncEvent>(
    BotaOperation.transferRecording,
    BotaRecordingSyncSubscriptionMessage(
      device: BridgeMapper.deviceReference(device),
      recording: BridgeMapper.deviceRecordingMessage(recording),
      sinkId: sinkId,
      confirmOnCompletion: confirmOnCompletion,
    ),
    (BotaEventPayloadMessage payload) => switch (payload) {
      BotaRecordingSyncProgressEventMessage(:final progress) =>
        BotaRecordingSyncProgress(BridgeMapper.recordingProgress(progress)),
      BotaRecordingSyncCompletedEventMessage(:final localPath) =>
        BotaRecordingSyncCompleted(localPath: localPath),
      _ => throw const FormatException('Unexpected recording-sync event.'),
    },
  );

  @override
  Future<BotaRecordingTransferMetadata?> takeTransferMetadata(String sinkId) =>
      _runOperation<BotaRecordingTransferMetadata?>(
        BotaOperation.transferRecording,
        (String operationId) async {
          final BotaRecordingTransferMetadataMessage? metadata = await _hostApi
              .takeTransferMetadata(operationId, sinkId);
          return metadata == null
              ? null
              : BridgeMapper.recordingTransferMetadata(metadata);
        },
      );

  @override
  Future<void> confirmRecording(
    BotaConnectedDevice device,
    String recordingId,
  ) => _runVoid(
    BotaOperation.transferRecording,
    (String operationId) => _hostApi.confirmRecording(
      operationId,
      BridgeMapper.deviceReference(device),
      recordingId,
    ),
  );

  @override
  Stream<BotaUploadOwnershipEvent> observeUploadOwnership(
    BotaConnectedDevice device, {
    required String recordingId,
    required String uploadId,
    required String destinationId,
  }) => _stream<BotaUploadOwnershipEvent>(
    BotaOperation.upload,
    BotaUploadOwnershipSubscriptionMessage(
      device: BridgeMapper.deviceReference(device),
      recordingId: recordingId,
      uploadId: uploadId,
      destinationId: destinationId,
    ),
    (BotaEventPayloadMessage payload) => switch (payload) {
      BotaUploadOwnershipProgressEventMessage(:final progress) =>
        BotaUploadOwnershipProgress(BridgeMapper.recordingProgress(progress)),
      BotaUploadOwnershipResolvedEventMessage(:final result) =>
        BotaUploadOwnershipResolved(BridgeMapper.uploadOwnershipResult(result)),
      _ => throw const FormatException('Unexpected upload-ownership event.'),
    },
  );

  @override
  Future<void> cancelRecordingOperation() => _runVoid(
    BotaOperation.transferRecording,
    _hostApi.cancelRecordingOperation,
  );

  @override
  Stream<BotaFirmwareProgress> updateFirmware(
    BotaConnectedDevice device,
    BotaFirmwareImage image,
  ) => _stream<BotaFirmwareProgress>(
    BotaOperation.updateFirmware,
    BotaFirmwareUpdateSubscriptionMessage(
      device: BridgeMapper.deviceReference(device),
      image: BridgeMapper.firmwareImageMessage(image),
    ),
    (BotaEventPayloadMessage payload) {
      if (payload case BotaFirmwareProgressEventMessage(:final progress)) {
        return BridgeMapper.firmwareProgress(progress);
      }
      throw const FormatException('Unexpected firmware event.');
    },
  );

  @override
  Future<void> cancelOtaOperation() =>
      _runVoid(BotaOperation.updateFirmware, _hostApi.cancelOtaOperation);

  @override
  Stream<BotaDeviceLogLine> streamLogs(BotaConnectedDevice device) =>
      _stream<BotaDeviceLogLine>(
        BotaOperation.readDeviceLogs,
        BotaLogSubscriptionMessage(
          device: BridgeMapper.deviceReference(device),
        ),
        (BotaEventPayloadMessage payload) {
          if (payload case BotaDeviceLogEventMessage(:final line)) {
            return BridgeMapper.deviceLogLine(line);
          }
          throw const FormatException('Unexpected device-log event.');
        },
      );

  @override
  Future<void> stopLogs() =>
      _runVoid(BotaOperation.readDeviceLogs, _hostApi.stopLogs);

  @override
  Future<BotaWifiConfigResult> configureWifi(
    BotaConnectedDevice device,
    BotaWifiCredentials credentials, {
    required String grantBlob,
  }) => _runOperation<BotaWifiConfigResult>(
    BotaOperation.provision,
    (String operationId) async => BridgeMapper.wifiConfigResult(
      await _hostApi.configureWifi(
        operationId,
        BridgeMapper.deviceReference(device),
        BridgeMapper.wifiCredentials(credentials),
        grantBlob,
      ),
    ),
  );

  @override
  Future<BotaWifiConfigResult> disconnectWifi(BotaConnectedDevice device) =>
      _runOperation<BotaWifiConfigResult>(
        BotaOperation.provision,
        (String operationId) async => BridgeMapper.wifiConfigResult(
          await _hostApi.disconnectWifi(
            operationId,
            BridgeMapper.deviceReference(device),
          ),
        ),
      );

  @override
  Future<BotaWifiStatus> readWifiStatus(BotaConnectedDevice device) =>
      _runOperation<BotaWifiStatus>(
        BotaOperation.readStatus,
        (String operationId) async => BridgeMapper.wifiStatus(
          await _hostApi.readWifiStatus(
            operationId,
            BridgeMapper.deviceReference(device),
          ),
        ),
      );

  @override
  Stream<BotaWifiStatus> wifiStatus(BotaConnectedDevice device) =>
      _stream<BotaWifiStatus>(
        BotaOperation.readStatus,
        BotaWifiStatusSubscriptionMessage(
          device: BridgeMapper.deviceReference(device),
        ),
        (BotaEventPayloadMessage payload) {
          if (payload case BotaWifiStatusEventMessage(:final status)) {
            return BridgeMapper.wifiStatus(status);
          }
          throw const FormatException('Unexpected WiFi-status event.');
        },
      );

  @override
  Future<BotaWifiScanResult> scanWifi(BotaConnectedDevice device) =>
      _runOperation<BotaWifiScanResult>(
        BotaOperation.discover,
        (String operationId) async => BridgeMapper.wifiScanResult(
          await _hostApi.scanWifi(
            operationId,
            BridgeMapper.deviceReference(device),
          ),
        ),
      );

  @override
  Future<void> cancelWifiOperation() =>
      _runVoid(BotaOperation.provision, _hostApi.cancelWifiOperation);

  @override
  void onEvent(BotaEventMessage event) {
    if (!RequestId.isValid(event.subscriptionId)) return;
    final _ActiveStream? stream = _activeStreams[event.subscriptionId];
    if (stream == null) return;

    switch (event.payload) {
      case BotaSubscriptionErrorEventMessage(:final error):
        unawaited(
          _finishStream(
            event.subscriptionId,
            error: _stableBridgeError(error, stream.operation),
            cancelNative: true,
          ),
        );
      case BotaSubscriptionCompleteEventMessage():
        unawaited(_finishStream(event.subscriptionId));
      default:
        try {
          stream.add(event.payload);
        } on Object {
          unawaited(
            _finishStream(
              event.subscriptionId,
              error: _unexpectedEvent(stream.operation),
              cancelNative: true,
            ),
          );
        }
    }
  }

  Stream<T> _stream<T>(
    BotaOperation operation,
    BotaSubscriptionRequestMessage request,
    T Function(BotaEventPayloadMessage payload) map,
  ) {
    final String subscriptionId = RequestId.next();
    late final StreamController<T> controller;
    late final _ActiveStream active;
    controller = StreamController<T>(
      sync: true,
      onListen: () {
        final BotaSdkException? lifecycleError = _lifecycleError(operation);
        if (lifecycleError != null) {
          controller.addError(lifecycleError);
          unawaited(controller.close());
          return;
        }

        _activeStreams[subscriptionId] = active;
        Future<void>.sync(
          () => _hostApi.startSubscription(subscriptionId, request),
        ).then(
          (_) {},
          onError: (Object error, StackTrace stackTrace) {
            unawaited(
              _finishStream(
                subscriptionId,
                error: _stableError(error, operation),
                cancelNative: true,
              ),
            );
          },
        );
      },
      onCancel: () => _cancelStream(subscriptionId),
    );
    active = _ActiveStream(
      operation: operation,
      add: (BotaEventPayloadMessage payload) => controller.add(map(payload)),
      addError: controller.addError,
      close: controller.close,
    );
    return controller.stream;
  }

  Future<void> _cancelStream(String subscriptionId) async {
    final _ActiveStream? active = _activeStreams.remove(subscriptionId);
    if (active == null) return;
    try {
      await _hostApi.cancelSubscription(subscriptionId);
    } on Object catch (error, stackTrace) {
      Error.throwWithStackTrace(
        _stableError(error, active.operation),
        stackTrace,
      );
    }
  }

  Future<void> _finishStream(
    String subscriptionId, {
    Object? error,
    bool cancelNative = false,
  }) async {
    final _ActiveStream? active = _activeStreams.remove(subscriptionId);
    if (active == null) return;

    if (cancelNative) {
      try {
        await _hostApi.cancelSubscription(subscriptionId);
      } on Object {
        // The stream's primary failure remains authoritative.
      }
    }
    if (error != null) active.addError(error);
    await active.close();
  }

  @override
  Future<BotaMaterialResponseMessage> requestMaterial(
    BotaMaterialRequestMessage request,
  ) => switch (request) {
    BotaProvisioningMaterialRequestMessage() => _requestProvisioningMaterial(
      request,
    ),
    BotaFactoryResetGrantRequestMessage() => _requestFactoryResetGrant(request),
  };

  @override
  Future<BotaFirmwareSourceMessage> requestFirmware(
    BotaFirmwareRequestMessage request,
  ) {
    final BotaFirmwareCallback? callback = _applicationCallbacks?.firmware;
    if (callback == null) {
      return Future<BotaFirmwareSourceMessage>.error(_callbackUnavailable());
    }
    return _runCallback<BotaFirmwareSource, BotaFirmwareSourceMessage>(
      requestId: request.requestId,
      kind: _CallbackKind.firmware,
      invoke: () => callback(BridgeMapper.firmwareRequest(request)),
      responseId: (BotaFirmwareSource value) => value.requestId,
      map: BridgeMapper.firmwareSource,
    );
  }

  @override
  Future<BotaFactoryResetResultAcknowledgementMessage>
  persistFactoryResetResult(BotaFactoryResetResultRequestMessage request) {
    final BotaFactoryResetResultCallback? callback =
        _applicationCallbacks?.persistFactoryResetResult;
    if (callback == null) {
      return Future<BotaFactoryResetResultAcknowledgementMessage>.error(
        _callbackUnavailable(),
      );
    }
    return _runCallback<
      BotaFactoryResetResultAcknowledgement,
      BotaFactoryResetResultAcknowledgementMessage
    >(
      requestId: request.requestId,
      kind: _CallbackKind.factoryResetResult,
      invoke: () => callback(BridgeMapper.factoryResetResultRequest(request)),
      responseId: (BotaFactoryResetResultAcknowledgement value) =>
          value.requestId,
      map: BridgeMapper.factoryResetResultAcknowledgement,
    );
  }

  BotaApplicationCallbacks? get _applicationCallbacks =>
      (_configuration ?? _configuring)?.callbacks;

  Future<BotaMaterialResponseMessage> _requestProvisioningMaterial(
    BotaProvisioningMaterialRequestMessage request,
  ) {
    final BotaProvisioningMaterialCallback? callback =
        _applicationCallbacks?.provisioningMaterial;
    if (callback == null) {
      return Future<BotaMaterialResponseMessage>.error(_callbackUnavailable());
    }
    return _runCallback<BotaProvisioningMaterial, BotaMaterialResponseMessage>(
      requestId: request.requestId,
      kind: _CallbackKind.provisioningMaterial,
      invoke: () => callback(BridgeMapper.provisioningMaterialRequest(request)),
      responseId: (BotaProvisioningMaterial value) => value.requestId,
      map: BridgeMapper.provisioningMaterialResponse,
    );
  }

  Future<BotaMaterialResponseMessage> _requestFactoryResetGrant(
    BotaFactoryResetGrantRequestMessage request,
  ) {
    final BotaFactoryResetGrantCallback? callback =
        _applicationCallbacks?.factoryResetGrant;
    if (callback == null) {
      return Future<BotaMaterialResponseMessage>.error(_callbackUnavailable());
    }
    return _runCallback<BotaFactoryResetGrant, BotaMaterialResponseMessage>(
      requestId: request.requestId,
      kind: _CallbackKind.factoryResetGrant,
      invoke: () => callback(BridgeMapper.factoryResetGrantRequest(request)),
      responseId: (BotaFactoryResetGrant value) => value.requestId,
      map: BridgeMapper.factoryResetGrantResponse,
    );
  }

  Future<TOutput> _runCallback<TResponse, TOutput>({
    required String requestId,
    required _CallbackKind kind,
    required Future<TResponse> Function() invoke,
    required String Function(TResponse response) responseId,
    required TOutput Function(TResponse response) map,
  }) {
    if (!RequestId.isValid(requestId)) {
      return Future<TOutput>.error(
        _callbackError(
          'invalid_callback_request',
          'The native callback request ID is invalid.',
        ),
      );
    }
    if (_destroying || _destroyed) {
      return Future<TOutput>.error(
        _callbackError(
          'client_destroyed',
          'The Bota client has been destroyed.',
        ),
      );
    }

    final _PendingCallback? existing = _pendingCallbacks[requestId];
    if (existing != null) {
      return Future<TOutput>.error(
        existing.kind == kind
            ? _callbackError(
                'duplicate_callback_request',
                'The callback request ID is already active.',
              )
            : _callbackError(
                'callback_kind_mismatch',
                'The callback request ID belongs to a different kind.',
              ),
      );
    }
    final _CallbackKind? consumedKind = _consumedCallbacks[requestId];
    if (consumedKind != null) {
      return Future<TOutput>.error(
        consumedKind == kind
            ? _callbackError(
                'duplicate_callback_request',
                'The callback request ID has already been used.',
              )
            : _callbackError(
                'callback_kind_mismatch',
                'The callback request ID belongs to a different kind.',
              ),
      );
    }

    final Completer<TOutput> completer = Completer<TOutput>();
    final _PendingCallback pending = _PendingCallback(
      kind: kind,
      reject: completer.completeError,
    );
    _pendingCallbacks[requestId] = pending;
    _consumedCallbacks[requestId] = kind;
    Future<TResponse>.sync(invoke).then(
      (TResponse response) {
        final _PendingCallback? active = _pendingCallbacks.remove(requestId);
        if (!identical(active, pending)) return;
        if (responseId(response) != requestId) {
          completer.completeError(
            _callbackError(
              'callback_id_mismatch',
              'The callback response ID does not match its request.',
            ),
          );
          return;
        }
        try {
          completer.complete(map(response));
        } on Object catch (_, stackTrace) {
          completer.completeError(_callbackFailed(), stackTrace);
        }
      },
      onError: (Object _, StackTrace stackTrace) {
        final _PendingCallback? active = _pendingCallbacks.remove(requestId);
        if (!identical(active, pending)) return;
        completer.completeError(_callbackFailed(), stackTrace);
      },
    );
    return completer.future;
  }
}

final class _PendingOperation {
  const _PendingOperation({
    required this.operation,
    required this.complete,
    required this.fail,
  });

  final BotaOperation operation;
  final void Function(Object? value) complete;
  final void Function(Object error, [StackTrace? stackTrace]) fail;
}

final class _ActiveStream {
  const _ActiveStream({
    required this.operation,
    required this.add,
    required this.addError,
    required this.close,
  });

  final BotaOperation operation;
  final void Function(BotaEventPayloadMessage payload) add;
  final void Function(Object error, [StackTrace? stackTrace]) addError;
  final Future<void> Function() close;
}

enum _CallbackKind {
  provisioningMaterial,
  factoryResetGrant,
  factoryResetResult,
  firmware,
}

final class _PendingCallback {
  const _PendingCallback({required this.kind, required this.reject});

  final _CallbackKind kind;
  final void Function(Object error, [StackTrace? stackTrace]) reject;
}

BotaSdkException _clientDestroyed(BotaOperation operation) => BotaSdkException(
  code: BotaErrorCode.clientDestroyed,
  operation: operation,
  retryable: false,
  detail: 'The Bota client has been destroyed.',
);

BotaSdkException _configurationConflict() => const BotaSdkException(
  code: BotaErrorCode.configurationConflict,
  operation: BotaOperation.validate,
  retryable: false,
  detail: 'The Bota client is configured with different settings.',
);

BotaSdkException _stableError(Object error, BotaOperation operation) {
  if (error case BotaSdkException sdkError) return sdkError;
  if (error case PlatformException(
    :final code,
    details: final BotaErrorMessage details,
  )) {
    final BotaSdkException? bridgeError = _adapterBridgeError(code, operation);
    if (bridgeError != null) return bridgeError;
    if (code == 'bota_sdk_error') {
      return _stableBridgeError(details, operation);
    }
  }
  return BotaSdkException(
    code: BotaErrorCode.internal,
    operation: operation,
    retryable: false,
    detail: error is PlatformException
        ? 'The native bridge operation failed.'
        : 'The bridge operation failed.',
  );
}

BotaSdkException? _adapterBridgeError(String code, BotaOperation operation) {
  final (BotaErrorCode, bool)? mapping = switch (code) {
    'callback_id_mismatch' => (BotaErrorCode.unexpectedEvent, false),
    'callback_kind_mismatch' => (BotaErrorCode.unexpectedEvent, false),
    'callback_unavailable' => (BotaErrorCode.featureUnavailable, false),
    'cancelled' => (BotaErrorCode.cancelled, false),
    'configuration_conflict' => (BotaErrorCode.configurationConflict, false),
    'device_not_found' => (BotaErrorCode.deviceNotFound, false),
    'duplicate_identifier' => (BotaErrorCode.invalidInput, false),
    'engine_detached' => (BotaErrorCode.clientDestroyed, false),
    'invalid_callback_response' => (BotaErrorCode.invalidInput, false),
    'invalid_configuration' => (BotaErrorCode.invalidInput, false),
    'invalid_operation_id' => (BotaErrorCode.invalidInput, false),
    'invalid_request' => (BotaErrorCode.invalidInput, false),
    'not_configured' => (BotaErrorCode.featureUnavailable, false),
    'operation_in_progress' => (BotaErrorCode.operationInProgress, true),
    'operation_not_owned' => (BotaErrorCode.operationNotOwned, false),
    'subscription_not_found' => (BotaErrorCode.operationNotOwned, false),
    'unsupported_subscription' => (BotaErrorCode.unsupportedOperation, false),
    _ => null,
  };
  if (mapping == null) return null;
  return BotaSdkException(
    code: mapping.$1,
    operation: operation,
    retryable: mapping.$2,
    detail: 'The native bridge rejected the operation.',
  );
}

BotaSdkException _stableBridgeError(
  BotaErrorMessage error,
  BotaOperation operation,
) {
  try {
    return BridgeMapper.error(error);
  } on Object {
    return BotaSdkException(
      code: BotaErrorCode.internal,
      operation: operation,
      retryable: false,
      detail: 'The native bridge operation failed.',
    );
  }
}

BotaSdkException _unexpectedEvent(BotaOperation operation) => BotaSdkException(
  code: BotaErrorCode.unexpectedEvent,
  operation: operation,
  retryable: false,
  detail: 'The native bridge emitted an event for the wrong stream kind.',
);

PlatformException _callbackUnavailable() => _callbackError(
  'callback_unavailable',
  'The requested application callback is unavailable.',
);

PlatformException _callbackFailed() =>
    _callbackError('callback_failed', 'The application callback failed.');

PlatformException _callbackError(String code, String message) =>
    PlatformException(code: code, message: message);
