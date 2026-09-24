public enum ConnectionType: Equatable, Sendable {
    case wifi
    case ble
    case cellular
    case unknown(UInt8)
}

public struct DeviceConnectionSettings: Equatable, Sendable {
    public struct EnabledConnections: Equatable, Sendable {
        public var wifi: Bool
        public var cellular: Bool

        public init(wifi: Bool, cellular: Bool) {
            self.wifi = wifi
            self.cellular = cellular
        }
    }

    public struct PowerManagement: Equatable, Sendable {
        public var wifiIdleTimeoutSeconds: Int
        public var cellularIdleTimeoutSeconds: Int

        public init(wifiIdleTimeoutSeconds: Int, cellularIdleTimeoutSeconds: Int) {
            self.wifiIdleTimeoutSeconds = wifiIdleTimeoutSeconds
            self.cellularIdleTimeoutSeconds = cellularIdleTimeoutSeconds
        }
    }

    public var enabledConnections: EnabledConnections
    public var heartbeatEnabledConnections: EnabledConnections
    public var heartbeatUnknownMask: UInt8
    public var uploadNetworkPreference: [ConnectionType]
    public var powerManagement: PowerManagement
    public var streamingEnabled: Bool
    public var streamingFlushIntervalSeconds: Int

    public init(
        enabledConnections: EnabledConnections,
        heartbeatEnabledConnections: EnabledConnections? = nil,
        heartbeatUnknownMask: UInt8 = 0,
        uploadNetworkPreference: [ConnectionType],
        powerManagement: PowerManagement = .init(
            wifiIdleTimeoutSeconds: 180,
            cellularIdleTimeoutSeconds: 180
        ),
        streamingEnabled: Bool = true,
        streamingFlushIntervalSeconds: Int = 60
    ) {
        self.enabledConnections = enabledConnections
        self.heartbeatEnabledConnections = heartbeatEnabledConnections ?? enabledConnections
        self.heartbeatUnknownMask = heartbeatUnknownMask
        self.uploadNetworkPreference = uploadNetworkPreference
        self.powerManagement = powerManagement
        self.streamingEnabled = streamingEnabled
        self.streamingFlushIntervalSeconds = streamingFlushIntervalSeconds
    }

    public func normalized(for model: DeviceType) -> Self {
        guard model == .botaNote else { return self }
        var normalized = self
        normalized.enabledConnections.cellular = false
        normalized.heartbeatEnabledConnections.cellular = false
        normalized.uploadNetworkPreference.removeAll { $0 == .cellular }
        return normalized
    }
}

public struct ParsedConnectionSettings: Equatable, Sendable {
    public let settings: DeviceConnectionSettings
    public let supportedVersion: Bool

    public init(settings: DeviceConnectionSettings, supportedVersion: Bool) {
        self.settings = settings
        self.supportedVersion = supportedVersion
    }
}

public enum WiFiConfigResult: Equatable, Sendable {
    case success
    case invalidGrant
    case grantExpired
    case decryptionError
    case storageError
    case unknown(UInt8)
}

public enum WiFiConnectionStatus: Equatable, Sendable {
    case idle
    case connecting
    case connected
    case failed
    case disconnected
    case unknown(UInt8)
}

public struct WiFiStatusInfo: Equatable, Sendable {
    public var status: WiFiConnectionStatus
    public var signalStrength: UInt8?
    public var ssid: String?
    public var lastError: String?

    public init(
        status: WiFiConnectionStatus,
        signalStrength: UInt8? = nil,
        ssid: String? = nil,
        lastError: String? = nil
    ) {
        self.status = status
        self.signalStrength = signalStrength
        self.ssid = ssid
        self.lastError = lastError
    }
}

public struct WiFiScanNetwork: Equatable, Sendable {
    public var ssid: String
    public var quality: UInt8
    public var isCurrent: Bool
    public var isOpen: Bool

    public init(ssid: String, quality: UInt8, isCurrent: Bool, isOpen: Bool) {
        self.ssid = ssid
        self.quality = quality
        self.isCurrent = isCurrent
        self.isOpen = isOpen
    }
}

public struct DeviceWiFiScanResult: Equatable, Sendable {
    public var networks: [WiFiScanNetwork]
    public var currentSSID: String?

    public init(networks: [WiFiScanNetwork], currentSSID: String?) {
        self.networks = networks
        self.currentSSID = currentSSID
    }
}

enum WiFiScanUpdate: Equatable, Sendable {
    case pending(UInt8)
    case done(DeviceWiFiScanResult)
}
