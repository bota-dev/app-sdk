package dev.bota.sdk.flutter

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.RecordingTransferMetadata
import dev.bota.sdk.UploadOwnershipResult
import dev.bota.sdk.model.AudioCodec
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeprovisionResult
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.ModemInfo
import dev.bota.sdk.model.PairingState
import dev.bota.sdk.model.RecordingInitiator
import dev.bota.sdk.model.RecordingState
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiConnectionStatus
import dev.bota.sdk.model.WiFiStatusInfo
import dev.bota.sdk.model.WifiRadioStatus
import dev.bota.sdk.model.WireValue
import java.time.Instant

internal object BotaAndroidMapper {
    fun discoveredDevice(value: DiscoveredDevice): BotaDiscoveredDeviceMessage = BotaDiscoveredDeviceMessage(
        id = value.id,
        name = value.name,
        deviceType = value.deviceType?.let(::deviceType),
        firmwareVersion = value.firmwareVersion,
        macAddress = value.macAddress,
        pairingState = value.pairingState?.let(::pairingState),
        rssi = value.rssi.toLong(),
        discoveredAtMillis = value.discoveredAt.toEpochMilli(),
    )

    fun discoveredDevice(value: BotaDiscoveredDeviceMessage): DiscoveredDevice = DiscoveredDevice(
        id = value.id,
        name = value.name,
        deviceType = value.deviceType?.let(::deviceType),
        firmwareVersion = value.firmwareVersion,
        macAddress = value.macAddress,
        pairingState = value.pairingState?.let(::pairingState),
        rssi = int(value.rssi),
        discoveredAt = Instant.ofEpochMilli(value.discoveredAtMillis),
    )

    fun connectedDevice(value: ConnectedDevice): BotaConnectedDeviceMessage = BotaConnectedDeviceMessage(
        id = value.id,
        serialNumber = value.serialNumber,
        deviceType = deviceType(value.deviceType),
        firmwareVersion = value.firmwareVersion,
        hardwareRevision = value.hardwareRevision,
        isProvisioned = value.isProvisioned,
        connectionState = connectionState(value.connectionState),
        mtu = value.mtu.toLong(),
    )

    fun deviceStatus(value: DeviceStatus): BotaDeviceStatusMessage = BotaDeviceStatusMessage(
        batteryLevel = value.batteryLevel.toLong(),
        batteryMillivolts = value.batteryMv?.toLong(),
        storageTotalMegabytes = value.storageTotalMb.toLong(),
        storageUsedMegabytes = value.storageUsedMb.toLong(),
        state = deviceState(value.state),
        pendingRecordings = value.pendingRecordings.toLong(),
        lastTimeSyncAtMillis = value.lastTimeSyncAt?.toEpochMilli(),
        signalStrength = value.signalStrength.toLong(),
        flags = deviceFlags(value.flags),
        timestamp = value.timestamp.toLong(),
        lteState = lteState(value.lteStatus),
        lteSignalQuality = value.lteSignalQuality?.toLong(),
        wifiState = value.wifiStatus?.let(::wifiRadioState),
        modemInfo = value.modemInfo?.let(::modemInfo),
    )

    fun connectionSettings(value: DeviceConnectionSettings): BotaConnectionSettingsMessage =
        BotaConnectionSettingsMessage(
            enabledConnections = enabledConnections(value.enabledConnections),
            heartbeatEnabledConnections = enabledConnections(value.heartbeatEnabledConnections),
            heartbeatUnknownMask = value.heartbeatUnknownMask.toLong(),
            uploadNetworkPreference = value.uploadNetworkPreference.map(::connectionType),
            powerManagement = BotaPowerManagementMessage(
                wifiIdleTimeoutMillis = secondsToMillis(value.powerManagement.wifiIdleTimeoutSeconds),
                cellularIdleTimeoutMillis = secondsToMillis(value.powerManagement.cellularIdleTimeoutSeconds),
            ),
            streamingEnabled = value.streamingEnabled,
            streamingFlushIntervalMillis = secondsToMillis(value.streamingFlushIntervalSeconds),
        )

    fun connectionSettings(value: BotaConnectionSettingsMessage): DeviceConnectionSettings =
        DeviceConnectionSettings(
            enabledConnections = enabledConnections(value.enabledConnections),
            heartbeatEnabledConnections = enabledConnections(value.heartbeatEnabledConnections),
            heartbeatUnknownMask = uByte(value.heartbeatUnknownMask),
            uploadNetworkPreference = value.uploadNetworkPreference.map(::connectionType),
            powerManagement = DeviceConnectionSettings.PowerManagement(
                wifiIdleTimeoutSeconds = timeoutSeconds(value.powerManagement.wifiIdleTimeoutMillis),
                cellularIdleTimeoutSeconds = timeoutSeconds(value.powerManagement.cellularIdleTimeoutMillis),
            ),
            streamingEnabled = value.streamingEnabled,
            streamingFlushIntervalSeconds = durationSeconds(value.streamingFlushIntervalMillis),
        )

    fun recording(value: DeviceRecording): BotaDeviceRecordingMessage = BotaDeviceRecordingMessage(
        recordingId = value.uuid,
        startedAtMillis = value.startedAt.toEpochMilli(),
        durationMillis = signedLong(value.durationMs),
        fileSizeBytes = signedLong(value.fileSizeBytes),
        codec = audioCodec(value.codec),
        isEncrypted = value.isEncrypted,
    )

    fun recording(value: BotaDeviceRecordingMessage): DeviceRecording = DeviceRecording(
        uuid = value.recordingId,
        startedAt = Instant.ofEpochMilli(value.startedAtMillis),
        durationMs = unsignedLong(value.durationMillis),
        fileSizeBytes = unsignedLong(value.fileSizeBytes),
        codec = audioCodec(value.codec),
        isEncrypted = value.isEncrypted,
    )

    fun recordingState(value: RecordingState): BotaRecordingStateMessage = BotaRecordingStateMessage(
        active = value.active,
        recordingId = value.recordingId,
        initiatedBy = BotaRecordingInitiatorMessage(
            name = if (value.initiatedBy == RecordingInitiator.Local) "local" else "remote",
        ),
    )

    fun recordingProgress(value: RecordingTransferProgress): BotaRecordingTransferProgressMessage =
        BotaRecordingTransferProgressMessage(
            completedBytes = signedLong(value.completedBytes),
            totalBytes = signedLong(value.totalBytes),
        )

    fun transferMetadata(value: RecordingTransferMetadata): BotaRecordingTransferMetadataMessage =
        BotaRecordingTransferMetadataMessage(
            isE2EEncrypted = value.isE2EEncrypted,
            contentSha256Hex = value.contentSha256Hex,
        )

    fun uploadOwnership(value: UploadOwnershipResult): BotaUploadOwnershipResultMessage = when (value) {
        UploadOwnershipResult.DeviceUploadCompleted -> BotaUploadOwnershipResultMessage(
            kind = BotaUploadOwnershipResultKindMessage.DEVICE_UPLOAD_COMPLETED,
        )
        is UploadOwnershipResult.DeviceUploadPreserved -> BotaUploadOwnershipResultMessage(
            kind = BotaUploadOwnershipResultKindMessage.DEVICE_UPLOAD_PRESERVED,
            uploadId = value.uploadId,
        )
        is UploadOwnershipResult.BluetoothFallback -> BotaUploadOwnershipResultMessage(
            kind = BotaUploadOwnershipResultKindMessage.BLUETOOTH_FALLBACK,
            recordingId = value.recordingUuid,
            uploadId = value.uploadId,
            destinationId = value.destinationId,
        )
    }

    fun firmwareProgress(value: FirmwareUpdateProgress): BotaFirmwareProgressMessage =
        BotaFirmwareProgressMessage(
            phase = firmwarePhase(value.phase),
            completedBytes = signedLong(value.completedBytes),
            totalBytes = signedLong(value.totalBytes),
        )

    fun logLine(value: DeviceLogLine): BotaDeviceLogLineMessage =
        BotaDeviceLogLineMessage(value.message, value.isBacklog)

    fun wifiConfigResult(value: WiFiConfigResult): BotaWifiConfigResultMessage = when (value) {
        WiFiConfigResult.Success -> BotaWifiConfigResultMessage("success")
        WiFiConfigResult.InvalidGrant -> BotaWifiConfigResultMessage("invalidGrant")
        WiFiConfigResult.GrantExpired -> BotaWifiConfigResultMessage("grantExpired")
        WiFiConfigResult.DecryptionError -> BotaWifiConfigResultMessage("decryptionError")
        WiFiConfigResult.StorageError -> BotaWifiConfigResultMessage("storageError")
        is WiFiConfigResult.Unknown -> BotaWifiConfigResultMessage("unknown", value.rawValue.toLong())
    }

    fun wifiStatus(value: WiFiStatusInfo): BotaWifiStatusMessage = BotaWifiStatusMessage(
        state = wifiState(value.status),
        signalStrength = value.signalStrength?.toLong(),
        ssid = value.ssid,
        lastError = value.lastError,
    )

    fun wifiScan(value: DeviceWiFiScanResult): BotaWifiScanResultMessage = BotaWifiScanResultMessage(
        networks = value.networks.map {
            BotaWifiNetworkMessage(it.ssid, it.quality.toLong(), it.isCurrent, it.isOpen)
        },
        currentSsid = value.currentSsid,
    )

    fun deprovisionResult(value: DeprovisionResult): BotaDeprovisionResultMessage =
        BotaDeprovisionResultMessage(
            success = value.success,
            error = value.error?.let {
                BotaProvisioningFailureMessage(
                    when (it) {
                        dev.bota.sdk.model.ProvisioningFailure.InvalidToken -> "invalidToken"
                        dev.bota.sdk.model.ProvisioningFailure.StorageError -> "storageError"
                        dev.bota.sdk.model.ProvisioningFailure.ChunkError -> "chunkError"
                        dev.bota.sdk.model.ProvisioningFailure.AlreadyPaired -> "alreadyPaired"
                        dev.bota.sdk.model.ProvisioningFailure.Unknown -> "unknown"
                    },
                    if (it == dev.bota.sdk.model.ProvisioningFailure.Unknown) 0 else null,
                )
            },
        )

    fun factoryResetCompletion(value: FactoryResetCompletion): BotaFactoryResetCompletionMessage =
        BotaFactoryResetCompletionMessage(value.commandId, signedLong(value.bindingGeneration))

    fun deviceType(value: DeviceType): BotaDeviceTypeMessage = when (value) {
        DeviceType.BotaPin -> BotaDeviceTypeMessage("botaPin")
        DeviceType.BotaPin4G -> BotaDeviceTypeMessage("botaPin4G")
        DeviceType.BotaNote -> BotaDeviceTypeMessage("botaNote")
        is DeviceType.Unknown -> BotaDeviceTypeMessage("unknown", value.rawValue.toLong())
    }

    fun deviceType(value: BotaDeviceTypeMessage): DeviceType = when (value.name) {
        "botaPin" -> DeviceType.BotaPin
        "botaPin4G" -> DeviceType.BotaPin4G
        "botaNote" -> DeviceType.BotaNote
        else -> DeviceType.Unknown(uByte(requiredRaw(value.rawValue)))
    }

    fun error(value: Throwable): BotaErrorMessage = when (value) {
        is BotaBridgeException -> BotaErrorMessage(
            code = BotaErrorCodeMessage(value.errorName),
            operation = BotaOperationMessage(value.operation),
            retryable = false,
            detail = value.detail,
        )
        is BotaSDKError.AuthorizationRequired -> BotaErrorMessage(
            code = BotaErrorCodeMessage("featureUnavailable"),
            operation = operation(value.operation),
            retryable = false,
            detail = "Required Bluetooth permissions are missing: ${value.permissions.sorted().joinToString(", ")}",
        )
        is BotaSDKError.Core -> BotaErrorMessage(
            code = errorCode(value.code),
            operation = operation(value.operation),
            retryable = value.retryable,
            protocolStatus = value.protocolStatus?.toLong(),
            detail = value.detail,
        )
        else -> BotaErrorMessage(
            code = BotaErrorCodeMessage("internal"),
            operation = BotaOperationMessage("unknown"),
            retryable = false,
            detail = "native operation failed",
        )
    }

    fun flutterError(value: Throwable): FlutterError {
        if (value is FlutterError) return value
        return if (value is BotaBridgeException) {
            FlutterError(value.code, details = error(value))
        } else {
            FlutterError("bota_sdk_error", details = error(value))
        }
    }

    fun unsignedLong(value: Long): ULong {
        if (value < 0) throw inputError("value must be non-negative")
        return value.toULong()
    }

    fun unsignedInt(value: Long): UInt {
        if (value !in 0..UInt.MAX_VALUE.toLong()) throw inputError("value is outside the UInt range")
        return value.toUInt()
    }

    fun unsignedShort(value: Long): UShort {
        if (value !in 0..UShort.MAX_VALUE.toLong()) throw inputError("value is outside the UShort range")
        return value.toUShort()
    }

    fun uByte(value: Long): UByte {
        if (value !in 0..UByte.MAX_VALUE.toLong()) throw inputError("value is outside the UByte range")
        return value.toUByte()
    }

    fun signedLong(value: ULong): Long {
        if (value > Long.MAX_VALUE.toULong()) throw payloadError("value exceeds Long.MAX_VALUE")
        return value.toLong()
    }

    private fun pairingState(value: PairingState): BotaPairingStateMessage = when (value) {
        PairingState.Unpaired -> BotaPairingStateMessage("unpaired")
        PairingState.Pairing -> BotaPairingStateMessage("pairing")
        PairingState.Paired -> BotaPairingStateMessage("paired")
        PairingState.Error -> BotaPairingStateMessage("error")
        is PairingState.Unknown -> BotaPairingStateMessage("unknown", value.rawValue.toLong())
    }

    private fun pairingState(value: BotaPairingStateMessage): PairingState = when (value.name) {
        "unpaired" -> PairingState.Unpaired
        "pairing" -> PairingState.Pairing
        "paired" -> PairingState.Paired
        "error" -> PairingState.Error
        else -> PairingState.Unknown(uByte(requiredRaw(value.rawValue)))
    }

    private fun connectionState(value: ConnectionState): BotaConnectionStateMessage = when (value) {
        ConnectionState.Disconnected -> BotaConnectionStateMessage.DISCONNECTED
        ConnectionState.Connecting -> BotaConnectionStateMessage.CONNECTING
        ConnectionState.Bonding -> BotaConnectionStateMessage.BONDING
        ConnectionState.Discovering -> BotaConnectionStateMessage.DISCOVERING
        ConnectionState.Connected -> BotaConnectionStateMessage.CONNECTED
        ConnectionState.Disconnecting -> BotaConnectionStateMessage.DISCONNECTING
    }

    private fun deviceState(value: WireValue<DeviceState>): BotaDeviceStateValueMessage = when (value) {
        is WireValue.Unknown -> BotaDeviceStateValueMessage("unknown", signedLong(value.rawValue))
        is WireValue.Known -> BotaDeviceStateValueMessage(
            when (value.value) {
                DeviceState.Idle -> "idle"
                DeviceState.Recording -> "recording"
                DeviceState.Syncing -> "syncing"
                DeviceState.Uploading -> "uploading"
                DeviceState.Charging -> "charging"
                DeviceState.LowBattery -> "lowBattery"
                DeviceState.StorageFull -> "storageFull"
                DeviceState.Error -> "error"
            },
        )
    }

    private fun lteState(value: WireValue<LteStatus>): BotaLteStateMessage = when (value) {
        is WireValue.Unknown -> BotaLteStateMessage("unknown", signedLong(value.rawValue))
        is WireValue.Known -> BotaLteStateMessage(
            when (value.value) {
                LteStatus.Off -> "off"
                LteStatus.Searching -> "searching"
                LteStatus.Registered -> "registered"
                LteStatus.Connected -> "connected"
                LteStatus.Denied -> "denied"
                LteStatus.NoSim -> "noSim"
                LteStatus.Error -> "error"
                LteStatus.LowVoltage -> "lowVoltage"
                LteStatus.Disabled -> "disabled"
            },
        )
    }

    private fun wifiRadioState(value: WireValue<WifiRadioStatus>): BotaWifiRadioStateMessage = when (value) {
        is WireValue.Unknown -> BotaWifiRadioStateMessage("unknown", signedLong(value.rawValue))
        is WireValue.Known -> BotaWifiRadioStateMessage(
            when (value.value) {
                WifiRadioStatus.Off -> "off"
                WifiRadioStatus.Scanning -> "scanning"
                WifiRadioStatus.Connecting -> "connecting"
                WifiRadioStatus.Connected -> "connected"
                WifiRadioStatus.ConnectFailed -> "connectFailed"
                WifiRadioStatus.NoCredentials -> "noCredentials"
                WifiRadioStatus.Disabled -> "disabled"
                WifiRadioStatus.Error -> "error"
            },
        )
    }

    private fun connectionType(value: DeviceConnectionSettings.ConnectionType): BotaConnectionTypeMessage =
        when (value) {
            DeviceConnectionSettings.ConnectionType.Wifi -> BotaConnectionTypeMessage("wifi")
            DeviceConnectionSettings.ConnectionType.Ble -> BotaConnectionTypeMessage("ble")
            DeviceConnectionSettings.ConnectionType.Cellular -> BotaConnectionTypeMessage("cellular")
            is DeviceConnectionSettings.ConnectionType.Unknown ->
                BotaConnectionTypeMessage("unknown", value.rawValue.toLong())
        }

    private fun connectionType(value: BotaConnectionTypeMessage): DeviceConnectionSettings.ConnectionType =
        when (value.name) {
            "wifi" -> DeviceConnectionSettings.ConnectionType.Wifi
            "ble" -> DeviceConnectionSettings.ConnectionType.Ble
            "cellular" -> DeviceConnectionSettings.ConnectionType.Cellular
            else -> DeviceConnectionSettings.ConnectionType.Unknown(uByte(requiredRaw(value.rawValue)))
        }

    private fun audioCodec(value: WireValue<AudioCodec>): BotaAudioCodecMessage = when (value) {
        is WireValue.Unknown -> BotaAudioCodecMessage("unknown", signedLong(value.rawValue))
        is WireValue.Known -> BotaAudioCodecMessage(
            when (value.value) {
                AudioCodec.Pcm16k -> "pcm16k"
                AudioCodec.Pcm8k -> "pcm8k"
                AudioCodec.Opus16k -> "opus16k"
                AudioCodec.Opus8k -> "opus8k"
            },
        )
    }

    private fun audioCodec(value: BotaAudioCodecMessage): WireValue<AudioCodec> = when (value.name) {
        "pcm16k" -> WireValue.Known(AudioCodec.Pcm16k)
        "pcm8k" -> WireValue.Known(AudioCodec.Pcm8k)
        "opus16k" -> WireValue.Known(AudioCodec.Opus16k)
        "opus8k" -> WireValue.Known(AudioCodec.Opus8k)
        else -> WireValue.Unknown(unsignedLong(requiredRaw(value.rawValue)))
    }

    private fun firmwarePhase(value: FirmwareUpdatePhase): BotaFirmwarePhaseMessage =
        BotaFirmwarePhaseMessage(
            when (value) {
                FirmwareUpdatePhase.Downloading -> "downloading"
                FirmwareUpdatePhase.AwaitingDevice -> "awaitingDevice"
                FirmwareUpdatePhase.Transferring -> "transferring"
                FirmwareUpdatePhase.Verifying -> "verifying"
                FirmwareUpdatePhase.Rebooting -> "rebooting"
                FirmwareUpdatePhase.Reconnecting -> "reconnecting"
                FirmwareUpdatePhase.Complete -> "complete"
            },
        )

    private fun wifiState(value: WiFiConnectionStatus): BotaWifiStateMessage = when (value) {
        WiFiConnectionStatus.Idle -> BotaWifiStateMessage("idle")
        WiFiConnectionStatus.Connecting -> BotaWifiStateMessage("connecting")
        WiFiConnectionStatus.Connected -> BotaWifiStateMessage("connected")
        WiFiConnectionStatus.Failed -> BotaWifiStateMessage("failed")
        WiFiConnectionStatus.Disconnected -> BotaWifiStateMessage("disconnected")
        is WiFiConnectionStatus.Unknown -> BotaWifiStateMessage("unknown", value.rawValue.toLong())
    }

    private fun deviceFlags(value: DeviceFlags): BotaDeviceFlagsMessage = BotaDeviceFlagsMessage(
        value.charging,
        value.lowBattery,
        value.storageFull,
        value.wifiConnected,
        value.lteConnected,
        value.syncActive,
    )

    private fun modemInfo(value: ModemInfo): BotaModemInfoMessage = BotaModemInfoMessage(
        imei = value.imei,
        iccid = value.iccid,
        operatorName = value.operator,
        rat = value.rat,
        band = value.band,
        apn = value.apn,
        simStatus = value.simStatus,
        csq = value.csq?.toLong(),
        ipAddress = value.ipAddress,
        modemVoltage = value.modemVoltage?.toLong(),
        modemFirmware = value.modemFirmware,
        roaming = value.roaming,
    )

    private fun enabledConnections(value: DeviceConnectionSettings.EnabledConnections) =
        BotaEnabledConnectionsMessage(value.wifi, value.cellular)

    private fun enabledConnections(value: BotaEnabledConnectionsMessage) =
        DeviceConnectionSettings.EnabledConnections(value.wifi, value.cellular)

    private fun errorCode(value: BotaErrorCode): BotaErrorCodeMessage = when (value) {
        BotaErrorCode.InvalidInput -> BotaErrorCodeMessage("invalidInput")
        BotaErrorCode.TruncatedPacket -> BotaErrorCodeMessage("truncatedPacket")
        BotaErrorCode.UnknownPacket -> BotaErrorCodeMessage("unknownPacket")
        BotaErrorCode.PayloadTooLarge -> BotaErrorCodeMessage("payloadTooLarge")
        BotaErrorCode.UnsupportedCapability -> BotaErrorCodeMessage("unsupportedCapability")
        BotaErrorCode.UnsupportedOperation -> BotaErrorCodeMessage("unsupportedOperation")
        BotaErrorCode.FeatureUnavailable -> BotaErrorCodeMessage("featureUnavailable")
        BotaErrorCode.OperationInProgress -> BotaErrorCodeMessage("operationInProgress")
        BotaErrorCode.UnexpectedEvent -> BotaErrorCodeMessage("unexpectedEvent")
        BotaErrorCode.DeviceNotFound -> BotaErrorCodeMessage("deviceNotFound")
        BotaErrorCode.IdentityMismatch -> BotaErrorCodeMessage("identityMismatch")
        BotaErrorCode.ConnectionFailed -> BotaErrorCodeMessage("connectionFailed")
        BotaErrorCode.PersistenceFailed -> BotaErrorCodeMessage("persistenceFailed")
        BotaErrorCode.NotConnected -> BotaErrorCodeMessage("notConnected")
        BotaErrorCode.Timeout -> BotaErrorCodeMessage("timeout")
        BotaErrorCode.Cancelled -> BotaErrorCodeMessage("cancelled")
        BotaErrorCode.ProtocolRejected -> BotaErrorCodeMessage("protocolRejected")
        BotaErrorCode.IntegrityFailed -> BotaErrorCodeMessage("integrityFailed")
        BotaErrorCode.UploadOwnershipUnknown -> BotaErrorCodeMessage("uploadOwnershipUnknown")
        BotaErrorCode.DownloadFailed -> BotaErrorCodeMessage("downloadFailed")
        BotaErrorCode.Internal -> BotaErrorCodeMessage("internal")
        is BotaErrorCode.Unknown -> BotaErrorCodeMessage("unknown", value.rawValue.toLong())
    }

    private fun operation(value: BotaOperation): BotaOperationMessage = when (value) {
        BotaOperation.Validate -> BotaOperationMessage("validate")
        BotaOperation.Decode -> BotaOperationMessage("decode")
        BotaOperation.Encode -> BotaOperationMessage("encode")
        BotaOperation.Discover -> BotaOperationMessage("discover")
        BotaOperation.Connect -> BotaOperationMessage("connect")
        BotaOperation.Reconnect -> BotaOperationMessage("reconnect")
        BotaOperation.ReadStatus -> BotaOperationMessage("readStatus")
        BotaOperation.Provision -> BotaOperationMessage("provision")
        BotaOperation.TransferRecording -> BotaOperationMessage("transferRecording")
        BotaOperation.Upload -> BotaOperationMessage("upload")
        BotaOperation.UpdateFirmware -> BotaOperationMessage("updateFirmware")
        BotaOperation.ReadDeviceLogs -> BotaOperationMessage("readDeviceLogs")
        BotaOperation.FactoryReset -> BotaOperationMessage("factoryReset")
        is BotaOperation.Unknown -> BotaOperationMessage("unknown", value.rawValue.toLong())
    }

    private fun timeoutSeconds(milliseconds: Long): Int {
        if (milliseconds < -1_000 || milliseconds % 1_000L != 0L) {
            throw inputError("timeout must be -1000 or a non-negative whole number of seconds")
        }
        return int(milliseconds / 1_000L)
    }

    private fun durationSeconds(milliseconds: Long): Int {
        if (milliseconds < 0 || milliseconds % 1_000L != 0L) {
            throw inputError("millisecond duration must be a non-negative whole number of seconds")
        }
        return int(milliseconds / 1_000L)
    }

    private fun secondsToMillis(seconds: Int): Long = try {
        Math.multiplyExact(seconds.toLong(), 1_000L)
    } catch (_: ArithmeticException) {
        throw payloadError("seconds value exceeds the millisecond range")
    }

    private fun int(value: Long): Int {
        if (value !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            throw payloadError("value exceeds Int range")
        }
        return value.toInt()
    }

    private fun requiredRaw(value: Long?): Long = value ?: throw inputError(
        "unknown enum value requires rawValue",
    )

    private fun inputError(detail: String) = BotaSDKError.Core(
        BotaErrorCode.InvalidInput,
        BotaOperation.Validate,
        retryable = false,
        protocolStatus = null,
        detail = detail,
    )

    private fun payloadError(detail: String) = BotaSDKError.Core(
        BotaErrorCode.PayloadTooLarge,
        BotaOperation.Encode,
        retryable = false,
        protocolStatus = null,
        detail = detail,
    )
}

internal class BotaBridgeException(
    val code: String,
    val errorName: String = "invalidInput",
    val operation: String = "validate",
    val detail: String,
) : IllegalStateException(detail)
