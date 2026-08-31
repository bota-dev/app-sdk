import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleClient: Sendable {
    func configure(applicationSupportDirectory: URL?) async throws
    func destroy() async
}

struct BotaDeviceSDKSharedAppleClient: BotaDeviceSDKAppleClient {
    private let client: BotaDeviceClient

    init(client: BotaDeviceClient = .shared) {
        self.client = client
    }

    func configure(applicationSupportDirectory: URL?) async throws {
        try await client.configure(
            BotaConfiguration(applicationSupportDirectory: applicationSupportDirectory)
        )
    }

    func destroy() async {
        await client.destroy()
    }
}

struct BotaDeviceSDKAppleCapabilities: Equatable, Sendable {
    let backgroundReconnect: Bool
    let backgroundScan: Bool
    let bluetooth: Bool
    let nativeFileTransfer: Bool
    let platform: String

    static let current = Self(
        backgroundReconnect: false,
        backgroundScan: false,
        bluetooth: true,
        nativeFileTransfer: true,
        platform: "ios"
    )
}

actor BotaDeviceSDKAppleLifecycle {
    private enum Phase {
        case uninitialized
        case configuring(UUID, Task<Void, Error>)
        case ready
        case error
        case destroying(UUID, Task<Void, Never>)
    }

    private let client: any BotaDeviceSDKAppleClient
    private var phase = Phase.uninitialized

    init(client: any BotaDeviceSDKAppleClient = BotaDeviceSDKSharedAppleClient()) {
        self.client = client
    }

    func configure(applicationSupportDirectory: URL?) async throws {
        while true {
            switch phase {
            case .ready:
                return
            case let .configuring(id, task):
                try await finishConfigure(id: id, task: task)
                return
            case let .destroying(id, task):
                await task.value
                finishDestroy(id: id)
            case .uninitialized, .error:
                let id = UUID()
                let task = Task {
                    try await client.configure(
                        applicationSupportDirectory: applicationSupportDirectory
                    )
                }
                phase = .configuring(id, task)
                try await finishConfigure(id: id, task: task)
                return
            }
        }
    }

    func destroy() async {
        while true {
            switch phase {
            case .uninitialized:
                return
            case let .configuring(_, configureTask):
                let id = UUID()
                let task = Task {
                    _ = try? await configureTask.value
                    await client.destroy()
                }
                phase = .destroying(id, task)
                await task.value
                finishDestroy(id: id)
                return
            case let .destroying(id, task):
                await task.value
                finishDestroy(id: id)
                return
            case .ready, .error:
                let id = UUID()
                let task = Task { await client.destroy() }
                phase = .destroying(id, task)
                await task.value
                finishDestroy(id: id)
                return
            }
        }
    }

    func state() -> String {
        switch phase {
        case .uninitialized, .destroying:
            "uninitialized"
        case .configuring:
            "initializing"
        case .ready:
            "ready"
        case .error:
            "error"
        }
    }

    func capabilities() -> BotaDeviceSDKAppleCapabilities {
        .current
    }

    private func finishConfigure(id: UUID, task: Task<Void, Error>) async throws {
        do {
            try await task.value
            if case let .configuring(activeID, _) = phase, activeID == id {
                phase = .ready
            }
        } catch {
            if case let .configuring(activeID, _) = phase, activeID == id {
                phase = .error
            }
            throw error
        }
    }

    private func finishDestroy(id: UUID) {
        if case let .destroying(activeID, _) = phase, activeID == id {
            phase = .uninitialized
        }
    }
}
