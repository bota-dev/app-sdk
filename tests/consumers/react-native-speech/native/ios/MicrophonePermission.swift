import AVFoundation
import Foundation
import React
import UIKit

@objc(MicrophonePermission)
final class MicrophonePermission: NSObject, RCTInvalidating {
    private var retired = false
    private var revision = 0
    private var background: NSObjectProtocol?
    @objc static func requiresMainQueueSetup() -> Bool { true }
    @objc var methodQueue: DispatchQueue { .main }
    override init() {
        super.init()
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.revision += 1
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
    func invalidate() {
        retired = true; revision += 1
        if let background { NotificationCenter.default.removeObserver(background) }
    }
}
