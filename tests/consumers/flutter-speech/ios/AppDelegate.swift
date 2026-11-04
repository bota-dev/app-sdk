import AVFoundation
import Flutter
import UIKit
import bota_app_sdk
import BotaAppSDK

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
    private(set) var speechBridge: FlutterCompanionBridge?
    func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
        GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
        guard let plugin = engineBridge.pluginRegistry.valuePublished(byPlugin: "BotaFlutterSdkPlugin") as? BotaFlutterSdkPlugin,
              let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "SpeechCompanionHost") else { return }
        speechBridge = FlutterCompanionBridge(registrar: registrar, plugin: plugin)
    }
}

/// The App channel carries only preparation metadata and permission results.
@MainActor
final class FlutterCompanionBridge: NSObject, FlutterPlugin {
    private static let owner = FlutterLabOwner(originalFactory: { try await LabOriginal.create(host: $0, joined: $1, update: $2) })
    private let id = UUID().uuidString
    private let channel: FlutterMethodChannel
    private var dialog: UIAlertController?
    private var preparing: FlutterResult?
    private var permission: (UUID, FlutterResult)?
    private var prepareId: UUID?
    init(registrar: FlutterPluginRegistrar, plugin: BotaFlutterSdkPlugin) {
        channel = FlutterMethodChannel(name: "dev.bota.speech.companion/host", binaryMessenger: registrar.messenger())
        super.init()
        Self.owner.bindEngine(id)
        let capturedId = id
        do { try plugin.setSpeechConnectionFactory { session, observer in
            OriginalFlutterConnection(owner: Self.owner, id: capturedId,
                session: try Self.owner.create(capturedId, sessionId: session, observer: observer))
        } }
        catch { _ = Self.owner.leave(id); return }
        registrar.publish(self)
        channel.setMethodCallHandler { [weak self] call, reply in
            guard let self else { reply(FlutterError(code: "closed", message: "The session was closed", details: nil)); return }
            switch call.method {
            case "prepare": self.prepare(reply)
            case "microphonePermission": self.microphone(reply)
            case "leave":
                let closing = self.leave()
                Task { @MainActor in
                    do { try await closing.value; reply(nil) }
                    catch { reply(FlutterError(code: "cleanupFailed", message: "Audio cleanup failed", details: nil)) }
                }
            default: reply(FlutterMethodNotImplemented)
            }
        }
    }
    static func register(with registrar: FlutterPluginRegistrar) {}
    func detachFromEngine(for registrar: FlutterPluginRegistrar) { _ = leave(); channel.setMethodCallHandler(nil) }
    @discardableResult
    func leave() -> Task<Void, any Error> {
        dialog?.textFields?.forEach { $0.text = "" }; dialog?.dismiss(animated: false); dialog = nil
        let reply = preparing; preparing = nil; prepareId = nil
        reply?(FlutterError(code: "closed", message: "The session was closed", details: nil))
        let prompt = permission; permission = nil; prompt?.1(false)
        return Self.owner.leave(id)
    }
    private func prepare(_ reply: @escaping FlutterResult) {
        guard preparing == nil, !Self.owner.isCurrent(id), let presenter = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else {
            reply(FlutterError(code: "busy", message: "A session is already active", details: nil)); return
        }
        preparing = reply; let request = UUID(); prepareId = request
        let form = UIAlertController(title: "Join a conversation", message: "Choose your assigned speaker role.", preferredStyle: .alert)
        form.addTextField { $0.placeholder = "Session host"; $0.text = "http://127.0.0.1:4173"; $0.keyboardType = .URL; $0.autocapitalizationType = .none }
        form.addTextField { $0.placeholder = "Access code"; $0.isSecureTextEntry = true; $0.autocapitalizationType = .none; $0.autocorrectionType = .no }
        for role in ["a", "b"] {
            form.addAction(UIAlertAction(title: "Join as Speaker " + role.uppercased(), style: .default) { [weak self, weak form] _ in
                guard let self, let fields = form?.textFields else { return }
                let origin = fields[0].text ?? "", code = fields[1].text ?? ""; fields[1].text = ""; self.dialog = nil
                Task { @MainActor in
                    do {
                        guard let url = URL(string: origin) else { throw LabFailure.invalidConfiguration }
                        let display = try await Self.owner.prepare(self.id, origin: url, role: role, code: code)
                        if self.prepareId == request { self.preparing = nil; self.prepareId = nil; reply(display) }
                    } catch {
                        if self.prepareId == request {
                            self.preparing = nil; self.prepareId = nil
                            reply(FlutterError(code: "unavailable", message: "Could not join the session", details: nil))
                        }
                    }
                }
            })
        }
        form.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in _ = self?.leave() })
        dialog = form; presenter.present(form, animated: true)
    }
    private func microphone(_ reply: @escaping FlutterResult) {
        guard let captured = Self.owner.permissionOwner(id), permission == nil else { reply(false); return }
        permission = (captured, reply)
        Task { @MainActor in
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard let current = permission, current.0 == captured else { return }
            permission = nil
            reply(granted && Self.owner.acceptsPermission(id, owner: captured))
        }
    }
}

@MainActor private final class OriginalFlutterConnection: BotaFlutterSpeechConnection {
    private let owner: FlutterLabOwner, id: String, session: SpeechSession
    init(owner: FlutterLabOwner, id: String, session: SpeechSession) { self.owner = owner; self.id = id; self.session = session }
    var state: SpeechState { session.state }
    func ready() async throws { try await session.ready() }
    func setInput(_ enabled: Bool) async throws {
        if !enabled { try await owner.finishOriginal(id, session) }
        try await session.setInput(enabled)
        if enabled { try await owner.startOriginal(id, session) }
    }
    func setListening(_ enabled: Bool) async throws { try await session.setListening(enabled) }
    func changeSubscription(_ selection: SpeechSelection) async throws { try await session.changeSubscription(selection) }
    func resumeAudio() async throws { try await session.resumeAudio() }
    func recoverCaptions() async throws -> SpeechCaptionRecovery { try await session.recoverCaptions() }
    func finishInput() async throws -> SpeechSourceFinish {
        try await owner.finishOriginal(id, session); return try await session.finishInput()
    }
    func finishOriginal() async throws { try await owner.finishOriginal(id, session) }
    func originalView() async throws -> BotaFlutterSpeechOriginalView {
        let (view, rtc) = try owner.originalView(id, session)
        return BotaFlutterSpeechOriginalView(enabled: view.enabled, capturing: view.capturing, finished: view.finished,
            rtcAvailable: rtc, status: view.status, passages: view.passages)
    }
    func close() async throws { try await owner.close(id, session).value }
}
