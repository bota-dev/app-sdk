@testable import BotaDeviceSDKAppleAdapter
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

private enum TestError: Error {
    case configureFailed
}

private actor TestAppleClient: BotaDeviceSDKAppleClient {
    struct Snapshot: Sendable {
        let configureDirectories: [URL?]
        let destroyCount: Int
    }

    private let blockConfigure: Bool
    private var configureFailures: Int
    private var configureDirectories: [URL?] = []
    private var destroyCount = 0
    private var configureWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var configureBlockers: [CheckedContinuation<Void, Never>] = []

    init(blockConfigure: Bool = false, configureFailures: Int = 0) {
        self.blockConfigure = blockConfigure
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
}
