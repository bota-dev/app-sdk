import AVFoundation
import BotaAppSDK
import Flutter
import UIKit
import bota_app_sdk

@MainActor
final class RecordingFlutterHost {
    private struct Selection { let id: String, origin: URL, code: String, target: String, retention: String }
    private let channel: FlutterMethodChannel
    private var selection: Selection?
    private var active: RecordingLabOwner?
    private var creating: Task<RecordingLabOwner, any Error>?
    private var closing: Task<Void, any Error>?
    private var dialog: UIAlertController?
    private var preparing: FlutterResult?
    private var revision = UUID()
    init(registrar: FlutterPluginRegistrar, plugin: BotaFlutterSdkPlugin) throws {
        channel = FlutterMethodChannel(name: "dev.bota.recording.companion/host", binaryMessenger: registrar.messenger())
        try plugin.setRecordingSpeechFactory { [weak self] id, caption, status in
            guard let self, UIApplication.shared.applicationState == .active, let selected = self.selection, selected.id == id else { throw LabFailure.closed }
            self.selection = nil; let revision = self.revision
            let task = Task { @MainActor in try await RecordingLabOwner.start(origin: selected.origin, code: selected.code, activityId: id,
                target: selected.target, retention: selected.retention, headphones: { Self.headphoneRoute() }, caption: caption, status: status) }
            self.creating = task
            let owner = try await task.value; self.active = owner
            guard self.revision == revision, UIApplication.shared.applicationState == .active else { try await owner.close(); throw LabFailure.closed }
            return owner
        }
        channel.setMethodCallHandler { [weak self] call, reply in
            guard let self else { reply(FlutterError(code: "closed", message: "Recording closed", details: nil)); return }
            switch call.method {
            case "prepare": self.prepare(reply)
            case "original": let view = self.active?.originalView ?? OriginalView(); reply(["status": view.status, "passages": view.passages])
            case "leave": Task { @MainActor in do { try await self.leave().value; reply(nil) } catch { reply(FlutterError(code: "cleanupFailed", message: "Recording cleanup failed", details: nil)) } }
            default: reply(FlutterMethodNotImplemented)
            }
        }
    }
    nonisolated private static func headphoneRoute() -> Bool {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return !outputs.isEmpty && outputs.allSatisfy { [.headphones,.bluetoothHFP,.bluetoothA2DP,.bluetoothLE].contains($0.portType) }
    }
    private func prepare(_ reply: @escaping FlutterResult) {
        guard preparing == nil, selection == nil, active == nil, creating == nil, UIApplication.shared.applicationState == .active else {
            reply(FlutterError(code: "busy", message: "Recording is busy", details: nil)); return
        }
        preparing = reply; let owned = revision
        Task { @MainActor in
            do { try await closing?.value } catch { preparing = nil; reply(FlutterError(code: "cleanupFailed", message: "Recording cleanup failed", details: nil)); return }
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard revision == owned, preparing != nil else { return }
            guard granted, UIApplication.shared.applicationState == .active,
                  let presenter = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else {
                preparing = nil; reply(FlutterError(code: "permissionDenied", message: "Microphone permission denied", details: nil)); return
            }
            let form = UIAlertController(title: "Recording translation", message: "Use headphones for translation audio.", preferredStyle: .alert)
            form.addTextField { $0.placeholder = "Local host"; $0.text = "http://127.0.0.1:4173"; $0.keyboardType = .URL; $0.autocapitalizationType = .none }
            form.addTextField { $0.placeholder = "Operator access code"; $0.isSecureTextEntry = true; $0.autocapitalizationType = .none; $0.autocorrectionType = .no }
            form.addTextField { $0.placeholder = "Target: zh, en, ja, ko, es, fr, de"; $0.text = "zh"; $0.autocapitalizationType = .none }
            for (retention, title) in [("original_audio_and_text","Keep audio and text"),("text_only","Keep text only"),("live_only","Live only")] {
                form.addAction(UIAlertAction(title: title, style: .default) { [weak self, weak form] _ in
                    guard let self, self.revision == owned else { return }
                    guard let fields = form?.textFields, let origin = URL(string: fields[0].text ?? "") else {
                        self.dialog = nil; self.preparing = nil; reply(FlutterError(code: "invalidInput", message: "Invalid local host", details: nil)); return
                    }
                    let id = UUID().uuidString.lowercased(), target = fields[2].text ?? "zh"
                    self.selection = Selection(id: id, origin: origin, code: fields[1].text ?? "", target: target, retention: retention)
                    fields[1].text = ""; self.dialog = nil; self.preparing = nil; reply(["activityId": id, "target": target])
                })
            }
            form.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in _ = self?.leave() })
            dialog = form; presenter.present(form, animated: true)
        }
    }
    @discardableResult func leave() -> Task<Void, any Error> {
        revision = UUID(); selection = nil; dialog?.textFields?.forEach { $0.text = "" }; dialog?.dismiss(animated: false); dialog = nil
        let pendingReply = preparing; preparing = nil; pendingReply?(FlutterError(code: "closed", message: "Recording closed", details: nil))
        if let closing { return closing }
        creating?.cancel(); let pending = creating, owner = active
        let task = Task { @MainActor in
            let acquired: RecordingLabOwner?
            if let owner { acquired = owner } else { do { acquired = try await pending?.value } catch is RecordingCleanupFailure { throw RecordingCleanupFailure() } catch { acquired = nil } }
            try await acquired?.close(); active = nil; creating = nil; closing = nil
        }
        closing = task; return task
    }
    func detach() { _ = leave(); channel.setMethodCallHandler(nil) }
}
