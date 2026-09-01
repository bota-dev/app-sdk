import BotaAppleSDK
import Foundation

private enum BotaDeviceSDKAppleBridgeInputError: LocalizedError {
    case invalidConnectedDevice
    case invalidConnectionSettings
    case invalidEnvironment
    case invalidHexadecimal
    case invalidTimeout
    case invalidUnsignedInteger

    var errorDescription: String? {
        switch self {
        case .invalidConnectedDevice: "connected device contains an unsupported value"
        case .invalidConnectionSettings: "connection settings contain an unsupported value"
        case .invalidEnvironment: "API environment is unsupported"
        case .invalidHexadecimal: "public key must be hexadecimal"
        case .invalidTimeout: "timeout must be a finite non-negative number"
        case .invalidUnsignedInteger: "value must be a finite non-negative integer"
        }
    }
}

@objc(BotaDeviceSDKAppleBridge)
public final class BotaDeviceSDKAppleBridge: NSObject, @unchecked Sendable {
    @objc public static let shared = BotaDeviceSDKAppleBridge()

    private let lifecycle: BotaDeviceSDKAppleLifecycle
    private let devices: BotaDeviceSDKAppleDevices
    private let logs: BotaDeviceSDKAppleLogs
    private let ota: BotaDeviceSDKAppleOTA
    private let recordings: BotaDeviceSDKAppleRecordings
    private let recordingUploads: BotaDeviceSDKAppleRecordingUploads
    private let security: BotaDeviceSDKAppleSecurity
    private let wifi: BotaDeviceSDKAppleWiFi

    override private init() {
        lifecycle = BotaDeviceSDKAppleLifecycle()
        devices = BotaDeviceSDKAppleDevices()
        logs = BotaDeviceSDKAppleLogs()
        ota = BotaDeviceSDKAppleOTA()
        recordings = BotaDeviceSDKAppleRecordings()
        recordingUploads = BotaDeviceSDKAppleRecordingUploads()
        security = BotaDeviceSDKAppleSecurity()
        wifi = BotaDeviceSDKAppleWiFi()
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
                await recordingUploads.configure(applicationSupportDirectory: directory)
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(destroyWithCompletion:)
    public func destroy(completion: @escaping @Sendable () -> Void) {
        Task {
            await security.cancelAll()
            await wifi.cancelAll()
            await logs.stop()
            await ota.cancelAll()
            await recordings.cancelAll()
            await recordingUploads.cancelAll()
            await devices.stopAll()
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

    @objc(isProvisionedWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func isProvisioned(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable (Bool, NSError?) -> Void
    ) {
        Task {
            do {
                completion(try await security.isProvisioned(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                )), nil)
            } catch {
                completion(false, error as NSError)
            }
        }
    }

    @objc(readPublicKeyWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func readPublicKey(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        Task {
            do {
                completion(try await security.readPublicKey(from: Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                )), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(readAuthNonceWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func readAuthNonce(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        Task {
            do {
                completion(try await security.readAuthNonce(from: Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                )), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(setApiEndpointWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:environment:completion:)
    public func setAPIEndpoint(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        environment: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.setAPIEndpoint(
                    try Self.environment(environment),
                    on: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(deliverCertificateWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:certificatePem:privateKeyPem:completion:)
    public func deliverCertificate(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        certificatePEM: String,
        privateKeyPEM: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.deliverCertificate(
                    certificatePEM,
                    privateKeyPEM: privateKeyPEM,
                    to: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(deliverBackendPublicKeyWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:publicKeyHex:completion:)
    public func deliverBackendPublicKey(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        publicKeyHex: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.deliverBackendPublicKey(
                    try Self.hexData(publicKeyHex),
                    to: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(writeGrantWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:grantBlob:completion:)
    public func writeGrant(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        grantBlob: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.writeGrant(
                    grantBlob,
                    to: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(syncTimeWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func syncTime(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.syncTime(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(requestStartRecordingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:grantBlob:completion:)
    public func requestStartRecording(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        grantBlob: String,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await security.requestStartRecording(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    grantBlob: grantBlob
                )
                completion(Self.recordingControlResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(requestStopRecordingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:grantBlob:completion:)
    public func requestStopRecording(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        grantBlob: String,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await security.requestStopRecording(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    grantBlob: grantBlob
                )
                completion(Self.recordingControlResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(readRecordingStateWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func readRecordingState(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let state = try await security.readRecordingState(from: Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(Self.recordingState(state), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(startRecordingStateUpdatesWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:onState:onError:completion:)
    public func startRecordingStateUpdates(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        onState: @escaping @Sendable ([String: Any]) -> Void,
        onError: @escaping @Sendable (NSError) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.startRecordingStateUpdates(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    onState: { onState(Self.recordingState($0)) },
                    onError: { onError($0 as NSError) }
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopRecordingStateUpdatesWithCompletion:)
    public func stopRecordingStateUpdates(completion: @escaping @Sendable () -> Void) {
        Task {
            await security.stopRecordingStateUpdates()
            completion()
        }
    }

    @objc(configureWiFiWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:ssid:password:grantBlob:completion:)
    public func configureWiFi(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        ssid: String,
        password: String,
        grantBlob: String,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await wifi.configure(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    ssid: ssid,
                    password: password,
                    grantBlob: grantBlob
                )
                completion(Self.wifiConfigResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(disconnectWiFiWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func disconnectWiFi(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await wifi.disconnect(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(Self.wifiConfigResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(readWiFiStatusWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func readWiFiStatus(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let status = try await wifi.readStatus(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(Self.wifiStatusInfo(status), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(startWiFiStatusUpdatesWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:onStatus:onError:completion:)
    public func startWiFiStatusUpdates(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        onStatus: @escaping @Sendable ([String: Any]) -> Void,
        onError: @escaping @Sendable (NSError) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await wifi.startStatusUpdates(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    onStatus: { onStatus(Self.wifiStatusInfo($0)) },
                    onError: { onError($0 as NSError) }
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopWiFiStatusUpdatesWithCompletion:)
    public func stopWiFiStatusUpdates(completion: @escaping @Sendable () -> Void) {
        Task {
            await wifi.stopStatusUpdates()
            completion()
        }
    }

    @objc(scanWiFiNetworksWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func scanWiFiNetworks(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await wifi.scanNetworks(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(Self.wifiScanResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(listRecordingsWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func listRecordings(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([[String: Any]]?, NSError?) -> Void
    ) {
        Task {
            do {
                let values = try await recordings.listRecordings(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ))
                completion(values.map(Self.recording), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(syncRecordingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:recordingUUID:startedAtMilliseconds:durationMilliseconds:fileSize:codec:isEncrypted:sinkID:onProgress:completion:)
    public func syncRecording(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        recordingUUID: String,
        startedAtMilliseconds: Double,
        durationMilliseconds: Double,
        fileSize: Double,
        codec: String,
        isEncrypted: Bool,
        sinkID: String,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await recordings.syncRecording(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    recording: DeviceRecording(
                        uuid: recordingUUID,
                        startedAt: Date(
                            timeIntervalSince1970:
                                Double(try Self.unsignedInteger(startedAtMilliseconds)) / 1_000
                        ),
                        durationMs: try Self.unsignedInteger(durationMilliseconds),
                        fileSizeBytes: try Self.unsignedInteger(fileSize),
                        codec: .known(Self.audioCodec(codec)),
                        isEncrypted: isEncrypted
                    ),
                    sinkID: sinkID
                ) { progress in
                    onProgress([
                        "completedUnits": progress.completedBytes,
                        "totalUnits": progress.totalBytes,
                    ])
                }
                var value: [String: Any] = [
                    "localPath": result.localPath,
                    "e2eEncrypted": result.isE2EEncrypted,
                ]
                if let contentSHA256Hex = result.contentSHA256Hex {
                    value["contentSha256"] = contentSHA256Hex
                }
                completion(value, nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(startStreamingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:sessionID:recordingUUID:recordingID:chunkSizeBytes:flushIntervalMilliseconds:onProgress:onDestinationRequest:onFinalizeRequest:completion:)
    public func startStreaming(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        sessionID: String,
        recordingUUID: String,
        recordingID _: String,
        chunkSizeBytes: Double,
        flushIntervalMilliseconds: Double,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        onDestinationRequest: @escaping @Sendable ([String: Any]) -> Void,
        onFinalizeRequest: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable (Double, NSError?) -> Void
    ) {
        Task {
            do {
                let totalBytes = try await recordings.streamRecording(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    recordingUUID: recordingUUID,
                    sessionID: sessionID,
                    chunkSizeBytes: Int(try Self.unsignedInteger(chunkSizeBytes)),
                    flushIntervalMilliseconds: try Self.unsignedInteger(
                        flushIntervalMilliseconds
                    ),
                    onProgress: onProgress,
                    onDestinationRequest: onDestinationRequest,
                    onFinalizeRequest: onFinalizeRequest
                )
                completion(Double(totalBytes), nil)
            } catch {
                completion(0, error as NSError)
            }
        }
    }

    @objc(abortStreamingWithSessionID:completion:)
    public func abortStreaming(
        sessionID: String,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordings.abortStreaming(sessionID: sessionID)
            completion()
        }
    }

    @objc(resolveStreamingDestinationWithRequestID:url:method:contentType:bearerToken:completion:)
    public func resolveStreamingDestination(
        requestID: String,
        url: String,
        method: String,
        contentType: String,
        bearerToken: String?,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordings.resolveStreamingDestination(
                requestID: requestID,
                url: url,
                method: method,
                contentType: contentType,
                bearerToken: bearerToken
            )
            completion()
        }
    }

    @objc(rejectStreamingDestinationWithRequestID:message:completion:)
    public func rejectStreamingDestination(
        requestID: String,
        message: String,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordings.rejectStreamingDestination(requestID: requestID, message: message)
            completion()
        }
    }

    @objc(resolveStreamingFinalizeWithRequestID:completion:)
    public func resolveStreamingFinalize(
        requestID: String,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordings.resolveStreamingFinalize(requestID: requestID)
            completion()
        }
    }

    @objc(rejectStreamingFinalizeWithRequestID:message:completion:)
    public func rejectStreamingFinalize(
        requestID: String,
        message: String,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordings.rejectStreamingFinalize(requestID: requestID, message: message)
            completion()
        }
    }

    @objc(confirmRecordingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:recordingUUID:completion:)
    public func confirmRecording(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        recordingUUID: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await recordings.confirmRecording(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    recordingUUID: recordingUUID
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(uploadRecordingFileWithTaskID:recordingID:localPath:uploadURL:uploadToken:completeURL:contentType:contentSHA256:relayURL:relayBearerToken:onProgress:completion:)
    public func uploadRecordingFile(
        taskID: String,
        recordingID: String,
        localPath: String,
        uploadURL: String,
        uploadToken: String?,
        completeURL: String?,
        contentType: String?,
        contentSHA256: String?,
        relayURL: String?,
        relayBearerToken: String?,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await recordingUploads.upload(.init(
                    taskID: taskID,
                    recordingID: recordingID,
                    localPath: localPath,
                    uploadURL: uploadURL,
                    uploadToken: uploadToken,
                    completeURL: completeURL,
                    contentType: contentType,
                    contentSHA256: contentSHA256,
                    relayURL: relayURL,
                    relayBearerToken: relayBearerToken
                )) { progress in
                    onProgress([
                        "taskId": progress.taskID,
                        "completedBytes": progress.completedBytes,
                        "totalBytes": progress.totalBytes,
                    ])
                }
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(cancelRecordingUploadWithTaskID:completion:)
    public func cancelRecordingUpload(
        taskID: String,
        completion: @escaping @Sendable () -> Void
    ) {
        Task {
            await recordingUploads.cancel(taskID: taskID)
            completion()
        }
    }

    @objc(loadCompatibilityUploadQueueWithCompletion:)
    public func loadCompatibilityUploadQueue(
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        Task {
            do {
                completion(try await recordingUploads.loadQueue(), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(saveCompatibilityUploadQueueWithSerializedTasks:completion:)
    public func saveCompatibilityUploadQueue(
        serializedTasks: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await recordingUploads.saveQueue(serializedTasks)
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopAllRecordingOperationsWithCompletion:)
    public func stopAllRecordingOperations(completion: @escaping @Sendable () -> Void) {
        Task {
            await recordingUploads.cancelAll()
            await recordings.cancelAll()
            completion()
        }
    }

    @objc(observeUploadOwnershipWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:recordingUUID:uploadID:destinationID:onProgress:completion:)
    public func observeUploadOwnership(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        recordingUUID: String,
        uploadID: String,
        destinationID: String,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await recordings.observeUploadOwnership(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    recordingUUID: recordingUUID,
                    uploadID: uploadID,
                    destinationID: destinationID
                ) { progress in
                    onProgress([
                        "completedUnits": progress.completedBytes,
                        "totalUnits": progress.totalBytes,
                    ])
                }
                completion(Self.uploadOwnershipResult(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(updateFirmwareWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:version:sizeUnits:crc32:url:onProgress:completion:)
    public func updateFirmware(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        version: String,
        sizeUnits: Double,
        crc32: Double,
        url: String,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await ota.updateFirmware(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    version: version,
                    sizeBytes: try Self.unsigned32(sizeUnits),
                    crc32: try Self.unsigned32(crc32),
                    url: url
                ) { progress in
                    onProgress([
                        "phase": Self.firmwarePhase(progress.phase),
                        "completedUnits": progress.completedBytes,
                        "totalUnits": progress.totalBytes,
                    ])
                }
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(cancelFirmwareUpdateWithCompletion:)
    public func cancelFirmwareUpdate(completion: @escaping @Sendable () -> Void) {
        Task {
            await ota.cancelAll()
            completion()
        }
    }

    @objc(startDeviceLogsWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:onLine:onError:completion:)
    public func startDeviceLogs(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        onLine: @escaping @Sendable ([String: Any]) -> Void,
        onError: @escaping @Sendable (NSError) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await logs.start(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    onLine: {
                        onLine([
                            "message": $0.message,
                            "isBacklog": $0.isBacklog,
                        ])
                    },
                    onError: { onError($0 as NSError) }
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopDeviceLogsWithCompletion:)
    public func stopDeviceLogs(completion: @escaping @Sendable () -> Void) {
        Task {
            await logs.stop()
            completion()
        }
    }

    @objc(readStatusWithCompletion:)
    public func readStatus(
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                completion(Self.deviceStatus(try await devices.readStatus()), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(startStatusUpdatesWithOnStatus:onError:completion:)
    public func startStatusUpdates(
        onStatus: @escaping @Sendable ([String: Any]) -> Void,
        onError: @escaping @Sendable (NSError) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await devices.startStatusUpdates(
                    onStatus: { onStatus(Self.deviceStatus($0)) },
                    onError: { onError($0 as NSError) }
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(stopStatusUpdatesWithCompletion:)
    public func stopStatusUpdates(completion: @escaping @Sendable () -> Void) {
        Task {
            await devices.stopStatusUpdates()
            completion()
        }
    }

    @objc(provisionWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:onMaterialRequest:completion:)
    public func provision(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        onMaterialRequest: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                let device = try Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                )
                try await security.provision(device) { request in
                    onMaterialRequest([
                        "requestId": request.requestID,
                        "serialNumber": request.serialNumber,
                        "nonce": request.nonce,
                        "devicePublicKey": request.devicePublicKey,
                    ])
                }
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(deprovisionWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:grantBlob:completion:)
    public func deprovision(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        grantBlob: String,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let result = try await security.deprovision(Self.connectedDevice(
                    id: id,
                    serialNumber: serialNumber,
                    deviceType: deviceType,
                    firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision,
                    isProvisioned: isProvisioned,
                    connectionState: connectionState,
                    mtu: mtu
                ), grantBlob: grantBlob)
                completion([
                    "success": result.success,
                    "error": result.error?.rawValue as Any,
                ], nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(writeConnectionSettingsWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:enabledWifi:enabledCellular:heartbeatWifi:heartbeatCellular:uploadNetworkPreference:wifiIdleTimeoutSeconds:cellularIdleTimeoutSeconds:streamingEnabled:streamingFlushIntervalSeconds:completion:)
    public func writeConnectionSettings(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        enabledWifi: Bool,
        enabledCellular: Bool,
        heartbeatWifi: Bool,
        heartbeatCellular: Bool,
        uploadNetworkPreference: [String],
        wifiIdleTimeoutSeconds: Double,
        cellularIdleTimeoutSeconds: Double,
        streamingEnabled: Bool,
        streamingFlushIntervalSeconds: Double,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                let preference = try uploadNetworkPreference.map {
                    guard let value = Self.connectionType($0) else {
                        throw BotaDeviceSDKAppleBridgeInputError.invalidConnectionSettings
                    }
                    return value
                }
                let settings = DeviceConnectionSettings(
                    enabledConnections: .init(
                        wifi: enabledWifi,
                        cellular: enabledCellular
                    ),
                    heartbeatEnabledConnections: .init(
                        wifi: heartbeatWifi,
                        cellular: heartbeatCellular
                    ),
                    uploadNetworkPreference: preference,
                    powerManagement: .init(
                        wifiIdleTimeoutSeconds: try Self.signedInteger(
                            wifiIdleTimeoutSeconds
                        ),
                        cellularIdleTimeoutSeconds: try Self.signedInteger(
                            cellularIdleTimeoutSeconds
                        )
                    ),
                    streamingEnabled: streamingEnabled,
                    streamingFlushIntervalSeconds: try Self.signedInteger(
                        streamingFlushIntervalSeconds
                    )
                )
                try await security.writeConnectionSettings(
                    settings,
                    to: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(readConnectionSettingsWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func readConnectionSettings(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let settings = try await security.readConnectionSettings(
                    from: Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    )
                )
                completion(Self.connectionSettings(settings), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(factoryResetWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:commandID:bindingGeneration:requiresApplicationPersistence:onGrantRequest:onPersistenceRequest:completion:)
    public func factoryReset(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        commandID: String,
        bindingGeneration: Double,
        requiresApplicationPersistence: Bool,
        onGrantRequest: @escaping @Sendable ([String: Any]) -> Void,
        onPersistenceRequest: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let persistenceHandler: (@Sendable (
                    BotaDeviceSDKAppleFactoryResetPersistenceRequest
                ) -> Void)?
                if requiresApplicationPersistence {
                    persistenceHandler = { request in
                        onPersistenceRequest([
                            "requestId": request.requestID,
                            "localRecordingsDeleted": request.localRecordingsDeleted,
                        ])
                    }
                } else {
                    persistenceHandler = nil
                }
                let result = try await security.factoryReset(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    commandID: commandID,
                    bindingGeneration: try Self.unsignedInteger(bindingGeneration),
                    onGrantRequest: { request in
                        onGrantRequest([
                            "requestId": request.requestID,
                            "serialNumber": request.serialNumber,
                            "nonce": request.nonce,
                            "commandId": request.commandID,
                            "bindingGeneration": request.bindingGeneration,
                        ])
                    },
                    onPersistenceRequest: persistenceHandler
                )
                completion(Self.factoryResetCompletion(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(resumePendingFactoryResetWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:currentBindingGeneration:requiresApplicationPersistence:onPersistenceRequest:completion:)
    public func resumePendingFactoryReset(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double,
        currentBindingGeneration: Double,
        requiresApplicationPersistence: Bool,
        onPersistenceRequest: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
                let persistenceHandler: (@Sendable (
                    BotaDeviceSDKAppleFactoryResetPersistenceRequest
                ) -> Void)?
                if requiresApplicationPersistence {
                    persistenceHandler = { request in
                        onPersistenceRequest([
                            "requestId": request.requestID,
                            "localRecordingsDeleted": request.localRecordingsDeleted,
                        ])
                    }
                } else {
                    persistenceHandler = nil
                }
                let result = try await security.resumePendingFactoryReset(
                    Self.connectedDevice(
                        id: id,
                        serialNumber: serialNumber,
                        deviceType: deviceType,
                        firmwareVersion: firmwareVersion,
                        hardwareRevision: hardwareRevision,
                        isProvisioned: isProvisioned,
                        connectionState: connectionState,
                        mtu: mtu
                    ),
                    currentBindingGeneration: try Self.unsignedInteger(currentBindingGeneration),
                    onPersistenceRequest: persistenceHandler
                )
                completion(result.map(Self.factoryResetCompletion), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(resolveProvisioningMaterialWithRequestID:apiEndpoint:deviceToken:mtu:completion:)
    public func resolveProvisioningMaterial(
        requestID: String,
        apiEndpoint: String,
        deviceToken: String,
        mtu: Double,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.resolveProvisioningMaterial(
                    requestID: requestID,
                    apiEndpoint: apiEndpoint,
                    deviceToken: deviceToken,
                    mtu: try Self.unsignedInteger(mtu)
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(resolveFactoryResetGrantWithRequestID:grantBlob:completion:)
    public func resolveFactoryResetGrant(
        requestID: String,
        grantBlob: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.resolveFactoryResetGrant(
                    requestID: requestID,
                    grantBlob: grantBlob
                )
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(resolveFactoryResetResultPersistenceWithRequestID:completion:)
    public func resolveFactoryResetResultPersistence(
        requestID: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.resolveFactoryResetResultPersistence(requestID: requestID)
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(rejectApplicationMaterialWithRequestID:message:completion:)
    public func rejectApplicationMaterial(
        requestID: String,
        message: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        Task {
            do {
                try await security.rejectApplicationMaterial(
                    requestID: requestID,
                    message: message
                )
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

    private static func recording(_ recording: DeviceRecording) -> [String: Any] {
        [
            "uuid": recording.uuid,
            "startedAtMs": recording.startedAt.timeIntervalSince1970 * 1_000,
            "durationMs": recording.durationMs,
            "fileSize": recording.fileSizeBytes,
            "codec": audioCodec(recording.codec),
            "isEncrypted": recording.isEncrypted,
        ]
    }

    private static func recordingControlResult(_ result: RecordingControlResult) -> [String: Any] {
        var value: [String: Any] = ["success": result.success]
        if let error = result.error { value["error"] = error.rawValue }
        return value
    }

    private static func recordingState(_ state: RecordingState) -> [String: Any] {
        var value: [String: Any] = [
            "active": state.active,
            "initiatedBy": state.initiatedBy == .remote ? "remote" : "local",
        ]
        if let recordingID = state.recordingID { value["recordingId"] = recordingID }
        return value
    }

    private static func uploadOwnershipResult(_ result: UploadOwnershipResult) -> [String: Any] {
        switch result {
        case .deviceUploadCompleted:
            ["kind": "device_upload_completed"]
        case let .deviceUploadPreserved(uploadID):
            [
                "kind": "device_upload_preserved",
                "uploadId": uploadID,
            ]
        case let .bluetoothFallback(recordingUUID, uploadID, destinationID):
            [
                "kind": "bluetooth_fallback",
                "recordingUuid": recordingUUID,
                "uploadId": uploadID,
                "destinationId": destinationID,
            ]
        }
    }

    private static func firmwarePhase(_ phase: FirmwareUpdatePhase) -> String {
        switch phase {
        case .downloading: "downloading"
        case .awaitingDevice: "awaiting_device"
        case .transferring: "transferring"
        case .verifying: "verifying"
        case .rebooting: "rebooting"
        case .reconnecting: "reconnecting"
        case .complete: "complete"
        }
    }

    private static func audioCodec(_ codec: WireValue<AudioCodec>) -> String {
        switch codec {
        case let .known(value): audioCodec(value)
        case .unknown: "opus_16k"
        }
    }

    private static func audioCodec(_ value: AudioCodec) -> String {
        switch value {
        case .pcm16k: "pcm_16k"
        case .pcm8k: "pcm_8k"
        case .opus16k: "opus_16k"
        case .opus8k: "opus_8k"
        }
    }

    private static func audioCodec(_ value: String) -> AudioCodec {
        switch value {
        case "pcm_16k": .pcm16k
        case "pcm_8k": .pcm8k
        case "opus_8k": .opus8k
        default: .opus16k
        }
    }

    private static func connectionType(_ value: String) -> ConnectionType? {
        switch value {
        case "wifi": .wifi
        case "ble": .ble
        case "cellular": .cellular
        default: nil
        }
    }

    private static func connectionTypeValue(_ value: ConnectionType) -> String? {
        switch value {
        case .wifi: "wifi"
        case .ble: "ble"
        case .cellular: "cellular"
        case .unknown: nil
        }
    }

    private static func connectionSettings(_ settings: DeviceConnectionSettings) -> [String: Any] {
        [
            "enabledConnections": [
                "wifi": settings.enabledConnections.wifi,
                "cellular": settings.enabledConnections.cellular,
            ],
            "heartbeatEnabledConnections": [
                "wifi": settings.heartbeatEnabledConnections.wifi,
                "cellular": settings.heartbeatEnabledConnections.cellular,
            ],
            "uploadNetworkPreference": settings.uploadNetworkPreference.compactMap(connectionTypeValue),
            "powerManagement": [
                "wifiIdleTimeoutSeconds": settings.powerManagement.wifiIdleTimeoutSeconds,
                "cellularIdleTimeoutSeconds": settings.powerManagement.cellularIdleTimeoutSeconds,
            ],
            "streamingEnabled": settings.streamingEnabled,
            "streamingFlushIntervalSeconds": settings.streamingFlushIntervalSeconds,
        ]
    }

    private static func wifiConfigResult(_ result: WiFiConfigResult) -> [String: Any] {
        switch result {
        case .success:
            ["success": true]
        case .invalidGrant:
            ["success": false, "error": "invalid_grant"]
        case .grantExpired:
            ["success": false, "error": "grant_expired"]
        case .decryptionError:
            ["success": false, "error": "decryption_error"]
        case .storageError:
            ["success": false, "error": "storage_error"]
        case .unknown:
            ["success": false, "error": "unknown"]
        }
    }

    private static func wifiStatusInfo(_ status: WiFiStatusInfo) -> [String: Any] {
        var value: [String: Any] = ["status": wifiConnectionStatus(status.status)]
        if let strength = status.signalStrength { value["signalStrength"] = strength }
        if let ssid = status.ssid { value["ssid"] = ssid }
        if let error = status.lastError { value["lastError"] = error }
        return value
    }

    private static func wifiConnectionStatus(_ status: WiFiConnectionStatus) -> String {
        switch status {
        case .idle: "idle"
        case .connecting: "connecting"
        case .connected: "connected"
        case .failed: "failed"
        case .disconnected: "disconnected"
        case .unknown: "idle"
        }
    }

    private static func wifiScanResult(_ result: DeviceWiFiScanResult) -> [String: Any] {
        var value: [String: Any] = [
            "networks": result.networks.map { network in
                [
                    "ssid": network.ssid,
                    "quality": network.quality,
                    "isCurrent": network.isCurrent,
                    "isOpen": network.isOpen,
                ] as [String: Any]
            },
        ]
        if let currentSSID = result.currentSSID { value["currentSsid"] = currentSSID }
        return value
    }

    private static func factoryResetCompletion(
        _ completion: FactoryResetCompletion
    ) -> [String: Any] {
        [
            "commandId": completion.commandID,
            "bindingGeneration": completion.bindingGeneration,
        ]
    }

    private static func connectedDevice(
        id: String,
        serialNumber: String,
        deviceType: String,
        firmwareVersion: String,
        hardwareRevision: String?,
        isProvisioned: Bool,
        connectionState: String,
        mtu: Double
    ) throws -> ConnectedDevice {
        guard let type = self.deviceType(deviceType),
              let state = self.connectionState(connectionState),
              mtu.isFinite,
              mtu.rounded(.towardZero) == mtu,
              let mtuValue = Int(exactly: mtu)
        else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidConnectedDevice
        }
        return ConnectedDevice(
            id: id,
            serialNumber: serialNumber,
            deviceType: type,
            firmwareVersion: firmwareVersion,
            hardwareRevision: hardwareRevision,
            isProvisioned: isProvisioned,
            connectionState: state,
            mtu: mtuValue
        )
    }

    private static func signedInteger(_ value: Double) throws -> Int {
        guard value.isFinite,
              value.rounded(.towardZero) == value,
              let result = Int(exactly: value)
        else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidConnectionSettings
        }
        return result
    }

    private static func environment(_ value: String) throws -> DeviceAPIEnvironment {
        switch value {
        case "development": .development
        case "gamma": .gamma
        case "production": .production
        default: throw BotaDeviceSDKAppleBridgeInputError.invalidEnvironment
        }
    }

    private static func hexData(_ value: String) throws -> Data {
        guard value.count.isMultiple(of: 2) else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidHexadecimal
        }
        var data = Data(capacity: value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let end = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<end], radix: 16) else {
                throw BotaDeviceSDKAppleBridgeInputError.invalidHexadecimal
            }
            data.append(byte)
            index = end
        }
        return data
    }

    private static func deviceStatus(_ status: DeviceStatus) -> [String: Any] {
        var value: [String: Any] = [
            "batteryLevel": status.batteryLevel,
            "storageTotalMb": status.storageTotalMb,
            "storageUsedMb": status.storageUsedMb,
            "state": deviceState(status.state),
            "pendingRecordings": status.pendingRecordings,
            "signalStrength": status.signalStrength,
            "flags": deviceFlags(status.flags),
            "timestamp": status.timestamp,
            "lteStatus": lteStatus(status.lteStatus),
        ]
        if let batteryMv = status.batteryMv { value["batteryMv"] = batteryMv }
        if let syncedAt = status.lastTimeSyncAt {
            value["lastTimeSyncAtMs"] = syncedAt.timeIntervalSince1970 * 1_000
        }
        if let quality = status.lteSignalQuality { value["lteSignalQuality"] = quality }
        if let wifi = status.wifiStatus { value["wifiStatus"] = wifiStatus(wifi) }
        if let modem = status.modemInfo { value["modemInfo"] = modemInfo(modem) }
        return value
    }

    private static func deviceFlags(_ flags: DeviceFlags) -> [String: Any] {
        [
            "charging": flags.charging,
            "lowBattery": flags.lowBattery,
            "storageFull": flags.storageFull,
            "wifiConnected": flags.wifiConnected,
            "lteConnected": flags.lteConnected,
            "syncActive": flags.syncActive,
        ]
    }

    private static func modemInfo(_ modem: ModemInfo) -> [String: Any] {
        var value: [String: Any] = [:]
        if let imei = modem.imei { value["imei"] = imei }
        if let iccid = modem.iccid { value["iccid"] = iccid }
        if let carrier = modem.operator { value["operator"] = carrier }
        if let rat = modem.rat { value["rat"] = rat }
        if let band = modem.band { value["band"] = band }
        if let apn = modem.apn { value["apn"] = apn }
        if let simStatus = modem.simStatus { value["simStatus"] = simStatus }
        if let csq = modem.csq { value["csq"] = csq }
        if let address = modem.ipAddress { value["ipAddress"] = address }
        if let voltage = modem.modemVoltage { value["modemVoltage"] = voltage }
        if let firmware = modem.modemFirmware { value["modemFirmware"] = firmware }
        if let roaming = modem.roaming { value["roaming"] = roaming }
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

    private static func connectionState(_ value: String) -> ConnectionState? {
        switch value {
        case "disconnected": .disconnected
        case "connecting": .connecting
        case "bonding": .bonding
        case "discovering": .discovering
        case "connected": .connected
        case "disconnecting": .disconnecting
        default: nil
        }
    }

    private static func deviceState(_ value: WireValue<DeviceState>) -> String {
        guard case let .known(state) = value else { return "idle" }
        return switch state {
        case .idle: "idle"
        case .recording: "recording"
        case .syncing: "syncing"
        case .uploading: "uploading"
        case .charging: "charging"
        case .lowBattery: "lowBattery"
        case .storageFull: "storageFull"
        case .error: "error"
        }
    }

    private static func lteStatus(_ value: WireValue<LteStatus>) -> String {
        guard case let .known(status) = value else { return "off" }
        return switch status {
        case .off: "off"
        case .searching: "searching"
        case .registered: "registered"
        case .connected: "connected"
        case .denied: "denied"
        case .noSim: "noSim"
        case .error: "error"
        case .lowVoltage: "lowVoltage"
        case .disabled: "disabled"
        }
    }

    private static func wifiStatus(_ value: WireValue<WifiRadioStatus>) -> String {
        guard case let .known(status) = value else { return "off" }
        return switch status {
        case .off: "off"
        case .scanning: "scanning"
        case .connecting: "connecting"
        case .connected: "connected"
        case .connectFailed: "connectFailed"
        case .noCredentials: "noCredentials"
        case .disabled: "disabled"
        case .error: "error"
        }
    }

    static func timeoutMilliseconds(_ value: Double) throws -> UInt64 {
        guard value.isFinite, value >= 0, value <= Double(Int64.max) else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidTimeout
        }
        return UInt64(value)
    }

    private static func unsignedInteger(_ value: Double) throws -> UInt64 {
        guard value.isFinite,
              value >= 0,
              value <= 9_007_199_254_740_991,
              value.rounded(.towardZero) == value
        else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidUnsignedInteger
        }
        return UInt64(value)
    }

    private static func unsigned32(_ value: Double) throws -> UInt32 {
        let integer = try unsignedInteger(value)
        guard let result = UInt32(exactly: integer) else {
            throw BotaDeviceSDKAppleBridgeInputError.invalidUnsignedInteger
        }
        return result
    }
}
