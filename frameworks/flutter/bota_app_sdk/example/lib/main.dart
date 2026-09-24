import 'dart:async';

import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:flutter/material.dart';

void main() {
  runApp(const BotaExampleApp());
}

final class BotaExampleApp extends StatelessWidget {
  const BotaExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    const Color ink = Color(0xFF172126);
    const Color teal = Color(0xFF087E8B);
    const Color coral = Color(0xFFD95D39);
    final ColorScheme colors = ColorScheme.fromSeed(
      seedColor: teal,
      brightness: Brightness.light,
      surface: const Color(0xFFF5F7F6),
    ).copyWith(primary: teal, secondary: coral, onSurface: ink);

    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Bota Device Console',
      theme: ThemeData(
        colorScheme: colors,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF5F7F6),
        cardTheme: const CardThemeData(
          margin: EdgeInsets.zero,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(6)),
            side: BorderSide(color: Color(0xFFD7DEDC)),
          ),
        ),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(6)),
          ),
          isDense: true,
        ),
      ),
      home: const DeviceConsoleScreen(),
    );
  }
}

final class DeviceConsoleScreen extends StatefulWidget {
  const DeviceConsoleScreen({
    super.key,
    this.client,
    this.uploadEncryptedBatch = _uploadEncryptedBatch,
    this.deprovisionGrant = _deprovisionGrantUnavailable,
    this.factoryResetCommand = _factoryResetCommandUnavailable,
  });

  final BotaDeviceClient? client;
  final Future<void> Function(
    String localPath,
    BotaRecordingTransferMetadata? metadata,
  )
  uploadEncryptedBatch;
  final Future<String> Function() deprovisionGrant;
  final Future<BotaFactoryResetCommand> Function() factoryResetCommand;

  @override
  State<DeviceConsoleScreen> createState() => _DeviceConsoleScreenState();
}

final class _DeviceConsoleScreenState extends State<DeviceConsoleScreen> {
  late final BotaDeviceClient _client = widget.client ?? BotaDeviceClient();
  final TextEditingController _serialController = TextEditingController();
  final TextEditingController _ssidController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();

  StreamSubscription<BotaDiscoveredDevice>? _scanSubscription;
  List<BotaDiscoveredDevice> _discovered = <BotaDiscoveredDevice>[];
  List<BotaDeviceRecording> _recordings = <BotaDeviceRecording>[];
  BotaConnectedDevice? _connected;
  BotaDeviceStatus? _status;
  BotaFirmwareProgress? _firmwareProgress;
  String? _activeCommand;
  String _notice = 'Starting SDK';
  bool _configured = false;

  bool get _canRun => _configured && _activeCommand == null;

  @override
  void initState() {
    super.initState();
    unawaited(_configure());
  }

  @override
  void dispose() {
    unawaited(_scanSubscription?.cancel());
    unawaited(_client.destroy());
    _serialController.dispose();
    _ssidController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _configure() async {
    try {
      await _client.configure(
        const BotaConfiguration(
          applicationSupportNamespace: 'bota_example',
          callbacks: BotaApplicationCallbacks(
            provisioningMaterial: _provisioningMaterialUnavailable,
            factoryResetGrant: _factoryResetGrantUnavailable,
            persistFactoryResetResult: _resetPersistenceUnavailable,
            firmware: _firmwareSourceUnavailable,
          ),
        ),
      );
      if (!mounted) return;
      setState(() {
        _configured = true;
        _notice = 'SDK ready';
      });
    } on Object catch (error) {
      _setFailure(error);
    }
  }

  Future<void> _run(String command, Future<String?> Function() action) async {
    if (!_canRun) return;
    setState(() {
      _activeCommand = command;
      _notice = command;
    });
    try {
      final String? notice = await action();
      if (!mounted) return;
      setState(() {
        _notice = notice ?? '$command complete';
      });
    } on Object catch (error) {
      _setFailure(error);
    } finally {
      if (mounted) {
        setState(() {
          _activeCommand = null;
        });
      }
    }
  }

  void _setFailure(Object error) {
    if (!mounted) return;
    setState(() {
      _notice = switch (error) {
        BotaSdkException(:final code, :final operation) =>
          '${operation.name}: ${code.name}',
        UnsupportedError(:final message) => message ?? 'Integration required',
        StateError(:final message) => message,
        _ => 'Operation failed',
      };
    });
  }

  Future<void> _scan() => _run('Scanning nearby devices', () async {
    await _scanSubscription?.cancel();
    if (mounted) {
      setState(() {
        _discovered = <BotaDiscoveredDevice>[];
      });
    }
    final Completer<void> finished = Completer<void>();
    _scanSubscription = _client.devices
        .scan(timeout: const Duration(seconds: 10))
        .listen(
          (BotaDiscoveredDevice device) {
            if (!mounted) return;
            setState(() {
              final List<BotaDiscoveredDevice> next =
                  <BotaDiscoveredDevice>[
                    ..._discovered.where(
                      (BotaDiscoveredDevice value) => value.id != device.id,
                    ),
                    device,
                  ]..sort(
                    (BotaDiscoveredDevice left, BotaDiscoveredDevice right) =>
                        right.rssi.compareTo(left.rssi),
                  );
              _discovered = next;
            });
          },
          onError: (Object error, StackTrace stackTrace) {
            if (!finished.isCompleted) {
              finished.completeError(error, stackTrace);
            }
          },
          onDone: () {
            if (!finished.isCompleted) finished.complete();
          },
          cancelOnError: true,
        );
    await finished.future;
    return '${_discovered.length} device${_discovered.length == 1 ? '' : 's'} found';
  });

  Future<void> _connect(BotaDiscoveredDevice device) =>
      _run('Connecting', () async {
        final BotaConnectedDevice connected = await _client.devices.connect(
          device,
        );
        if (mounted) {
          setState(() {
            _connected = connected;
            _serialController.text = connected.serialNumber;
            _recordings = <BotaDeviceRecording>[];
            _status = null;
          });
        }
        return 'Connected to ${connected.serialNumber}';
      });

  Future<void> _reconnect() => _run('Reconnecting by serial', () async {
    final String serial = _serialController.text.trim();
    if (serial.isEmpty) {
      throw StateError('Enter the saved serial number');
    }
    final BotaConnectedDevice connected = await _client.devices.reconnect(
      serial,
    );
    if (mounted) {
      setState(() {
        _connected = connected;
      });
    }
    return 'Serial verified: ${connected.serialNumber}';
  });

  Future<void> _disconnect() => _run('Disconnecting', () async {
    await _client.devices.disconnect();
    if (mounted) {
      setState(() {
        _clearDeviceState();
      });
    }
    return 'Disconnected';
  });

  Future<void> _readStatus() => _run('Reading status', () async {
    _requireDevice();
    final BotaDeviceStatus status = await _client.devices.readStatus();
    if (mounted) {
      setState(() {
        _status = status;
      });
    }
    return 'Status updated';
  });

  Future<void> _listRecordings() => _run('Loading recordings', () async {
    final BotaConnectedDevice device = _requireDevice();
    final List<BotaDeviceRecording> recordings = await _client.recordings.list(
      device,
    );
    if (mounted) {
      setState(() {
        _recordings = recordings;
      });
    }
    return '${recordings.length} recording${recordings.length == 1 ? '' : 's'} on device';
  });

  Future<void> _syncRecording(
    BotaDeviceRecording recording,
  ) => _run('Transferring recording', () async {
    final BotaConnectedDevice device = _requireDevice();
    final String sinkId = 'batch-${recording.recordingId}';
    String? localPath;
    await for (final BotaRecordingSyncEvent event in _client.recordings.sync(
      device,
      recording,
      sinkId: sinkId,
      confirmOnCompletion: false,
    )) {
      switch (event) {
        case BotaRecordingSyncProgress(:final progress):
          if (mounted) {
            setState(() {
              _notice =
                  'Transferred ${progress.completedBytes} of ${progress.totalBytes} bytes';
            });
          }
        case BotaRecordingSyncCompleted(localPath: final path):
          localPath = path;
      }
    }
    final String completedPath =
        localPath ??
        (throw StateError('Native transfer ended without a file path'));
    final BotaRecordingTransferMetadata? metadata = await _client.recordings
        .takeTransferMetadata(sinkId);
    await widget.uploadEncryptedBatch(completedPath, metadata);
    await _client.recordings.confirm(device, recording.recordingId);
    if (mounted) {
      setState(() {
        _recordings = _recordings
            .where(
              (BotaDeviceRecording value) =>
                  value.recordingId != recording.recordingId,
            )
            .toList(growable: false);
      });
    }
    return 'Upload confirmed; device copy removed';
  });

  Future<void> _provision() => _run('Provisioning device', () async {
    await _client.provisioning.provision(_requireDevice());
    return 'Provisioned';
  });

  Future<void> _configureWifi() => _run('Configuring WiFi', () async {
    final BotaConnectedDevice device = _requireDevice();
    final String ssid = _ssidController.text.trim();
    if (ssid.isEmpty || _passwordController.text.isEmpty) {
      throw StateError('Enter the WiFi network and password');
    }
    final String grantBlob = await _wifiGrantUnavailable();
    final BotaWifiConfigResult result = await _client.wifi.configure(
      device,
      BotaWifiCredentials(ssid: ssid, password: _passwordController.text),
      grantBlob: grantBlob,
    );
    return 'WiFi: ${result.name}';
  });

  Future<void> _startOta() => _run('Updating firmware', () async {
    final BotaConnectedDevice device = _requireDevice();
    final BotaFirmwareImage image = await _firmwareImageUnavailable();
    await for (final BotaFirmwareProgress progress in _client.ota.update(
      device,
      image,
    )) {
      if (mounted) {
        setState(() {
          _firmwareProgress = progress;
          _notice = 'Firmware: ${progress.phase.name}';
        });
      }
    }
    return 'Firmware update complete';
  });

  Future<void> _removeOnly() async {
    if (!await _confirm(
      title: 'Remove device pairing?',
      body: 'Recordings remain on the physical device.',
      action: 'Remove',
    )) {
      return;
    }
    await _run('Removing pairing', () async {
      final BotaConnectedDevice device = _requireDevice();
      final String grantBlob = await widget.deprovisionGrant();
      final BotaDeprovisionResult result = await _client.provisioning
          .deprovision(device, grantBlob: grantBlob);
      if (!result.success) throw StateError('Device rejected removal');
      if (mounted) {
        setState(() {
          _clearDeviceState(clearReconnectTargets: true);
        });
      }
      return 'Pairing removed; recordings retained';
    });
  }

  Future<void> _factoryReset() async {
    if (!await _confirm(
      title: 'Factory reset device?',
      body: 'This wipes every recording on the physical device.',
      action: 'Reset',
    )) {
      return;
    }
    await _run('Factory reset', () async {
      final BotaFactoryResetCommand command = await widget
          .factoryResetCommand();
      final BotaFactoryResetCompletion result = await _client.factoryReset
          .reset(_requireDevice(), command);
      if (mounted) {
        setState(() {
          _clearDeviceState(clearReconnectTargets: true);
        });
      }
      return 'Reset acknowledged for generation ${result.bindingGeneration}';
    });
  }

  void _clearDeviceState({bool clearReconnectTargets = false}) {
    _connected = null;
    _status = null;
    _recordings = <BotaDeviceRecording>[];
    _firmwareProgress = null;
    if (clearReconnectTargets) {
      _discovered = <BotaDiscoveredDevice>[];
      _serialController.clear();
    }
  }

  BotaConnectedDevice _requireDevice() =>
      _connected ?? (throw StateError('Connect a device first'));

  Future<bool> _confirm({
    required String title,
    required String body,
    required String action,
  }) async =>
      await showDialog<bool>(
        context: context,
        builder: (BuildContext context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;

  @override
  Widget build(BuildContext context) {
    final BotaConnectedDevice? device = _connected;
    final BotaDeviceStatus? status = _status;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bota Device Console'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Scan nearby devices',
            onPressed: _canRun ? _scan : null,
            icon: const Icon(Icons.radar),
          ),
          IconButton(
            key: const ValueKey<String>('device-console-disconnect'),
            tooltip: 'Disconnect',
            onPressed: _canRun && device != null ? _disconnect : null,
            icon: const Icon(Icons.link_off),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: <Widget>[
            if (_activeCommand != null) const LinearProgressIndicator(),
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _notice,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            const _SectionHeading('Connection'),
            TextField(
              key: const ValueKey<String>('device-console-serial'),
              controller: _serialController,
              enabled: _canRun,
              autocorrect: false,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Saved device serial',
                prefixIcon: Icon(Icons.confirmation_number_outlined),
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                FilledButton.icon(
                  key: const ValueKey<String>('device-console-scan'),
                  onPressed: _canRun ? _scan : null,
                  icon: const Icon(Icons.radar),
                  label: const Text('Scan'),
                ),
                OutlinedButton.icon(
                  onPressed: _canRun ? _reconnect : null,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Reconnect by serial'),
                ),
              ],
            ),
            if (_discovered.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              for (final BotaDiscoveredDevice result
                  in _discovered) ...<Widget>[
                Card(
                  child: ListTile(
                    dense: true,
                    leading: const Icon(Icons.bluetooth),
                    title: Text(result.name ?? 'Bota device'),
                    subtitle: Text(
                      '${result.deviceType ?? 'unknown'}  ${result.rssi} dBm',
                    ),
                    trailing: IconButton(
                      key: ValueKey<String>(
                        'device-console-connect-${result.id}',
                      ),
                      tooltip: 'Connect to ${result.name ?? 'device'}',
                      onPressed: _canRun ? () => _connect(result) : null,
                      icon: const Icon(Icons.link),
                    ),
                  ),
                ),
                const SizedBox(height: 6),
              ],
            ],
            const _SectionHeading('Connected Device'),
            if (device == null)
              const Text('No device connected')
            else ...<Widget>[
              Text(
                key: const ValueKey<String>('device-console-connected-serial'),
                device.serialNumber,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text('${device.deviceType}  Firmware ${device.firmwareVersion}'),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  FilledButton.tonalIcon(
                    key: const ValueKey<String>('device-console-status'),
                    onPressed: _canRun ? _readStatus : null,
                    icon: const Icon(Icons.monitor_heart_outlined),
                    label: const Text('Read status'),
                  ),
                  FilledButton.tonalIcon(
                    key: const ValueKey<String>('device-console-recordings'),
                    onPressed: _canRun ? _listRecordings : null,
                    icon: const Icon(Icons.library_music_outlined),
                    label: const Text('Recordings'),
                  ),
                ],
              ),
            ],
            if (status != null) ...<Widget>[
              const SizedBox(height: 12),
              Wrap(
                spacing: 16,
                runSpacing: 8,
                children: <Widget>[
                  _Metric(label: 'Battery', value: '${status.batteryLevel}%'),
                  _Metric(label: 'State', value: status.state.name),
                  _Metric(
                    label: 'Storage',
                    value:
                        '${status.storageUsedMegabytes}/${status.storageTotalMegabytes} MB',
                  ),
                  _Metric(
                    label: 'Pending',
                    value: '${status.pendingRecordings}',
                  ),
                ],
              ),
            ],
            if (_recordings.isNotEmpty) ...<Widget>[
              const _SectionHeading('On-device Recordings'),
              for (final BotaDeviceRecording recording
                  in _recordings) ...<Widget>[
                Card(
                  key: ValueKey<String>(
                    'device-console-recording-${recording.recordingId}',
                  ),
                  child: ListTile(
                    dense: true,
                    leading: const Icon(Icons.graphic_eq),
                    title: Text(recording.recordingId),
                    subtitle: Text(
                      '${recording.fileSizeBytes} bytes  ${recording.codec}',
                    ),
                    trailing: IconButton(
                      key: ValueKey<String>(
                        'device-console-sync-${recording.recordingId}',
                      ),
                      tooltip: 'Transfer for encrypted upload',
                      onPressed: _canRun
                          ? () => _syncRecording(recording)
                          : null,
                      icon: const Icon(Icons.cloud_upload_outlined),
                    ),
                  ),
                ),
                const SizedBox(height: 6),
              ],
            ],
            const _SectionHeading('WiFi'),
            TextField(
              controller: _ssidController,
              enabled: _canRun && device != null,
              decoration: const InputDecoration(
                labelText: 'Network name',
                prefixIcon: Icon(Icons.wifi),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _passwordController,
              enabled: _canRun && device != null,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Password',
                prefixIcon: Icon(Icons.password),
              ),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                key: const ValueKey<String>('device-console-wifi'),
                onPressed: _canRun && device != null ? _configureWifi : null,
                icon: const Icon(Icons.wifi_tethering),
                label: const Text('Configure WiFi'),
              ),
            ),
            const _SectionHeading('Device Actions'),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                OutlinedButton.icon(
                  key: const ValueKey<String>('device-console-provision'),
                  onPressed: _canRun && device != null ? _provision : null,
                  icon: const Icon(Icons.key_outlined),
                  label: const Text('Provision'),
                ),
                OutlinedButton.icon(
                  key: const ValueKey<String>('device-console-ota'),
                  onPressed: _canRun && device != null ? _startOta : null,
                  icon: const Icon(Icons.system_update_alt),
                  label: const Text('Update firmware'),
                ),
                OutlinedButton.icon(
                  key: const ValueKey<String>('device-console-remove-only'),
                  onPressed: _canRun && device != null ? _removeOnly : null,
                  icon: const Icon(Icons.person_remove_outlined),
                  label: const Text('Remove pairing'),
                ),
                FilledButton.icon(
                  key: const ValueKey<String>('device-console-factory-reset'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.error,
                  ),
                  onPressed: _canRun && device != null ? _factoryReset : null,
                  icon: const Icon(Icons.delete_forever_outlined),
                  label: const Text('Factory reset'),
                ),
              ],
            ),
            if (_firmwareProgress
                case final BotaFirmwareProgress progress) ...<Widget>[
              const SizedBox(height: 12),
              LinearProgressIndicator(
                value: progress.totalBytes == 0
                    ? null
                    : progress.completedBytes / progress.totalBytes,
                semanticsLabel: 'Firmware ${progress.phase.name}',
              ),
            ],
          ],
        ),
      ),
    );
  }
}

final class _SectionHeading extends StatelessWidget {
  const _SectionHeading(this.label);

  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 8),
    child: Text(
      label,
      style: Theme.of(
        context,
      ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
    ),
  );
}

final class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 132,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label, style: Theme.of(context).textTheme.labelSmall),
        Text(
          value,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
      ],
    ),
  );
}

Future<BotaProvisioningMaterial> _provisioningMaterialUnavailable(
  BotaProvisioningMaterialRequest request,
) => Future<BotaProvisioningMaterial>.error(
  UnsupportedError('Integrate the application backend for provisioning'),
);

Future<BotaFactoryResetGrant> _factoryResetGrantUnavailable(
  BotaFactoryResetGrantRequest request,
) => Future<BotaFactoryResetGrant>.error(
  UnsupportedError('Integrate the application backend for reset grants'),
);

Future<BotaFactoryResetResultAcknowledgement> _resetPersistenceUnavailable(
  BotaFactoryResetResultRequest request,
) => Future<BotaFactoryResetResultAcknowledgement>.error(
  UnsupportedError('Integrate durable backend reset-result persistence'),
);

Future<BotaFirmwareSource> _firmwareSourceUnavailable(
  BotaFirmwareRequest request,
) => Future<BotaFirmwareSource>.error(
  UnsupportedError('Integrate the application backend for firmware access'),
);

Future<String> _wifiGrantUnavailable() => Future<String>.error(
  UnsupportedError('Integrate the application backend for WiFi grants'),
);

Future<String> _deprovisionGrantUnavailable() => Future<String>.error(
  UnsupportedError('Integrate the application backend for removal grants'),
);

Future<BotaFactoryResetCommand> _factoryResetCommandUnavailable() =>
    Future<BotaFactoryResetCommand>.error(
      UnsupportedError('Integrate the application backend for reset commands'),
    );

Future<BotaFirmwareImage> _firmwareImageUnavailable() =>
    Future<BotaFirmwareImage>.error(
      UnsupportedError(
        'Integrate the application backend for firmware metadata',
      ),
    );

Future<void> _uploadEncryptedBatch(
  String localPath,
  BotaRecordingTransferMetadata? metadata,
) async {
  if (localPath.isEmpty || metadata == null || !metadata.isE2EEncrypted) {
    throw StateError('Native encrypted transfer metadata is incomplete');
  }
  throw UnsupportedError(
    'Integrate app-owned encrypted S3 upload before confirming deletion',
  );
}
