import XCTest

final class MediaTests: XCTestCase, @unchecked Sendable {
    func testConnection() async throws { try await MediaChecks().testConnectionStartsNeitherCaptureNorPlayback() }
    func testHold() async throws { try await MediaChecks().testHoldSurvivesLateAcquisitionWithoutInterruptingListening() }
    func testLateAcquisition() async throws { try await MediaChecks().testCloseJoinsAcquisitionEvenWhenItsPublicWaiterIsCancelled() }
    func testClear() async throws { try await MediaChecks().testClearWaitsForNativeFlushWhileCaptureContinues() }
    func testFailedPublish() async throws { try await MediaChecks().testFailedPublicationIsDisposedAndNotRetained() }
    func testCleanup() async throws { try await MediaChecks().testCleanupFailureRemainsTheResultForEveryCloseCaller() }
    func testRustComposition() async throws { try await MediaChecks().testPublicSessionExecutesActualRustPolicyThroughTheAdapter() }
    func testLateCleanupFailure() async throws { try await MediaChecks().testLateUnownedInputCleanupRunsOnceAndRemainsFailed() }
    func testTail() async throws { try await MediaChecks().testUnpublicationWaitsForTheNativePlaybackTail() }
    func testRetiredTail() async throws { try await MediaChecks().testRetiredTailCannotRemoveANewerSelection() }
}

final class PCMTests: XCTestCase, @unchecked Sendable {
    func testAdmission() async throws { try await PCMChecks().testUnknownAndClearedFramesCannotReachTheDevice() }
    func testResume() async throws { try await PCMChecks().testSilencedSidCannotReuseItsOldDeviceBuffers() }
    func testBudget() async throws { try await PCMChecks().testUnplayedFramesRemainBoundedByTheQueueBudget() }
    func testDrain() async throws { try await PCMChecks().testDrainRequiresThePlayedCallbackAndClearRetiresIt() }
    func testCopy() async throws { try await PCMChecks().testBorrowedNativeBuffersAreCopiedBeforeReturning() }
    func testRetirementBudget() async throws { try await PCMChecks().testRetiredTrackCannotConsumeTheNextSelectionBudget() }
}
