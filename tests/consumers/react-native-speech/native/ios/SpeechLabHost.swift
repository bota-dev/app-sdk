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
    @objc static func requiresMainQueueSetup() -> Bool { true }
    @objc var methodQueue: DispatchQueue { .main }
    override init() {
        super.init()
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in self?.retireRequests() }
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
                let response = try await transport.send(request)
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
        DispatchQueue.main.async { [self] in retired = true; retireRequests(); transport.close() }
    }
    deinit { if let background { NotificationCenter.default.removeObserver(background) }; transport.close() }
}
