import Foundation
import XCTest
@testable import BotaAppSDK

final class EncryptedUploadV2ContextTests: XCTestCase {
    func testFreshAttemptUsesIndependentNonceAndAcceptsResult() async throws {
        let io = ContextIO()
        let host = EncryptedUploadV2ContextHost(
            begin: { await io.begin($0) }, read: { await io.read() },
            sendDocument: { kind, bytes in await io.send(kind, bytes) }, validateDocument: { _, _ in }
        )
        for _ in 0..<2 {
            try await host.refresh { nonce in
                XCTAssertEqual(nonce, Data(repeating: 7, count: 16))
                return .init(challenge: Data([3]), exchangeProof: { proof in
                    XCTAssertEqual(proof, Data(repeating: 8, count: 116))
                    return Data([4])
                })
            }
        }
        let attempts = await io.attempts
        XCTAssertEqual(Set(attempts).count, 2)
        let kinds = await io.kinds
        XCTAssertEqual(kinds, [3, 4, 3, 4])
    }

    func testDeadlineCoversUncooperativeProviderAndBlocksLateDocument() async throws {
        let io = ContextIO()
        let gate = ContextProviderGate()
        let host = EncryptedUploadV2ContextHost(
            begin: { await io.begin($0) }, read: { await io.read() },
            sendDocument: { kind, bytes in await io.send(kind, bytes) }, validateDocument: { _, _ in }
        )
        do {
            try await host.refresh(timeoutNanoseconds: 20_000_000) { _ in
                await gate.wait()
                return .init(challenge: Data([3]), exchangeProof: { _ in Data([4]) })
            }
            XCTFail("Whole attempt must expire")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .timeout) }
        await gate.resume()
        await host.cancel()
        let kinds = await io.kinds
        XCTAssertTrue(kinds.isEmpty)
    }

    func testForeignAttemptFailsBeforeProvider() async throws {
        let host = EncryptedUploadV2ContextHost(
            begin: { _ in },
            read: { .init(attemptID: 0, state: 1, result: 0, payload: Data(repeating: 7, count: 16)) },
            sendDocument: { _, _ in XCTFail("No document after foreign attempt") },
            validateDocument: { _, _ in }
        )
        do {
            try await host.refresh { _ in
                XCTFail("No provider after foreign attempt")
                throw CancellationError()
            }
            XCTFail("Expected rejected context")
        } catch {}
    }
}

private actor ContextIO {
    var attempts: [UInt32] = []
    var kinds: [UInt8] = []
    var state: UInt8 = 1
    func begin(_ id: UInt32) { attempts.append(id); state = 1 }
    func read() -> EncryptedUploadV2ContextSnapshot {
        .init(attemptID: attempts.last!, state: state, result: 0,
              payload: state == 1 ? Data(repeating: 7, count: 16) : state == 2 ? Data(repeating: 8, count: 116) : Data())
    }
    func send(_ kind: UInt8, _ bytes: Data) { kinds.append(kind); state += 1 }
}

private actor ContextProviderGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func resume() { continuation?.resume(); continuation = nil }
}
