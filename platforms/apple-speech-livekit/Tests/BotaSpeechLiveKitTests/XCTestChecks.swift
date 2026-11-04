import XCTest

final class CompanionTests: XCTestCase, @unchecked Sendable {
    func testOriginalIndependence() async throws { try await CompanionChecks().testOriginalOwnerSurvivesRtcFailureAndStopsOnExplicitLeave() }
    func testReactNativeOriginalIndependence() async throws { try await CompanionChecks().testReactNativeRtcClosePreservesIndependentOriginal() }
    func testReactNativeNativeExpiry() async throws { try await CompanionChecks().testReactNativeNativeExpiryRetiresMediaWithoutJsPolling() }
    func testFlutterPreparation() async throws { try await CompanionChecks().testFlutterPreparationIsNativeAndConsumedByOnlyItsEngine() }
    func testFlutterRetirement() async throws { try await CompanionChecks().testFlutterEngineReplacementRetiresLateBootstrap() }
    func testFlutterCleanupFailure() async throws { try await CompanionChecks().testFlutterCleanupFailurePreventsNewEngineAdmission() }
    func testJoin() async throws { try await CompanionChecks().testCompanionJoinsOnlyTheLoopbackRoleWithoutProjectCredentials() }
    func testAdmission() async throws { try await CompanionChecks().testCompanionRefusesUnsupportedRetentionAndForeignOriginsBeforeCapture() }
    func testRetirement() async throws { try await CompanionChecks().testCompanionRetirementRejectsLateBootstrap() }
    func testConcurrency() async throws { try await CompanionChecks().testCompanionDoesNotStartConcurrentBootstrapRequests() }
    func testBounds() async throws { try await CompanionChecks().testCompanionBoundsResponsesAndDoesNotRetryDeniedRequests() }
    func testFinishContract() async throws { try await CompanionChecks().testCompanionFinishUsesExplicitNullBoundariesAndAcceptsPendingResponse() }
    func testNativeOwner() async throws { try await CompanionChecks().testCompanionAppUsesTheNativeOwnerAndClearsOnLeave() }
    func testLateAppJoin() async throws { try await CompanionChecks().testCompanionAppJoinsLateBootstrapBeforeAllowingAnotherOwner() }
    func testPermission() async throws { try await CompanionChecks().testCompanionPermissionDenialAndLateApprovalNeverStartInput() }
    func testAppFinishAndCleanup() async throws { try await CompanionChecks().testCompanionFinishKeepsListeningAndFailedCleanupBlocksReentry() }
    func testCaptions() async throws { try await CompanionChecks().testCompanionPairsCaptionsAndClearsOnLanguageChange() }
}

final class ExternalPCMTests: XCTestCase, @unchecked Sendable {
    func testCopy() async throws { try await ExternalChecks().testExternalInputCopiesBorrowedFramesAndStartsSilent() }
    func testMute() async throws { try await ExternalChecks().testExternalMuteAndHoldCannotReplayQueuedSpeech() }
    func testBounds() async throws { try await ExternalChecks().testExternalOverflowAndStaleAudioAreTerminal() }
    func testFormat() async throws { try await ExternalChecks().testExternalInvalidFormatAndNativeRateFailClosed() }
    func testBinding() async throws { try await ExternalChecks().testExternalBindingAndDuplicateOwnershipAreRejected() }
    func testRetirement() async throws { try await ExternalChecks().testExternalEndAndCloseFenceLateFrames() }
    func testConnection() async throws { try await ExternalChecks().testExternalMediaBindingFailsBeforeConnection() }
    func testEnd() async throws { try await ExternalChecks().testExternalMediaEndAndCloseRetireInput() }
    func testVendorOwnership() async throws { try await ExternalChecks().testExternalFactoryRestoresTheActualVendorAudioOwner() }
    func testNativeCapture() async throws { try await ExternalChecks().testExternalPcmTraversesTheActualNoDeviceCaptureCallback() }
}

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
