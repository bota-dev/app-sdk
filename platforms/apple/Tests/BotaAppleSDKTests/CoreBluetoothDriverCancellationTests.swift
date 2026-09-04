import Foundation
import XCTest

@testable import BotaAppleSDK

final class CoreBluetoothDriverCancellationTests: XCTestCase {
  func testGateGrantBeforeContinuationRegistrationTransfersOwnership() async throws {
    let waiter = PeripheralOperationWaiter()
    XCTAssertTrue(waiter.grant())
    try await waiter.value()
    XCTAssertFalse(waiter.grant())
  }

  func testCancellationAfterPreRegistrationGrantDoesNotRevokeTransferredOwnership() async {
    let waiter = PeripheralOperationWaiter()
    XCTAssertTrue(waiter.grant())
    let task = Task {
      try await waiter.value()
      try Task.checkCancellation()
    }
    task.cancel()
    await assertCancelled(task)
    XCTAssertFalse(waiter.grant())
  }

  func testCancelledQueuedReadAndWriteDoNotEnterOrReleasePeripheralGate() async throws {
    let gate = PeripheralOperationGate()
    let entries = GateEntryRecorder()
    try await gate.acquire("peripheral")

    let read = Task<Void, Error> {
      try await gate.acquire("peripheral")
      entries.record("read")
      await gate.release("peripheral")
    }
    let write = Task<Void, Error> {
      try await gate.acquire("peripheral")
      entries.record("write")
      await gate.release("peripheral")
    }
    try await waitUntil { await gate.waiterCount(for: "peripheral") == 2 }

    read.cancel()
    write.cancel()

    await assertCancelled(read)
    await assertCancelled(write)
    XCTAssertEqual(entries.values, [])
    let busyAfterCancellation = await gate.isBusy("peripheral")
    let waitersAfterCancellation = await gate.waiterCount(for: "peripheral")
    XCTAssertTrue(busyAfterCancellation)
    XCTAssertEqual(waitersAfterCancellation, 0)

    let live = Task<Void, Error> {
      try await gate.acquire("peripheral")
      entries.record("live")
      await gate.release("peripheral")
    }
    try await waitUntil { await gate.waiterCount(for: "peripheral") == 1 }
    XCTAssertEqual(entries.values, [])

    await gate.release("peripheral")
    try await live.value
    XCTAssertEqual(entries.values, ["live"])
    let busyAfterRelease = await gate.isBusy("peripheral")
    XCTAssertFalse(busyAfterRelease)
  }

  func testCancelledReadResumesExactlyOnceAndIgnoresLateCallback() async throws {
    let request = CoreBluetoothPendingRequest<Data>()
    let callbacks = CallbackRecorder()
    let task = Task {
      try await request.value(
        start: { callbacks.recordStart() },
        onCancel: { callbacks.recordCancellation() }
      )
    }
    try await waitUntil { callbacks.startCount == 1 }

    task.cancel()

    do {
      _ = try await task.value
      XCTFail("cancelled read should throw")
    } catch is CancellationError {}
    XCTAssertEqual(callbacks.cancellationCount, 1)
    XCTAssertFalse(request.succeed(Data([0x01])))
  }

  func testCancelledWriteResumesExactlyOnceAndIgnoresLateCallback() async throws {
    let request = CoreBluetoothPendingRequest<Void>()
    let callbacks = CallbackRecorder()
    let task = Task {
      try await request.value(
        start: { callbacks.recordStart() },
        onCancel: { callbacks.recordCancellation() }
      )
    }
    try await waitUntil { callbacks.startCount == 1 }

    task.cancel()

    do {
      try await task.value
      XCTFail("cancelled write should throw")
    } catch is CancellationError {}
    XCTAssertEqual(callbacks.cancellationCount, 1)
    XCTAssertFalse(request.succeed(()))
  }

  func testCancellationBeforeRegistrationNeverStartsCoreBluetoothRequest() async throws {
    let request = CoreBluetoothPendingRequest<Data>()
    let callbacks = CallbackRecorder()
    let gate = RegistrationGate()
    let task = Task {
      await gate.wait()
      return try await request.value(
        start: { callbacks.recordStart() },
        onCancel: { callbacks.recordCancellation() }
      )
    }

    task.cancel()
    await gate.open()

    do {
      _ = try await task.value
      XCTFail("pre-cancelled read should throw")
    } catch is CancellationError {}
    XCTAssertEqual(callbacks.startCount, 0)
    XCTAssertEqual(callbacks.cancellationCount, 1)
    XCTAssertFalse(request.succeed(Data([0x01])))
  }

  func testCancelledCharacteristicStaysQuarantinedUntilUnambiguousLateCallbackArrives() {
    var callbacks = CoreBluetoothPendingCallbacks<String, Data>()
    let cancelled = CoreBluetoothPendingRequest<Data>()
    let replacement = CoreBluetoothPendingRequest<Data>()
    XCTAssertTrue(callbacks.install(cancelled, for: "status"))
    XCTAssertTrue(callbacks.cancel(cancelled.id))
    XCTAssertFalse(callbacks.install(replacement, for: "status"))

    if case .ignored = callbacks.take(for: "status", hasActiveSubscription: false) {
    } else {
      XCTFail("the cancelled request's late callback must be ignored")
    }
    XCTAssertTrue(callbacks.install(replacement, for: "status"))
    if case .pending(let request) = callbacks.take(for: "status", hasActiveSubscription: false) {
      XCTAssertEqual(request.id, replacement.id)
    } else {
      XCTFail("reuse is safe only after the stale callback clears quarantine")
    }
  }

  func testLiveNotificationDoesNotClearCancelledReadQuarantine() {
    var callbacks = CoreBluetoothPendingCallbacks<String, Data>()
    let cancelled = CoreBluetoothPendingRequest<Data>()
    let replacement = CoreBluetoothPendingRequest<Data>()
    XCTAssertTrue(callbacks.install(cancelled, for: "status"))
    XCTAssertTrue(callbacks.cancel(cancelled.id))

    if case .unowned = callbacks.take(for: "status", hasActiveSubscription: true) {
    } else {
      XCTFail("a live notification must remain owned by the subscription")
    }
    XCTAssertFalse(callbacks.install(replacement, for: "status"))

    if case .ignored = callbacks.take(for: "status", hasActiveSubscription: false) {
    } else {
      XCTFail("only an unambiguous callback may clear read quarantine")
    }
    XCTAssertTrue(callbacks.install(replacement, for: "status"))
  }

  func testNotificationDuringCancellationRegistrationRaceIsNotSwallowed() async throws {
    var callbacks = CoreBluetoothPendingCallbacks<String, Data>()
    let cancelled = CoreBluetoothPendingRequest<Data>()
    let replacement = CoreBluetoothPendingRequest<Data>()
    XCTAssertTrue(callbacks.install(cancelled, for: "status"))
    let task = Task {
      try await cancelled.value(start: {}, onCancel: {})
    }
    try await waitUntil { cancelled.isPending }
    task.cancel()
    await assertCancelled(task)

    if case .unowned = callbacks.take(for: "status", hasActiveSubscription: true) {
    } else {
      XCTFail("the notification must flow while cancellation is being removed")
    }
    XCTAssertFalse(callbacks.install(replacement, for: "status"))
    XCTAssertFalse(cancelled.succeed(Data([0x01])))
  }

  func testCancellationRemovesAndQuarantinesBeforeRequestStateCanRejectCallback() async throws {
    let request = CoreBluetoothPendingRequest<Data>()
    let arbitration = CancellationArbitrationRecorder()
    let callbacks = PendingCallbacksBox()
    XCTAssertTrue(callbacks.install(request, for: "status"))
    let task = Task {
      try await request.value(start: {}) {
        arbitration.record(requestCannotReceiveCallback: request.cannotReceiveCallback)
        XCTAssertTrue(callbacks.cancel(request.id))
      }
    }
    try await waitUntil { request.isPending }

    task.cancel()
    await assertCancelled(task)

    XCTAssertEqual(arbitration.requestWasTerminalDuringRemoval, false)
    if case .unowned = callbacks.take(for: "status", hasActiveSubscription: true) {
    } else {
      XCTFail("notification must remain routed while cancellation quarantine is active")
    }
    XCTAssertFalse(callbacks.install(CoreBluetoothPendingRequest<Data>(), for: "status"))
  }

  func testDisconnectClearsCancelledCharacteristicQuarantine() {
    var callbacks = CoreBluetoothPendingCallbacks<String, Data>()
    let cancelled = CoreBluetoothPendingRequest<Data>()
    let replacement = CoreBluetoothPendingRequest<Data>()
    XCTAssertTrue(callbacks.install(cancelled, for: "status"))
    XCTAssertTrue(callbacks.cancel(cancelled.id))

    XCTAssertTrue(callbacks.removeAll(where: { $0 == "status" }).isEmpty)
    XCTAssertTrue(callbacks.install(replacement, for: "status"))
  }

  private func waitUntil(
    timeoutNanoseconds: UInt64 = 500_000_000,
    condition: @escaping @Sendable () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
    while !(await condition()) {
      if ContinuousClock.now >= deadline { throw CancellationTestError.timedOut }
      await Task.yield()
    }
  }

  private func assertCancelled<T>(_ task: Task<T, Error>) async {
    do {
      _ = try await task.value
      XCTFail("task should be cancelled")
    } catch is CancellationError {
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }
}

private enum CancellationTestError: Error {
  case timedOut
}

private final class CallbackRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var starts = 0
  private var cancellations = 0

  var startCount: Int { lock.withLock { starts } }
  var cancellationCount: Int { lock.withLock { cancellations } }

  func recordStart() { lock.withLock { starts += 1 } }
  func recordCancellation() { lock.withLock { cancellations += 1 } }
}

private final class GateEntryRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storedValues: [String] = []

  var values: [String] { lock.withLock { storedValues } }
  func record(_ value: String) { lock.withLock { storedValues.append(value) } }
}

private final class CancellationArbitrationRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storedRequestWasTerminal: Bool?

  var requestWasTerminalDuringRemoval: Bool? { lock.withLock { storedRequestWasTerminal } }
  func record(requestCannotReceiveCallback: Bool) {
    lock.withLock { storedRequestWasTerminal = requestCannotReceiveCallback }
  }
}

private final class PendingCallbacksBox: @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks = CoreBluetoothPendingCallbacks<String, Data>()

  func install(_ request: CoreBluetoothPendingRequest<Data>, for key: String) -> Bool {
    lock.withLock { callbacks.install(request, for: key) }
  }

  func cancel(_ requestID: UUID) -> Bool {
    lock.withLock { callbacks.cancel(requestID) }
  }

  func take(for key: String, hasActiveSubscription: Bool)
    -> CoreBluetoothPendingCallbacks<String, Data>.Resolution
  {
    lock.withLock { callbacks.take(for: key, hasActiveSubscription: hasActiveSubscription) }
  }
}

private actor RegistrationGate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    guard !isOpen else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    let waiting = waiters
    waiters.removeAll()
    for waiter in waiting { waiter.resume() }
  }
}
