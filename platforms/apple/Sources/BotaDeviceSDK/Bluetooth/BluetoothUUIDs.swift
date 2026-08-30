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
