import Foundation

@testable import BotaAppleSDK

actor FakeCentralDriver: CentralDriver {
    var connected: [CentralAdvertisement]
    var scanned: [CentralAdvertisement]
    var operationDelayNanoseconds: UInt64
    var discoveryDelayNanoseconds: UInt64 = 0
    private(set) var log: [String] = []
    private(set) var characteristicLog: [String] = []
    private(set) var maximumConcurrentByPeripheral: [String: Int] = [:]
    private(set) var maximumGlobalConcurrency = 0
    private(set) var disconnectCount = 0
    private(set) var failedPendingReadCount = 0
    private var concurrentByPeripheral: [String: Int] = [:]
    private var globalConcurrency = 0
    private var suspendReads = false
    private var subscriptionNotifications = [Data([2])]
    private var pendingReads: [CheckedContinuation<Data, Error>] = []

    init(
        connected: [CentralAdvertisement] = [],
        scanned: [CentralAdvertisement] = [],
        operationDelayNanoseconds: UInt64 = 0
    ) {
        self.connected = connected
        self.scanned = scanned
        self.operationDelayNanoseconds = operationDelayNanoseconds
    }

    func connectedPeripherals(serviceUUIDs: [String]) async -> [CentralAdvertisement] {
        log.append("connected")
        return connected
    }

    func startScan(allowDuplicates: Bool) async throws -> AsyncThrowingStream<CentralAdvertisement, Error> {
        log.append("startScan:\(allowDuplicates)")
        let values = scanned
        return AsyncThrowingStream { continuation in
            values.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    func stopScan() async throws { log.append("stopScan") }

    func connect(peripheralID: String) async throws {
        try await operation("connect", peripheralID: peripheralID)
    }

    func discoverServices(peripheralID: String, serviceUUIDs: [String]) async throws -> [String] {
        log.append("services:\(peripheralID)")
        if discoveryDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: discoveryDelayNanoseconds)
        }
        return serviceUUIDs
    }

    func discoverCharacteristics(peripheralID: String, serviceUUIDs: [String]) async throws {
        log.append("characteristics:\(peripheralID)")
    }

    func disconnect(peripheralID: String) async throws {
        disconnectCount += 1
        log.append("disconnect:\(peripheralID)")
        let reads = pendingReads
        pendingReads.removeAll()
        failedPendingReadCount += reads.count
        reads.forEach { $0.resume(throwing: CentralDriverError.disconnected(peripheralID)) }
    }

    func read(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws -> Data {
        if suspendReads {
            return try await withCheckedThrowingContinuation { pendingReads.append($0) }
        }
        try await operation("read", peripheralID: peripheralID)
        return Data([1])
    }

    func maximumWriteValueLength(peripheralID: String, withResponse: Bool) async throws -> Int {
        log.append("maximumWriteValueLength:\(peripheralID):\(withResponse)")
        return 512
    }

    func write(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String,
        data: Data,
        withResponse: Bool
    ) async throws {
        characteristicLog.append(
            "write:\(serviceUUID):\(characteristicUUID):\(withResponse)"
        )
        try await operation("write", peripheralID: peripheralID)
    }

    func subscribe(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws -> AsyncThrowingStream<Data, Error> {
        characteristicLog.append("subscribe:\(serviceUUID):\(characteristicUUID)")
        try await operation("subscribe", peripheralID: peripheralID)
        let values = subscriptionNotifications
        return AsyncThrowingStream { continuation in
            values.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    func unsubscribe(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws {
        characteristicLog.append("unsubscribe:\(serviceUUID):\(characteristicUUID)")
        try await operation("unsubscribe", peripheralID: peripheralID)
    }

    private func operation(_ name: String, peripheralID: String) async throws {
        log.append("\(name):start:\(peripheralID)")
        globalConcurrency += 1
        concurrentByPeripheral[peripheralID, default: 0] += 1
        defer {
            concurrentByPeripheral[peripheralID, default: 1] -= 1
            globalConcurrency -= 1
            log.append("\(name):end:\(peripheralID)")
        }
        maximumGlobalConcurrency = max(maximumGlobalConcurrency, globalConcurrency)
        maximumConcurrentByPeripheral[peripheralID] = max(
            maximumConcurrentByPeripheral[peripheralID, default: 0],
            concurrentByPeripheral[peripheralID, default: 0]
        )
        if operationDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: operationDelayNanoseconds)
        }
    }

    func setReadsSuspended(_ value: Bool) { suspendReads = value }
    func setSubscriptionNotifications(_ values: [Data]) { subscriptionNotifications = values }
    var pendingReadCount: Int { pendingReads.count }
}
