import BotaAppleSDK
import Foundation

private enum BotaDeviceSDKAppleBridgeInputError: LocalizedError {
    case invalidConnectedDevice
    case invalidTimeout
    case invalidUnsignedInteger

    var errorDescription: String? {
        switch self {
        case .invalidConnectedDevice: "connected device contains an unsupported value"
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
    private let ota: BotaDeviceSDKAppleOTA
    private let recordings: BotaDeviceSDKAppleRecordings
    private let security: BotaDeviceSDKAppleSecurity

    override private init() {
        lifecycle = BotaDeviceSDKAppleLifecycle()
        devices = BotaDeviceSDKAppleDevices()
        ota = BotaDeviceSDKAppleOTA()
        recordings = BotaDeviceSDKAppleRecordings()
        security = BotaDeviceSDKAppleSecurity()
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
            await security.cancelAll()
            await ota.cancelAll()
            await recordings.cancelAll()
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

    @objc(syncRecordingWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:recordingUUID:startedAtMilliseconds:durationMilliseconds:fileSize:codec:isEncrypted:onProgress:completion:)
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
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        Task {
            do {
                let path = try await recordings.syncRecording(
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
                    )
                ) { progress in
                    onProgress([
                        "completedUnits": progress.completedBytes,
                        "totalUnits": progress.totalBytes,
                    ])
                }
                completion(path, nil)
            } catch {
                completion(nil, error as NSError)
            }
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

    @objc(deprovisionWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:completion:)
    public func deprovision(
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
                try await security.deprovision(Self.connectedDevice(
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

    @objc(factoryResetWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:commandID:bindingGeneration:onGrantRequest:completion:)
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
        onGrantRequest: @escaping @Sendable ([String: Any]) -> Void,
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
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
                    bindingGeneration: try Self.unsignedInteger(bindingGeneration)
                ) { request in
                    onGrantRequest([
                        "requestId": request.requestID,
                        "serialNumber": request.serialNumber,
                        "nonce": request.nonce,
                        "commandId": request.commandID,
                        "bindingGeneration": request.bindingGeneration,
                    ])
                }
                completion(Self.factoryResetCompletion(result), nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc(resumePendingFactoryResetWithID:serialNumber:deviceType:firmwareVersion:hardwareRevision:isProvisioned:connectionState:mtu:currentBindingGeneration:completion:)
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
        completion: @escaping @Sendable ([String: Any]?, NSError?) -> Void
    ) {
        Task {
            do {
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
                    currentBindingGeneration: try Self.unsignedInteger(
                        currentBindingGeneration
                    )
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
