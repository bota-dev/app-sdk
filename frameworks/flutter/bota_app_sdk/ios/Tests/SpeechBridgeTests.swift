import XCTest

@MainActor
final class SpeechBridgeTests: XCTestCase {
  func testCloseDuringReadyJoinsAndRetiresCallbacks() async throws {
    try await SpeechBridgeChecks().testCloseDuringReadyJoinsAndRetiresCallbacks()
  }
  func testIndependentControlsAndRetiredSessionIsolation() async throws {
    try await SpeechBridgeChecks().testIndependentControlsAndRetiredSessionIsolation()
  }
  func testCleanupFailureStaysStableAndPreventsReuse() async throws {
    try await SpeechBridgeChecks().testCleanupFailureStaysStableAndPreventsReuse()
  }
  func testMissingFactoryFailsClosedAndDestroyIsTerminal() async throws {
    try await SpeechBridgeChecks().testMissingFactoryFailsClosedAndDestroyIsTerminal()
  }
  func testSynchronousFactoryOverflowClosesTheReturnedOwner() async throws {
    try await SpeechBridgeChecks().testSynchronousFactoryOverflowClosesTheReturnedOwner()
  }
  func testFactoryExceptionDetailsNeverCrossPigeon() async throws {
    try await SpeechBridgeChecks().testFactoryExceptionDetailsNeverCrossPigeon()
  }
  func testOverflowCancelsPendingDartReplyAndIgnoresLateCompletion() async throws {
    try await SpeechBridgeChecks().testOverflowCancelsPendingDartReplyAndIgnoresLateCompletion()
  }
}
