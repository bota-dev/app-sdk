import Foundation

public enum WireValue<Known: Equatable & Sendable>: Equatable, Sendable {
    case known(Known)
    case unknown(UInt64)
}

public enum DeviceType: Equatable, Sendable {
    case botaPin
    case botaPin4G
    case botaNote
    case unknown(UInt8)
}

public enum PairingState: Equatable, Sendable {
    case unpaired
    case pairing
    case paired
    case error
    case unknown(UInt8)
}

public enum ConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case bonding
    case discovering
    case connected
    case disconnecting
}

public enum DeviceState: Equatable, Sendable {
    case idle
    case recording
    case syncing
    case uploading
    case charging
    case lowBattery
    case storageFull
    case error
}

public enum LteStatus: Equatable, Sendable {
    case off
    case searching
    case registered
    case connected
    case denied
    case noSim
    case error
    case lowVoltage
    case disabled
}

public enum WifiRadioStatus: Equatable, Sendable {
    case off
    case scanning
    case connecting
    case connected
    case connectFailed
    case noCredentials
    case disabled
    case error
}

public struct DeviceFlags: Equatable, Sendable {
    public var charging: Bool
    public var lowBattery: Bool
    public var storageFull: Bool
    public var wifiConnected: Bool
    public var lteConnected: Bool
    public var syncActive: Bool

    public init(
        charging: Bool,
        lowBattery: Bool,
        storageFull: Bool,
        wifiConnected: Bool,
        lteConnected: Bool,
        syncActive: Bool
    ) {
        self.charging = charging
        self.lowBattery = lowBattery
        self.storageFull = storageFull
        self.wifiConnected = wifiConnected
        self.lteConnected = lteConnected
        self.syncActive = syncActive
    }
}

public struct ModemInfo: Equatable, Sendable {
    public var imei: String?
    public var iccid: String?
    public var `operator`: String?
    public var rat: String?
    public var band: String?
    public var apn: String?
    public var simStatus: String?
    public var csq: Int?
    public var ipAddress: String?
    public var modemVoltage: Int?
    public var modemFirmware: String?
    public var roaming: Bool?

    public init(
        imei: String? = nil,
        iccid: String? = nil,
        operator: String? = nil,
        rat: String? = nil,
        band: String? = nil,
        apn: String? = nil,
        simStatus: String? = nil,
        csq: Int? = nil,
        ipAddress: String? = nil,
        modemVoltage: Int? = nil,
        modemFirmware: String? = nil,
        roaming: Bool? = nil
    ) {
        self.imei = imei
        self.iccid = iccid
        self.operator = `operator`
        self.rat = rat
        self.band = band
        self.apn = apn
        self.simStatus = simStatus
        self.csq = csq
        self.ipAddress = ipAddress
        self.modemVoltage = modemVoltage
        self.modemFirmware = modemFirmware
        self.roaming = roaming
    }
}

public struct DeviceStatus: Equatable, Sendable {
    public var batteryLevel: Int
    public var batteryMv: Int?
    public var storageTotalMb: Int
    public var storageUsedMb: Int
    public var state: WireValue<DeviceState>
    public var pendingRecordings: Int
    public var lastTimeSyncAt: Date?
    public var signalStrength: Int
    public var flags: DeviceFlags
    public var timestamp: UInt32
    public var lteStatus: WireValue<LteStatus>
    public var lteSignalQuality: Int?
    public var wifiStatus: WireValue<WifiRadioStatus>?
    public var modemInfo: ModemInfo?

    public init(
        batteryLevel: Int,
        batteryMv: Int? = nil,
        storageTotalMb: Int,
        storageUsedMb: Int,
        state: WireValue<DeviceState>,
        pendingRecordings: Int,
        lastTimeSyncAt: Date?,
        signalStrength: Int = 0,
        flags: DeviceFlags,
        timestamp: UInt32,
        lteStatus: WireValue<LteStatus>,
        lteSignalQuality: Int? = nil,
        wifiStatus: WireValue<WifiRadioStatus>? = nil,
        modemInfo: ModemInfo? = nil
    ) {
        self.batteryLevel = batteryLevel
        self.batteryMv = batteryMv
        self.storageTotalMb = storageTotalMb
        self.storageUsedMb = storageUsedMb
        self.state = state
        self.pendingRecordings = pendingRecordings
        self.lastTimeSyncAt = lastTimeSyncAt
        self.signalStrength = signalStrength
        self.flags = flags
        self.timestamp = timestamp
        self.lteStatus = lteStatus
        self.lteSignalQuality = lteSignalQuality
        self.wifiStatus = wifiStatus
        self.modemInfo = modemInfo
    }
}

public struct DiscoveredDevice: Equatable, Sendable {
    public var id: String
    public var name: String?
    public var deviceType: DeviceType?
    public var firmwareVersion: String?
    public var macAddress: String?
    public var pairingState: PairingState?
    public var rssi: Int
    public var manufacturerData: Data?
    public var discoveredAt: Date

    public init(
        id: String,
        name: String? = nil,
        deviceType: DeviceType? = nil,
        firmwareVersion: String? = nil,
        macAddress: String? = nil,
        pairingState: PairingState? = nil,
        rssi: Int,
        manufacturerData: Data? = nil,
        discoveredAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.deviceType = deviceType
        self.firmwareVersion = firmwareVersion
        self.macAddress = macAddress
        self.pairingState = pairingState
        self.rssi = rssi
        self.manufacturerData = manufacturerData
        self.discoveredAt = discoveredAt
    }
}

public struct ConnectedDevice: Equatable, Sendable {
    public var id: String
    public var serialNumber: String
    public var deviceType: DeviceType
    public var firmwareVersion: String
    public var hardwareRevision: String?
    public var isProvisioned: Bool
    public var connectionState: ConnectionState
    public var mtu: Int

    public init(
        id: String,
        serialNumber: String,
        deviceType: DeviceType,
        firmwareVersion: String,
        hardwareRevision: String? = nil,
        isProvisioned: Bool,
        connectionState: ConnectionState,
        mtu: Int
    ) {
        self.id = id
        self.serialNumber = serialNumber
        self.deviceType = deviceType
        self.firmwareVersion = firmwareVersion
        self.hardwareRevision = hardwareRevision
        self.isProvisioned = isProvisioned
        self.connectionState = connectionState
        self.mtu = mtu
    }
}
