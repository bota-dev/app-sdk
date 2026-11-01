import Foundation
import XCTest
@testable import BotaAppSDK

final class SpeechSessionTests: XCTestCase, @unchecked Sendable {
    private func checks() throws -> SpeechSessionChecks {
        SpeechSessionChecks(fixtureURL: try XCTUnwrap(Bundle.module.url(forResource: "client-v1", withExtension: "json", subdirectory: "SpeechFixtures")))
    }
    func testDuplexLanguageChangeWaitsForCurrentHttpWorkerAndClear() async throws { try await checks().testDuplexLanguageChangeWaitsForCurrentHttpWorkerAndClear() }
    func testSupersededHttpCannotReplaceNewLanguage() async throws { try await checks().testSupersededHttpCannotReplaceNewLanguage() }
    func testCancelledCaptureClosesAndJoinsLateAcquisition() async throws { try await checks().testCancelledCaptureClosesAndJoinsLateAcquisition() }
    func testFinishHoldsPendingPublicationThenDrainsWhileListening() async throws { try await checks().testFinishHoldsPendingPublicationThenDrainsWhileListening() }
    func testCaptionRecoveryUsesSharedCursorAndPreservesUnicode() async throws { try await checks().testCaptionRecoveryUsesSharedCursorAndPreservesUnicode() }
    func testAuthorizationRevocationAndExpiryRetireMedia() async throws { try await checks().testAuthorizationRevocationAndExpiryRetireMedia() }
    func testFailedConnectionPreservesStableErrorAndSingleClose() async throws { try await checks().testFailedConnectionPreservesStableErrorAndSingleClose() }
    func testFailedCleanupRemainsFailedForEveryCaller() async throws { try await checks().testFailedCleanupRemainsFailedForEveryCaller() }
    func testNoPublicationIsNotCompletedAsr() async throws { try await checks().testNoPublicationIsNotCompletedAsr() }
    func testBoundedCallDoesNotJoinAnUncooperativeNativeTask() async throws { try await checks().testBoundedCallDoesNotJoinAnUncooperativeNativeTask() }
    func testRetiredCaptionRequestDoesNotBlockOrPublishIntoNewRevision() async throws { try await checks().testRetiredCaptionRequestDoesNotBlockOrPublishIntoNewRevision() }
    func testMalformedCaptionBodyIsRejectedByRust() async throws { try await checks().testMalformedCaptionBodyIsRejectedByRust() }
    func testConcurrentFinishSharesAuthorityAndRejectsHeldInput() async throws { try await checks().testConcurrentFinishSharesAuthorityAndRejectsHeldInput() }
    func testHttpFirstAndStaleClearCannotResumeCurrentAudio() async throws { try await checks().testHttpFirstAndStaleClearCannotResumeCurrentAudio() }
    func testCancellingCloseWaiterDoesNotCancelActualCleanup() async throws { try await checks().testCancellingCloseWaiterDoesNotCancelActualCleanup() }
    func testCloseCancelsResumeBeforeCleanupSettles() async throws { try await checks().testCloseCancelsResumeBeforeCleanupSettles() }
    func testCancellationBeforeTaskStartRetiresCompletionOwnershipExactlyOnce() async throws { try await checks().testCancellationBeforeTaskStartRetiresCompletionOwnershipExactlyOnce() }
}
