package dev.bota.sdk.internal.core

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.internal.jni.NativeCoreException
import dev.bota.sdk.internal.jni.NativePacket
import dev.bota.sdk.model.AckType
import dev.bota.sdk.model.AudioCodec
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.FactoryResetResult
import dev.bota.sdk.model.FirmwareStatus
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.ModemInfo
import dev.bota.sdk.model.ParsedConnectionSettings
import dev.bota.sdk.model.RecordingControlError
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingInitiator
import dev.bota.sdk.model.RecordingState
import dev.bota.sdk.model.TransferCommand
import dev.bota.sdk.model.TransferPacket
import dev.bota.sdk.model.TransferPacketType
import dev.bota.sdk.model.TriggerDeviceUploadResponse
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiConnectionStatus
import dev.bota.sdk.model.WiFiScanNetwork
import dev.bota.sdk.model.WiFiScanUpdate
import dev.bota.sdk.model.WiFiStatusInfo
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.WifiRadioStatus
import dev.bota.sdk.model.WireValue
import java.time.Instant

internal class CoreModelMapper(
    private val core: NativeCore = NativeCoreBridge(),
) : AutoCloseable {
    fun parseDeviceStatus(data: ByteArray): DeviceStatus {
        val fields = decode(Protocol.Kind.DecodeDeviceStatus, data)
        val timestamp = fields.requiredUInt(Protocol.Field.Timestamp)
        val flagBits = fields.requiredUByte(Protocol.Field.Flags).toInt()
        val modem = ModemInfo(
            imei = fields.text(Protocol.Field.ModemImei),
            iccid = fields.text(Protocol.Field.ModemIccid),
            operator = fields.text(Protocol.Field.ModemOperator),
            rat = fields.text(Protocol.Field.ModemRat),
            band = fields.text(Protocol.Field.ModemBand),
            apn = fields.text(Protocol.Field.ModemApn),
            simStatus = fields.text(Protocol.Field.ModemSimStatus),
            csq = fields.optionalInt(Protocol.Field.ModemCsq),
            ipAddress = fields.text(Protocol.Field.ModemIpAddress),
            modemVoltage = fields.optionalInt(Protocol.Field.ModemVoltageMv),
            modemFirmware = fields.text(Protocol.Field.ModemFirmware),
            roaming = fields.boolean(Protocol.Field.ModemRoaming),
        )
        val hasModem = listOf(
            modem.imei,
            modem.iccid,
            modem.operator,
            modem.rat,
            modem.band,
            modem.apn,
            modem.simStatus,
            modem.csq,
            modem.ipAddress,
            modem.modemVoltage,
            modem.modemFirmware,
            modem.roaming,
        ).any { it != null }
        return DeviceStatus(
            batteryLevel = fields.requiredInt(Protocol.Field.BatteryPercent),
            batteryMv = fields.optionalInt(Protocol.Field.BatteryMv),
            storageTotalMb = fields.requiredInt(Protocol.Field.StorageTotalMb),
            storageUsedMb = fields.requiredInt(Protocol.Field.StorageUsedMb),
            state = deviceState(fields.requiredUByte(Protocol.Field.DeviceState)),
            pendingRecordings = fields.requiredInt(Protocol.Field.PendingRecordings),
            lastTimeSyncAt = timestamp.takeIf { it != 0u }?.let { Instant.ofEpochSecond(it.toLong()) },
            flags = DeviceFlags(
                charging = flagBits and 0x01 != 0,
                lowBattery = flagBits and 0x02 != 0,
                storageFull = flagBits and 0x04 != 0,
                wifiConnected = flagBits and 0x08 != 0,
                lteConnected = flagBits and 0x10 != 0,
                syncActive = flagBits and 0x20 != 0,
            ),
            timestamp = timestamp,
            lteStatus = lteStatus(fields.requiredUByte(Protocol.Field.LteStatusRaw)),
            lteSignalQuality = fields.optionalInt(Protocol.Field.LteSignalQuality),
            wifiStatus = fields.optionalUByte(Protocol.Field.WifiStatusRaw)?.let(::wifiStatus),
            modemInfo = modem.takeIf { hasModem },
        )
    }

    fun parseRecordingList(data: ByteArray): List<DeviceRecording> {
        val fields = decode(Protocol.Kind.DecodeRecordingList, data)
        val count = fields.requiredInt(Protocol.Field.RecordingCount)
        val uuids = fields.texts(Protocol.Field.RecordingUuid)
        val started = fields.unsigneds(Protocol.Field.StartedAt)
        val durations = fields.unsigneds(Protocol.Field.DurationMs)
        val sizes = fields.unsigneds(Protocol.Field.FileSizeBytes)
        val codecs = fields.unsigneds(Protocol.Field.AudioCodec)
        val encrypted = fields.booleans(Protocol.Field.Encrypted)
        if (listOf(uuids.size, started.size, durations.size, sizes.size, codecs.size, encrypted.size)
                .any { it != count }
        ) {
            throw invalid("recording-list fields have inconsistent counts")
        }
        return List(count) { index ->
            DeviceRecording(
                uuid = uuids[index],
                startedAt = Instant.ofEpochSecond(started[index].toUIntExact("recording timestamp").toLong()),
                durationMs = durations[index],
                fileSizeBytes = sizes[index],
                codec = audioCodec(codecs[index].toUByteExact("audio codec")),
                isEncrypted = encrypted[index],
            )
        }
    }

    fun parseRecordingState(data: ByteArray): RecordingState {
        val fields = decode(Protocol.Kind.DecodeRecordingState, data)
        return RecordingState(
            active = fields.requiredBoolean(Protocol.Field.RecordingActive),
            recordingId = fields.text(Protocol.Field.RecordingUuid),
            initiatedBy = if (fields.requiredBoolean(Protocol.Field.RecordingInitiatedRemotely)) {
                RecordingInitiator.Remote
            } else {
                RecordingInitiator.Local
            },
        )
    }

    fun parseRecordingControlResult(data: ByteArray): RecordingControlResult {
        val fields = decode(Protocol.Kind.DecodeRecordingControlResult, data)
        val success = fields.requiredBoolean(Protocol.Field.RecordingSuccess)
        return RecordingControlResult(
            success = success,
            error = if (success) null else recordingControlError(fields.text(Protocol.Field.ErrorDetail)),
        )
    }

    fun parseTransferPacket(data: ByteArray): TransferPacket {
        val fields = decode(Protocol.Kind.DecodeTransferPacket, data)
        val variant = fields.requiredUByte(Protocol.Field.ProtocolVariant).toInt()
        val sequence = fields.optionalUShort(Protocol.Field.Sequence) ?: 0u
        return when (variant) {
            1 -> TransferPacket(
                type = TransferPacketType.Data,
                sequenceNumber = sequence,
                data = fields.requiredBytes(Protocol.Field.Value),
            )
            2 -> TransferPacket(
                type = TransferPacketType.Eof,
                sequenceNumber = sequence,
                checksum = fields.requiredUInt(Protocol.Field.Checksum),
            )
            3 -> TransferPacket(
                type = TransferPacketType.Paused,
                sequenceNumber = sequence,
                bytesSent = fields.optionalUInt(Protocol.Field.BytesSent),
            )
            4 -> TransferPacket(type = TransferPacketType.Sha256, sha256 = fields.requiredBytes(Protocol.Field.Value))
            5 -> TransferPacket(
                type = TransferPacketType.E2eStart,
                e2eEphemeralPublicKey = fields.requiredBytes(Protocol.Field.EphemeralPublicKey),
                e2eSalt = fields.requiredBytes(Protocol.Field.Salt),
            )
            6 -> TransferPacket(
                type = TransferPacketType.EncryptedData,
                sequenceNumber = sequence,
                e2eChunk = fields.requiredBytes(Protocol.Field.Value),
            )
            7 -> TransferPacket(type = TransferPacketType.EncryptedEof, sequenceNumber = sequence)
            8 -> TransferPacket(
                type = TransferPacketType.Error,
                sequenceNumber = sequence,
                errorCode = fields.requiredUByte(Protocol.Field.ErrorCode),
            )
            else -> throw invalid("unknown transfer packet variant $variant")
        }
    }

    fun parseTriggerDeviceUploadResponse(data: ByteArray): TriggerDeviceUploadResponse? {
        val fields = decode(Protocol.Kind.DecodeTriggerUploadResponse, data)
        if (fields.requiredUByte(Protocol.Field.ProtocolVariant) == 0.toUByte()) return null
        return TriggerDeviceUploadResponse(
            accepted = fields.requiredBoolean(Protocol.Field.Accepted),
            errorCode = fields.optionalUByte(Protocol.Field.ErrorCode),
        )
    }

    fun parseFirmwareStatus(data: ByteArray): FirmwareStatus {
        val fields = decode(Protocol.Kind.DecodeFirmwareStatus, data)
        return FirmwareStatus(
            command = fields.requiredUByte(Protocol.Field.Command),
            result = fields.requiredUByte(Protocol.Field.Result),
            sequenceNumber = fields.optionalUShort(Protocol.Field.Sequence),
        )
    }

    fun parseWiFiConfigResult(data: ByteArray): WiFiConfigResult {
        val fields = decode(Protocol.Kind.DecodeWifiConfigResult, data)
        return when (val result = fields.requiredUByte(Protocol.Field.WifiResult)) {
            0.toUByte() -> WiFiConfigResult.Success
            1.toUByte() -> WiFiConfigResult.InvalidGrant
            2.toUByte() -> WiFiConfigResult.GrantExpired
            3.toUByte() -> WiFiConfigResult.DecryptionError
            4.toUByte() -> WiFiConfigResult.StorageError
            else -> WiFiConfigResult.Unknown(result)
        }
    }

    fun parseWiFiStatusInfo(data: ByteArray): WiFiStatusInfo {
        val fields = decode(Protocol.Kind.DecodeWifiStatus, data)
        return WiFiStatusInfo(
            status = wifiConnectionStatus(fields.requiredUByte(Protocol.Field.StatusCode)),
            signalStrength = fields.optionalUByte(Protocol.Field.WifiSignalStrength),
            ssid = fields.text(Protocol.Field.WifiSsid),
            lastError = fields.text(Protocol.Field.ErrorDetail),
        )
    }

    fun parseWiFiScanResult(data: ByteArray): WiFiScanUpdate {
        val fields = decode(Protocol.Kind.DecodeWifiScan, data)
        val status = fields.requiredUByte(Protocol.Field.StatusCode)
        if (status != 2.toUByte()) return WiFiScanUpdate.Pending(status)
        val ssids = fields.texts(Protocol.Field.WifiSsid)
        val qualities = fields.unsigneds(Protocol.Field.WifiQuality)
        val current = fields.booleans(Protocol.Field.WifiIsCurrent)
        val open = fields.booleans(Protocol.Field.WifiIsOpen)
        if (listOf(qualities.size, current.size, open.size).any { it != ssids.size }) {
            throw invalid("WiFi scan fields have inconsistent counts")
        }
        val networks = ssids.indices.map { index ->
            WiFiScanNetwork(
                ssid = ssids[index],
                quality = qualities[index].toUByteExact("WiFi quality"),
                isCurrent = current[index],
                isOpen = open[index],
            )
        }
        return WiFiScanUpdate.Done(
            DeviceWiFiScanResult(networks, networks.firstOrNull { it.isCurrent }?.ssid),
        )
    }

    fun parseFactoryResetResult(data: ByteArray): FactoryResetResult {
        val fields = decode(Protocol.Kind.DecodeFactoryResetResult, data)
        return FactoryResetResult(
            resultCode = fields.requiredUByte(Protocol.Field.ResultCode),
            deletedRecordingCount = fields.requiredUShort(Protocol.Field.DeletedRecordingCount),
        )
    }

    fun parseConnectionSettings(data: ByteArray): ParsedConnectionSettings {
        val fields = decode(Protocol.Kind.DecodeConnectionSettings, data)
        return ParsedConnectionSettings(
            settings = DeviceConnectionSettings(
                enabledConnections = DeviceConnectionSettings.EnabledConnections(
                    wifi = fields.requiredBoolean(Protocol.Field.EnabledWifi),
                    cellular = fields.requiredBoolean(Protocol.Field.EnabledCellular),
                ),
                heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(
                    wifi = fields.requiredBoolean(Protocol.Field.HeartbeatWifi),
                    cellular = fields.requiredBoolean(Protocol.Field.HeartbeatCellular),
                ),
                heartbeatUnknownMask = fields.requiredUByte(Protocol.Field.HeartbeatUnknownMask),
                uploadNetworkPreference = fields.unsigneds(Protocol.Field.ConnectionType).map {
                    connectionType(it.toUByteExact("connection type"))
                },
                powerManagement = DeviceConnectionSettings.PowerManagement(
                    wifiIdleTimeoutSeconds = fields.requiredSignedInt(Protocol.Field.WifiIdleTimeout),
                    cellularIdleTimeoutSeconds = fields.requiredSignedInt(Protocol.Field.CellularIdleTimeout),
                ),
                streamingEnabled = fields.requiredBoolean(Protocol.Field.StreamingEnabled),
                streamingFlushIntervalSeconds = fields.requiredInt(Protocol.Field.StreamingFlushInterval),
            ),
            supportedVersion = fields.requiredBoolean(Protocol.Field.SupportedVersion),
        )
    }

    fun decodeDeviceLogs(data: ByteArray): List<DeviceLogLine> {
        val fields = decode(Protocol.Kind.DecodeDeviceLogs, data)
        val messages = fields.texts(Protocol.Field.LogMessage)
        val backlog = fields.booleans(Protocol.Field.IsBacklog)
        if (messages.size != backlog.size) throw invalid("device-log fields have inconsistent counts")
        return messages.indices.map { DeviceLogLine(messages[it], backlog[it]) }
    }

    fun createAckPacket(type: AckType, sequenceNumber: UShort): ByteArray = encode(
        Protocol.Kind.EncodeAck,
        listOf(
            Field.unsigned(Protocol.Field.AckType, ackCode(type)),
            Field.unsigned(Protocol.Field.Sequence, sequenceNumber.toULong()),
        ),
    )

    fun createTransferCommand(command: TransferCommand): ByteArray {
        val fields = when (command) {
            TransferCommand.List -> listOf(Field.unsigned(Protocol.Field.Command, 1u))
            is TransferCommand.Start -> listOf(
                Field.unsigned(Protocol.Field.Command, 2u),
                Field.text(Protocol.Field.RecordingUuid, command.recordingUuid),
            )
            TransferCommand.TriggerDeviceUpload -> listOf(Field.unsigned(Protocol.Field.Command, 3u))
            is TransferCommand.Confirm -> listOf(
                Field.unsigned(Protocol.Field.Command, 4u),
                Field.text(Protocol.Field.RecordingUuid, command.recordingUuid),
            )
        }
        return encode(Protocol.Kind.EncodeTransferCommand, fields)
    }

    fun createRecordingControlCommand(command: dev.bota.sdk.RecordingControlCommand): ByteArray = encode(
        Protocol.Kind.EncodeRecordingControlCommand,
        listOf(
            Field.unsigned(
                Protocol.Field.Command,
                if (command == dev.bota.sdk.RecordingControlCommand.Start) 1u else 2u,
            ),
        ),
    )

    fun encodeDeviceCommand(command: UByte): ByteArray = encode(
        Protocol.Kind.EncodeDeviceCommand,
        listOf(Field.unsigned(Protocol.Field.Command, command.toULong())),
    )

    fun firmwareUploadStart(size: UInt): ByteArray = encode(
        Protocol.Kind.EncodeFirmwareUploadStart,
        listOf(Field.unsigned(Protocol.Field.FirmwareSizeBytes, size.toULong())),
    )

    fun firmwareDataPacket(sequenceNumber: UShort, payload: ByteArray): ByteArray = encode(
        Protocol.Kind.EncodeFirmwareData,
        listOf(
            Field.unsigned(Protocol.Field.Sequence, sequenceNumber.toULong()),
            Field.bytes(Protocol.Field.Payload, payload),
        ),
    )

    fun firmwareWindowAck(sequenceNumber: UShort): ByteArray = encode(
        Protocol.Kind.EncodeFirmwareWindowAck,
        listOf(Field.unsigned(Protocol.Field.Sequence, sequenceNumber.toULong())),
    )

    fun firmwareUploadVerify(crc32: UInt): ByteArray = encode(
        Protocol.Kind.EncodeFirmwareUploadVerify,
        listOf(Field.unsigned(Protocol.Field.FirmwareCrc32, crc32.toULong())),
    )

    fun encodeFirmwareStatus(status: FirmwareStatus): ByteArray {
        val fields = mutableListOf(
            Field.unsigned(Protocol.Field.Command, status.command.toULong()),
            Field.unsigned(Protocol.Field.Result, status.result.toULong()),
        )
        status.sequenceNumber?.let { fields += Field.unsigned(Protocol.Field.Sequence, it.toULong()) }
        return encode(Protocol.Kind.EncodeFirmwareStatus, fields)
    }

    fun serializeConnectionSettings(settings: DeviceConnectionSettings, model: DeviceType): ByteArray {
        val normalized = settings.normalized(model)
        return encode(
            Protocol.Kind.EncodeConnectionSettings,
            listOf(
                Field.boolean(Protocol.Field.EnabledWifi, normalized.enabledConnections.wifi),
                Field.boolean(Protocol.Field.EnabledCellular, normalized.enabledConnections.cellular),
                Field.bytes(
                    Protocol.Field.ConnectionType,
                    normalized.uploadNetworkPreference.map(::connectionCode).toByteArray(),
                ),
                Field.signed(
                    Protocol.Field.CellularIdleTimeout,
                    normalized.powerManagement.cellularIdleTimeoutSeconds.toLong(),
                ),
                Field.signed(
                    Protocol.Field.WifiIdleTimeout,
                    normalized.powerManagement.wifiIdleTimeoutSeconds.toLong(),
                ),
                Field.boolean(Protocol.Field.StreamingEnabled, normalized.streamingEnabled),
                Field.unsigned(
                    Protocol.Field.StreamingFlushInterval,
                    normalized.streamingFlushIntervalSeconds.toULongChecked("streaming flush interval"),
                ),
                Field.boolean(Protocol.Field.HeartbeatWifi, normalized.heartbeatEnabledConnections.wifi),
                Field.boolean(Protocol.Field.HeartbeatCellular, normalized.heartbeatEnabledConnections.cellular),
                Field.unsigned(Protocol.Field.HeartbeatUnknownMask, normalized.heartbeatUnknownMask.toULong()),
                Field.unsigned(Protocol.Field.DeviceModel, deviceTypeCode(model).toULong()),
            ),
        )
    }

    fun encodeBoundedPayload(data: ByteArray, capacity: Int = Int.MAX_VALUE): ByteArray = encode(
        Protocol.Kind.EncodeBoundedPayload,
        listOf(
            Field.bytes(Protocol.Field.Payload, data),
            Field.unsigned(Protocol.Field.Capacity, capacity.toULongChecked("capacity")),
        ),
    )

    fun createWiFiGrantPacket(grant: String, capacity: Int = Int.MAX_VALUE): ByteArray = encode(
        Protocol.Kind.EncodeWifiGrant,
        listOf(
            Field.text(Protocol.Field.Grant, grant),
            Field.unsigned(Protocol.Field.Capacity, capacity.toULongChecked("capacity")),
        ),
    )

    fun createWiFiScanCommand(): ByteArray = encode(Protocol.Kind.EncodeWifiScan, emptyList())

    fun createProvisioningChunks(data: ByteArray, mtu: Int): List<ByteArray> =
        nativeCall {
            core.encode(packet(
                Protocol.Kind.EncodeProvisioningChunks,
                listOf(
                    Field.bytes(Protocol.Field.Payload, data),
                    Field.unsigned(Protocol.Field.Mtu, mtu.toULongChecked("MTU")),
                ),
            )).byteArrays(Protocol.Field.Chunk)
        }

    fun createTimeSyncData(epochMilliseconds: ULong, timezoneOffsetMinutes: Short): ByteArray = encode(
        Protocol.Kind.EncodeTimeSync,
        listOf(
            Field.unsigned(Protocol.Field.Timestamp, epochMilliseconds),
            Field.signed(Protocol.Field.Offset, timezoneOffsetMinutes.toLong()),
        ),
    )

    fun createWiFiCredentialPacket(ssid: String, password: String): ByteArray = encode(
        Protocol.Kind.EncodeWifiCredentials,
        listOf(
            Field.text(Protocol.Field.WifiSsid, ssid),
            Field.text(Protocol.Field.WifiPassword, password),
        ),
    )

    override fun close() {
        core.close()
    }

    private fun decode(kind: Int, data: ByteArray): PacketFields = nativeCall {
        PacketFields(core.decode(packet(kind, listOf(Field.bytes(Protocol.Field.Value, data)))))
    }

    private fun encode(kind: Int, fields: List<Field>): ByteArray = nativeCall {
        PacketFields(core.encode(packet(kind, fields))).requiredBytes(Protocol.Field.Value)
    }

    private inline fun <T> nativeCall(block: () -> T): T = try {
        block()
    } catch (error: NativeCoreException) {
        throw error.toSdkError()
    }

    private fun packet(kind: Int, fields: List<Field>): NativePacket = NativePacket(
        kind = kind,
        fieldIds = fields.map(Field::id).toIntArray(),
        fieldTypes = fields.map(Field::type).toIntArray(),
        unsignedValues = fields.map(Field::unsignedValue).toLongArray(),
        signedValues = fields.map(Field::signedValue).toLongArray(),
        dataValues = fields.map(Field::dataValue).toTypedArray(),
    )
}

internal object BotaProtocolConstants {
    fun byteNamed(name: String): Byte = when (name) {
        "PROVISIONING_SUCCESS" -> 0x00
        "PROVISIONING_ALREADY_PAIRED" -> 0x04
        "DEVICE_CMD_BLE_DEPROVISION" -> 0x05
        "DEVICE_CMD_BLE_FACTORY_RESET" -> 0x06
        "DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK" -> 0x0a
        else -> throw invalid("unknown protocol constant $name")
    }
}

private data class Field(
    val id: Int,
    val type: Int,
    val unsignedValue: Long = 0,
    val signedValue: Long = 0,
    val dataValue: Any? = null,
) {
    companion object {
        fun unsigned(id: Int, value: ULong) = Field(
            id,
            NativePacket.FIELD_TYPE_UNSIGNED,
            unsignedValue = value.toLong(),
        )

        fun signed(id: Int, value: Long) = Field(id, NativePacket.FIELD_TYPE_SIGNED, signedValue = value)

        fun boolean(id: Int, value: Boolean) = Field(
            id,
            NativePacket.FIELD_TYPE_BOOL,
            unsignedValue = if (value) 1 else 0,
        )

        fun text(id: Int, value: String) = Field(
            id,
            NativePacket.FIELD_TYPE_UTF8,
            dataValue = value.encodeToByteArray(),
        )

        fun bytes(id: Int, value: ByteArray) = Field(
            id,
            NativePacket.FIELD_TYPE_BYTES,
            dataValue = value.copyOf(),
        )
    }
}

private class PacketFields(private val packet: NativePacket) {
    fun unsigneds(id: Int): List<ULong> = packet.unsigneds(id)
    fun booleans(id: Int): List<Boolean> = packet.booleans(id)
    fun texts(id: Int): List<String> = packet.texts(id)
    fun text(id: Int): String? = texts(id).firstOrNull()
    fun boolean(id: Int): Boolean? = booleans(id).firstOrNull()

    fun requiredBoolean(id: Int): Boolean = boolean(id) ?: throw invalid("missing Boolean field $id")
    fun requiredBytes(id: Int): ByteArray = packet.bytes(id) ?: throw invalid("missing bytes field $id")
    fun requiredUByte(id: Int): UByte = unsigneds(id).firstOrNull()?.toUByteExact("field $id")
        ?: throw invalid("missing UByte field $id")
    fun optionalUByte(id: Int): UByte? = unsigneds(id).firstOrNull()?.toUByteExact("field $id")
    fun requiredUShort(id: Int): UShort = unsigneds(id).firstOrNull()?.toUShortExact("field $id")
        ?: throw invalid("missing UShort field $id")
    fun optionalUShort(id: Int): UShort? = unsigneds(id).firstOrNull()?.toUShortExact("field $id")
    fun requiredUInt(id: Int): UInt = unsigneds(id).firstOrNull()?.toUIntExact("field $id")
        ?: throw invalid("missing UInt field $id")
    fun optionalUInt(id: Int): UInt? = unsigneds(id).firstOrNull()?.toUIntExact("field $id")
    fun requiredInt(id: Int): Int = unsigneds(id).firstOrNull()?.toIntExact("field $id")
        ?: throw invalid("missing integer field $id")
    fun optionalInt(id: Int): Int? = unsigneds(id).firstOrNull()?.toIntExact("field $id")
    fun requiredSignedInt(id: Int): Int = packet.signed(id)?.let {
        if (it !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) throw invalid("field $id exceeds Int")
        it.toInt()
    } ?: throw invalid("missing signed field $id")
}

private fun deviceState(raw: UByte): WireValue<DeviceState> = when (raw.toInt()) {
    0 -> WireValue.Known(DeviceState.Idle)
    1 -> WireValue.Known(DeviceState.Recording)
    2 -> WireValue.Known(DeviceState.Syncing)
    3 -> WireValue.Known(DeviceState.Uploading)
    4 -> WireValue.Known(DeviceState.Charging)
    5 -> WireValue.Known(DeviceState.LowBattery)
    6 -> WireValue.Known(DeviceState.StorageFull)
    7 -> WireValue.Known(DeviceState.Error)
    else -> WireValue.Unknown(raw.toULong())
}

private fun lteStatus(raw: UByte): WireValue<LteStatus> = when (raw.toInt()) {
    0 -> WireValue.Known(LteStatus.Off)
    1 -> WireValue.Known(LteStatus.Searching)
    2 -> WireValue.Known(LteStatus.Registered)
    3 -> WireValue.Known(LteStatus.Connected)
    4 -> WireValue.Known(LteStatus.Denied)
    5 -> WireValue.Known(LteStatus.NoSim)
    6 -> WireValue.Known(LteStatus.Error)
    7 -> WireValue.Known(LteStatus.LowVoltage)
    8 -> WireValue.Known(LteStatus.Disabled)
    else -> WireValue.Unknown(raw.toULong())
}

private fun wifiStatus(raw: UByte): WireValue<WifiRadioStatus> = when (raw.toInt()) {
    0 -> WireValue.Known(WifiRadioStatus.Off)
    1 -> WireValue.Known(WifiRadioStatus.Scanning)
    2 -> WireValue.Known(WifiRadioStatus.Connecting)
    3 -> WireValue.Known(WifiRadioStatus.Connected)
    4 -> WireValue.Known(WifiRadioStatus.ConnectFailed)
    5 -> WireValue.Known(WifiRadioStatus.NoCredentials)
    6 -> WireValue.Known(WifiRadioStatus.Disabled)
    7 -> WireValue.Known(WifiRadioStatus.Error)
    else -> WireValue.Unknown(raw.toULong())
}

private fun wifiConnectionStatus(raw: UByte): WiFiConnectionStatus = when (raw.toInt()) {
    0 -> WiFiConnectionStatus.Idle
    1 -> WiFiConnectionStatus.Connecting
    2 -> WiFiConnectionStatus.Connected
    3 -> WiFiConnectionStatus.Failed
    4 -> WiFiConnectionStatus.Disconnected
    else -> WiFiConnectionStatus.Unknown(raw)
}

private fun recordingControlError(value: String?): RecordingControlError =
    RecordingControlError.entries.firstOrNull { it.wireValue == value } ?: RecordingControlError.UnknownError

private fun audioCodec(raw: UByte): WireValue<AudioCodec> = when (raw.toInt()) {
    0x00 -> WireValue.Known(AudioCodec.Pcm16k)
    0x01 -> WireValue.Known(AudioCodec.Pcm8k)
    0x10 -> WireValue.Known(AudioCodec.Opus16k)
    0x11 -> WireValue.Known(AudioCodec.Opus8k)
    else -> WireValue.Unknown(raw.toULong())
}

private fun connectionType(raw: UByte): DeviceConnectionSettings.ConnectionType = when (raw.toInt()) {
    1 -> DeviceConnectionSettings.ConnectionType.Wifi
    2 -> DeviceConnectionSettings.ConnectionType.Ble
    3 -> DeviceConnectionSettings.ConnectionType.Cellular
    else -> DeviceConnectionSettings.ConnectionType.Unknown(raw)
}

private fun connectionCode(value: DeviceConnectionSettings.ConnectionType): Byte = when (value) {
    DeviceConnectionSettings.ConnectionType.Wifi -> 1
    DeviceConnectionSettings.ConnectionType.Ble -> 2
    DeviceConnectionSettings.ConnectionType.Cellular -> 3
    is DeviceConnectionSettings.ConnectionType.Unknown -> value.rawValue.toByte()
}

private fun deviceTypeCode(value: DeviceType): UByte = when (value) {
    DeviceType.BotaPin -> 1u
    DeviceType.BotaPin4G -> 2u
    DeviceType.BotaNote -> 3u
    is DeviceType.Unknown -> value.rawValue
}

private fun ackCode(value: AckType): ULong = when (value) {
    AckType.Ack -> 1u
    AckType.Nack -> 2u
    AckType.Abort -> 3u
}

private fun NativeCoreException.toSdkError(): BotaSDKError.Core = BotaSDKError.Core(
    code = errorCode(code),
    operation = operation(operation),
    retryable = retryable,
    protocolStatus = protocolStatus.takeIf { it >= 0 }?.toUShort(),
    detail = detail,
)

private fun errorCode(raw: Int): BotaErrorCode = when (raw) {
    1 -> BotaErrorCode.InvalidInput
    2 -> BotaErrorCode.TruncatedPacket
    3 -> BotaErrorCode.UnknownPacket
    4 -> BotaErrorCode.PayloadTooLarge
    5 -> BotaErrorCode.UnsupportedCapability
    6 -> BotaErrorCode.UnsupportedOperation
    7 -> BotaErrorCode.FeatureUnavailable
    8 -> BotaErrorCode.OperationInProgress
    9 -> BotaErrorCode.UnexpectedEvent
    10 -> BotaErrorCode.DeviceNotFound
    11 -> BotaErrorCode.IdentityMismatch
    12 -> BotaErrorCode.ConnectionFailed
    13 -> BotaErrorCode.PersistenceFailed
    14 -> BotaErrorCode.NotConnected
    15 -> BotaErrorCode.Timeout
    16 -> BotaErrorCode.Cancelled
    17 -> BotaErrorCode.ProtocolRejected
    18 -> BotaErrorCode.IntegrityFailed
    19 -> BotaErrorCode.UploadOwnershipUnknown
    20 -> BotaErrorCode.DownloadFailed
    21 -> BotaErrorCode.Internal
    else -> BotaErrorCode.Unknown(raw.toUInt())
}

private fun operation(raw: Int): BotaOperation = when (raw) {
    1 -> BotaOperation.Validate
    2 -> BotaOperation.Decode
    3 -> BotaOperation.Encode
    4 -> BotaOperation.Discover
    5 -> BotaOperation.Connect
    6 -> BotaOperation.Reconnect
    7 -> BotaOperation.Provision
    8 -> BotaOperation.TransferRecording
    9 -> BotaOperation.Upload
    10 -> BotaOperation.UpdateFirmware
    11 -> BotaOperation.ReadDeviceLogs
    12 -> BotaOperation.FactoryReset
    else -> BotaOperation.Unknown(raw.toUInt())
}

private fun invalid(detail: String): BotaSDKError.Core = BotaSDKError.Core(
    code = BotaErrorCode.InvalidInput,
    operation = BotaOperation.Decode,
    retryable = false,
    protocolStatus = null,
    detail = detail,
)

private fun ULong.toUByteExact(label: String): UByte {
    if (this > UByte.MAX_VALUE.toULong()) throw invalid("$label exceeds UByte")
    return toUByte()
}

private fun ULong.toUShortExact(label: String): UShort {
    if (this > UShort.MAX_VALUE.toULong()) throw invalid("$label exceeds UShort")
    return toUShort()
}

private fun ULong.toUIntExact(label: String): UInt {
    if (this > UInt.MAX_VALUE.toULong()) throw invalid("$label exceeds UInt")
    return toUInt()
}

private fun ULong.toIntExact(label: String): Int {
    if (this > Int.MAX_VALUE.toULong()) throw invalid("$label exceeds Int")
    return toInt()
}

private fun Int.toULongChecked(label: String): ULong {
    if (this < 0) throw invalid("$label cannot be negative")
    return toULong()
}

private object Protocol {
    object Kind {
        const val DecodeDeviceStatus = 0x0501
        const val DecodeRecordingList = 0x0502
        const val DecodeTransferPacket = 0x0503
        const val DecodeTriggerUploadResponse = 0x0504
        const val DecodeFirmwareStatus = 0x0506
        const val DecodeWifiConfigResult = 0x0507
        const val DecodeFactoryResetResult = 0x0508
        const val DecodeConnectionSettings = 0x0509
        const val DecodeDeviceLogs = 0x050a
        const val DecodeWifiStatus = 0x050b
        const val DecodeWifiScan = 0x050c
        const val DecodeRecordingState = 0x050d
        const val DecodeRecordingControlResult = 0x050e
        const val EncodeAck = 0x0510
        const val EncodeTransferCommand = 0x0511
        const val EncodeDeviceCommand = 0x0512
        const val EncodeFirmwareUploadStart = 0x0513
        const val EncodeFirmwareData = 0x0514
        const val EncodeFirmwareWindowAck = 0x0515
        const val EncodeFirmwareUploadVerify = 0x0516
        const val EncodeFirmwareStatus = 0x0517
        const val EncodeConnectionSettings = 0x0518
        const val EncodeBoundedPayload = 0x0519
        const val EncodeWifiGrant = 0x051a
        const val EncodeWifiScan = 0x051b
        const val EncodeWifiCredentials = 0x051d
        const val EncodeProvisioningChunks = 0x051c
        const val EncodeTimeSync = 0x051e
        const val EncodeRecordingControlCommand = 0x051f
    }

    object Field {
        const val RecordingUuid = 13
        const val FirmwareSizeBytes = 19
        const val FirmwareCrc32 = 20
        const val ResultCode = 24
        const val DeletedRecordingCount = 25
        const val Value = 30
        const val Payload = 33
        const val Sequence = 38
        const val Grant = 58
        const val BatteryPercent = 62
        const val BatteryMv = 63
        const val StorageTotalMb = 64
        const val StorageUsedMb = 65
        const val DeviceState = 66
        const val PendingRecordings = 67
        const val Timestamp = 68
        const val Flags = 69
        const val LteStatusRaw = 70
        const val LteSignalQuality = 71
        const val WifiStatusRaw = 72
        const val ModemImei = 73
        const val ModemIccid = 74
        const val ModemOperator = 75
        const val ModemRat = 76
        const val ModemBand = 77
        const val ModemApn = 78
        const val ModemSimStatus = 79
        const val ModemCsq = 80
        const val ModemIpAddress = 81
        const val ModemVoltageMv = 82
        const val ModemFirmware = 83
        const val ModemRoaming = 84
        const val RecordingCount = 85
        const val StartedAt = 86
        const val DurationMs = 87
        const val FileSizeBytes = 88
        const val AudioCodec = 89
        const val Encrypted = 90
        const val Checksum = 91
        const val BytesSent = 92
        const val EphemeralPublicKey = 93
        const val Salt = 94
        const val Accepted = 95
        const val AckType = 96
        const val Command = 97
        const val Result = 98
        const val WifiResult = 99
        const val SupportedVersion = 100
        const val EnabledWifi = 101
        const val EnabledCellular = 102
        const val ConnectionType = 103
        const val CellularIdleTimeout = 104
        const val WifiIdleTimeout = 105
        const val StreamingEnabled = 106
        const val StreamingFlushInterval = 107
        const val HeartbeatWifi = 108
        const val HeartbeatCellular = 109
        const val HeartbeatUnknownMask = 110
        const val DeviceModel = 111
        const val Capacity = 112
        const val ProtocolVariant = 61
        const val ErrorCode = 47
        const val LogMessage = 46
        const val IsBacklog = 51
        const val ErrorDetail = 50
        const val StatusCode = 60
        const val WifiSsid = 114
        const val WifiSignalStrength = 115
        const val WifiQuality = 116
        const val WifiIsCurrent = 117
        const val WifiIsOpen = 118
        const val WifiPassword = 119
        const val RecordingActive = 120
        const val RecordingInitiatedRemotely = 121
        const val RecordingSuccess = 122
        const val Mtu = 57
        const val Chunk = 113
        const val Offset = 39
    }
}
