export 'src/client.dart' show BotaConfiguration, BotaDeviceClient;
export 'src/client_presence.dart' show SdkClientContext, BotaClientPresence;
export 'src/errors.dart' show BotaErrorCode, BotaOperation, BotaSdkException;
export 'src/managers.dart'
    show
        BotaControlManager,
        BotaDeviceManager,
        BotaFactoryResetManager,
        BotaLogManager,
        BotaOtaManager,
        BotaProvisioningManager,
        BotaRecordingManager,
        BotaWifiManager;
export 'src/models/device.dart'
    show
        BotaCapabilities,
        BotaCapability,
        BotaConnectedDevice,
        BotaConnectionState,
        BotaDeviceFlags,
        BotaDeviceLogLine,
        BotaDeviceState,
        BotaDeviceStatus,
        BotaDeviceType,
        BotaDiscoveredDevice,
        BotaLteState,
        BotaModemInfo,
        BotaPairingState,
        BotaReconnectHint,
        BotaWifiRadioState;
export 'src/models/ota.dart'
    show BotaFirmwareImage, BotaFirmwarePhase, BotaFirmwareProgress;
export 'src/models/recording.dart'
    show
        BotaAudioCodec,
        BotaBluetoothFallback,
        BotaDeviceRecording,
        BotaDeviceUploadCompleted,
        BotaDeviceUploadPreserved,
        BotaRecordingInitiator,
        BotaRecordingState,
        BotaRecordingSyncCompleted,
        BotaRecordingSyncEvent,
        BotaRecordingSyncProgress,
        BotaRecordingTransferMetadata,
        BotaRecordingTransferProgress,
        BotaUploadOwnershipEvent,
        BotaUploadOwnershipProgress,
        BotaUploadOwnershipResolved,
        BotaUploadOwnershipResult;
export 'src/models/security.dart'
    show
        BotaApplicationCallbacks,
        BotaDeprovisionResult,
        BotaFactoryResetCommand,
        BotaFactoryResetCompletion,
        BotaFactoryResetGrant,
        BotaFactoryResetGrantCallback,
        BotaFactoryResetGrantRequest,
        BotaFactoryResetResultAcknowledgement,
        BotaFactoryResetResultCallback,
        BotaFactoryResetResultRequest,
        BotaFirmwareCallback,
        BotaFirmwareRequest,
        BotaFirmwareSource,
        BotaProvisioningFailure,
        BotaProvisioningMaterial,
        BotaProvisioningMaterialCallback,
        BotaProvisioningMaterialRequest;
export 'src/models/settings.dart'
    show
        BotaConnectionSettings,
        BotaConnectionType,
        BotaEnabledConnections,
        BotaPowerManagement;
export 'src/models/wifi.dart'
    show
        BotaWifiConfigResult,
        BotaWifiCredentials,
        BotaWifiNetwork,
        BotaWifiScanResult,
        BotaWifiState,
        BotaWifiStatus;

/// Metadata for the Bota Flutter SDK package.
abstract final class BotaFlutterSdk {
  /// The package name used by Flutter applications.
  static const String packageName = 'bota_app_sdk';
}
