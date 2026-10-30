import Foundation

@MainActor private final class Association: LocalWiFiAssociation {
    var started = false
    var delayed = false
    var completion: CheckedContinuation<Void, Never>?
    var closes = 0
    var failClose = false
    func join(ssid: String, password: String) async throws {
        started = true
        if delayed { await withCheckedContinuation { completion = $0 } }
    }
    func close() throws {
        if failClose { throw NSError(domain: "test", code: 1) }
        closes += 1
    }
}
@main struct BridgeChecks {
    @MainActor static func call(_ submit: (@escaping @Sendable (String?, NSError?) -> Void) -> Void) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            submit { value, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value) }
            }
        }
    }
    @MainActor static func main() async throws {
        let association = Association()
        let bridge = BotaLocalWifiTransportBridge(isForeground: { true }, makeAssociation: { association })
        let lease = try await call(bridge.createLease)!
        do { _ = try await call(bridge.preflight); fatalError("Occupied lease admitted preflight") } catch { }
        let input = "{\"ssid\":\"test\",\"password\":\"test-only-password\",\"remainingMs\":60000}"
        _ = try await call { bridge.join(lease, inputJSON: input, completion: $0) }
        _ = try await call { bridge.closeLease(lease, completion: $0) }
        _ = try await call { bridge.closeLease(lease, completion: $0) }
        precondition(association.closes == 1)
        let next = try await call(bridge.createLease)!
        _ = try await call { bridge.closeLease(lease, completion: $0) }
        _ = try await call { bridge.join(next, inputJSON: input, completion: $0) }
        precondition(association.closes == 1)
        association.failClose = true
        do { _ = try await call { bridge.closeLease(next, completion: $0) }; fatalError("Failed removal hidden") } catch { }
        association.failClose = false
        _ = try await call { bridge.closeLease(next, completion: $0) }
        precondition(association.closes == 2)
        association.started = false; association.delayed = true
        let delayed = try await call(bridge.createLease)!
        let joining = Task { @MainActor in try await call { bridge.join(delayed, inputJSON: input, completion: $0) } }
        while !association.started { await Task.yield() }
        var closed = false
        let closing = Task { @MainActor in
            _ = try await call { bridge.closeLease(delayed, completion: $0) }; closed = true
        }
        for _ in 0..<20 { await Task.yield() }
        precondition(!closed && association.closes == 2)
        association.completion?.resume(); association.completion = nil
        _ = await joining.result
        try await closing.value
        precondition(association.closes == 3)
        bridge.invalidate()
        for _ in 0..<20 { await Task.yield() }
        do { _ = try await call(bridge.createLease); fatalError("Invalidated bridge admitted lease") } catch { }
        let background = BotaLocalWifiTransportBridge(isForeground: { false }, makeAssociation: { association })
        do { _ = try await call(background.preflight); fatalError("Background bridge admitted preflight") } catch { }
        print("Apple bridge handles, stale close, delayed join retirement, cleanup retry and foreground checks passed")
    }
}
