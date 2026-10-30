import Foundation

func check(_ condition: Bool, file: StaticString = #file, line: UInt = #line) {
  precondition(condition, "Check failed", file: file, line: line)
}
func require<T>(_ value: T?) throws -> T {
  guard let value else { throw CheckFailure.missingValue }
  return value
}
enum CheckFailure: Error { case missingValue, expectedError }
func checkThrows<E: Error & Equatable>(_ expected: E, _ body: () throws -> some Any) {
  do {
    _ = try body()
    preconditionFailure("Expected error")
  } catch { precondition(error as? E == expected, "Expected \(expected), received \(error)") }
}
func checkThrows<E: Error & Equatable>(_ expected: E, _ body: () async throws -> some Any) async {
  do {
    _ = try await body()
    preconditionFailure("Expected error")
  } catch { precondition(error as? E == expected, "Expected \(expected), received \(error)") }
}

@main struct Runner {
  static func main() async throws {
    try await usesExistingCommandRouteAndExplicitAction()
    try await retriesReuseOriginalIntentAndDeadline()
    try await lookupUsesReadOnlyListNotPendingClaim()
    try await rejectsWrongDeviceResponse()
    try refusesInsecureOriginAndPathTraversal()
    try await expiredIntentNeverReachesNetwork()
    try await customerHeaderFailureDoesNotSend()
    try await malformedOrReservedHeadersDoNotSend()
    try await httpErrorsAreSanitizedAndNeverRetried()
    try await stateIsReturnedWithoutBusinessActionSelection()
    try await lostPostIsRecoveredByRequestMetadataUsingOnlyGET()
    try await stopUsesExplicitStopAndDoesNotAcknowledge()
    try await absentCommandRemainsUnknown()
    try await detailLookupUsesConfiguredExistingRouteAndValidatesIdentity()
    try await listLookupUsesExistingBoundedLimit()
    try await transportContractErrorIsNotReportedAsNetworkFailure()
    try await cancellationDuringHeaderPreparationNeverSends()
    try await minimumTTLCanBeSubmittedImmediately()
    try await urlSessionStyleCancellationIsPreserved()
    print("Watch SDK checks passed (19 groups).")
  }
}
