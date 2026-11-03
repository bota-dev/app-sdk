import BotaAppSDK
import SwiftUI

@MainActor
public struct CompanionView: View {
    @StateObject private var model = CompanionModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var role = "a"
    @State private var code = ""
    @State private var host = "http://127.0.0.1:4173"
    private let green = Color(red: 0.13, green: 0.35, blue: 0.27)
    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("BOTA / CONVERSATION").font(.caption.weight(.semibold)).foregroundStyle(green)
                    Text("Speak. Listen. Stay in the conversation.").font(.system(size: 28, weight: .semibold))
                    Text("Two speakers, separate languages. Use headphones for your first session.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if !model.connected {
                    GroupBox("Join a conversation") {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("Your role", selection: $role) { Text("Speaker A").tag("a"); Text("Speaker B").tag("b") }
                                .pickerStyle(.segmented)
                            TextField("Session host", text: $host).textFieldStyle(.roundedBorder)
                            SecureField("Access code", text: $code).textFieldStyle(.roundedBorder)
                            Button(model.joining ? "Joining…" : "Join session") {
                                guard let origin = URL(string: host) else { return }
                                let selectedCode = code; code = ""
                                Task { await model.join(origin: origin, role: role, code: selectedCode) }
                            }.buttonStyle(.borderedProminent)
                                .disabled(model.joining || model.closing || model.cleanupFailed || code.isEmpty || URL(string: host) == nil)
                        }.padding(.top, 8)
                    }.disabled(model.joining || model.closing || model.cleanupFailed)
                }
                HStack(alignment: .top) {
                    Circle().fill(model.connected ? green : Color.gray).frame(width: 8, height: 8).padding(.top, 5)
                    Text(model.notice).font(.subheadline).accessibilityAddTraits(.updatesFrequently)
                    Spacer(minLength: 0)
                    if model.connected || model.joining {
                        Button("Leave") { code = ""; Task { await model.leave() } }.buttonStyle(.bordered)
                    }
                }
                if model.connected {
                    GroupBox("Your audio") {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle("Microphone", isOn: Binding(get: { model.inputEnabled }, set: { enabled in Task { await model.setInput(enabled) } }))
                                .disabled(model.busy.contains("input") || model.busy.contains("finish"))
                            Toggle("Listening", isOn: Binding(get: { model.listeningEnabled }, set: { enabled in Task { await model.setListening(enabled) } }))
                                .disabled(model.busy.contains("listen"))
                            HStack {
                                Button(model.busy.contains("finish") ? "Finishing input…" : "Finish input") { Task { await model.finish() } }
                                    .disabled(model.busy.contains("finish") || model.busy.contains("input"))
                                Button("Resume audio") { Task { await model.resumeAudio() } }.disabled(model.busy.contains("resume"))
                            }.buttonStyle(.bordered)
                            Text(model.listeningEnabled && model.state?.canPlay != true ? "Listening will start when your preference is ready." :
                                "Finishing input keeps listening available.").font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 8)
                    }
                    GroupBox("What you hear") {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("Receiving language", selection: Binding(get: { model.language }, set: { value in
                                Task { await model.select(language: value, mode: model.mode) }
                            })) {
                                ForEach(model.languages, id: \.self) { language in
                                    Text(Locale.current.localizedString(forLanguageCode: language) ?? language).tag(language)
                                }
                            }
                            Picker("Listening mode", selection: Binding(get: { model.mode }, set: { value in
                                Task { await model.select(language: model.language, mode: value) }
                            })) {
                                Text("Translated").tag(SpeechListeningMode.translated)
                                Text("Original").tag(SpeechListeningMode.original)
                                Text("Captions only").tag(SpeechListeningMode.captionsOnly)
                            }
                        }.padding(.top, 8)
                    }.disabled(model.busy.contains("selection"))
                }
                HStack {
                    Text("Conversation").font(.title2.weight(.semibold))
                    Spacer()
                    if model.connected {
                        Button("Recover captions") { Task { await model.recoverCaptions() } }.disabled(model.busy.contains("recovery"))
                    }
                }
                if model.pairs.isEmpty {
                    Text("Original speech and its translation will appear together here.")
                        .foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 110, alignment: .center)
                } else {
                    ForEach(model.pairs) { pair in
                        VStack(alignment: .leading, spacing: 9) {
                            Text(pair.speaker).font(.caption.weight(.semibold)).foregroundStyle(green)
                            if !pair.original.isEmpty { Text(pair.original).font(.body).textSelection(.enabled) }
                            if !pair.translation.isEmpty { Text(pair.translation).font(.title3).textSelection(.enabled) }
                            if !pair.originalFinal { Text("Live caption").font(.caption).foregroundStyle(.secondary) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }.padding(24).frame(maxWidth: 840)
                .frame(maxWidth: .infinity, alignment: .top)
        }.background(Color(red: 0.95, green: 0.96, blue: 0.94)).tint(green).preferredColorScheme(.light)
            .onChange(of: scenePhase) { phase in
                if phase == .background { code = ""; Task { await model.leave() } }
            }
            .onDisappear { code = ""; Task { await model.leave() } }
    }
}
