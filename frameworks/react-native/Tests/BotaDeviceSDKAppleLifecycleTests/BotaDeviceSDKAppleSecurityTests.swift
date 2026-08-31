import BotaAppleSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleSecurityTests: XCTestCase {
    func testProvisioningMaterialRoundTripAndDeprovisionDelegateToAppleFacade() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: false,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleSecurityClient()
        let security = BotaDeviceSDKAppleSecurity(client: client)
        let requests = ProvisioningRequestCapture()

        let operation = Task {
            try await security.provision(connected) { request in
                Task { await requests.append(request) }
            }
        }
        let request = await requests.next()
        XCTAssertEqual(request.serialNumber, connected.serialNumber)
        XCTAssertEqual(request.nonce, "00112233")
        XCTAssertEqual(request.devicePublicKey, "aabbccdd")

        try await security.resolveProvisioningMaterial(
            requestID: request.requestID,
            apiEndpoint: "https://api.bota.dev",
            deviceToken: "dtok_example",
            mtu: 247
        )
        try await operation.value
        try await security.deprovision(connected)

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.material?.apiEndpoint, Data("https://api.bota.dev".utf8))
        XCTAssertEqual(snapshot.material?.deviceToken, Data("dtok_example".utf8))
        XCTAssertEqual(snapshot.material?.mtu, 247)
        XCTAssertEqual(snapshot.deprovisionedSerials, [connected.serialNumber])
    }
}

private actor ProvisioningRequestCapture {
    private var requests: [BotaDeviceSDKAppleProvisioningRequest] = []
    private var waiter: CheckedContinuation<BotaDeviceSDKAppleProvisioningRequest, Never>?

    func append(_ request: BotaDeviceSDKAppleProvisioningRequest) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: request)
        } else {
            requests.append(request)
        }
    }

    func next() async -> BotaDeviceSDKAppleProvisioningRequest {
        if !requests.isEmpty { return requests.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private actor TestAppleSecurityClient: BotaDeviceSDKAppleSecurityClient {
    struct Snapshot: Sendable {
        let material: ProvisioningMaterial?
        let deprovisionedSerials: [String]
    }

    private var material: ProvisioningMaterial?
    private var deprovisionedSerials: [String] = []

    func provision(
        _ device: ConnectedDevice,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws {
        material = try await provider(.init(
            serialNumber: device.serialNumber,
            nonce: Data([0x00, 0x11, 0x22, 0x33]),
            devicePublicKey: Data([0xAA, 0xBB, 0xCC, 0xDD])
        ))
    }

    func deprovision(_ device: ConnectedDevice) async throws {
        deprovisionedSerials.append(device.serialNumber)
    }

    func cancelCurrentOperation() async throws {}

    func snapshot() -> Snapshot {
        Snapshot(material: material, deprovisionedSerials: deprovisionedSerials)
    }
}
