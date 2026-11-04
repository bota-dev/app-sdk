import AVFoundation
import Foundation
import React
import UIKit

@objc(SpeechLabHost)
final class SpeechLabHost: NSObject, RCTInvalidating {
    private let transport = NativeLabTransport()
    private var requests: [String: Task<Void, Never>] = [:]
    private var revision = 0
    private var retired = false
    private var background: NSObjectProtocol?
    private let mediaLock = NSLock()
    private var mediaOwner: ReactNativeLabOwner?
    private var closing: Task<Void, any Error>?
    @objc static func requiresMainQueueSetup() -> Bool { true }
    @objc var methodQueue: DispatchQueue { .main }
    override init() {
        super.init()
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in _ = self?.closeOwner() }
            }
    }
    @objc(request:origin:role:code:action:body:resolver:rejecter:)
    func request(_ id: String, origin: String, role: String, code: String, action: String, body: String,
                 resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard !retired, UIApplication.shared.applicationState == .active, requests.count < 8, requests[id] == nil,
              id.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
              let url = URL(string: origin), url.scheme == "http", url.host == "127.0.0.1", url.path.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              (1...65535).contains(url.port ?? 80), ["a", "b"].contains(role),
              code.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil,
              ["join", "grant", "subscription", "captions", "finish"].contains(action), body.utf8.count <= 8192 else {
            rejecter("unavailable", "Speech host unavailable", nil); return
        }
        let ownRevision = revision
        var request = URLRequest(url: url.appendingPathComponent("speech-host/" + action), cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"; request.httpBody = Data(body.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(role, forHTTPHeaderField: "X-Speech-Role")
        request.setValue(code, forHTTPHeaderField: "X-Speech-Code")
        requests[id] = Task { @MainActor [self] in
            defer { requests[id] = nil }
            do {
                let response: LabResponse
                if action == "join" {
                    try await closing?.value
                    guard mediaLock.withLock({ mediaOwner == nil }) else { throw LabFailure.conflict }
                    let owner = try ReactNativeLabOwner(origin: url, role: role, code: code)
                    mediaLock.withLock { mediaOwner = owner }
                    do { response = LabResponse(status: 200, body: try await owner.prepare()) }
                    catch {
                        try await owner.close()
                        mediaLock.withLock { if mediaOwner === owner { mediaOwner = nil } }; throw error
                    }
                } else if action == "grant" {
                    guard let owner = mediaLock.withLock({ mediaOwner }) else { throw LabFailure.closed }
                    response = LabResponse(status: 200, body: try await owner.renew())
                } else { response = try await transport.send(request) }
                try Task.checkCancellation()
                guard !retired, revision == ownRevision, let text = String(data: response.body, encoding: .utf8) else {
                    throw LabFailure.unavailable
                }
                resolver(["status": response.status, "body": text])
            } catch { rejecter("unavailable", "Speech host unavailable", nil) }
        }
    }
    @objc(cancel:resolver:rejecter:)
    func cancel(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        let request = requests[id]; request?.cancel()
        Task { @MainActor in await request?.value; resolver(nil) }
    }
    private func perform(_ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock,
                         _ action: @escaping @MainActor (ReactNativeLabOwner) async throws -> Any?) {
        Task { @MainActor in
            do {
                guard !retired, UIApplication.shared.applicationState == .active,
                      let owner = mediaLock.withLock({ mediaOwner }) else { throw LabFailure.closed }
                resolve(try await action(owner))
            } catch { reject("unavailable", "Speech operation unavailable", nil) }
        }
    }
    @objc(createMedia:resolver:rejecter:)
    func createMedia(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try $0.createMedia(id) }
    }
    @objc(mediaCommand:action:body:resolver:rejecter:)
    func mediaCommand(_ id: String, action: String, body: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try await $0.command(id, action: action, body: body) }
    }
    @objc(mediaFence:action:)
    func mediaFence(_ id: String, action: String) -> NSNumber {
        NSNumber(value: mediaLock.withLock { mediaOwner }?.fence(id, action) ?? true)
    }
    @objc(mediaEvents:resolver:rejecter:)
    func mediaEvents(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try $0.events(id) }
    }
    @objc(closeMedia:resolver:rejecter:)
    func closeMedia(_ id: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in
            do { try await mediaLock.withLock { mediaOwner }?.closeMedia(id); resolver(nil) }
            catch { rejecter("cleanup_failed", "Speech cleanup failed", nil) }
        }
    }
    @objc(startOriginal:rejecter:)
    func startOriginal(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try await $0.startOriginal(); return nil }
    }
    @objc(finishOriginal:rejecter:)
    func finishOriginal(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try await $0.finishOriginal(); return nil }
    }
    @objc(originalView:rejecter:)
    func originalView(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        perform(resolver, rejecter) { try $0.originalView() }
    }
    @MainActor private func closeOwner() -> Task<Void, any Error> {
        if let closing { return closing }
        let owner = mediaLock.withLock { mediaOwner }, pending = Array(requests.values); retireRequests()
        let task = Task { @MainActor in
            do {
                try await owner?.close()
                for request in pending { await request.value }
                mediaLock.withLock { if mediaOwner === owner { mediaOwner = nil } }
                closing = nil
            } catch { throw error }
        }
        closing = task; return task
    }
    @objc(closeSession:rejecter:)
    func closeSession(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in
            do { try await closeOwner().value; resolver(nil) }
            catch { rejecter("cleanup_failed", "Speech cleanup failed", nil) }
        }
    }
    @objc(microphonePermission:rejecter:)
    func microphonePermission(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard !retired, UIApplication.shared.applicationState == .active else { resolver(false); return }
        let ownRevision = revision
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { resolver(false); return }
                resolver(granted && !self.retired && self.revision == ownRevision)
            }
        }
    }
    private func retireRequests() { revision += 1; for task in requests.values { task.cancel() } }
    func invalidate() {
        Task { @MainActor [self] in retired = true; _ = await closeOwner().result; transport.close() }
    }
    deinit { if let background { NotificationCenter.default.removeObserver(background) }; transport.close() }
}
