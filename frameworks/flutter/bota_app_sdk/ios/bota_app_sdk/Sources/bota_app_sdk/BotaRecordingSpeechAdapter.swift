import BotaAppSDK
import Foundation

/// Native admission and fresh grant acquisition stay in the App. The factory
/// starts one new direct activity and connects only caption/status callbacks.
public typealias BotaFlutterRecordingSpeechFactory = @MainActor (
  _ activityID: String, _ onCaption: @escaping @Sendable (Data) -> Void,
  _ onStatus: @escaping @Sendable (String) -> Void
) async throws -> any RecordingSpeechConnection

private enum NativeRecordingEvent: Sendable {
  case caption(Data), status(String)
}

private final class RecordingMailbox: @unchecked Sendable {
  let stream: AsyncStream<NativeRecordingEvent>
  private let continuation: AsyncStream<NativeRecordingEvent>.Continuation
  private let lock = NSLock()
  private var retired = false
  var isRetired: Bool { lock.withLock { retired } }
  private let overflow: @Sendable () -> Void
  init(overflow: @escaping @Sendable () -> Void) {
    let pair = AsyncStream<NativeRecordingEvent>.makeStream(bufferingPolicy: .bufferingOldest(32))
    stream = pair.stream; continuation = pair.continuation; self.overflow = overflow
  }
  func offer(_ event: NativeRecordingEvent) {
    let failed = lock.withLock { () -> Bool in
      guard !retired else { return false }
      if case .dropped = continuation.yield(event) {
        retired = true; continuation.finish(); return true
      }
      return false
    }
    if failed { overflow() }
  }
  func retire() { lock.withLock { retired = true; continuation.finish() } }
}

@MainActor
private final class RecordingCompletion {
  private var done = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    if done { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func finish() { done = true; let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() } }
}

@MainActor
final class BotaAppleRecordingSpeechAdapter: @preconcurrency BotaRecordingSpeechHostApi {
  private final class Slot {
    let id: String, generation: UUID, mailbox: RecordingMailbox
    var port: (any RecordingSpeechConnection)?
    let created = RecordingCompletion()
    var pump: Task<Void, Never>?
    var calls: [UUID: RecordingCompletion] = [:]
    init(id: String, generation: UUID, mailbox: RecordingMailbox) {
      self.id = id; self.generation = generation; self.mailbox = mailbox
    }
  }
  private let emit: @MainActor (BotaRecordingSpeechEventMessage) async throws -> Void
  private let terminal: @MainActor (BotaRecordingSpeechEventMessage) -> Void
  private var factory: BotaFlutterRecordingSpeechFactory?
  private var current: Slot?
  private var closed: (id: String, task: Task<Void, Error>)?
  private var failedOwner: Slot?
  private var destroyed = false
  private var shutdown: Task<Void, Error>?

  init(emit: @escaping @MainActor (BotaRecordingSpeechEventMessage) async throws -> Void,
       terminal: @escaping @MainActor (BotaRecordingSpeechEventMessage) -> Void = { _ in }) {
    self.emit = emit; self.terminal = terminal
  }

  func setFactory(_ factory: @escaping BotaFlutterRecordingSpeechFactory) throws {
    guard !destroyed else { throw Self.failure("closed") }
    guard current == nil, closed == nil else { throw Self.failure("busy") }
    self.factory = factory
  }

  func start(connectionId: String, activityId: String) async throws {
    guard !destroyed else { throw Self.failure("closed") }
    guard connectionId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
          !activityId.isEmpty, activityId.utf8.count <= 256 else { throw Self.failure("invalidInput") }
    guard current == nil else { throw Self.failure("busy") }
    if let closed { try await closed.task.value }
    guard !destroyed else { throw Self.failure("closed") }
    guard current == nil else { throw Self.failure("busy") }
    guard let factory else { throw Self.failure("unavailable") }
    let generation = UUID()
    let mailbox = RecordingMailbox { [weak self] in
      Task { @MainActor in
        guard let self, let slot = self.current, slot.generation == generation else { return }
        self.failClosed(slot, code: "bridgeOverflow")
      }
    }
    let slot = Slot(id: connectionId, generation: generation, mailbox: mailbox)
    current = slot
    slot.pump = Task { @MainActor [weak self, weak slot] in
      for await event in mailbox.stream {
        guard let self, let slot, self.current === slot, !Task.isCancelled else { return }
        do { try await self.emit(try Self.message(event, id: connectionId)) }
        catch { if self.current === slot { self.failClosed(slot, code: "bridgeUnavailable") }; return }
      }
    }
    do {
      do {
        slot.port = try await factory(activityId,
          { mailbox.offer(.caption($0)) }, { mailbox.offer(.status($0)) })
        slot.created.finish()
      } catch { slot.created.finish(); throw error }
      guard !mailbox.isRetired, current === slot, !destroyed else { throw Self.failure("closed") }
    } catch {
      let result = Self.map(error)
      if current === slot { try await beginClose(slot).value }
      throw result
    }
  }

  func changeTarget(connectionId: String, language: String, requestId: String) async throws {
    try await call(connectionId) { try await $0.changeTarget(language: language, requestId: requestId) }
  }
  func qualifyHeadphones(connectionId: String) async throws -> Bool { try await call(connectionId) { try await $0.qualifyHeadphones() } }
  func finish(connectionId: String) async throws { try await call(connectionId) { try await $0.finish() } }
  func close(connectionId: String) async throws {
    if let current, current.id == connectionId { try await beginClose(current).value }
    else if let closed, closed.id == connectionId { try await closed.task.value }
  }
  func destroy() async throws { try await retire().value }

  /// Retire callbacks synchronously at engine detach, before scheduling cleanup.
  func retire() -> Task<Void, Error> {
    if let shutdown { return shutdown }
    destroyed = true; factory = nil
    let cleanup = current.map { beginClose($0) } ?? closed?.task
    let task = Task { @MainActor in if let cleanup { try await cleanup.value } }
    shutdown = task; return task
  }

  private func call<T>(_ id: String, _ body: @MainActor (any RecordingSpeechConnection) async throws -> T) async throws -> T {
    guard !destroyed, let slot = current, slot.id == id, let port = slot.port else { throw Self.failure("closed") }
    guard slot.calls.count < 32 else { throw Self.failure("busy") }
    let key = UUID(), completion = RecordingCompletion(); slot.calls[key] = completion
    defer { slot.calls[key] = nil; completion.finish() }
    do {
      let result = try await body(port)
      guard current === slot, !destroyed else { throw Self.failure("closed") }
      return result
    } catch { throw Self.map(error) }
  }

  private func beginClose(_ slot: Slot) -> Task<Void, Error> {
    if current !== slot { return closed!.task }
    current = nil; slot.mailbox.retire(); slot.pump?.cancel()
    let calls = Array(slot.calls.values)
    let task = Task { @MainActor in
      do { await slot.created.wait(); try await slot.port?.close() }
      catch {
        self.failedOwner = slot
        await slot.pump?.value
        throw Self.failure("cleanupFailed")
      }
      for call in calls { await call.wait() }
      await slot.pump?.value
    }
    closed = (slot.id, task); return task
  }

  private func failClosed(_ slot: Slot, code: String) {
    _ = beginClose(slot)
    terminal(.init(connectionId: slot.id, status: code))
  }

  private static func failure(_ code: String) -> PigeonError { PigeonError(code: code, message: code, details: nil) }
  private static func map(_ error: Error) -> PigeonError {
    let allowed = ["invalidInput", "closed", "busy", "unavailable", "cleanupFailed", "bridgeOverflow", "bridgeUnavailable"]
    if let error = error as? PigeonError { return failure(allowed.contains(error.code) ? error.code : "unavailable") }
    if error is CancellationError { return failure("closed") }
    return failure("unavailable")
  }
  private static func message(_ event: NativeRecordingEvent, id: String) throws -> BotaRecordingSpeechEventMessage {
    switch event {
    case .status(let code):
      let allowed = ["interrupted", "output_skipped", "archive_unavailable", "capture_interrupted"]
      return .init(connectionId: id, status: allowed.contains(code) ? code : "interrupted")
    case .caption(let data):
      guard data.count <= 32768,
        let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let c = event["caption"] as? [String: Any], let final = event["final"] as? Bool,
        let unit = c["unitId"] as? String, let source = c["sourceId"] as? String,
        let epoch = c["sourceEpoch"] as? Int64, let revision = c["revision"] as? Int64,
        let start = c["startSample"] as? Int64, let end = c["endSample"] as? Int64,
        let language = c["sourceLanguage"] as? String, let text = c["text"] as? String
      else { throw failure("invalidInput") }
      return .init(connectionId: id, caption: .init(unitId: unit, sourceId: source, sourceEpoch: epoch,
        revision: revision, startSample: start, endSample: end, sourceLanguage: language,
        targetLanguage: c["targetLanguage"] as? String, text: text, isFinal: final))
    }
  }
}
