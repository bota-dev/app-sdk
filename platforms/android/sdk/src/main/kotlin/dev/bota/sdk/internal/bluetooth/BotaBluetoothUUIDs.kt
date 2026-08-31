package dev.bota.sdk.internal.bluetooth

import java.util.UUID

internal object BotaBluetoothUUIDs {
    val DeviceInformationService: UUID = shortUuid(0x180a)
    val BatteryService: UUID = shortUuid(0x180f)
    val SerialNumber: UUID = shortUuid(0x2a25)
    val Cccd: UUID = shortUuid(0x2902)

    val AudioService: UUID = botaUuid(0x0001, 0x0000)
    val ControlService: UUID = botaUuid(0x0002, 0x0000)
    val DeviceStatus: UUID = botaUuid(0x0002, 0x0001)
    val ProvisioningService: UUID = botaUuid(0x0003, 0x0000)
    val StorageService: UUID = botaUuid(0x0004, 0x0000)
    val AuthService: UUID = botaUuid(0x0005, 0x0000)
    val WifiService: UUID = botaUuid(0x0006, 0x0000)
    val WifiGrant: UUID = botaUuid(0x0006, 0x0001)
    val WifiCredential: UUID = botaUuid(0x0006, 0x0002)
    val WifiStatus: UUID = botaUuid(0x0006, 0x0003)
    val WifiScan: UUID = botaUuid(0x0006, 0x0004)
    val DiagnosticsService: UUID = botaUuid(0x0007, 0x0000)

    val BotaServices: Set<UUID> = setOf(
        AudioService,
        ControlService,
        ProvisioningService,
        StorageService,
        AuthService,
        WifiService,
        DiagnosticsService,
    )

    const val ManufacturerId: Int = 0xb07a

    private fun shortUuid(value: Int): UUID =
        UUID.fromString("%08x-0000-1000-8000-00805f9b34fb".format(value))

    private fun botaUuid(service: Int, characteristic: Int): UUID =
        UUID.fromString("b07a%04x-%04x-1000-8000-00805f9b34fb".format(service, characteristic))
}
