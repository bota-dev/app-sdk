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

  private init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
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
    registrar.publish(plugin)
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    BotaHostApiSetup.setUp(binaryMessenger: messenger, api: nil)
    let adapter = adapter
    Task { @MainActor in await adapter.detach() }
  }
}
