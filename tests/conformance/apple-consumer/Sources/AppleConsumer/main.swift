import BotaAppleSDK
import Foundation

@main
enum AppleConsumer {
    static func main() {
        precondition(BotaAppleSDKVersion.current == "1.0.2")
        _ = BotaConfiguration()
        _ = BotaDeviceClient()
        print("BotaAppleSDK \(BotaAppleSDKVersion.current) consumer import passed")
    }
}

private func typeCheckPublicFacade(
    client: BotaDeviceClient,
    device: ConnectedDevice,
    recording: DeviceRecording,
    firmware: FirmwareImage
) async throws {
    let _: AsyncThrowingStream<DiscoveredDevice, Error> = try await client.devices.startScan()
    let _: ConnectedDevice = try await client.devices.reconnect(serialNumber: device.serialNumber)
    let _: AsyncThrowingStream<RecordingSyncEvent, Error> = try await client.recordings.syncRecording(
        device,
        recording: recording
    )
    let _: AsyncThrowingStream<UploadOwnershipEvent, Error> = try await client.recordings.observeUploadOwnership(
        device,
        recordingUUID: recording.uuid,
        uploadID: "upload-id",
        destinationID: "destination-id"
    )
    let _: AsyncThrowingStream<FirmwareUpdateProgress, Error> = try await client.ota.updateFirmware(
        device,
        image: firmware
    )
    let _: AsyncThrowingStream<DeviceLogLine, Error> = try await client.logs.streamLogs(device)
    try await client.provisioning.deprovision(device)
    let _: FactoryResetCompletion = try await client.factoryReset.factoryReset(
        device,
        commandID: "command-id",
        grantID: "grant-id",
        bindingGeneration: 1
    ) { _ in
        Data([0])
    }
}
