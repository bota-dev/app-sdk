import Foundation

#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#endif

@MainActor
public final class BotaFlutterSdkPlugin: NSObject, @preconcurrency FlutterPlugin {
  private let messenger: FlutterBinaryMessenger
  private let adapter: BotaAppleAdapter
  private let speech: BotaAppleSpeechAdapter
  public private(set) var speechShutdown: Task<Void, Error>?

  private init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    let speechApi = BotaSpeechFlutterApi(binaryMessenger: messenger)
    speech = BotaAppleSpeechAdapter(emit: { event in
      try await SpeechFlutterDelivery.send(event) { event, reply in
        speechApi.onEvent(event: event, completion: reply)
      }
    }, terminal: { event in speechApi.onEvent(event: event) { _ in } })
    let root =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first ?? FileManager.default.temporaryDirectory
    adapter = BotaAppleAdapter(
      engineID: UUID().uuidString,
      client: BotaAppleNativeClient.shared,
      leaseCoordinator: .shared,
      flutterApi: BotaFlutterApi(binaryMessenger: messenger),
      applicationSupportRoot: root
    )
    super.init()
  }

  public static func register(with registrar: FlutterPluginRegistrar) {
    #if os(iOS)
      let messenger = registrar.messenger()
    #else
      let messenger = registrar.messenger
    #endif
    let plugin = BotaFlutterSdkPlugin(messenger: messenger)
    BotaHostApiSetup.setUp(binaryMessenger: messenger, api: plugin.adapter)
    BotaSpeechHostApiSetup.setUp(binaryMessenger: messenger, api: plugin.speech)
    registrar.publish(plugin)
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    BotaHostApiSetup.setUp(binaryMessenger: messenger, api: nil)
    BotaSpeechHostApiSetup.setUp(binaryMessenger: messenger, api: nil)
    speechShutdown = speech.retire()
    let adapter = adapter
    Task { @MainActor in await adapter.detach() }
  }

  /// Install before the first speech session. The native App retains HTTP/media
  /// integration and prepares each initial grant; Dart supplies only a session ID.
  public func setSpeechFactory(_ factory: @escaping BotaFlutterSpeechFactory) throws {
    try speech.setFactory { id, observer in NativeFlutterSpeechSession(try factory(id, observer)) }
  }
  /// Install a native composition with independent original capture.
  public func setSpeechConnectionFactory(_ factory: @escaping BotaFlutterSpeechConnectionFactory) throws {
    try speech.setFactory(factory)
  }
}
