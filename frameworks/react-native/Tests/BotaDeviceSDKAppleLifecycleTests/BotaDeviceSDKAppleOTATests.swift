import BotaAppleSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleOTATests: XCTestCase {
    func testFirmwareDownloadAndTransferStayNative() async throws {
        let client = TestAppleOTAClient()
        let ota = BotaDeviceSDKAppleOTA(client: client)
        let progress = FirmwareProgressCapture()

        try await ota.updateFirmware(
            ConnectedDevice(
                id: "selected",
                serialNumber: "EVFXXW67KP",
                deviceType: .botaPin,
                firmwareVersion: "1.0.11",
                isProvisioned: true,
                connectionState: .connected,
                mtu: 247
            ),
            version: "1.0.12",
            sizeBytes: 1_024_000,
            crc32: 0x1234_5678,
            url: "https://firmware.bota.dev/update.ufw"
        ) { value in
            Task { await progress.append(value) }
        }

        let capturedImage = await client.capturedImage()
        let image = try XCTUnwrap(capturedImage)
        XCTAssertEqual(image.version, "1.0.12")
        XCTAssertEqual(image.sizeBytes, 1_024_000)
        XCTAssertEqual(image.crc32, 0x1234_5678)
        XCTAssertEqual(image.request.url?.absoluteString, "https://firmware.bota.dev/update.ufw")
        let progressSnapshot = await progress.snapshot()
        XCTAssertEqual(
            progressSnapshot,
            [
                .init(phase: .downloading, completedBytes: 512_000, totalBytes: 1_024_000),
                .init(phase: .complete, completedBytes: 1_024_000, totalBytes: 1_024_000),
            ]
        )
        await ota.cancelAll()
        let cancelled = await client.wasCancelled()
        XCTAssertTrue(cancelled)
    }
}

private actor FirmwareProgressCapture {
    private var values: [FirmwareUpdateProgress] = []

    func append(_ value: FirmwareUpdateProgress) {
        values.append(value)
    }

    func snapshot() -> [FirmwareUpdateProgress] {
        values
    }
}

private actor TestAppleOTAClient: BotaDeviceSDKAppleOTAClient {
    private var image: FirmwareImage?
    private var cancelled = false

    func updateFirmware(
        _ device: ConnectedDevice,
        image: FirmwareImage
    ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error> {
        self.image = image
        let pair = AsyncThrowingStream<FirmwareUpdateProgress, Error>.makeStream()
        pair.continuation.yield(
            .init(phase: .downloading, completedBytes: 512_000, totalBytes: 1_024_000)
        )
        pair.continuation.yield(
            .init(phase: .complete, completedBytes: 1_024_000, totalBytes: 1_024_000)
        )
        pair.continuation.finish()
        return pair.stream
    }

    func cancelCurrentOperation() async throws {
        cancelled = true
    }

    func capturedImage() -> FirmwareImage? {
        image
    }

    func wasCancelled() -> Bool {
        cancelled
    }
}
