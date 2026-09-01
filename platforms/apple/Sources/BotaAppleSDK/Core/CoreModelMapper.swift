import BotaDeviceSDKC
import Foundation

final class CoreModelMapper: @unchecked Sendable {
    private let client: CoreAbiClient

    init(client: CoreAbiClient? = nil) throws {
        self.client = try client ?? CoreAbiClient()
    }

    func parseDeviceStatus(_ data: Data) throws -> DeviceStatus {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_DEVICE_STATUS), data)
        let timestamp = try fields.requiredUInt32(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMESTAMP))
        let flagBits = try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_FLAGS))
        let modem = ModemInfo(
            imei: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_IMEI)),
            iccid: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_ICCID)),
            operator: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_OPERATOR)),
            rat: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_RAT)),
            band: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_BAND)),
            apn: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_APN)),
            simStatus: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_SIM_STATUS)),
            csq: try fields.optionalInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_CSQ)),
            ipAddress: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_IP_ADDRESS)),
            modemVoltage: try fields.optionalInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_VOLTAGE_MV)),
            modemFirmware: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_FIRMWARE)),
            roaming: fields.bool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_MODEM_ROAMING))
        )
        let hasModem = modem.imei != nil || modem.iccid != nil || modem.operator != nil
            || modem.rat != nil || modem.band != nil || modem.apn != nil || modem.simStatus != nil
            || modem.csq != nil || modem.ipAddress != nil || modem.modemVoltage != nil
            || modem.modemFirmware != nil || modem.roaming != nil
        return DeviceStatus(
            batteryLevel: try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_BATTERY_PERCENT)),
            batteryMv: try fields.optionalInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_BATTERY_MV)),
            storageTotalMb: try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORAGE_TOTAL_MB)),
            storageUsedMb: try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORAGE_USED_MB)),
            state: Self.deviceState(try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_STATE))),
            pendingRecordings: try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PENDING_RECORDINGS)),
            lastTimeSyncAt: timestamp == 0 ? nil : Date(timeIntervalSince1970: TimeInterval(timestamp)),
            flags: DeviceFlags(
                charging: flagBits & 0x01 != 0,
                lowBattery: flagBits & 0x02 != 0,
                storageFull: flagBits & 0x04 != 0,
                wifiConnected: flagBits & 0x08 != 0,
                lteConnected: flagBits & 0x10 != 0,
                syncActive: flagBits & 0x20 != 0
            ),
            timestamp: timestamp,
            lteStatus: Self.lteStatus(try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_LTE_STATUS_RAW))),
            lteSignalQuality: try fields.optionalInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_LTE_SIGNAL_QUALITY)),
            wifiStatus: try fields.optionalUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_WIFI_STATUS_RAW)).map(Self.wifiStatus),
            modemInfo: hasModem ? modem : nil
        )
    }

    func parseRecordingList(_ data: Data) throws -> [DeviceRecording] {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_RECORDING_LIST), data)
        let count = try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_COUNT))
        let uuids = fields.texts(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID))
        let started = fields.unsigneds(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STARTED_AT))
        let durations = fields.unsigneds(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURATION_MS))
        let sizes = fields.unsigneds(UInt32(BOTA_DEVICE_SDK_V1_FIELD_FILE_SIZE_BYTES))
        let codecs = fields.unsigneds(UInt32(BOTA_DEVICE_SDK_V1_FIELD_AUDIO_CODEC))
        let encrypted = fields.bools(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENCRYPTED))
        guard [uuids.count, started.count, durations.count, sizes.count, codecs.count, encrypted.count]
            .allSatisfy({ $0 == count })
        else {
            throw Self.invalid("recording-list fields have inconsistent counts")
        }
        return try (0..<count).map { index in
            DeviceRecording(
                uuid: uuids[index],
                startedAt: Date(timeIntervalSince1970: TimeInterval(try Self.uint32(started[index], "recording timestamp"))),
                durationMs: durations[index],
                fileSizeBytes: sizes[index],
                codec: Self.audioCodec(try Self.uint8(codecs[index], "audio codec")),
                isEncrypted: encrypted[index]
            )
        }
    }

    func parseTransferPacket(_ data: Data) throws -> TransferPacket {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_TRANSFER_PACKET), data)
        let variant = try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PROTOCOL_VARIANT))
        let sequence = try fields.optionalUInt16(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE)) ?? 0
        switch variant {
        case 1:
            return TransferPacket(type: .data, sequenceNumber: sequence, data: try fields.requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE)))
        case 2:
            return TransferPacket(type: .eof, sequenceNumber: sequence, checksum: try fields.requiredUInt32(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKSUM)))
        case 3:
            return TransferPacket(type: .paused, sequenceNumber: sequence, bytesSent: try fields.optionalUInt32(UInt32(BOTA_DEVICE_SDK_V1_FIELD_BYTES_SENT)))
        case 4:
            return TransferPacket(type: .sha256, sha256: try fields.requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE)))
        case 5:
            return TransferPacket(
                type: .e2eStart,
                e2eEphemeralPublicKey: try fields.requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_EPHEMERAL_PUBLIC_KEY)),
                e2eSalt: try fields.requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SALT))
            )
        case 6:
            return TransferPacket(type: .encryptedData, sequenceNumber: sequence, e2eChunk: try fields.requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE)))
        case 7:
            return TransferPacket(type: .encryptedEof, sequenceNumber: sequence)
        case 8:
            return TransferPacket(type: .error, sequenceNumber: sequence, errorCode: try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE)))
        default:
            throw Self.invalid("unknown transfer packet variant \(variant)")
        }
    }

    func parseTriggerDeviceUploadResponse(_ data: Data) throws -> TriggerDeviceUploadResponse? {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_TRIGGER_UPLOAD_RESPONSE), data)
        guard try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PROTOCOL_VARIANT)) != 0 else {
            return nil
        }
        return TriggerDeviceUploadResponse(
            accepted: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ACCEPTED)),
            errorCode: try fields.optionalUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE))
        )
    }

    func parseFirmwareStatus(_ data: Data) throws -> FirmwareStatus {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_FIRMWARE_STATUS), data)
        return FirmwareStatus(
            command: try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND)),
            result: try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT)),
            sequenceNumber: try fields.optionalUInt16(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE))
        )
    }

    func parseWiFiConfigResult(_ data: Data) throws -> WiFiConfigResult {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_WIFI_CONFIG_RESULT), data)
        switch try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_WIFI_RESULT)) {
        case 0: return .success
        case 1: return .invalidGrant
        case 2: return .grantExpired
        case 3: return .decryptionError
        case 4: return .storageError
        case let value: return .unknown(value)
        }
    }

    func parseWiFiStatusInfo(_ data: Data) throws -> WiFiStatusInfo {
        let fields = try decode(BotaPrivateProtocol.decodeWiFiStatus, data)
        return WiFiStatusInfo(
            status: Self.wifiConnectionStatus(
                try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STATUS_CODE))
            ),
            signalStrength: try fields.optionalUInt8(
                BotaPrivateProtocol.wifiSignalStrength
            ),
            ssid: fields.text(BotaPrivateProtocol.wifiSSID),
            lastError: fields.text(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL))
        )
    }

    func parseWiFiScanResult(_ data: Data) throws -> WiFiScanUpdate {
        let fields = try decode(BotaPrivateProtocol.decodeWiFiScan, data)
        let status = try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STATUS_CODE))
        guard status == 2 else { return .pending(status) }
        let ssids = fields.texts(BotaPrivateProtocol.wifiSSID)
        let qualities = fields.unsigneds(BotaPrivateProtocol.wifiQuality)
        let current = fields.bools(BotaPrivateProtocol.wifiIsCurrent)
        let open = fields.bools(BotaPrivateProtocol.wifiIsOpen)
        guard [qualities.count, current.count, open.count].allSatisfy({ $0 == ssids.count }) else {
            throw Self.invalid("WiFi scan fields have inconsistent counts")
        }
        let networks = try ssids.indices.map { index in
            WiFiScanNetwork(
                ssid: ssids[index],
                quality: try Self.uint8(qualities[index], "WiFi quality"),
                isCurrent: current[index],
                isOpen: open[index]
            )
        }
        return .done(DeviceWiFiScanResult(
            networks: networks,
            currentSSID: networks.first(where: \.isCurrent)?.ssid
        ))
    }

    func parseFactoryResetResult(_ data: Data) throws -> FactoryResetResult {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_FACTORY_RESET_RESULT), data)
        return FactoryResetResult(
            resultCode: try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE)),
            deletedRecordingCount: try fields.requiredUInt16(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT))
        )
    }

    func parseConnectionSettings(_ data: Data) throws -> ParsedConnectionSettings {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_CONNECTION_SETTINGS), data)
        let priorities = try fields.unsigneds(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CONNECTION_TYPE)).map {
            Self.connectionType(try Self.uint8($0, "connection type"))
        }
        return ParsedConnectionSettings(
            settings: DeviceConnectionSettings(
                enabledConnections: .init(
                    wifi: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENABLED_WIFI)),
                    cellular: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENABLED_CELLULAR))
                ),
                heartbeatEnabledConnections: .init(
                    wifi: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_WIFI)),
                    cellular: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_CELLULAR))
                ),
                heartbeatUnknownMask: try fields.requiredUInt8(UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_UNKNOWN_MASK)),
                uploadNetworkPreference: priorities,
                powerManagement: .init(
                    wifiIdleTimeoutSeconds: try fields.requiredIntFromSigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_WIFI_IDLE_TIMEOUT)),
                    cellularIdleTimeoutSeconds: try fields.requiredIntFromSigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CELLULAR_IDLE_TIMEOUT))
                ),
                streamingEnabled: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STREAMING_ENABLED)),
                streamingFlushIntervalSeconds: try fields.requiredInt(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STREAMING_FLUSH_INTERVAL))
            ),
            supportedVersion: try fields.requiredBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_SUPPORTED_VERSION))
        )
    }

    func decodeDeviceLogs(_ data: Data) throws -> [DeviceLogLine] {
        let fields = try decode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_DEVICE_LOGS), data)
        let messages = fields.texts(UInt32(BOTA_DEVICE_SDK_V1_FIELD_LOG_MESSAGE))
        let backlog = fields.bools(UInt32(BOTA_DEVICE_SDK_V1_FIELD_IS_BACKLOG))
        guard messages.count == backlog.count else {
            throw Self.invalid("device-log fields have inconsistent counts")
        }
        return zip(messages, backlog).map(DeviceLogLine.init)
    }

    func createAckPacket(type: AckType, sequenceNumber: UInt16) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_ACK),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ACK_TYPE), value: Self.ackCode(type)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: UInt64(sequenceNumber)),
            ]
        )
    }

    func createTransferCommand(_ command: TransferCommand) throws -> Data {
        var fields: [CoreField]
        switch command {
        case .list:
            fields = [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: 1)]
        case let .start(uuid):
            fields = [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: 2),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: uuid),
            ]
        case .triggerDeviceUpload:
            fields = [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: 3)]
        case let .confirm(uuid):
            fields = [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: 4),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: uuid),
            ]
        }
        return try encode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_TRANSFER_COMMAND), fields: fields)
    }

    func encodeDeviceCommand(_ command: UInt8) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_DEVICE_COMMAND),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: UInt64(command))]
        )
    }

    func firmwareUploadStart(size: UInt32) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_UPLOAD_START),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_SIZE_BYTES), value: UInt64(size))]
        )
    }

    func firmwareDataPacket(sequenceNumber: UInt16, payload: Data) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_DATA),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: UInt64(sequenceNumber)),
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: payload),
            ]
        )
    }

    func firmwareWindowAck(sequenceNumber: UInt16) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_WINDOW_ACK),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: UInt64(sequenceNumber))]
        )
    }

    func firmwareUploadVerify(crc32: UInt32) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_UPLOAD_VERIFY),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_CRC32), value: UInt64(crc32))]
        )
    }

    func encodeFirmwareStatus(_ status: FirmwareStatus) throws -> Data {
        var fields: [CoreField] = [
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND), value: UInt64(status.command)),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT), value: UInt64(status.result)),
        ]
        if let sequence = status.sequenceNumber {
            fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: UInt64(sequence)))
        }
        return try encode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_STATUS), fields: fields)
    }

    func serializeConnectionSettings(_ settings: DeviceConnectionSettings, model: DeviceType) throws -> Data {
        let normalized = settings.normalized(for: model)
        return try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_CONNECTION_SETTINGS),
            fields: [
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENABLED_WIFI), value: normalized.enabledConnections.wifi),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENABLED_CELLULAR), value: normalized.enabledConnections.cellular),
                .bytes(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CONNECTION_TYPE),
                    value: Data(normalized.uploadNetworkPreference.map(Self.connectionCode))
                ),
                .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CELLULAR_IDLE_TIMEOUT), value: Int64(normalized.powerManagement.cellularIdleTimeoutSeconds)),
                .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_WIFI_IDLE_TIMEOUT), value: Int64(normalized.powerManagement.wifiIdleTimeoutSeconds)),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STREAMING_ENABLED), value: normalized.streamingEnabled),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STREAMING_FLUSH_INTERVAL), value: UInt64(normalized.streamingFlushIntervalSeconds)),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_WIFI), value: normalized.heartbeatEnabledConnections.wifi),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_CELLULAR), value: normalized.heartbeatEnabledConnections.cellular),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_HEARTBEAT_UNKNOWN_MASK), value: UInt64(normalized.heartbeatUnknownMask)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_MODEL), value: UInt64(Self.deviceTypeCode(model))),
            ]
        )
    }

    func encodeBoundedPayload(_ data: Data, capacity: Int = Int.max) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_BOUNDED_PAYLOAD),
            fields: [
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: data),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CAPACITY), value: UInt64(capacity)),
            ]
        )
    }

    func createWiFiGrantPacket(_ grant: String, capacity: Int = Int.max) throws -> Data {
        try encode(
            UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_WIFI_GRANT),
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT), value: grant),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CAPACITY), value: UInt64(capacity)),
            ]
        )
    }

    func createWiFiScanCommand() throws -> Data {
        try encode(UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_WIFI_SCAN), fields: [])
    }

    func createProvisioningChunks(_ data: Data, mtu: Int) throws -> [Data] {
        do {
            let packet = try client.protocolEncode(Self.protocolPacket(
                kind: BotaPrivateProtocol.encodeProvisioningChunks,
                fields: [
                    .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: data),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MTU), value: UInt64(mtu)),
                ]
            ))
            return PacketFields(packet.fields).bytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHUNK))
        } catch let error as CoreError {
            throw BotaSDKError(error)
        }
    }

    func createTimeSyncData(
        epochMilliseconds: UInt64,
        timezoneOffsetMinutes: Int16
    ) throws -> Data {
        try encode(
            BotaPrivateProtocol.encodeTimeSync,
            fields: [
                .unsigned(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMESTAMP),
                    value: epochMilliseconds
                ),
                .signed(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET),
                    value: Int64(timezoneOffsetMinutes)
                ),
            ]
        )
    }

    func createWiFiCredentialPacket(ssid: String, password: String) throws -> Data {
        try encode(
            BotaPrivateProtocol.encodeWiFiCredentials,
            fields: [
                .text(id: BotaPrivateProtocol.wifiSSID, value: ssid),
                .text(id: BotaPrivateProtocol.wifiPassword, value: password),
            ]
        )
    }

    private func decode(_ kind: UInt32, _ data: Data) throws -> PacketFields {
        do {
            let packet = try client.protocolDecode(Self.protocolPacket(kind: kind, fields: [
                .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: data),
            ]))
            return PacketFields(packet.fields)
        } catch let error as CoreError {
            throw BotaSDKError(error)
        }
    }

    private func encode(_ kind: UInt32, fields: [CoreField]) throws -> Data {
        do {
            let packet = try client.protocolEncode(Self.protocolPacket(kind: kind, fields: fields))
            return try PacketFields(packet.fields).requiredBytes(UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE))
        } catch let error as CoreError {
            throw BotaSDKError(error)
        }
    }

    private static func protocolPacket(kind: UInt32, fields: [CoreField]) -> CorePacket {
        CorePacket(
            kind: kind,
            operation: 0,
            requestID: 0,
            cancellationHigh: 0,
            cancellationLow: 0,
            fields: fields
        )
    }

    private static func deviceState(_ raw: UInt8) -> WireValue<DeviceState> {
        switch raw {
        case 0: return .known(.idle)
        case 1: return .known(.recording)
        case 2: return .known(.syncing)
        case 3: return .known(.uploading)
        case 4: return .known(.charging)
        case 5: return .known(.lowBattery)
        case 6: return .known(.storageFull)
        case 7: return .known(.error)
        default: return .unknown(UInt64(raw))
        }
    }

    private static func lteStatus(_ raw: UInt8) -> WireValue<LteStatus> {
        switch raw {
        case 0: return .known(.off)
        case 1: return .known(.searching)
        case 2: return .known(.registered)
        case 3: return .known(.connected)
        case 4: return .known(.denied)
        case 5: return .known(.noSim)
        case 6: return .known(.error)
        case 7: return .known(.lowVoltage)
        case 8: return .known(.disabled)
        default: return .unknown(UInt64(raw))
        }
    }

    private static func wifiStatus(_ raw: UInt8) -> WireValue<WifiRadioStatus> {
        switch raw {
        case 0: return .known(.off)
        case 1: return .known(.scanning)
        case 2: return .known(.connecting)
        case 3: return .known(.connected)
        case 4: return .known(.connectFailed)
        case 5: return .known(.noCredentials)
        case 6: return .known(.disabled)
        case 7: return .known(.error)
        default: return .unknown(UInt64(raw))
        }
    }

    private static func wifiConnectionStatus(_ raw: UInt8) -> WiFiConnectionStatus {
        switch raw {
        case 0: .idle
        case 1: .connecting
        case 2: .connected
        case 3: .failed
        case 4: .disconnected
        default: .unknown(raw)
        }
    }

    private static func audioCodec(_ raw: UInt8) -> WireValue<AudioCodec> {
        switch raw {
        case 0x00: return .known(.pcm16k)
        case 0x01: return .known(.pcm8k)
        case 0x10: return .known(.opus16k)
        case 0x11: return .known(.opus8k)
        default: return .unknown(UInt64(raw))
        }
    }

    private static func connectionType(_ raw: UInt8) -> ConnectionType {
        switch raw {
        case 1: return .wifi
        case 2: return .ble
        case 3: return .cellular
        default: return .unknown(raw)
        }
    }

    private static func connectionCode(_ value: ConnectionType) -> UInt8 {
        switch value {
        case .wifi: return 1
        case .ble: return 2
        case .cellular: return 3
        case let .unknown(raw): return raw
        }
    }

    private static func deviceTypeCode(_ value: DeviceType) -> UInt8 {
        switch value {
        case .botaPin: return 1
        case .botaPin4G: return 2
        case .botaNote: return 3
        case let .unknown(raw): return raw
        }
    }

    private static func ackCode(_ value: AckType) -> UInt64 {
        switch value {
        case .ack: return 1
        case .nack: return 2
        case .abort: return 3
        }
    }

    private static func uint8(_ value: UInt64, _ label: String) throws -> UInt8 {
        guard let result = UInt8(exactly: value) else { throw invalid("\(label) exceeds UInt8") }
        return result
    }

    private static func uint32(_ value: UInt64, _ label: String) throws -> UInt32 {
        guard let result = UInt32(exactly: value) else { throw invalid("\(label) exceeds UInt32") }
        return result
    }

    fileprivate static func invalid(_ detail: String) -> BotaSDKError {
        BotaSDKError(code: .invalidInput, operation: .decode, retryable: false, detail: detail)
    }
}

private enum BotaPrivateProtocol {
    static let decodeWiFiStatus: UInt32 = 0x050B
    static let decodeWiFiScan: UInt32 = 0x050C
    static let encodeWiFiCredentials: UInt32 = 0x051D
    static let encodeProvisioningChunks: UInt32 = 0x051C
    static let encodeTimeSync: UInt32 = 0x051E
    static let wifiSSID: UInt32 = 114
    static let wifiSignalStrength: UInt32 = 115
    static let wifiQuality: UInt32 = 116
    static let wifiIsCurrent: UInt32 = 117
    static let wifiIsOpen: UInt32 = 118
    static let wifiPassword: UInt32 = 119
}

enum BotaProtocolConstants {
    static func byte(named name: String) throws -> UInt8 {
        switch name {
        case "PROVISIONING_SUCCESS": return 0x00
        case "PROVISIONING_ALREADY_PAIRED": return 0x04
        case "DEVICE_CMD_BLE_DEPROVISION": return 0x05
        case "DEVICE_CMD_BLE_FACTORY_RESET": return 0x06
        case "DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK": return 0x0A
        default: throw CoreModelMapper.invalid("unknown protocol constant \(name)")
        }
    }
}

private struct PacketFields {
    let values: [CoreField]

    init(_ values: [CoreField]) {
        self.values = values
    }

    func unsigneds(_ id: UInt32) -> [UInt64] {
        values.compactMap { field in
            guard case let .unsigned(fieldID, value) = field, fieldID == id else { return nil }
            return value
        }
    }

    func bools(_ id: UInt32) -> [Bool] {
        values.compactMap { field in
            guard case let .bool(fieldID, value) = field, fieldID == id else { return nil }
            return value
        }
    }

    func texts(_ id: UInt32) -> [String] {
        values.compactMap { field in
            guard case let .text(fieldID, value) = field, fieldID == id else { return nil }
            return value
        }
    }

    func bytes(_ id: UInt32) -> [Data] {
        values.compactMap { field in
            guard case let .bytes(fieldID, value) = field, fieldID == id else { return nil }
            return value
        }
    }

    func text(_ id: UInt32) -> String? { texts(id).first }
    func bool(_ id: UInt32) -> Bool? { bools(id).first }

    func requiredBool(_ id: UInt32) throws -> Bool {
        guard let value = bool(id) else { throw CoreModelMapper.invalid("missing Boolean field \(id)") }
        return value
    }

    func requiredBytes(_ id: UInt32) throws -> Data {
        for field in values {
            if case let .bytes(fieldID, value) = field, fieldID == id { return value }
        }
        throw CoreModelMapper.invalid("missing bytes field \(id)")
    }

    func requiredUInt8(_ id: UInt32) throws -> UInt8 {
        guard let value = unsigneds(id).first, let result = UInt8(exactly: value) else {
            throw CoreModelMapper.invalid("missing or invalid UInt8 field \(id)")
        }
        return result
    }

    func optionalUInt8(_ id: UInt32) throws -> UInt8? {
        guard let value = unsigneds(id).first else { return nil }
        guard let result = UInt8(exactly: value) else { throw CoreModelMapper.invalid("invalid UInt8 field \(id)") }
        return result
    }

    func requiredUInt16(_ id: UInt32) throws -> UInt16 {
        guard let value = unsigneds(id).first, let result = UInt16(exactly: value) else {
            throw CoreModelMapper.invalid("missing or invalid UInt16 field \(id)")
        }
        return result
    }

    func optionalUInt16(_ id: UInt32) throws -> UInt16? {
        guard let value = unsigneds(id).first else { return nil }
        guard let result = UInt16(exactly: value) else { throw CoreModelMapper.invalid("invalid UInt16 field \(id)") }
        return result
    }

    func requiredUInt32(_ id: UInt32) throws -> UInt32 {
        guard let value = unsigneds(id).first, let result = UInt32(exactly: value) else {
            throw CoreModelMapper.invalid("missing or invalid UInt32 field \(id)")
        }
        return result
    }

    func optionalUInt32(_ id: UInt32) throws -> UInt32? {
        guard let value = unsigneds(id).first else { return nil }
        guard let result = UInt32(exactly: value) else { throw CoreModelMapper.invalid("invalid UInt32 field \(id)") }
        return result
    }

    func requiredInt(_ id: UInt32) throws -> Int {
        guard let value = unsigneds(id).first, let result = Int(exactly: value) else {
            throw CoreModelMapper.invalid("missing or invalid integer field \(id)")
        }
        return result
    }

    func optionalInt(_ id: UInt32) throws -> Int? {
        guard let value = unsigneds(id).first else { return nil }
        guard let result = Int(exactly: value) else { throw CoreModelMapper.invalid("invalid integer field \(id)") }
        return result
    }

    func requiredIntFromSigned(_ id: UInt32) throws -> Int {
        for field in values {
            if case let .signed(fieldID, value) = field, fieldID == id {
                guard let result = Int(exactly: value) else { throw CoreModelMapper.invalid("invalid signed field \(id)") }
                return result
            }
        }
        throw CoreModelMapper.invalid("missing signed field \(id)")
    }
}

extension BotaSDKError {
    init(_ error: CoreError) {
        self.init(
            code: Self.code(error.code),
            operation: Self.operation(error.operation),
            retryable: error.retryable,
            protocolStatus: error.protocolStatus,
            detail: error.detail
        )
    }

    static func code(_ raw: UInt32) -> BotaSDKErrorCode {
        switch raw {
        case 1: return .invalidInput
        case 2: return .truncatedPacket
        case 3: return .unknownPacket
        case 4: return .payloadTooLarge
        case 5: return .unsupportedCapability
        case 6: return .unsupportedOperation
        case 7: return .featureUnavailable
        case 8: return .operationInProgress
        case 9: return .unexpectedEvent
        case 10: return .deviceNotFound
        case 11: return .identityMismatch
        case 12: return .connectionFailed
        case 13: return .persistenceFailed
        case 14: return .notConnected
        case 15: return .timeout
        case 16: return .cancelled
        case 17: return .protocolRejected
        case 18: return .integrityFailed
        case 19: return .uploadOwnershipUnknown
        case 20: return .downloadFailed
        case 21: return .internal
        default: return .unknown(raw)
        }
    }

    static func operation(_ raw: UInt32) -> BotaOperation {
        switch raw {
        case 1: return .validate
        case 2: return .decode
        case 3: return .encode
        case 4: return .discover
        case 5: return .connect
        case 6: return .reconnect
        case 7: return .provision
        case 8: return .transferRecording
        case 9: return .upload
        case 10: return .updateFirmware
        case 11: return .readDeviceLogs
        case 12: return .factoryReset
        default: return .unknown(raw)
        }
    }
}
