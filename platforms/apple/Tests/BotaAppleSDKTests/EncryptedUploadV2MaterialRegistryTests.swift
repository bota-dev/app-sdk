import CryptoKit
import Foundation
import XCTest
@testable import BotaAppleSDK

final class EncryptedUploadV2MaterialRegistryTests: XCTestCase {
    func testRegistryKeepsArtifactsNativeAndReturnsOnlyDigestsToCore() async throws {
        let authorization = Data(repeating: 0xa1, count: 408)
        let receipt = Data(repeating: 0xb2, count: 336)
        let manifest = Data(repeating: 0xc3, count: 580)
        let evidence = makeEvidence(manifest: manifest)
        let calls = MaterialProviderCalls()
        let registry = EncryptedUploadV2MaterialRegistry()
        let provider = EncryptedUploadV2MaterialProvider(
            authorization: authorization,
            stagingRequest: { received in
                await calls.record(.stagingRequest(received))
                var request = URLRequest(url: URL(string: "https://staging.example/upload")!)
                request.httpMethod = "PUT"
                request.setValue("checksum", forHTTPHeaderField: "x-amz-checksum-sha256")
                return request
            },
            submitManifest: { submission in
                await calls.record(.submitManifest(submission))
            },
            finalize: { received in
                await calls.record(.finalize(received))
            },
            completionReceipt: { received in
                await calls.record(.completionReceipt(received))
                return receipt
            },
            cancel: {
                await calls.record(.cancel)
            }
        )

        try await registry.register(id: "v2-material-1", provider: provider)
        let prepared = try await registry.preparedMaterial(id: "v2-material-1")
        let request = try await registry.stagingRequest(id: "v2-material-1", evidence: evidence)
        try await registry.submitManifest(
            id: "v2-material-1",
            manifest: manifest,
            evidence: evidence
        )
        let acceptedReceipt = try await registry.finalizeAndReceiveReceipt(
            id: "v2-material-1",
            evidence: evidence
        )

        XCTAssertEqual(prepared.authorization, authorization)
        XCTAssertEqual(prepared.authorizationSHA256, sha256(authorization))
        XCTAssertEqual(request.url?.absoluteString, "https://staging.example/upload")
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertNil(request.httpBody)
        XCTAssertNil(request.httpBodyStream)
        XCTAssertEqual(acceptedReceipt.receipt, receipt)
        XCTAssertEqual(acceptedReceipt.receiptSHA256, sha256(receipt))
        let recordedCalls = await calls.values
        XCTAssertEqual(recordedCalls, [
            .stagingRequest(evidence),
            .submitManifest(.init(manifest: manifest, evidence: evidence)),
            .finalize(evidence),
            .completionReceipt(evidence),
        ])
    }

    func testRegistrationRejectsInvalidOrDuplicateOpaqueIDs() async throws {
        let registry = EncryptedUploadV2MaterialRegistry()
        let provider = makeProvider()

        await XCTAssertThrowsErrorAsync(
            try await registry.register(id: "contains whitespace", provider: provider)
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidMaterialID)
        }

        try await registry.register(id: "v2-material-1", provider: provider)
        await XCTAssertThrowsErrorAsync(
            try await registry.register(id: "v2-material-1", provider: provider)
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .duplicateMaterialID)
        }
    }

    func testRegistryValidatesOpaqueDocumentLengthsAndEvidence() async throws {
        let registry = EncryptedUploadV2MaterialRegistry()
        let invalidAuthorization = makeProvider(authorization: Data(repeating: 1, count: 407))
        await XCTAssertThrowsErrorAsync(
            try await registry.register(id: "invalid-authorization", provider: invalidAuthorization)
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidAuthorization)
        }

        let manifest = Data(repeating: 2, count: 580)
        let evidence = makeEvidence(manifest: manifest)
        try await registry.register(id: "valid-material", provider: makeProvider())
        await XCTAssertThrowsErrorAsync(
            try await registry.submitManifest(
                id: "valid-material",
                manifest: Data(repeating: 2, count: 579),
                evidence: evidence
            )
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidManifest)
        }

        let invalidEvidence = EncryptedUploadV2TransferEvidence(
            ciphertextLength: evidence.ciphertextLength,
            ciphertextSHA256: Data(repeating: 3, count: 31),
            manifestLength: evidence.manifestLength,
            manifestSHA256: evidence.manifestSHA256,
            blockCount: evidence.blockCount
        )
        await XCTAssertThrowsErrorAsync(
            try await registry.stagingRequest(id: "valid-material", evidence: invalidEvidence)
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidEvidence)
        }
    }

    func testStagingRequestMustBeBodylessHTTPSPut() async throws {
        let registry = EncryptedUploadV2MaterialRegistry()
        let provider = EncryptedUploadV2MaterialProvider(
            authorization: Data(repeating: 1, count: 408),
            stagingRequest: { _ in
                var request = URLRequest(url: URL(string: "http://staging.example/upload")!)
                request.httpMethod = "POST"
                request.httpBody = Data([1])
                return request
            },
            submitManifest: { _ in },
            finalize: { _ in },
            completionReceipt: { _ in Data(repeating: 2, count: 336) },
            cancel: {}
        )
        try await registry.register(id: "v2-material-1", provider: provider)

        await XCTAssertThrowsErrorAsync(
            try await registry.stagingRequest(
                id: "v2-material-1",
                evidence: makeEvidence(manifest: Data(repeating: 3, count: 580))
            )
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidStagingRequest)
        }
    }

    func testReceiptMustBeExactOpaqueReceiptSize() async throws {
        let registry = EncryptedUploadV2MaterialRegistry()
        try await registry.register(
            id: "v2-material-1",
            provider: makeProvider(receipt: Data(repeating: 4, count: 335))
        )

        await XCTAssertThrowsErrorAsync(
            try await registry.finalizeAndReceiveReceipt(
                id: "v2-material-1",
                evidence: makeEvidence(manifest: Data(repeating: 5, count: 580))
            )
        ) { error in
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .invalidReceipt)
        }
    }

    func testEveryTerminalOutcomeUnregistersAndOnlyNonCompletionCancelsBackendSession() async throws {
        for outcome in EncryptedUploadV2TerminalOutcome.allCases {
            let calls = MaterialProviderCalls()
            let registry = EncryptedUploadV2MaterialRegistry()
            try await registry.register(id: "v2-material-1", provider: makeProvider(calls: calls))

            try await registry.terminate(id: "v2-material-1", outcome: outcome)

            let remainsRegistered = await registry.contains(id: "v2-material-1")
            let recordedCalls = await calls.values
            XCTAssertFalse(remainsRegistered)
            XCTAssertEqual(recordedCalls, outcome == .completed ? [] : [.cancel])
            try await registry.terminate(id: "v2-material-1", outcome: outcome)
        }
    }

    func testTerminalCleanupRemovesProviderBeforeCancelFailureEscapes() async throws {
        let registry = EncryptedUploadV2MaterialRegistry()
        try await registry.register(
            id: "v2-material-1",
            provider: EncryptedUploadV2MaterialProvider(
                authorization: Data(repeating: 1, count: 408),
                stagingRequest: { _ in fatalError("unused") },
                submitManifest: { _ in },
                finalize: { _ in },
                completionReceipt: { _ in fatalError("unused") },
                cancel: { throw ProviderFailure.cancelFailed }
            )
        )

        await XCTAssertThrowsErrorAsync(
            try await registry.terminate(id: "v2-material-1", outcome: .failed)
        ) { error in
            XCTAssertEqual(error as? ProviderFailure, .cancelFailed)
        }
        let remainsRegistered = await registry.contains(id: "v2-material-1")
        XCTAssertFalse(remainsRegistered)
    }

    func testSensitiveProviderAndManifestDescriptionsAreRedacted() {
        let provider = makeProvider(authorization: Data(repeating: 0xab, count: 408))
        let submission = EncryptedUploadV2ManifestSubmission(
            manifest: Data(repeating: 0xcd, count: 580),
            evidence: makeEvidence(manifest: Data(repeating: 0xcd, count: 580))
        )

        XCTAssertEqual(String(describing: provider), "EncryptedUploadV2MaterialProvider(<redacted>)")
        XCTAssertEqual(String(reflecting: provider), "EncryptedUploadV2MaterialProvider(<redacted>)")
        XCTAssertEqual(String(describing: submission), "EncryptedUploadV2ManifestSubmission(<redacted>)")
        XCTAssertEqual(String(reflecting: submission), "EncryptedUploadV2ManifestSubmission(<redacted>)")
    }

    func testCallbackCompletionAfterTerminalRemovalIsRejectedAsStale() async throws {
        let started = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let registry = EncryptedUploadV2MaterialRegistry()
        let provider = EncryptedUploadV2MaterialProvider(
            authorization: Data(repeating: 1, count: 408),
            stagingRequest: { _ in
                started.continuation.yield()
                for await _ in release.stream.prefix(1) {}
                var request = URLRequest(url: URL(string: "https://staging.example/upload")!)
                request.httpMethod = "PUT"
                return request
            },
            submitManifest: { _ in },
            finalize: { _ in },
            completionReceipt: { _ in Data(repeating: 2, count: 336) },
            cancel: {}
        )
        try await registry.register(id: "v2-material-1", provider: provider)
        let evidence = makeEvidence(manifest: Data(repeating: 3, count: 580))
        let requestTask = Task {
            try await registry.stagingRequest(id: "v2-material-1", evidence: evidence)
        }

        for await _ in started.stream.prefix(1) {}
        try await registry.terminate(id: "v2-material-1", outcome: .completed)
        try await registry.register(id: "v2-material-1", provider: makeProvider())
        release.continuation.yield()

        do {
            _ = try await requestTask.value
            XCTFail("Expected stale provider callback to be rejected")
        } catch {
            XCTAssertEqual(error as? EncryptedUploadV2MaterialRegistryError, .missingMaterial)
        }
    }

    private func makeProvider(
        authorization: Data = Data(repeating: 1, count: 408),
        receipt: Data = Data(repeating: 2, count: 336),
        calls: MaterialProviderCalls? = nil
    ) -> EncryptedUploadV2MaterialProvider {
        EncryptedUploadV2MaterialProvider(
            authorization: authorization,
            stagingRequest: { _ in
                var request = URLRequest(url: URL(string: "https://staging.example/upload")!)
                request.httpMethod = "PUT"
                return request
            },
            submitManifest: { _ in },
            finalize: { _ in },
            completionReceipt: { _ in receipt },
            cancel: { await calls?.record(.cancel) }
        )
    }

    private func makeEvidence(manifest: Data) -> EncryptedUploadV2TransferEvidence {
        EncryptedUploadV2TransferEvidence(
            ciphertextLength: 16_384,
            ciphertextSHA256: Data(repeating: 0xab, count: 32),
            manifestLength: UInt16(manifest.count),
            manifestSHA256: sha256(manifest),
            blockCount: 4
        )
    }

    private func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
}

private enum ProviderFailure: Error, Equatable { case cancelFailed }

private enum MaterialProviderCall: Equatable {
    case stagingRequest(EncryptedUploadV2TransferEvidence)
    case submitManifest(EncryptedUploadV2ManifestSubmission)
    case finalize(EncryptedUploadV2TransferEvidence)
    case completionReceipt(EncryptedUploadV2TransferEvidence)
    case cancel
}

private actor MaterialProviderCalls {
    private(set) var values: [MaterialProviderCall] = []
    func record(_ value: MaterialProviderCall) { values.append(value) }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
