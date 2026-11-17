import AVFoundation
import BotaAppSDK
import Foundation
import SwiftUI

private final class RecordingRoute: @unchecked Sendable {
    private let lock = NSLock(); private var confirmed = false
    func confirm(_ value: Bool) { lock.withLock { confirmed = value } }
    func headphones() -> Bool {
        #if os(iOS)
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return !outputs.isEmpty && outputs.allSatisfy { [.headphones,.bluetoothHFP,.bluetoothA2DP,.bluetoothLE].contains($0.portType) }
        #else
        return lock.withLock { confirmed }
        #endif
    }
}

@MainActor private final class RecordingModel: ObservableObject {
    @Published var notice = "Ready"
    @Published var captions: [String] = []
    @Published var finalText = ""
    @Published var active = false
    @Published var busy = false
    @Published var cleanupFailed = false
    private let route = RecordingRoute()
    private var lines: [(String, String)] = []
    private var owner: RecordingLabOwner?
    private var starting: Task<RecordingLabOwner, any Error>?
    private var closing: Task<Void, any Error>?
    private var polling: Task<Void, Never>?
    private var revision = UUID()
    func start(origin: URL, code: String, target: String, retention: String) async {
        guard !active, !busy, !cleanupFailed else { return }
        busy = true; defer { busy = false }
        let captured = UUID(); revision = captured; let previous = closing
        notice = "Requesting microphone permission…"
        guard await AVCaptureDevice.requestAccess(for: .audio), revision == captured else { notice = "Microphone permission was not granted."; return }
        active = true; captions = []; lines = []; finalText = ""; notice = "Connecting…"
        let route = route
        let task = Task { @MainActor in
            try await previous?.value
            return try await RecordingLabOwner.start(origin: origin, code: code, activityId: UUID().uuidString.lowercased(), target: target, retention: retention,
                headphones: { route.headphones() }, caption: { [weak self] data in
                    guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let caption = event["caption"] as? [String: Any],
                          let unit = caption["unitId"] as? String, let text = caption["text"] as? String, let revision = caption["revision"] as? Int else { return }
                    let language = caption["targetLanguage"] as? String ?? caption["sourceLanguage"] as? String ?? "source"
                    let key = unit + ":" + language, value = "[\(language); revision \(revision)] \(text)"
                    Task { @MainActor in guard let self, self.revision == captured else { return }
                        self.lines.removeAll { $0.0 == key }; self.lines.append((key, value)); self.lines = Array(self.lines.suffix(100)); self.captions = self.lines.map(\.1)
                    }
                }, status: { [weak self] status in Task { @MainActor in if self?.revision == captured { self?.notice = status } } })
        }
        starting = task
        do {
            let acquired = try await task.value
            guard revision == captured else { try await acquired.close(); return }
            owner = acquired; notice = "Microphone active. Live captions are provisional."
            polling = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                    guard let self, self.revision == captured, let owner = self.owner else { return }
                    self.finalText = owner.originalView.status + "\n" + owner.originalView.passages.joined(separator: "\n\n")
                }
            }
        } catch { if revision == captured { notice = "Could not start recording translation."; active = false } }
    }
    func changeTarget(_ language: String) async { await command { try await $0.changeTarget(language: language, requestId: UUID().uuidString.lowercased()); self.notice = "Language change acknowledged." } }
    func headphones() async { route.confirm(true); await command { self.notice = try await $0.qualifyHeadphones() ? "Headphone playback enabled." : "Audio paused. Captions and original capture continue." } }
    func finish() async { await command { try await $0.finish(); self.notice = "Capture stopped. Original upload and final text continue." } }
    private func command(_ work: @MainActor (RecordingLabOwner) async throws -> Void) async {
        guard !busy, let owner else { return }; busy = true; defer { busy = false }
        do { try await work(owner) } catch { notice = "Operation unavailable. Original audio remains independent." }
    }
    func close() async {
        revision = UUID(); active = false; route.confirm(false); starting?.cancel(); polling?.cancel()
        if let closing { do { try await closing.value } catch { cleanupFailed = true }; return }
        let pending = starting, current = owner
        let task = Task { @MainActor in
            let acquired: RecordingLabOwner?
            if let current { acquired = current } else { do { acquired = try await pending?.value } catch is RecordingCleanupFailure { throw RecordingCleanupFailure() } catch { acquired = nil } }
            try await acquired?.close(); owner = nil; starting = nil; closing = nil
        }
        closing = task
        do { try await task.value; notice = "Closed." } catch { cleanupFailed = true; notice = "Cleanup failed. Reopen the App." }
    }
}

public struct RecordingView: View {
    @StateObject private var model = RecordingModel()
    @State private var origin = "http://127.0.0.1:4173"
    @State private var code = ""
    @State private var target = "zh"
    @State private var retention = "original_audio_and_text"
    @Environment(\.scenePhase) private var scenePhase
    public init() {}
    public var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 16) {
            Text("Recording translation").font(.largeTitle)
            Text("One microphone. One target language. Original audio is optional.")
            TextField("Local host", text: $origin).textFieldStyle(.roundedBorder).disabled(model.active || model.busy)
            SecureField("Operator access code", text: $code).textFieldStyle(.roundedBorder).disabled(model.active || model.busy)
            Picker("Keep", selection: $retention) { Text("Audio and text").tag("original_audio_and_text"); Text("Text only").tag("text_only"); Text("Live only").tag("live_only") }.disabled(model.active || model.busy)
            Picker("Translate to", selection: $target) { ForEach(["zh","en","ja","ko","es","fr","de"], id: \.self) { Text($0).tag($0) } }
            HStack {
                Button("Start microphone") { guard let url = URL(string: origin) else { return }; let access = code; code = ""; Task { await model.start(origin: url, code: access, target: target, retention: retention) } }.disabled(model.active || model.busy || model.cleanupFailed)
                Button("Close") { code = ""; Task { await model.close() } }.disabled(!model.active && !model.busy)
            }
            HStack {
                Button("Apply language") { Task { await model.changeTarget(target) } }
                Button("Confirm headphones") { Task { await model.headphones() } }
                Button("Stop capture") { Task { await model.finish() } }
            }.disabled(!model.active || model.busy)
            Text("Speaker playback is unavailable. Confirm headphones after any route change.").font(.caption)
            Text(model.notice).accessibilityAddTraits(.updatesFrequently)
            Text("Live captions (provisional)").font(.title2); Text(model.captions.joined(separator: "\n")).textSelection(.enabled)
            Text("Final original and translation").font(.title2); Text(model.finalText).textSelection(.enabled)
        }.padding(24) }
        .onChange(of: scenePhase) { phase in if phase == .background { code = ""; Task { await model.close() } } }
        .onDisappear { code = ""; Task { await model.close() } }
    }
}
