import Foundation

/// Passive SDK metadata. The host may explicitly attach it to an authenticated heartbeat.
public struct SDKClientContext: Equatable, Sendable {
    public let schemaVersion: Int
    public let sessionID: String
    public let sequence: Int64
    public let platform: String
    public let sdkPackage: String
    public let sdkVersion: String
}

public struct ClientPresence: Sendable {
    let devices: DeviceManager

    /// Returns nil without a current verified connection. Does not read GATT or send HTTP.
    public func nextReport(deviceID: String) async throws -> SDKClientContext? {
        await devices.nextClientReport(deviceID: deviceID)
    }
}

/// Confined to DeviceManager's actor; callbacks must name the session they belong to.
struct ConnectionClientPresence {
    private(set) var sessionID: String?
    private(set) var transportID: String?
    private var deviceID: String?
    private var sequence: Int64 = 0
    private var destroyed = false

    mutating func connected(deviceID: String, sessionID: String = UUID().uuidString.lowercased(), transportID: String) {
        guard !destroyed else { return }
        self.deviceID = deviceID
        self.sessionID = sessionID
        self.transportID = transportID
        sequence = 0
    }

    mutating func disconnected(sessionID: String?) {
        guard self.sessionID == sessionID else { return }
        self.sessionID = nil
        transportID = nil
        deviceID = nil
    }

    mutating func destroy() {
        destroyed = true
        disconnected(sessionID: sessionID)
    }

    mutating func nextReport(deviceID: String) -> SDKClientContext? {
        guard !destroyed, self.deviceID == deviceID, let sessionID,
              sequence < 9_007_199_254_740_991 else { return nil }
        sequence += 1
        #if os(iOS)
        let platform = "ios"
        #else
        let platform = "macos"
        #endif
        return SDKClientContext(schemaVersion: 1, sessionID: sessionID, sequence: sequence,
                                platform: platform, sdkPackage: SdkIdentity.package, sdkVersion: SdkIdentity.version)
    }
}
