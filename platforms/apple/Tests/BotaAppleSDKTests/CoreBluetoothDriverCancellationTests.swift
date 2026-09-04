import Foundation
import XCTest

@testable import BotaAppleSDK

final class CoreBluetoothDriverCancellationTests: XCTestCase {
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

  func testCancelledCharacteristicStaysQuarantinedUntilLateCallbackArrives() {
    var callbacks = CoreBluetoothPendingCallbacks<String, Data>()
    let cancelled = CoreBluetoothPendingRequest<Data>()
    let replacement = CoreBluetoothPendingRequest<Data>()
    XCTAssertTrue(callbacks.install(cancelled, for: "status"))
    XCTAssertTrue(callbacks.cancel(cancelled.id))
    XCTAssertFalse(callbacks.install(replacement, for: "status"))

    if case .ignored = callbacks.take(for: "status") {
    } else {
      XCTFail("the cancelled request's late callback must be ignored")
    }
    XCTAssertTrue(callbacks.install(replacement, for: "status"))
    if case .pending(let request) = callbacks.take(for: "status") {
      XCTAssertEqual(request.id, replacement.id)
    } else {
      XCTFail("reuse is safe only after the stale callback clears quarantine")
    }
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
    condition: @escaping @Sendable () -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
    while !condition() {
      if ContinuousClock.now >= deadline { throw CancellationTestError.timedOut }
      await Task.yield()
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
