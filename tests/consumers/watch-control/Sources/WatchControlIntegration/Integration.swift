import BotaWatchControl
import Foundation
import SwiftUI

/// Compiles the root-package product in a consumer, including the watchOS-only gesture branch.
@MainActor public func checkIntegration() throws {
  let client = WatchCloudClient(
    configuration: try .init(baseURL: URL(string: "https://customer.example.test")!))
  _ = Button("Customer action") {}.botaPrimaryHandGesture(isEnabled: false)
  let intent = try client.makeIntent(deviceID: "dev_consumer", action: .stopRecording)
  precondition(intent.action == .stopRecording)
}
