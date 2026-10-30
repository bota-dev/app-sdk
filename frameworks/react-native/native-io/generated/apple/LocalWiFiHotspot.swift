#if os(iOS)
import Foundation
import NetworkExtension

/// Foreground, temporary association only. Requires the app's Hotspot Configuration entitlement.
/// The caller supplies credentials only after its current BLE security check succeeds.
@MainActor public final class LocalWiFiHotspot {
    private var ownedSSID: String?
    private var joining = false
    public init() {}

    public func join(ssid: String, password: String) async throws {
        guard ownedSSID == nil, !joining else { throw LocalWiFiTransportError.busy }
        guard (1...32).contains(ssid.utf8.count), (8...63).contains(password.utf8.count),
              password.utf8.allSatisfy({ (32...126).contains($0) }) else { throw LocalWiFiTransportError.invalidInput }
        try Task.checkCancellation()
        joining = true
        // Never replace an existing app-managed configuration: cleanup must own what it removes.
        let existing = await withCheckedContinuation { done in
            NEHotspotConfigurationManager.shared.getConfiguredSSIDs { done.resume(returning: $0) }
        }
        guard !existing.contains(ssid) else { joining = false; throw LocalWiFiTransportError.busy }
        ownedSSID = ssid
        let configuration = NEHotspotConfiguration(ssid: ssid, passphrase: password, isWEP: false)
        configuration.joinOnce = true
        do {
            try Task.checkCancellation()
            // There is no cancellation API for apply. Await its callback before cleanup:
            // an unjoined removal task could otherwise delete a successor's configuration.
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
                NEHotspotConfigurationManager.shared.apply(configuration) { error in
                    if let error { done.resume(throwing: error) } else { done.resume() }
                }
            }
            try Task.checkCancellation()
            joining = false
        } catch {
            joining = false
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
            ownedSSID = nil
            throw error
        }
    }
    public func close() throws {
        guard !joining else { throw LocalWiFiTransportError.busy }
        if let ssid = ownedSSID {
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
            ownedSSID = nil
        }
    }
}
#endif
