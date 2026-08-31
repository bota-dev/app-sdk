@testable import BotaDeviceSDKAppleAdapter
import BotaAppleSDK
import Foundation
import XCTest

final class BotaDeviceSDKAppleLifecycleTests: XCTestCase {
    func testInitialStateAndCapabilitiesDescribeTheIOSAdapter() async {
        let client = TestAppleClient()
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)

        let state = await lifecycle.state()
        let capabilities = await lifecycle.capabilities()

        XCTAssertEqual(state, "uninitialized")
        XCTAssertEqual(
            capabilities,
            BotaDeviceSDKAppleCapabilities(
                backgroundReconnect: false,
                backgroundScan: false,
                bluetooth: true,
                nativeFileTransfer: true,
                platform: "ios"
            )
        )
    }

    func testConfigureForwardsTheExactDirectoryAndBecomesReady() async throws {
        let client = TestAppleClient()
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)
        let directory = URL(fileURLWithPath: "/tmp/bota-rn-state", isDirectory: true)

        try await lifecycle.configure(applicationSupportDirectory: directory)

        let snapshot = await client.snapshot()
        let state = await lifecycle.state()
        XCTAssertEqual(snapshot.configureDirectories, [directory])
        XCTAssertEqual(state, "ready")
    }

    func testConcurrentConfigureCallsShareOneAppleConfiguration() async throws {
        let client = TestAppleClient(blockConfigure: true)
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)

        async let first: Void = lifecycle.configure(applicationSupportDirectory: nil)
        await client.waitForConfigureCount(1)
        async let second: Void = lifecycle.configure(applicationSupportDirectory: nil)
        await Task.yield()
        await client.releaseConfigure()

        _ = try await (first, second)
        let snapshot = await client.snapshot()
        let state = await lifecycle.state()
        XCTAssertEqual(snapshot.configureDirectories.count, 1)
        XCTAssertEqual(state, "ready")
    }

    func testConfigureFailureIsRecoverable() async throws {
        let client = TestAppleClient(configureFailures: 1)
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)

        do {
            try await lifecycle.configure(applicationSupportDirectory: nil)
            XCTFail("Expected configure to fail")
        } catch TestError.configureFailed {}

        let failedState = await lifecycle.state()
        XCTAssertEqual(failedState, "error")

        try await lifecycle.configure(applicationSupportDirectory: nil)

        let snapshot = await client.snapshot()
        let recoveredState = await lifecycle.state()
        XCTAssertEqual(snapshot.configureDirectories.count, 2)
        XCTAssertEqual(recoveredState, "ready")
    }

    func testDestroyWaitsForConfigurationAndReturnsToUninitialized() async throws {
        let client = TestAppleClient(blockConfigure: true)
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)
        let configure = Task {
            try await lifecycle.configure(applicationSupportDirectory: nil)
        }

        await client.waitForConfigureCount(1)
        let destroy = Task {
            await lifecycle.destroy()
        }
        await Task.yield()

        let blockedSnapshot = await client.snapshot()
        XCTAssertEqual(blockedSnapshot.destroyCount, 0)

        await client.releaseConfigure()
        try await configure.value
        await destroy.value

        let snapshot = await client.snapshot()
        let state = await lifecycle.state()
        XCTAssertEqual(snapshot.destroyCount, 1)
        XCTAssertEqual(state, "uninitialized")
    }

    func testConfigureQueuedAfterDestroyStartsFreshAfterDestruction() async throws {
        let client = TestAppleClient(blockConfigure: true, blockDestroy: true)
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)
        let firstConfigure = Task {
            try await lifecycle.configure(applicationSupportDirectory: nil)
        }

        await client.waitForConfigureCount(1)
        let destroy = Task {
            await lifecycle.destroy()
        }
        await lifecycle.waitUntilDestroying()
        let secondConfigure = Task {
            try await lifecycle.configure(applicationSupportDirectory: nil)
        }

        await client.releaseConfigure()
        try await firstConfigure.value
        await client.waitForDestroyCount(1)
        await client.releaseDestroy()
        await destroy.value
        await client.waitForConfigureCount(2)
        await client.releaseConfigure()
        try await secondConfigure.value

        let snapshot = await client.snapshot()
        let state = await lifecycle.state()
        XCTAssertEqual(snapshot.configureDirectories.count, 2)
        XCTAssertEqual(snapshot.destroyCount, 1)
        XCTAssertEqual(state, "ready")
    }

    func testDestroyIsIdempotent() async throws {
        let client = TestAppleClient()
        let lifecycle = BotaDeviceSDKAppleLifecycle(client: client)
        try await lifecycle.configure(applicationSupportDirectory: nil)

        async let first: Void = lifecycle.destroy()
        async let second: Void = lifecycle.destroy()
        _ = await (first, second)

        let snapshot = await client.snapshot()
        let state = await lifecycle.state()
        XCTAssertEqual(snapshot.destroyCount, 1)
        XCTAssertEqual(state, "uninitialized")
    }
}

final class BotaDeviceSDKAppleDevicesTests: XCTestCase {
    func testBridgeTimeoutValidationRejectsInvalidJavaScriptNumbers() throws {
        XCTAssertEqual(
            try BotaDeviceSDKAppleBridge.timeoutMilliseconds(5_000),
            5_000
        )
        XCTAssertThrowsError(try BotaDeviceSDKAppleBridge.timeoutMilliseconds(.nan))
        XCTAssertThrowsError(try BotaDeviceSDKAppleBridge.timeoutMilliseconds(-1))
        XCTAssertThrowsError(try BotaDeviceSDKAppleBridge.timeoutMilliseconds(.infinity))
    }

    func testUnknownPairingStateUsesTheFrozenUnpairedFallback() {
        XCTAssertEqual(BotaDeviceSDKAppleBridge.pairingState(.unknown(0xFF)), "unpaired")
    }

    func testStatusReadAndSubscriptionDelegateToTheAppleFacade() async throws {
        let selected = DiscoveredDevice(id: "selected", name: "Bota Pin", rssi: -42)
        let verified = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: false,
            connectionState: .connected,
            mtu: 247
        )
        let expected = testDeviceStatus()
        let client = TestAppleDeviceClient(
            discovered: selected,
            connected: verified,
            status: expected
        )
        let devices = BotaDeviceSDKAppleDevices(client: client)
        let received = StatusCapture()

        let current = try await devices.readStatus()
        XCTAssertEqual(current, expected)
        try await devices.startStatusUpdates { status in
            Task { await received.append(status) }
        }
        await received.waitForCount(1)
        await devices.stopStatusUpdates()

        let snapshot = await client.snapshot()
        XCTAssertEqual(snapshot.statusReadCount, 1)
        XCTAssertEqual(snapshot.statusTerminationCount, 1)
    }

    func testScanAndConnectionsDelegateToTheAppleFacade() async throws {
        let selected = DiscoveredDevice(id: "selected", name: "Bota Pin", rssi: -42)
        let verified = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: false,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleDeviceClient(discovered: selected, connected: verified)
        let devices = BotaDeviceSDKAppleDevices(client: client)
        let received = DeviceCapture()

        try await devices.startScan(
            timeoutMilliseconds: 5_000,
            allowDuplicates: true
        ) { device in
            Task { await received.append(device) }
        }
        await received.waitForCount(1)
        let connected = try await devices.connect(selected)
        let reconnected = try await devices.reconnect(
            serialNumber: "EVFXXW67KP",
            hint: DeviceReconnectHint(
                scanTimeoutMilliseconds: 7_000,
                connectionTimeoutMilliseconds: 8_000
            )
        )
        try await devices.disconnect()

        let snapshot = await client.snapshot()
        XCTAssertEqual(
            snapshot.scanOptions,
            [TestAppleDeviceClient.ScanOptions(timeout: 5_000, allowDuplicates: true)]
        )
        XCTAssertEqual(snapshot.selectedIDs, ["selected"])
        XCTAssertEqual(snapshot.reconnectSerials, ["EVFXXW67KP"])
        XCTAssertEqual(snapshot.cancelCount, 1)
        XCTAssertEqual(snapshot.disconnectCount, 1)
        XCTAssertEqual(connected.serialNumber, "EVFXXW67KP")
        XCTAssertEqual(reconnected.serialNumber, "EVFXXW67KP")
    }
}

private func testDeviceStatus() -> DeviceStatus {
    DeviceStatus(
        batteryLevel: 72,
        batteryMv: 3_842,
        storageTotalMb: 8_192,
        storageUsedMb: 512,
        state: .known(.idle),
        pendingRecordings: 2,
        lastTimeSyncAt: Date(timeIntervalSince1970: 1_788_200_000),
        signalStrength: 4,
        flags: DeviceFlags(
            charging: false,
            lowBattery: false,
            storageFull: false,
            wifiConnected: true,
            lteConnected: false,
            syncActive: false
        ),
        timestamp: 1_788_200_000,
        lteStatus: .known(.off),
        lteSignalQuality: 99,
        wifiStatus: .known(.connected),
        modemInfo: ModemInfo(imei: "234108029872409", roaming: false)
    )
}

private enum TestError: Error {
    case configureFailed
}

private actor TestAppleClient: BotaDeviceSDKAppleClient {
    struct Snapshot: Sendable {
        let configureDirectories: [URL?]
        let destroyCount: Int
    }

    private let blockConfigure: Bool
    private let blockDestroy: Bool
    private var configureFailures: Int
    private var configureDirectories: [URL?] = []
    private var destroyCount = 0
    private var configureWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var configureBlockers: [CheckedContinuation<Void, Never>] = []
    private var destroyWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var destroyBlockers: [CheckedContinuation<Void, Never>] = []

    init(
        blockConfigure: Bool = false,
        blockDestroy: Bool = false,
        configureFailures: Int = 0
    ) {
        self.blockConfigure = blockConfigure
        self.blockDestroy = blockDestroy
        self.configureFailures = configureFailures
    }

    func configure(applicationSupportDirectory: URL?) async throws {
        configureDirectories.append(applicationSupportDirectory)
        resumeConfigureWaiters()
        if blockConfigure {
            await withCheckedContinuation { continuation in
                configureBlockers.append(continuation)
            }
        }
        if configureFailures > 0 {
            configureFailures -= 1
            throw TestError.configureFailed
        }
    }

    func destroy() async {
        destroyCount += 1
        resumeDestroyWaiters()
        if blockDestroy {
            await withCheckedContinuation { continuation in
                destroyBlockers.append(continuation)
            }
        }
    }

    func waitForConfigureCount(_ expected: Int) async {
        if configureDirectories.count >= expected { return }
        await withCheckedContinuation { continuation in
            configureWaiters.append((expected, continuation))
        }
    }

    func releaseConfigure() {
        let blockers = configureBlockers
        configureBlockers.removeAll()
        blockers.forEach { $0.resume() }
    }

    func waitForDestroyCount(_ expected: Int) async {
        if destroyCount >= expected { return }
        await withCheckedContinuation { continuation in
            destroyWaiters.append((expected, continuation))
        }
    }

    func releaseDestroy() {
        let blockers = destroyBlockers
        destroyBlockers.removeAll()
        blockers.forEach { $0.resume() }
    }

    func snapshot() -> Snapshot {
        Snapshot(
            configureDirectories: configureDirectories,
            destroyCount: destroyCount
        )
    }

    private func resumeConfigureWaiters() {
        var pending: [(Int, CheckedContinuation<Void, Never>)] = []
        for (expected, continuation) in configureWaiters {
            if configureDirectories.count >= expected {
                continuation.resume()
            } else {
                pending.append((expected, continuation))
            }
        }
        configureWaiters = pending
    }

    private func resumeDestroyWaiters() {
        var pending: [(Int, CheckedContinuation<Void, Never>)] = []
        for (expected, continuation) in destroyWaiters {
            if destroyCount >= expected {
                continuation.resume()
            } else {
                pending.append((expected, continuation))
            }
        }
        destroyWaiters = pending
    }
}

private actor DeviceCapture {
    private var devices: [DiscoveredDevice] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func append(_ device: DiscoveredDevice) {
        devices.append(device)
        let ready = waiters.filter { devices.count >= $0.0 }
        waiters.removeAll { devices.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }

    func waitForCount(_ count: Int) async {
        if devices.count >= count { return }
        await withCheckedContinuation { continuation in
            waiters.append((count, continuation))
        }
    }
}

private actor StatusCapture {
    private var statuses: [DeviceStatus] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func append(_ status: DeviceStatus) {
        statuses.append(status)
        let ready = waiters.filter { statuses.count >= $0.0 }
        waiters.removeAll { statuses.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }

    func waitForCount(_ count: Int) async {
        if statuses.count >= count { return }
        await withCheckedContinuation { continuation in
            waiters.append((count, continuation))
        }
    }
}

private actor TestAppleDeviceClient: BotaDeviceSDKAppleDeviceClient {
    struct ScanOptions: Equatable, Sendable {
        let timeout: UInt64
        let allowDuplicates: Bool
    }

    struct Snapshot: Sendable {
        let scanOptions: [ScanOptions]
        let selectedIDs: [String]
        let reconnectSerials: [String]
        let cancelCount: Int
        let disconnectCount: Int
        let statusReadCount: Int
        let statusTerminationCount: Int
    }

    private let discovered: DiscoveredDevice
    private let connected: ConnectedDevice
    private let status: DeviceStatus
    private var scanOptions: [ScanOptions] = []
    private var selectedIDs: [String] = []
    private var reconnectSerials: [String] = []
    private var cancelCount = 0
    private var disconnectCount = 0
    private var statusReadCount = 0
    private var statusTerminationCount = 0

    init(
        discovered: DiscoveredDevice,
        connected: ConnectedDevice,
        status: DeviceStatus = testDeviceStatus()
    ) {
        self.discovered = discovered
        self.connected = connected
        self.status = status
    }

    func startScan(
        timeoutMilliseconds: UInt64,
        allowDuplicates: Bool
    ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error> {
        scanOptions.append(.init(timeout: timeoutMilliseconds, allowDuplicates: allowDuplicates))
        return AsyncThrowingStream { continuation in
            continuation.yield(discovered)
        }
    }

    func cancelCurrentOperation() async throws {
        cancelCount += 1
    }

    func connect(device: DiscoveredDevice) async throws -> ConnectedDevice {
        selectedIDs.append(device.id)
        return connected
    }

    func reconnect(
        serialNumber: String,
        hint _: DeviceReconnectHint
    ) async throws -> ConnectedDevice {
        reconnectSerials.append(serialNumber)
        return connected
    }

    func disconnect() async throws {
        disconnectCount += 1
    }

    func readStatus() async throws -> DeviceStatus {
        statusReadCount += 1
        return status
    }

    func statusUpdates() async throws -> AsyncThrowingStream<DeviceStatus, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(status)
            continuation.onTermination = { @Sendable _ in
                Task { await self.statusTerminated() }
            }
        }
    }

    func snapshot() -> Snapshot {
        Snapshot(
            scanOptions: scanOptions,
            selectedIDs: selectedIDs,
            reconnectSerials: reconnectSerials,
            cancelCount: cancelCount,
            disconnectCount: disconnectCount,
            statusReadCount: statusReadCount,
            statusTerminationCount: statusTerminationCount
        )
    }

    private func statusTerminated() {
        statusTerminationCount += 1
    }
}
