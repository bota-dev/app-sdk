import BotaAppleSDK
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleWiFiTests: XCTestCase {
    func testConfigurationAndScanDelegateToNativeWiFiFacade() async throws {
        let client = TestAppleWiFiClient()
        let wifi = BotaDeviceSDKAppleWiFi(client: client)
        let device = wifiTestDevice()

        let configured = try await wifi.configure(
            device,
            ssid: "Bota",
            password: "secret",
            grantBlob: "grant.test"
        )
        let scan = try await wifi.scanNetworks(device)

        XCTAssertEqual(configured, .success)
        XCTAssertEqual(scan.currentSSID, "Bota")
        let input = await client.configurationInput
        XCTAssertEqual(input, .init(ssid: "Bota", password: "secret", grantBlob: "grant.test"))
    }

    func testStatusStreamOwnsExactlyOneNativeSubscription() async throws {
        let client = TestAppleWiFiClient()
        let wifi = BotaDeviceSDKAppleWiFi(client: client)
        let capture = WiFiStatusCapture()

        try await wifi.startStatusUpdates(wifiTestDevice()) { value in
            Task { await capture.append(value) }
        }
        for _ in 0 ..< 100 {
            if !(await capture.snapshot()).isEmpty { break }
            await Task.yield()
        }
        await wifi.stopStatusUpdates()
        await wifi.stopStatusUpdates()

        let values = await capture.snapshot()
        let terminations = await client.subscriptionTerminations
        XCTAssertEqual(values, [WiFiStatusInfo(status: .connected, signalStrength: 87, ssid: "Bota")])
        XCTAssertEqual(terminations, 1)
    }
}

private actor WiFiStatusCapture {
    private var values: [WiFiStatusInfo] = []
    func append(_ value: WiFiStatusInfo) { values.append(value) }
    func snapshot() -> [WiFiStatusInfo] { values }
}

private actor TestAppleWiFiClient: BotaDeviceSDKAppleWiFiClient {
    struct ConfigurationInput: Equatable, Sendable {
        let ssid: String
        let password: String
        let grantBlob: String
    }

    private(set) var configurationInput: ConfigurationInput?
    private(set) var subscriptionTerminations = 0

    func configure(
        _ device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String
    ) async throws -> WiFiConfigResult {
        configurationInput = .init(ssid: ssid, password: password, grantBlob: grantBlob)
        return .success
    }

    func disconnect(_ device: ConnectedDevice) async throws -> WiFiConfigResult { .success }

    func readStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
        .init(status: .connected, signalStrength: 87, ssid: "Bota")
    }

    func statusUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error> {
        let pair = AsyncThrowingStream<WiFiStatusInfo, Error>.makeStream()
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.didTerminate() }
        }
        pair.continuation.yield(.init(status: .connected, signalStrength: 87, ssid: "Bota"))
        return pair.stream
    }

    func scanNetworks(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
        .init(
            networks: [.init(ssid: "Bota", quality: 100, isCurrent: true, isOpen: false)],
            currentSSID: "Bota"
        )
    }

    func cancelCurrentOperation() async {}

    private func didTerminate() { subscriptionTerminations += 1 }
}

private func wifiTestDevice() -> ConnectedDevice {
    ConnectedDevice(
        id: "selected",
        serialNumber: "EVFXXW67KP",
        deviceType: .botaNote,
        firmwareVersion: "1.0.17",
        isProvisioned: true,
        connectionState: .connected,
        mtu: 247
    )
}
