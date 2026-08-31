import Foundation

@objc(BotaDeviceSDKAppleBridge)
public final class BotaDeviceSDKAppleBridge: NSObject, @unchecked Sendable {
    @objc public static let shared = BotaDeviceSDKAppleBridge()

    private let lifecycle: BotaDeviceSDKAppleLifecycle

    override private init() {
        lifecycle = BotaDeviceSDKAppleLifecycle()
        super.init()
    }

    @objc(configureWithApplicationSupportDirectory:logLevel:completion:)
    public func configure(
        applicationSupportDirectory: String?,
        logLevel _: String,
        completion: @escaping @Sendable (NSError?) -> Void
    ) {
        let directory = applicationSupportDirectory.map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
        Task {
            do {
                try await lifecycle.configure(applicationSupportDirectory: directory)
                completion(nil)
            } catch {
                completion(error as NSError)
            }
        }
    }

    @objc(destroyWithCompletion:)
    public func destroy(completion: @escaping @Sendable () -> Void) {
        Task {
            await lifecycle.destroy()
            completion()
        }
    }

    @objc(stateWithCompletion:)
    public func state(completion: @escaping @Sendable (String) -> Void) {
        Task {
            completion(await lifecycle.state())
        }
    }

    @objc public func capabilities() -> [String: Any] {
        let capabilities = BotaDeviceSDKAppleCapabilities.current
        return [
            "backgroundReconnect": capabilities.backgroundReconnect,
            "backgroundScan": capabilities.backgroundScan,
            "bluetooth": capabilities.bluetooth,
            "nativeFileTransfer": capabilities.nativeFileTransfer,
            "platform": capabilities.platform,
        ]
    }
}
