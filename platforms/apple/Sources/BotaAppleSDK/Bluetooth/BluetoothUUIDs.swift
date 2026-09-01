enum BotaBluetoothUUIDs {
    static let deviceInformationService = "180A"
    static let batteryService = "180F"
    static let audioService = "B07A0001-0000-1000-8000-00805F9B34FB"
    static let controlService = "B07A0002-0000-1000-8000-00805F9B34FB"
    static let provisioningService = "B07A0003-0000-1000-8000-00805F9B34FB"
    static let storageService = "B07A0004-0000-1000-8000-00805F9B34FB"
    static let authService = "B07A0005-0000-1000-8000-00805F9B34FB"
    static let wifiService = "B07A0006-0000-1000-8000-00805F9B34FB"
    static let diagnosticsService = "B07A0007-0000-1000-8000-00805F9B34FB"

    static let deviceStatus = "B07A0002-0001-1000-8000-00805F9B34FB"
    static let timeSync = "B07A0002-0004-1000-8000-00805F9B34FB"
    static let deviceCommand = "B07A0002-0005-1000-8000-00805F9B34FB"
    static let pairingState = "B07A0003-0001-1000-8000-00805F9B34FB"
    static let apiEndpoint = "B07A0003-0003-1000-8000-00805F9B34FB"
    static let deviceSettings = "B07A0003-0006-1000-8000-00805F9B34FB"
    static let recordingList = "B07A0004-0002-1000-8000-00805F9B34FB"
    static let transferControl = "B07A0004-0004-1000-8000-00805F9B34FB"
    static let devicePublicKey = "B07A0005-0001-1000-8000-00805F9B34FB"
    static let authNonce = "B07A0005-0002-1000-8000-00805F9B34FB"
    static let backendPublicKey = "B07A0005-0003-1000-8000-00805F9B34FB"
    static let deviceCertificate = "B07A0005-0004-1000-8000-00805F9B34FB"
    static let wifiGrant = "B07A0006-0001-1000-8000-00805F9B34FB"
    static let wifiCredential = "B07A0006-0002-1000-8000-00805F9B34FB"
    static let wifiStatus = "B07A0006-0003-1000-8000-00805F9B34FB"
    static let wifiScan = "B07A0006-0004-1000-8000-00805F9B34FB"

    static let botaServices = [
        audioService,
        controlService,
        provisioningService,
        storageService,
        authService,
        wifiService,
        diagnosticsService,
    ]
}
