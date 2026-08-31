import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleOTAClient: Sendable {
    func updateFirmware(
        _ device: ConnectedDevice,
        image: FirmwareImage
    ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error>
    func cancelCurrentOperation() async throws
}

struct BotaDeviceSDKSharedAppleOTAClient: BotaDeviceSDKAppleOTAClient {
    private let ota: OTAManager

    init(client: BotaDeviceClient = .shared) {
        ota = client.ota
    }

    func updateFirmware(
        _ device: ConnectedDevice,
        image: FirmwareImage
    ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error> {
        try await ota.updateFirmware(device, image: image)
    }

    func cancelCurrentOperation() async throws {
        try await ota.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleOTA {
    private enum OTAError: LocalizedError {
        case invalidURL

        var errorDescription: String? {
            "firmware URL is invalid"
        }
    }

    private let client: any BotaDeviceSDKAppleOTAClient

    init(
        client: any BotaDeviceSDKAppleOTAClient = BotaDeviceSDKSharedAppleOTAClient()
    ) {
        self.client = client
    }

    func updateFirmware(
        _ device: ConnectedDevice,
        version: String,
        sizeBytes: UInt32,
        crc32: UInt32,
        url: String,
        onProgress: @escaping @Sendable (FirmwareUpdateProgress) -> Void
    ) async throws {
        guard let url = URL(string: url) else { throw OTAError.invalidURL }
        let image = FirmwareImage(
            version: version,
            sizeBytes: sizeBytes,
            crc32: crc32,
            downloadID: UInt64.random(in: 1 ... UInt64.max),
            request: URLRequest(url: url)
        )
        let progress = try await client.updateFirmware(device, image: image)
        for try await value in progress {
            onProgress(value)
        }
    }

    func cancelAll() async {
        try? await client.cancelCurrentOperation()
    }
}
