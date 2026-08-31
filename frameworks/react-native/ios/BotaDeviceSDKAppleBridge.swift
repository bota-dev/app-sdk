import BotaAppleSDK
import Foundation

private enum BotaDeviceSDKAppleBridgeInputError: LocalizedError {
    case invalidTimeout

    var errorDescription: String? {
        "timeout must be a finite non-negative number"
    }
}

@objc(BotaDeviceSDKAppleBridge)
public final class BotaDeviceSDKAppleBridge: NSObject, @unchecked Sendable {
    @objc public static let shared = BotaDeviceSDKAppleBridge()

    private let lifecycle: BotaDeviceSDKAppleLifecycle
    private let devices: BotaDeviceSDKAppleDevices

    override private init() {
        lifecycle = BotaDeviceSDKAppleLifecycle()
        devices = BotaDeviceSDKAppleDevices()
        super.init()
    }

    @objc(configureWithApplicationSupportDirectory:logLevel:completion:)
    public func configure(
        applicationSupportDirectory: String?,
        logLevel _: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        let directory = applicationSupportDirectory.map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
        Task {
            do {
                try await lifecycle.configure(applicationSupportDirectory: directory)
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(destroyWithCompletion:)
    public func destroy(completion: @escaping @Sendable () -> Void) {
        Task {
            await devices.stopScan()
            await lifecycle.destroy()
            completion()
        }
    }

    @objc(startScanWithTimeoutMilliseconds:allowDuplicates:onDevice:onError:completion:)
    public func startScan(
        timeoutMilliseconds: Double,
        allowDuplicates: Bool,
        onDevice: @escaping @Sendable ([String: Any]) -> Void,
        onError: @escaping @Sendable (NSError) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await devices.startScan(
                    timeoutMilliseconds: try Self.timeoutMilliseconds(timeoutMilliseconds),
                    allowDuplicates: allowDuplicates,
                    onDevice: { onDevice(Self.discoveredDevice($0)) },
                    onError: { onError($0 as NSError) }
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopScanWithCompletion:)
    public func stopScan(completion: @escaping @Sendable () -> Void) {
        Task {
            await devices.stopScan()
            completion()
        }
    }

    @objc(connectSelectedWithID:name:deviceType:firmwareVersion:macAddress:pairingState:rssi:discoveredAtMilliseconds:completion:)
    public func connectSelected(
        id: String,
        name: String?,
        deviceType: String?,
        firmwareVersion: String?,
        macAddress: String?,
        pairingState: String?,
        rssi: Double,
        discoveredAtMilliseconds: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        let selected = DiscoveredDevice(
            id: id,
            name: name,
            deviceType: Self.deviceType(deviceType),
            firmwareVersion: firmwareVersion,
            macAddress: macAddress,
            pairingState: Self.pairingState(pairingState),
            rssi: Int(rssi),
            discoveredAt: Date(timeIntervalSince1970: discoveredAtMilliseconds / 1_000)
        )
        Task {
            do {
                completion(Self.connectedDevice(try await devices.connect(selected)), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(reconnectWithSerialNumber:scanTimeoutMilliseconds:connectionTimeoutMilliseconds:completion:)
    public func reconnect(
        serialNumber: String,
        scanTimeoutMilliseconds: Double,
        connectionTimeoutMilliseconds: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let hint = try DeviceReconnectHint(
                    scanTimeoutMilliseconds: Self.timeoutMilliseconds(scanTimeoutMilliseconds),
                    connectionTimeoutMilliseconds: Self.timeoutMilliseconds(
                        connectionTimeoutMilliseconds
                    )
                )
                completion(
                    Self.connectedDevice(
                        try await devices.reconnect(serialNumber: serialNumber, hint: hint)
                    ),
                    nil
                )
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(disconnectWithCompletion:)
    public func disconnect(completion: @escaping @Sendable (NSError?) -> Void) {
        Task {
            do {
                try await devices.disconnect()
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stateWithCompletion:)
    public func state(completion: @escaping @Sendable (String) -> Void) {
        Task {
            completion(await lifecycle.state())
        }
    }

    @objc public func capabilities() -> [String: Any] {
        let capabilities = BotaDeviceSDKAppleCapabilities.current
        return [
            "backgroundReconnect": capabilities.backgroundReconnect,
            "backgroundScan": capabilities.backgroundScan,
            "bluetooth": capabilities.bluetooth,
            "nativeFileTransfer": capabilities.nativeFileTransfer,
            "platform": capabilities.platform,
        ]
    }

    private static func discoveredDevice(_ device: DiscoveredDevice) -> [String: Any] {
        var value: [String: Any] = [
            "id": device.id,
            "rssi": device.rssi,
            "discoveredAtMs": device.discoveredAt.timeIntervalSince1970 * 1_000,
        ]
        if let name = device.name { value["name"] = name }
        if let type = device.deviceType { value["deviceType"] = deviceType(type) }
        if let version = device.firmwareVersion { value["firmwareVersion"] = version }
        if let address = device.macAddress { value["macAddress"] = address }
        if let state = device.pairingState { value["pairingState"] = pairingState(state) }
        return value
    }

    private static func connectedDevice(_ device: ConnectedDevice) -> [String: Any] {
        var value: [String: Any] = [
            "id": device.id,
            "serialNumber": device.serialNumber,
            "deviceType": deviceType(device.deviceType),
            "firmwareVersion": device.firmwareVersion,
            "isProvisioned": device.isProvisioned,
            "connectionState": connectionState(device.connectionState),
            "mtu": device.mtu,
        ]
        if let revision = device.hardwareRevision { value["hardwareRevision"] = revision }
        return value
    }

    private static func deviceType(_ value: DeviceType) -> String {
        switch value {
        case .botaPin: "bota_pin"
        case .botaPin4G: "bota_pin_4g"
        case .botaNote: "bota_note"
        case .unknown: "bota_pin"
        }
    }

    private static func deviceType(_ value: String?) -> DeviceType? {
        switch value {
        case "bota_pin": .botaPin
        case "bota_pin_4g": .botaPin4G
        case "bota_note": .botaNote
        default: nil
        }
    }

    static func pairingState(_ value: PairingState) -> String {
        switch value {
        case .unpaired: "unpaired"
        case .pairing: "pairing"
        case .paired: "paired"
        case .error: "error"
        case .unknown: "unpaired"
        }
    }

    private static func pairingState(_ value: String?) -> PairingState? {
        switch value {
        case "unpaired": .unpaired
        case "pairing": .pairing
        case "paired": .paired
        case "error": .error
        default: nil
        }
    }

    private static func connectionState(_ value: ConnectionState) -> String {
        switch value {
        case .disconnected: "disconnected"
        case .connecting: "connecting"
        case .bonding: "bonding"
        case .discovering: "discovering"
        case .connected: "connected"
        case .disconnecting: "disconnecting"
        }
    }

    static func timeoutMilliseconds(_ value: Double) throws -> UInt64 {
        guard value.isFinite, value >= 0, value <= Double(Int64.max) else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidTimeout
        }
        return UInt64(value)
    }
}
