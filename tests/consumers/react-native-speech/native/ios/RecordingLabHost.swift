import AVFoundation
import BotaAppSDK
import Foundation
import React
import UIKit

@objc(RecordingLabHost)
final class RecordingLabHost: NSObject, RCTInvalidating {
    private struct Selection { let id: String, origin: URL, code: String, target: String, retention: String }
    private var selection: Selection?
    private var active: RecordingLabOwner?
    private var retired = false
    private var background: NSObjectProtocol?
    @MainActor private lazy var bridge = RecordingLabBridge { [weak self] id, caption, status in
        guard let self, self.foreground, let value = self.selection, value.id == id else { throw LabFailure.closed }
        self.selection = nil
        let owner = try await RecordingLabOwner.start(origin: value.origin, code: value.code, activityId: id, target: value.target, retention: value.retention,
            headphones: { Self.headphoneRoute() }, caption: caption, status: status)
        self.active = owner
        guard self.foreground else { try await owner.close(); throw LabFailure.closed }
        return owner
    }
    @objc static func requiresMainQueueSetup() -> Bool { true }
    @objc var methodQueue: DispatchQueue { .main }
    @MainActor private var foreground: Bool { !retired && UIApplication.shared.applicationState == .active }
    private static func headphoneRoute() -> Bool {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return !outputs.isEmpty && outputs.allSatisfy { [.headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE].contains($0.portType) }
    }
    override init() {
        super.init()
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self else { return }; self.selection = nil; try? await self.bridge.close(); self.active = nil }
        }
    }
    @MainActor private func run(_ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, work: @escaping @MainActor () async throws -> Any?) {
        Task { @MainActor in do { guard foreground else { throw LabFailure.closed }; resolve(try await work()) } catch { reject("unavailable", "Recording operation unavailable", nil) } }
    }
    @objc(prepare:code:target:retention:resolver:rejecter:)
    func prepare(_ origin: String, code: String, target: String, retention: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { [self] in
            guard selection == nil, active == nil, let url = URL(string: origin) else { throw LabFailure.conflict }
            let id = UUID().uuidString.lowercased(); selection = Selection(id: id, origin: url, code: code, target: target, retention: retention); return id
        } }
    }
    @objc(start:activityId:resolver:rejecter:)
    func start(_ id: String, activityId: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { try await self.bridge.start(id, activityId: activityId); return nil } }
    }
    @objc(changeTarget:language:requestId:resolver:rejecter:)
    func changeTarget(_ id: String, language: String, requestId: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { try await self.bridge.call(id) { try await $0.changeTarget(language: language, requestId: requestId) }; return nil } }
    }
    @objc(qualifyHeadphones:resolver:rejecter:)
    func qualifyHeadphones(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { try await self.bridge.call(id) { try await $0.qualifyHeadphones() } } }
    }
    @objc(finish:resolver:rejecter:)
    func finish(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { try await self.bridge.call(id) { try await $0.finish() }; return nil } }
    }
    @objc(events:resolver:rejecter:)
    func events(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { try await self.bridge.events(id) } }
    }
    @objc(original:rejecter:)
    func original(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in run(resolver, rejecter) { [self] in let view = active?.originalView ?? OriginalView()
            return String(data: try JSONSerialization.data(withJSONObject: ["status": view.status, "passages": view.passages]), encoding: .utf8) } }
    }
    @objc(close:resolver:rejecter:)
    func close(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in do { try await bridge.close(id); active = nil; selection = nil; resolver(nil) } catch { rejecter("cleanup_failed", "Recording cleanup failed", nil) } }
    }
    func invalidate() {
        if let background { NotificationCenter.default.removeObserver(background) }
        Task { @MainActor in retired = true; selection = nil; try? await bridge.close(); active = nil }
    }
    @objc(leave:rejecter:)
    func leave(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in selection = nil; do { try await bridge.close(); active = nil; resolver(nil) } catch { rejecter("cleanup_failed", "Recording cleanup failed", nil) } }
    }
}
