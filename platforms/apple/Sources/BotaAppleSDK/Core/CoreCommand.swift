import BotaDeviceSDKC
import Foundation

struct CoreCapabilities: OptionSet, Equatable, Sendable {
    let rawValue: UInt64

    static let bluetooth = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_BLE))
    static let timer = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_TIMER))
    static let persistence = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_PERSISTENCE))
    static let secureStorage = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_SECURE_STORAGE))
    static let networkTransfer = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_NETWORK_TRANSFER))
    static let progress = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_PROGRESS))
    static let hostMaterial = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_HOST_MATERIAL))
    static let recordingSink = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_RECORDING_SINK))
    static let firmwareBlob = Self(rawValue: UInt64(BOTA_DEVICE_SDK_V1_CAPABILITY_FIRMWARE_BLOB))

    init(rawValue: UInt64) {
        self.rawValue = rawValue
    }

    init(names: [String]) throws {
        var value: Self = []
        for name in names {
            switch name {
            case "ble": value.insert(.bluetooth)
            case "timer": value.insert(.timer)
            case "persistence": value.insert(.persistence)
            case "secure_storage": value.insert(.secureStorage)
            case "network_transfer": value.insert(.networkTransfer)
            case "progress": value.insert(.progress)
            case "host_material": value.insert(.hostMaterial)
            case "recording_sink": value.insert(.recordingSink)
            case "firmware_blob": value.insert(.firmwareBlob)
            default:
                throw CoreError(
                    code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INVALID_INPUT),
                    operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_DECODE),
                    retryable: false,
                    protocolStatus: nil,
                    detail: "unknown capability \(name)"
                )
            }
        }
        self = value
    }
}

struct CoreCancellationID: Equatable, Hashable, Sendable {
    let high: UInt64
    let low: UInt64

    init(_ id: UUID) {
        let bytes = withUnsafeBytes(of: id.uuid) { Array($0) }
        high = bytes[0..<8].reduce(0) { ($0 << 8) | UInt64($1) }
        low = bytes[8..<16].reduce(0) { ($0 << 8) | UInt64($1) }
    }
}

struct CoreCommand: Equatable, Sendable {
    let kind: UInt32
    let cancellationID: UUID
    let fields: [CoreField]

    var packet: CorePacket {
        let cancellation = CoreCancellationID(cancellationID)
        return CorePacket(
            kind: kind,
            operation: 0,
            requestID: 0,
            cancellationHigh: cancellation.high,
            cancellationLow: cancellation.low,
            fields: fields
        )
    }

    static func discoverDevices(
        timeoutMilliseconds: UInt64,
        allowDuplicates: Bool,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_DISCOVER_DEVICES),
            cancellationID: cancellationID,
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMEOUT_MS), value: timeoutMilliseconds),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES), value: allowDuplicates),
            ]
        )
    }

    static func connect(
        serialNumber: String,
        peripheralID: String,
        name: String?,
        advertisedAddress: String?,
        rssi: Int16,
        cancellationID: UUID = UUID()
    ) -> Self {
        var fields: [CoreField] = [
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID),
            .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: Int64(rssi)),
        ]
        if let name { fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME), value: name)) }
        if let advertisedAddress {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS), value: advertisedAddress))
        }
        return Self(kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_CONNECT), cancellationID: cancellationID, fields: fields)
    }

    static func connectSelected(
        peripheralID: String,
        name: String?,
        advertisedAddress: String?,
        rssi: Int16,
        cancellationID: UUID = UUID()
    ) -> Self {
        var fields: [CoreField] = [
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID), value: peripheralID),
            .signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI), value: Int64(rssi)),
        ]
        if let name { fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME), value: name)) }
        if let advertisedAddress {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS), value: advertisedAddress))
        }
        return Self(kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_CONNECT), cancellationID: cancellationID, fields: fields)
    }

    static func reconnect(
        serialNumber: String,
        storedPeripheralID: String? = nil,
        advertisedAddress: String? = nil,
        storedName: String? = nil,
        scanTimeoutMilliseconds: UInt64 = 10_000,
        connectionTimeoutMilliseconds: UInt64 = 10_000,
        cancellationID: UUID = UUID()
    ) -> Self {
        var fields: [CoreField] = [
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SCAN_TIMEOUT_MS), value: scanTimeoutMilliseconds),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CONNECTION_TIMEOUT_MS), value: connectionTimeoutMilliseconds),
        ]
        if let storedPeripheralID {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORED_PERIPHERAL_ID), value: storedPeripheralID))
        }
        if let advertisedAddress {
            fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS), value: advertisedAddress))
        }
        if let storedName { fields.append(.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORED_NAME), value: storedName)) }
        return Self(kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RECONNECT), cancellationID: cancellationID, fields: fields)
    }

    static func provision(serialNumber: String, materialID: String, cancellationID: UUID = UUID()) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_PROVISION),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID), value: materialID),
            ]
        )
    }

    static func transferRecording(
        serialNumber: String,
        recordingUUID: String,
        sinkID: String,
        totalUnits: UInt64,
        confirmOnCompletion: Bool = true,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_RECORDING),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: recordingUUID),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID), value: sinkID),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: totalUnits),
                .bool(id: 124, value: confirmOnCompletion),
            ]
        )
    }

    static func uploadRecording(
        serialNumber: String,
        recordingUUID: String,
        uploadID: String,
        destinationID: String,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_UPLOAD_RECORDING),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: recordingUUID),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: uploadID),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DESTINATION_ID), value: destinationID),
            ]
        )
    }

    static func updateFirmware(
        serialNumber: String,
        version: String,
        sizeBytes: UInt32,
        crc32: UInt32,
        downloadID: UInt64,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_UPDATE_FIRMWARE),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_VERSION), value: version),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_SIZE_BYTES), value: UInt64(sizeBytes)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_CRC32), value: UInt64(crc32)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: downloadID),
            ]
        )
    }

    static func readDeviceLogs(serialNumber: String, cancellationID: UUID = UUID()) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_READ_DEVICE_LOGS),
            cancellationID: cancellationID,
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber)]
        )
    }

    static func factoryReset(
        serialNumber: String,
        commandID: String,
        grantID: String,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_FACTORY_RESET),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: commandID),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID), value: grantID),
            ]
        )
    }

    static func resumeFactoryReset(
        serialNumber: String,
        commandID: String,
        resultCode: UInt8,
        deletedRecordingCount: UInt16,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RESUME_FACTORY_RESET),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: commandID),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE), value: UInt64(resultCode)),
                .unsigned(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT),
                    value: UInt64(deletedRecordingCount)
                ),
            ]
        )
    }

    static func resumeUnjournaledFactoryReset(
        serialNumber: String,
        commandID: String,
        cancellationID: UUID = UUID()
    ) -> Self {
        Self(
            kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RESUME_FACTORY_RESET),
            cancellationID: cancellationID,
            fields: [
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: serialNumber),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID), value: commandID),
            ]
        )
    }
}

extension CoreCommand {
    static func fixture(named name: String) -> Self? {
        let serial = "EVFXXW67KP"
        let recording = "00112233445566778899aabbccddeeff"
        switch name {
        case "discover_devices": return .discoverDevices(timeoutMilliseconds: 1, allowDuplicates: false)
        case "connect": return .connect(serialNumber: serial, peripheralID: "peripheral", name: nil, advertisedAddress: nil, rssi: -40)
        case "reconnect": return .reconnect(serialNumber: serial)
        case "provision": return .provision(serialNumber: serial, materialID: "material")
        case "transfer_recording": return .transferRecording(serialNumber: serial, recordingUUID: recording, sinkID: "sink", totalUnits: 1)
        case "upload_recording": return .uploadRecording(serialNumber: serial, recordingUUID: recording, uploadID: "upload", destinationID: "destination")
        case "update_firmware": return .updateFirmware(serialNumber: serial, version: "1.0.0", sizeBytes: 1, crc32: 1, downloadID: 1)
        case "read_device_logs": return .readDeviceLogs(serialNumber: serial)
        case "factory_reset": return .factoryReset(serialNumber: serial, commandID: "command", grantID: "grant")
        case "resume_factory_reset": return .resumeFactoryReset(serialNumber: serial, commandID: "command", resultCode: 0, deletedRecordingCount: 0)
        default: return nil
        }
    }
}
