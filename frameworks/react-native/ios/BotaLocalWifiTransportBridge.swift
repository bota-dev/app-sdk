#if !BOTA_LOCAL_WIFI_STANDALONE
import BotaAppSDK
#endif
import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor protocol LocalWiFiAssociation: AnyObject {
    func join(ssid: String, password: String) async throws
    func close() throws
}
#if os(iOS)
extension LocalWiFiHotspot: LocalWiFiAssociation {}
#endif

@objc(BotaLocalWifiTransportBridge)
public final class BotaLocalWifiTransportBridge: NSObject, @unchecked Sendable {
    @MainActor private final class Entry {
        let id = UUID().uuidString
        let association: any LocalWiFiAssociation
        var retiring = false
        var joining: Task<Void, any Error>?
        var didJoin = false
        var opened = false
        var readerRetiring = false
        var deadline = DispatchTime.now()
        var http: LocalWiFiHTTP?
        var active: Task<String?, any Error>?
        var closing: Task<Void, any Error>?
        init(_ association: any LocalWiFiAssociation) { self.association = association }
    }
    @MainActor private var current: Entry?
    @MainActor private var destroyed = false
    @MainActor private var observer: (any NSObjectProtocol)?
    private let isForeground: @MainActor @Sendable () -> Bool
    private let makeAssociation: @MainActor @Sendable () throws -> any LocalWiFiAssociation
    private typealias Completion = @Sendable (String?, NSError?) -> Void

    public override init() {
        isForeground = {
            #if canImport(UIKit)
            return UIApplication.shared.applicationState == .active
            #else
            return false
            #endif
        }
        makeAssociation = {
            #if os(iOS)
            return LocalWiFiHotspot()
            #else
            throw LocalWiFiTransportError.unavailable
            #endif
        }
        super.init()
    }
    // Injectable OS association for lifecycle tests; production uses the initializer above.
    init(isForeground: @escaping @MainActor @Sendable () -> Bool,
         makeAssociation: @escaping @MainActor @Sendable () throws -> any LocalWiFiAssociation) {
        self.isForeground = isForeground; self.makeAssociation = makeAssociation
        super.init()
    }
    @MainActor private func foreground() throws {
        guard !destroyed, isForeground() else { throw LocalWiFiTransportError.unavailable }
        #if canImport(UIKit)
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.retireCurrent() }
            }
        }
        #endif
    }
    @MainActor private func entry(_ id: String) throws -> Entry {
        guard let current, current.id == id else { throw LocalWiFiTransportError.closed }
        return current
    }
    @MainActor private func input(_ json: String) throws -> [String: Any] {
        guard json.utf8.count <= 4096,
              let value = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            throw LocalWiFiTransportError.invalidInput
        }
        return value
    }
    private func dispatch(_ completion: @escaping Completion,
        _ action: @escaping @MainActor @Sendable () async throws -> String?) {
        Task { @MainActor in
            do { completion(try await action(), nil) }
            catch { completion(nil, NSError(domain: "BotaLocalWiFi", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Local WiFi operation failed"])) }
        }
    }
    @objc(preflight:)
    public func preflight(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            try self.foreground()
            guard self.current == nil else { throw LocalWiFiTransportError.busy }
            return nil
        }
    }
    @objc(createLease:)
    public func createLease(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            try self.foreground()
            guard self.current == nil else { throw LocalWiFiTransportError.busy }
            let value = Entry(try self.makeAssociation()); self.current = value; return value.id
        }
    }
    @objc(join:inputJSON:completion:)
    public func join(_ id: String, inputJSON: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            try self.foreground()
            let owner = try self.entry(id), data = try self.input(inputJSON)
            guard !owner.retiring, owner.joining == nil, !owner.didJoin,
                  let ssid = data["ssid"] as? String, let password = data["password"] as? String,
                  let remaining = data["remainingMs"] as? Double,
                  remaining.isFinite, remaining > 0, remaining <= 4_294_967_295_000 else {
                throw LocalWiFiTransportError.invalidInput
            }
            owner.deadline = .now() + .nanoseconds(Int(remaining * 1_000_000))
            let task = Task { @MainActor in try await owner.association.join(ssid: ssid, password: password) }
            owner.joining = task
            defer { owner.joining = nil }
            try await task.value
            try self.foreground()
            guard !owner.retiring, DispatchTime.now() < owner.deadline else { throw LocalWiFiTransportError.closed }
            owner.didJoin = true
            return nil
        }
    }
    @objc(open:inputJSON:completion:)
    public func open(_ id: String, inputJSON: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            try self.foreground()
            let owner = try self.entry(id), data = try self.input(inputJSON)
            guard !owner.retiring, !owner.readerRetiring, owner.didJoin, !owner.opened, owner.active == nil,
                  let ipv4 = data["ipv4"] as? String, let port = data["port"] as? Int, let portValue = UInt16(exactly: port),
                  let hex = data["spkiHex"] as? String, hex.count == 64,
                  hex.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  let bearer = data["bearer"] as? String, let path = data["path"] as? String,
                  let offset = data["offset"] as? String, let etag = data["etag"] as? String else {
                throw LocalWiFiTransportError.invalidInput
            }
            let chars = Array(hex)
            let pin = Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...($0 + 1)]), radix: 16)! })
            let http = try LocalWiFiHTTP(ipv4: ipv4, port: portValue, spkiSHA256: pin, deadline: owner.deadline)
            owner.http = http; owner.opened = true
            let task = Task<String?, any Error> {
                let response = try await http.open(path: path, offset: offset, etag: etag, bearer: bearer)
                let bytes = try JSONSerialization.data(withJSONObject: ["status": response.status, "headers": response.headers])
                guard bytes.count <= 32_768 else { throw LocalWiFiTransportError.invalidResponse }
                return String(decoding: bytes, as: UTF8.self)
            }
            owner.active = task
            defer { owner.active = nil }
            let value = try await task.value
            guard !owner.retiring, !owner.readerRetiring else { throw LocalWiFiTransportError.closed }
            return value
        }
    }
    @objc(read:maximumLength:completion:)
    public func read(_ id: String, maximumLength: Double, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            try self.foreground()
            let owner = try self.entry(id)
            guard !owner.retiring, !owner.readerRetiring, owner.active == nil, let http = owner.http,
                  maximumLength.isFinite, (1...65_536).contains(maximumLength), maximumLength.rounded(.down) == maximumLength else {
                throw LocalWiFiTransportError.invalidInput
            }
            let task = Task<String?, any Error> { try await http.read(maximumLength: Int(maximumLength))?.base64EncodedString() }
            owner.active = task
            defer { owner.active = nil }
            let value = try await task.value
            guard !owner.retiring, !owner.readerRetiring else { throw LocalWiFiTransportError.closed }
            return value
        }
    }
    @MainActor private func closeReader(_ owner: Entry) async {
        owner.readerRetiring = true
        let active = owner.active
        active?.cancel()
        await owner.http?.close()
        _ = await active?.result
        owner.http = nil
    }
    @objc(closeReader:completion:)
    public func closeReader(_ id: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            if let owner = self.current, owner.id == id { await self.closeReader(owner) }
            return nil
        }
    }
    @MainActor private func close(_ owner: Entry) async throws {
        owner.retiring = true
        if let closing = owner.closing { try await closing.value; return }
        let closing = Task { @MainActor in
            owner.joining?.cancel()
            await self.closeReader(owner)
            _ = await owner.joining?.result
            try owner.association.close()
        }
        owner.closing = closing
        do {
            try await closing.value
            if self.current === owner { self.current = nil }
        } catch { owner.closing = nil; throw error }
    }
    @objc(closeLease:completion:)
    public func closeLease(_ id: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        dispatch(completion) {
            if let owner = self.current, owner.id == id { try await self.close(owner) }
            return nil
        }
    }
    @MainActor private func retireCurrent() {
        guard let owner = current else { return }
        owner.retiring = true
        Task { @MainActor in
            do { try await close(owner) } catch { /* Keep the handle for explicit cleanup retry. */ }
        }
    }
    @objc public func invalidate() {
        Task { @MainActor in
            destroyed = true
            if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
            retireCurrent()
        }
    }
}
