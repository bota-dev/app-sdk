import BotaAppSDK
import Foundation
@testable import BotaFlutterSdk

private struct BridgeCheckFailure: Error { let message: String }
private func check(_ value: Bool, _ message: String) throws {
  if !value { throw BridgeCheckFailure(message: message) }
}

private final class BridgeGate: @unchecked Sendable {
  private let lock = NSLock()
  private var opened = false
  private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
  var isOpen: Bool { lock.withLock { opened } }
  func wait() async throws {
    let id = UUID()
    let ready = await withCheckedContinuation { done in
      let ready = lock.withLock { if opened { return true }; waiters[id] = done; return false }
      if ready { done.resume(returning: true) }
      else { Task {
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        lock.withLock { waiters.removeValue(forKey: id) }?.resume(returning: false)
      } }
    }
    try check(ready, "Bridge phase did not settle within the test watchdog")
  }
  func open() {
    let pending = lock.withLock { opened = true; defer { waiters.removeAll() }; return Array(waiters.values) }
    pending.forEach { $0.resume(returning: true) }
  }
}

@MainActor
final class SpeechBridgeChecks {
  private let id = "0123456789abcdef0123456789abcdef"
  private let nextID = "abcdef0123456789abcdef0123456789"

  func testCloseDuringReadyJoinsAndRetiresCallbacks() async throws {
    let port = try BridgeTestSession(readyNow: false, closeNow: false)
    var events: [BotaSpeechEventMessage] = []
    var observer: SpeechObserver?
    let adapter = BotaAppleSpeechAdapter(emit: { events.append($0) })
    try adapter.setFactory { _, sink in observer = sink; return port }
    let starting = Task { try await adapter.start(connectionId: id, sessionId: "session") }
    try await port.readyEntered.wait()
    let closed = BridgeGate()
    let closing = Task { try await adapter.close(connectionId: id); closed.open() }
    try await port.closeEntered.wait()
    observer?.stateChanged(port.state)
    port.closeGate.open()
    try await port.closeReturned.wait()
    try check(!closed.isOpen, "Close abandoned an admitted start")
    port.readyGate.open()
    do { _ = try await starting.value; throw BridgeCheckFailure(message: "Retired start succeeded") }
    catch let error as PigeonError { try check(error.code == "closed", "Wrong start error") }
    try await closing.value
    try await adapter.close(connectionId: id)
    try check(port.closeCalls == 1 && events.isEmpty, "Cleanup or callback ownership changed")
    try await adapter.destroy()
  }

  func testIndependentControlsAndRetiredSessionIsolation() async throws {
    var observers: [SpeechObserver] = []
    var ports: [BridgeTestSession] = []
    var events: [BotaSpeechEventMessage] = []
    let delivered = BridgeGate()
    let adapter = BotaAppleSpeechAdapter(emit: { events.append($0); delivered.open() })
    try adapter.setFactory { _, observer in
      observers.append(observer); let port = try BridgeTestSession(); ports.append(port); return port
    }
    _ = try await adapter.start(connectionId: id, sessionId: "first")
    try await adapter.setInput(connectionId: id, enabled: true)
    try await adapter.setListening(connectionId: id, enabled: false)
    try await adapter.changeSubscription(connectionId: id, selection: .init(
      targetLanguage: "ja", mode: "translated", sourceParticipantIds: ["other"]))
    try check(ports[0].controls == ["input:true", "listening:false", "selection:ja:translated:other"], "Controls changed")
    let finish = try await adapter.finishInput(connectionId: id)
    let recovery = try await adapter.recoverCaptions(connectionId: id)
    try check(finish.status == "completed" && recovery.status == "complete", "Native results were not preserved")
    try await adapter.close(connectionId: id)
    _ = try await adapter.start(connectionId: nextID, sessionId: "second")
    observers[0].stateChanged(ports[0].state)
    observers[1].stateChanged(ports[1].state)
    try await delivered.wait()
    try check(events.count == 1 && events[0].connectionId == nextID, "Old observer escaped")
    try await adapter.close(connectionId: id)
    try check(ports[1].closeCalls == 0, "Old close stopped the replacement")
    try await adapter.destroy()
    try check(ports[1].closeCalls == 1, "Engine destroy missed its session")
  }

  func testCleanupFailureStaysStableAndPreventsReuse() async throws {
    let port = try BridgeTestSession(); port.failClose = true
    let adapter = BotaAppleSpeechAdapter(emit: { _ in })
    try adapter.setFactory { _, _ in port }
    _ = try await adapter.start(connectionId: id, sessionId: "session")
    for _ in 0..<2 {
      do { try await adapter.close(connectionId: id); throw BridgeCheckFailure(message: "Cleanup failure disappeared") }
      catch let error as PigeonError { try check(error.code == "cleanupFailed", "Wrong cleanup error") }
    }
    do { _ = try await adapter.start(connectionId: nextID, sessionId: "other"); throw BridgeCheckFailure(message: "Failed lease reused") }
    catch let error as PigeonError { try check(error.code == "cleanupFailed", "Failed owner was not retained") }
    try check(port.closeCalls == 1, "Cleanup was repeated")
    do { try await adapter.destroy() } catch {}
  }

  func testMissingFactoryFailsClosedAndDestroyIsTerminal() async throws {
    let adapter = BotaAppleSpeechAdapter(emit: { _ in })
    do { _ = try await adapter.start(connectionId: id, sessionId: "session"); throw BridgeCheckFailure(message: "Missing factory accepted") }
    catch let error as PigeonError { try check(error.code == "unavailable", "Wrong factory error") }
    try await adapter.destroy()
    do { _ = try await adapter.start(connectionId: id, sessionId: "session"); throw BridgeCheckFailure(message: "Destroyed engine accepted") }
    catch let error as PigeonError { try check(error.code == "closed", "Wrong destroyed error") }
  }

  func testSynchronousFactoryOverflowClosesTheReturnedOwner() async throws {
    let port = try BridgeTestSession()
    let adapter = BotaAppleSpeechAdapter(emit: { _ in })
    try adapter.setFactory { _, observer in
      for _ in 0..<40 { observer.stateChanged(port.state) }
      return port
    }
    do { _ = try await adapter.start(connectionId: id, sessionId: "session"); throw BridgeCheckFailure(message: "Overflowing construction succeeded") }
    catch let error as PigeonError { try check(error.code == "bridgeOverflow", "Wrong overflow error") }
    try check(port.closeCalls == 1, "Returned native owner leaked")
    try await adapter.destroy()
  }

  func testFactoryExceptionDetailsNeverCrossPigeon() async throws {
    let adapter = BotaAppleSpeechAdapter(emit: { _ in })
    try adapter.setFactory { _, _ in throw PigeonError(code: "PRIVATE_TOKEN", message: "PRIVATE_TOKEN", details: "PRIVATE_TOKEN") }
    do { _ = try await adapter.start(connectionId: id, sessionId: "session"); throw BridgeCheckFailure(message: "Failed factory succeeded") }
    catch let error as PigeonError {
      try check(error.code == "unavailable" && error.message == "unavailable" && error.details == nil, "Private factory error escaped")
    }
    try await adapter.destroy()
  }

  func testOverflowCancelsPendingDartReplyAndIgnoresLateCompletion() async throws {
    let port = try BridgeTestSession()
    let sent = BridgeGate()
    var reply: ((Result<Void, PigeonError>) -> Void)?
    var observer: SpeechObserver?
    var deliveries = 0
    var failures: [String] = []
    let adapter = BotaAppleSpeechAdapter(emit: { event in
      try await SpeechFlutterDelivery.send(event) { _, completion in
        deliveries += 1; reply = completion; sent.open()
      }
    }, terminal: { failures.append($0.errorCode ?? "missing") })
    try adapter.setFactory { _, sink in observer = sink; return port }
    _ = try await adapter.start(connectionId: id, sessionId: "session")
    observer?.stateChanged(port.state)
    try await sent.wait()
    for _ in 0..<40 { observer?.stateChanged(port.state) }
    try await port.closeEntered.wait()
    try await adapter.destroy()
    try check(deliveries == 1 && port.closeCalls == 1 && failures == ["bridgeOverflow"], "Bridge did not bound or retire pending delivery")
    reply?(.success(())); reply?(.success(()))
    observer?.stateChanged(port.state)
    try check(deliveries == 1, "Late Dart/native callback escaped")
  }
}

@MainActor
private final class BridgeTestSession: FlutterSpeechSession {
  let readyGate = BridgeGate(), readyEntered = BridgeGate()
  let closeGate = BridgeGate(), closeEntered = BridgeGate(), closeReturned = BridgeGate()
  var closeCalls = 0
  var failClose = false
  var controls: [String] = []
  let state: SpeechState
  init(readyNow: Bool = true, closeNow: Bool = true) throws {
    state = try JSONDecoder().decode(SpeechState.self, from: Data("""
      {"connected":true,"disconnect":false,"canCapture":false,"canPlay":false,
       "subscriptionRevision":1,"changeId":0,"clearGeneration":0,"clearPlayback":false,
       "expiresAtMs":5000,"gap":false,"tracks":[],"recovery":{"status":"idle","hasMore":false},
       "sourceFinish":{"status":"idle","holdPublication":false}}
      """.utf8))
    if readyNow { readyGate.open() }; if closeNow { closeGate.open() }
  }
  func ready() async throws { readyEntered.open(); try await readyGate.wait() }
  func setInput(_ enabled: Bool) async throws { controls.append("input:\(enabled)") }
  func setListening(_ enabled: Bool) async throws { controls.append("listening:\(enabled)") }
  func changeSubscription(_ selection: SpeechSelection) async throws {
    controls.append("selection:\(selection.targetLanguage):\(selection.mode.rawValue):\(selection.sourceParticipantIds.joined(separator: ","))")
  }
  func resumeAudio() async throws {}
  func finishInput() async throws -> SpeechSourceFinish {
    try JSONDecoder().decode(SpeechSourceFinish.self, from: Data("{\"status\":\"completed\",\"holdPublication\":false}".utf8))
  }
  func recoverCaptions() async throws -> SpeechCaptionRecovery {
    try JSONDecoder().decode(SpeechCaptionRecovery.self, from: Data("{\"status\":\"complete\",\"cursor\":\"PRIVATE_CURSOR\",\"hasMore\":false}".utf8))
  }
  func close() async throws {
    closeCalls += 1; closeEntered.open(); try await closeGate.wait(); closeReturned.open()
    if failClose { throw BridgeCheckFailure(message: "PRIVATE_TOKEN") }
  }
}
