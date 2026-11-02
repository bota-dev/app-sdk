import BotaAppSDK
import Foundation

/// The native App prepares the initial scoped grant before Dart starts a session.
/// This factory must return promptly, create a fresh owner, and use the supplied
/// observer. HTTP callbacks, credentials and media ports remain native.
public typealias BotaFlutterSpeechFactory = @MainActor (
  _ sessionID: String, _ observer: SpeechObserver
) throws -> SpeechSession

@MainActor
protocol FlutterSpeechSession: AnyObject {
  var state: SpeechState { get }
  func ready() async throws
  func setInput(_ enabled: Bool) async throws
  func setListening(_ enabled: Bool) async throws
  func changeSubscription(_ selection: SpeechSelection) async throws
  func resumeAudio() async throws
  func recoverCaptions() async throws -> SpeechCaptionRecovery
  func finishInput() async throws -> SpeechSourceFinish
  func close() async throws
}

@MainActor
final class NativeFlutterSpeechSession: FlutterSpeechSession {
  private let session: SpeechSession
  init(_ session: SpeechSession) { self.session = session }
  var state: SpeechState { session.state }
  func ready() async throws { try await session.ready() }
  func setInput(_ enabled: Bool) async throws { try await session.setInput(enabled) }
  func setListening(_ enabled: Bool) async throws { try await session.setListening(enabled) }
  func changeSubscription(_ selection: SpeechSelection) async throws { try await session.changeSubscription(selection) }
  func resumeAudio() async throws { try await session.resumeAudio() }
  func recoverCaptions() async throws -> SpeechCaptionRecovery { try await session.recoverCaptions() }
  func finishInput() async throws -> SpeechSourceFinish { try await session.finishInput() }
  func close() async throws { try await session.close() }
}

private enum NativeSpeechEvent: Sendable {
  case state(SpeechState), caption(SpeechCaption), error(SpeechError)
}

private final class SpeechMailbox: @unchecked Sendable {
  let stream: AsyncStream<NativeSpeechEvent>
  private let continuation: AsyncStream<NativeSpeechEvent>.Continuation
  private let lock = NSLock()
  private var retired = false
  var isRetired: Bool { lock.withLock { retired } }
  private let overflow: @Sendable () -> Void
  init(overflow: @escaping @Sendable () -> Void) {
    let pair = AsyncStream<NativeSpeechEvent>.makeStream(bufferingPolicy: .bufferingOldest(32))
    stream = pair.stream; continuation = pair.continuation; self.overflow = overflow
  }
  func offer(_ event: NativeSpeechEvent) {
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
private final class SpeechCompletion {
  private var done = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    if done { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func finish() { done = true; let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() } }
}

@MainActor
final class BotaAppleSpeechAdapter: @preconcurrency BotaSpeechHostApi {
  private final class Slot {
    let id: String, generation: UUID, mailbox: SpeechMailbox
    var port: (any FlutterSpeechSession)?
    var pump: Task<Void, Never>?
    var calls: [UUID: SpeechCompletion] = [:]
    init(id: String, generation: UUID, mailbox: SpeechMailbox) {
      self.id = id; self.generation = generation; self.mailbox = mailbox
    }
  }
  private let emit: @MainActor (BotaSpeechEventMessage) async throws -> Void
  private let terminal: @MainActor (BotaSpeechEventMessage) -> Void
  private var factory: (@MainActor (String, SpeechObserver) throws -> any FlutterSpeechSession)?
  private var current: Slot?
  private var closed: (id: String, task: Task<Void, Error>)?
  private var failedOwner: Slot?
  private var destroyed = false
  private var shutdown: Task<Void, Error>?

  init(emit: @escaping @MainActor (BotaSpeechEventMessage) async throws -> Void,
       terminal: @escaping @MainActor (BotaSpeechEventMessage) -> Void = { _ in }) {
    self.emit = emit; self.terminal = terminal
  }

  func setFactory(_ factory: @escaping @MainActor (String, SpeechObserver) throws -> any FlutterSpeechSession) throws {
    guard !destroyed else { throw Self.failure("closed") }
    guard current == nil, closed == nil else { throw Self.failure("busy") }
    self.factory = factory
  }

  func start(connectionId: String, sessionId: String) async throws -> BotaSpeechStateMessage {
    guard !destroyed else { throw Self.failure("closed") }
    guard connectionId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
          !sessionId.isEmpty, sessionId.utf8.count <= 256 else { throw Self.failure("invalidInput") }
    guard current == nil else { throw Self.failure("busy") }
    if let closed { try await closed.task.value }
    guard !destroyed else { throw Self.failure("closed") }
    guard current == nil else { throw Self.failure("busy") }
    guard let factory else { throw Self.failure("unavailable") }
    let generation = UUID()
    let mailbox = SpeechMailbox { [weak self] in
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
        do { try await self.emit(Self.message(event, id: connectionId)) }
        catch { if self.current === slot { self.failClosed(slot, code: "bridgeUnavailable") }; return }
      }
    }
    do {
      slot.port = try factory(sessionId, SpeechObserver(
        stateChanged: { mailbox.offer(.state($0)) }, caption: { mailbox.offer(.caption($0)) },
        error: { mailbox.offer(.error($0)) }))
      guard !mailbox.isRetired else { throw Self.failure("bridgeOverflow") }
      return try await call(connectionId) { port in try await port.ready(); return Self.state(port.state) }
    } catch {
      let result = Self.map(error)
      if current === slot { try await beginClose(slot).value }
      throw result
    }
  }

  func setInput(connectionId: String, enabled: Bool) async throws {
    try await call(connectionId) { try await $0.setInput(enabled) }
  }
  func setListening(connectionId: String, enabled: Bool) async throws {
    try await call(connectionId) { try await $0.setListening(enabled) }
  }
  func changeSubscription(connectionId: String, selection: BotaSpeechSelectionMessage) async throws {
    guard let mode = SpeechListeningMode(rawValue: selection.mode) else { throw Self.failure("invalidInput") }
    let value = SpeechSelection(targetLanguage: selection.targetLanguage, mode: mode,
                                sourceParticipantIds: selection.sourceParticipantIds)
    try await call(connectionId) { try await $0.changeSubscription(value) }
  }
  func resumeAudio(connectionId: String) async throws { try await call(connectionId) { try await $0.resumeAudio() } }
  func recoverCaptions(connectionId: String) async throws -> BotaSpeechRecoveryMessage {
    try await call(connectionId) { Self.recovery(try await $0.recoverCaptions()) }
  }
  func finishInput(connectionId: String) async throws -> BotaSpeechFinishMessage {
    try await call(connectionId) { Self.finish(try await $0.finishInput()) }
  }
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

  private func call<T>(_ id: String, _ body: @MainActor (any FlutterSpeechSession) async throws -> T) async throws -> T {
    guard !destroyed, let slot = current, slot.id == id, let port = slot.port else { throw Self.failure("closed") }
    guard slot.calls.count < 32 else { throw Self.failure("busy") }
    let key = UUID(), completion = SpeechCompletion(); slot.calls[key] = completion
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
      do { try await slot.port?.close() }
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
    terminal(.init(connectionId: slot.id, errorCode: code))
  }

  private static func failure(_ code: String) -> PigeonError { PigeonError(code: code, message: code, details: nil) }
  private static func map(_ error: Error) -> PigeonError {
    if let error = error as? PigeonError {
      let allowed = ["invalidInput", "closed", "superseded", "mediaFailed", "mediaTimeout",
        "subscriptionUnavailable", "authorizationUnavailable", "playbackBlocked", "cleanupFailed",
        "captionRecoveryUnavailable", "captionRecoveryStale", "sourceFinishUnavailable",
        "sourceFinishStale", "sourceFinishPending", "busy", "unavailable", "bridgeOverflow", "bridgeUnavailable"]
      return failure(allowed.contains(error.code) ? error.code : "unavailable")
    }
    if let error = error as? SpeechError { return failure(error.rawValue) }
    if error is CancellationError { return failure("closed") }
    return failure("unavailable")
  }
  private static func recovery(_ value: SpeechCaptionRecovery) -> BotaSpeechRecoveryMessage {
    .init(status: value.status, hasMore: value.hasMore)
  }
  private static func finish(_ value: SpeechSourceFinish) -> BotaSpeechFinishMessage {
    .init(status: value.status, holdPublication: value.holdPublication, trackSid: value.trackSid,
      source: value.source.map { .init(id: $0.id, epoch: String($0.epoch), participantId: $0.participantId,
        memberGeneration: Int64($0.memberGeneration), trackSid: $0.trackSid, state: $0.state,
        finishState: $0.finish.state, workerGeneration: Int64($0.finish.workerGeneration),
        sequence: $0.finish.sequence, samples: $0.finish.samples) })
  }
  private static func state(_ value: SpeechState) -> BotaSpeechStateMessage {
    .init(connected: value.connected, disconnect: value.disconnect, canCapture: value.canCapture,
      canPlay: value.canPlay, subscriptionRevision: Int64(value.subscriptionRevision), changeId: Int64(value.changeId),
      clearGeneration: Int64(value.clearGeneration), clearPlayback: value.clearPlayback,
      expiresAtMs: Int64(clamping: value.expiresAtMs), gap: value.gap,
      tracks: value.tracks.map { .init(mediaTrackSid: $0.mediaTrackSid, sourceId: $0.sourceId,
        sourceEpoch: String($0.sourceEpoch), sourceParticipantId: $0.sourceParticipantId, origin: $0.origin, outputId: $0.outputId) },
      recovery: recovery(value.recovery), sourceFinish: finish(value.sourceFinish))
  }
  private static func message(_ event: NativeSpeechEvent, id: String) -> BotaSpeechEventMessage {
    switch event {
    case .state(let value): return .init(connectionId: id, state: state(value))
    case .error(let value): return .init(connectionId: id, errorCode: value.rawValue)
    case .caption(let value):
      let record = value.record
      return .init(connectionId: id, caption: .init(key: value.key, origin: value.origin, isFinal: value.isFinal,
        subscriptionRevision: Int64(value.subscriptionRevision), sequence: value.sequence, sourceId: record.sourceId,
        sourceEpoch: String(record.sourceEpoch), sourceParticipantId: record.sourceParticipantId,
        sourceMemberGeneration: Int64(record.sourceMemberGeneration), unitId: record.unitId,
        sourceFirstSeq: String(record.sourceFirstSeq), sourceLastSeq: String(record.sourceLastSeq),
        startMs: record.startMs, endMs: record.endMs, sourceLanguage: record.sourceLanguage,
        targetLanguage: record.targetLanguage, text: record.text))
    }
  }
}

private enum SpeechDeliveryError: Error, Sendable { case cancelled, unavailable }

private final class SpeechDeliveryReply: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<Void, SpeechDeliveryError>?
  private var continuation: CheckedContinuation<Void, Error>?
  func install(_ continuation: CheckedContinuation<Void, Error>) {
    let result = lock.withLock { () -> Result<Void, SpeechDeliveryError>? in
      if let result = self.result { return result }; self.continuation = continuation; return nil
    }
    if let result { continuation.resume(with: result.mapError { $0 as Error }) }
  }
  func complete(_ result: Result<Void, SpeechDeliveryError>) {
    let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
      guard self.result == nil else { return nil }
      self.result = result; defer { self.continuation = nil }; return self.continuation
    }
    continuation?.resume(with: result.mapError { $0 as Error })
  }
}

/// One acknowledged message at a time. Cancellation does not depend on Dart
/// returning a reply; late/duplicate replies cannot resume the waiter again.
@MainActor
enum SpeechFlutterDelivery {
  static func send(_ event: BotaSpeechEventMessage,
                   using send: @MainActor (BotaSpeechEventMessage, @escaping (Result<Void, PigeonError>) -> Void) -> Void) async throws {
    let reply = SpeechDeliveryReply()
    let deadline = Task {
      do { try await Task.sleep(nanoseconds: 5_000_000_000); reply.complete(.failure(.unavailable)) }
      catch {}
    }
    defer { deadline.cancel() }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        reply.install(continuation)
        guard !Task.isCancelled else { reply.complete(.failure(.cancelled)); return }
        send(event) { result in reply.complete(result.mapError { _ in .unavailable }) }
      }
    } onCancel: { reply.complete(.failure(.cancelled)) }
  }
}
