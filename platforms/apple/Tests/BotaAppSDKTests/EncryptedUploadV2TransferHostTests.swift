import CryptoKit
import Foundation
import XCTest

@testable import BotaAppSDK

final class EncryptedUploadV2TransferHostTests: XCTestCase {
    func testLostAckReconcilesToZeroBeforeRestart() async throws {
        try await checkLostAckRecovery(offset: 0)
    }

    func testLostAckReconcilesToVerifiedNonzeroPrefixBeforeResume() async throws {
        try await checkLostAckRecovery(offset: 2)
    }

    private func checkLostAckRecovery(offset: UInt64) async throws {
        let fixture = try Fixture.lostAck()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let checkpoint = try await seedLostAckCheckpoint(fixture)
        let transport = LostAckTransport(replies: [
            fixture.resumeRejection(offset: offset), fixture.openingAccepted(offset: offset),
        ])
        let (host, _) = try lostAckHost(fixture, transport: transport)
        let (core, firstStart) = try await coreReadyToStart(fixture, host: host)
        let rejected = try await dispatch(core, host: host, effect: firstStart)
        XCTAssertEqual(rejected.map(\.kind), [EncryptedUploadV2Abi.eventResumeRejected])
        let persisted = try await host.checkpoint(
            serialNumber: fixture.serialNumber, recordingUUID: fixture.recordingUUID, recordingGeneration: 7
        )
        XCTAssertEqual(persisted?.revision, offset == 0 ? 0 : 1)
        XCTAssertEqual(persisted?.nextCiphertextOffset, offset)
        XCTAssertEqual(persisted?.highestContiguousSequence, offset == 0 ? nil : 0)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext, "Persist before truncate")
        let sidecar = try Data(contentsOf: fixture.checkpointURL)

        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectDeleteCheckpoint))
        XCTAssertEqual(try Data(contentsOf: fixture.checkpointURL), sidecar, "Core restart must retain recovery evidence")
        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectTruncateSink))
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), Data(fixture.ciphertext.prefix(Int(offset))))
        let retryStart = try nextEffect(core, kind: EncryptedUploadV2Abi.effectStartTransfer)
        var stream = await host.execute(retryStart).makeAsyncIterator()
        let started = try await stream.next()
        XCTAssertEqual(started?.kind, EncryptedUploadV2Abi.eventTransferStarted)
        try core.dispatch(CoreHostEvent(effect: retryStart, payload: XCTUnwrap(started)).packet)
        let openings = await transport.frames
        XCTAssertEqual(openings.map(\.first), [0x22, offset == 0 ? 0x20 : 0x22])
        let mapper = try CoreModelMapper()
        let expectedRetry = offset == 0
            ? try mapper.createEncryptedUploadV2Start(
                transportSessionID: fixture.transportSessionID, uploadSessionID: fixture.uploadSessionID,
                recordingUUID: fixture.recordingUUID, recordingGeneration: 7,
                authorizationSHA256: Data(repeating: 0x66, count: 32), checkpointRevision: 0,
                nextCiphertextOffset: 0, prefixSHA256: Data(SHA256.hash(data: Data())),
                windowPackets: 4, dataPayloadBytes: 300
            )
            : try mapper.createEncryptedUploadV2ResumeRequest(
                transportSessionID: fixture.transportSessionID, uploadSessionID: fixture.uploadSessionID,
                recordingUUID: fixture.recordingUUID, recordingGeneration: 7, checkpointRevision: 1,
                nextCiphertextOffset: offset, prefixSHA256: Data(SHA256.hash(data: fixture.ciphertext.prefix(Int(offset)))),
                windowPackets: 4, dataPayloadBytes: 300
            )
        XCTAssertEqual(openings.last, expectedRetry)
        await transport.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID, sequence: 1, offset: offset,
            bytes: Data(fixture.ciphertext.dropFirst(Int(offset)))
        ))
        await transport.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID, windowIndex: 0, firstSequence: 1, lastSequence: 1,
            nextOffset: 272, prefixSHA256: fixture.ciphertextSHA256, checkpointRevision: offset == 0 ? 1 : 2
        ))
        let staged = try await stream.next()
        XCTAssertEqual(staged?.kind, EncryptedUploadV2Abi.eventWindowStaged)
        try core.dispatch(CoreHostEvent(effect: retryStart, payload: XCTUnwrap(staged)).packet)
        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectSaveCheckpoint))
        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectAcknowledgeWindow))
        for offset in stride(from: 0, to: 580, by: 300) {
            await transport.yield(Self.manifestChunk(
                sessionID: fixture.transportSessionID, totalLength: 580, offset: UInt16(offset),
                digest: fixture.manifestSHA256, bytes: Data(fixture.manifest[offset..<min(offset + 300, 580)])
            ))
        }
        await transport.yield(Self.eof(
            sessionID: fixture.transportSessionID, finalSequence: 1, ciphertextLength: 272,
            ciphertextSHA256: fixture.ciphertextSHA256, manifestSHA256: fixture.manifestSHA256
        ))
        let completed = try await stream.next()
        XCTAssertEqual(completed?.kind, EncryptedUploadV2Abi.eventTransferCompleted)
        try core.dispatch(CoreHostEvent(effect: retryStart, payload: XCTUnwrap(completed)).packet)
        _ = try nextEffect(core, kind: EncryptedUploadV2Abi.effectStageArtifacts)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)
        _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        XCTAssertFalse(checkpoint.isEmpty)
    }

    func testLostAckUnsafeRejectionsRetainEvidenceWithoutRestart() async throws {
        for scenario in ["digest", "owner", "ahead", "equalRevision", "equalOffset", "zeroRevision", "zeroOffset", "foreign"] {
            let fixture = try Fixture.lostAck()
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let checkpoint = try await seedLostAckCheckpoint(fixture)
            let before = try Data(contentsOf: fixture.checkpointURL)
            let offset: UInt64 = scenario == "ahead" || scenario == "equalOffset" ? 272 : scenario == "zeroOffset" ? 0 : 2
            let revision: UInt32 = scenario == "ahead" ? 3 : scenario == "equalRevision" ? 2 : scenario == "zeroRevision" ? 0 : 1
            let transport = LostAckTransport(replies: [fixture.resumeRejection(
                offset: offset, revision: revision, reason: scenario == "owner" ? 0x13 : 0x0f,
                prefix: scenario == "digest" ? Data(repeating: 0, count: 32) : nil,
                sessionID: scenario == "foreign" ? fixture.transportSessionID + 1 : nil
            )])
            let (host, _) = try lostAckHost(fixture, transport: transport)
            _ = try await Self.collect(await host.execute(fixture.loadEffect()))
            do {
                _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
                XCTFail("Unsafe rejection must fail without a core restart: \(scenario)")
            } catch {}
            XCTAssertEqual(try Data(contentsOf: fixture.checkpointURL), before, scenario)
            XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext, scenario)
            let openings = await transport.frames.filter { $0.first == 0x20 || $0.first == 0x22 }
            XCTAssertEqual(openings.count, 1, scenario)
        }
    }

    func testLostAckPersistenceFailureDoesNotTruncateOrRetry() async throws {
        let fixture = try Fixture.lostAck()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let checkpoint = try await seedLostAckCheckpoint(fixture)
        let before = try Data(contentsOf: fixture.checkpointURL)
        let transport = LostAckTransport(replies: [fixture.resumeRejection(offset: 2)])
        let (host, _) = try lostAckHost(fixture, transport: transport)
        _ = try await Self.collect(await host.execute(fixture.loadEffect()))
        let directory = fixture.checkpointURL.deletingLastPathComponent()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        do {
            _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
            XCTFail("Persistence failure must prevent reconciliation")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: fixture.checkpointURL), before)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)
        let frames = await transport.frames
        XCTAssertEqual(frames.map(\.first), [0x22])
    }

    func testLostAckRepeatedRejectionCannotRollbackAgain() async throws {
        let fixture = try Fixture.lostAck()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let checkpoint = try await seedLostAckCheckpoint(fixture)
        let transport = LostAckTransport(replies: [fixture.resumeRejection(offset: 2), fixture.resumeRejection(offset: 0)])
        let (host, _) = try lostAckHost(fixture, transport: transport)
        _ = try await Self.collect(await host.execute(fixture.loadEffect()))
        _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
        _ = try await Self.collect(await host.execute(fixture.deleteEffect()))
        _ = try await Self.collect(await host.execute(fixture.truncateEffect(nextOffset: 0)))
        let before = try Data(contentsOf: fixture.checkpointURL)
        do {
            _ = try await Self.collect(await host.execute(fixture.startEffect()))
            XCTFail("A second rejection cannot authorize another rollback")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: fixture.checkpointURL), before)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), Data("ab".utf8))
        let frames = await transport.frames
        XCTAssertEqual(frames.map(\.first), [0x22, 0x22])
    }

    func testLostAckRetryCannotWriteToReplacementConnection() async throws {
        let fixture = try Fixture.lostAck()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let checkpoint = try await seedLostAckCheckpoint(fixture)
        let transport = LostAckTransport(replies: [fixture.resumeRejection(offset: 0), fixture.startAcknowledgement()])
        let (host, control) = try lostAckHost(fixture, transport: transport)
        _ = try await Self.collect(await host.execute(fixture.loadEffect()))
        _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
        await control.resetAfterConfirmedDisconnect()
        _ = try await Self.collect(await host.execute(fixture.deleteEffect()))
        _ = try await Self.collect(await host.execute(fixture.truncateEffect(nextOffset: 0)))
        var retry = await host.execute(fixture.startEffect()).makeAsyncIterator()
        do {
            _ = try await retry.next()
            XCTFail("An old reconciliation cannot open a replacement connection")
        } catch {}
        do {
            _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch, "The old connection has no remaining cleanup owner")
        }
        let frames = await transport.frames
        XCTAssertEqual(frames.map(\.first), [0x22], "No stale START, RESUME or ABORT")
    }

    func testLostAckReloadAfterPersistenceUsesNativePrefixWithoutDecodingCoreCheckpoint() async throws {
        for offset: UInt64 in [0, 2] {
            let fixture = try Fixture.lostAck()
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let checkpoint = try await seedLostAckCheckpoint(fixture)
            let (firstHost, _) = try lostAckHost(fixture, transport: LostAckTransport(replies: [fixture.resumeRejection(offset: offset)]))
            _ = try await Self.collect(await firstHost.execute(fixture.loadEffect()))
            _ = try await Self.collect(await firstHost.execute(fixture.startEffect(checkpoint: checkpoint)))
            _ = try await Self.collect(await firstHost.execute(fixture.abortEffect()))
            XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)

            let transport = LostAckTransport(replies: [fixture.openingAccepted(offset: offset)])
            let (host, _) = try lostAckHost(fixture, transport: transport)
            let (_, start) = try await coreReadyToStart(fixture, host: host)
            XCTAssertEqual(try Data(contentsOf: fixture.fileURL), Data(fixture.ciphertext.prefix(Int(offset))))
            var stream = await host.execute(start).makeAsyncIterator()
            let started = try await stream.next()
            XCTAssertEqual(started?.kind, EncryptedUploadV2Abi.eventTransferStarted)
            let frames = await transport.frames
            XCTAssertEqual(frames.map(\.first), [offset == 0 ? 0x20 : 0x22])
            _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        }
    }

    func testLostAckCancelledOrForeignRestartCannotDeleteEvidence() async throws {
        for foreign in [false, true] {
            let fixture = try Fixture.lostAck()
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let checkpoint = try await seedLostAckCheckpoint(fixture)
            let transport = LostAckTransport(replies: [fixture.resumeRejection(offset: 2)])
            let (host, _) = try lostAckHost(fixture, transport: transport)
            _ = try await Self.collect(await host.execute(fixture.loadEffect()))
            _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
            let before = try Data(contentsOf: fixture.checkpointURL)
            var effect = fixture.deleteEffect()
            if foreign {
                let packet = effect.packet
                effect = try CoreEffect(packet: .init(
                    kind: packet.kind, operation: packet.operation, requestID: packet.requestID,
                    cancellationHigh: packet.cancellationHigh, cancellationLow: packet.cancellationLow + 1,
                    fields: packet.fields
                ))
            } else {
                let committed = await host.confirmationAttemptedOrClaimCancellation(effect.cancellationID)
                XCTAssertFalse(committed)
            }
            do {
                _ = try await Self.collect(await host.execute(effect))
                XCTFail("A stale restart must not delete the durable prefix")
            } catch {}
            XCTAssertEqual(try Data(contentsOf: fixture.checkpointURL), before)
            XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)
            _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        }
    }

    func testLostAckClosedOriginalSubscriptionCannotBeReplacedForRetry() async throws {
        let fixture = try Fixture.lostAck()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let checkpoint = try await seedLostAckCheckpoint(fixture)
        let transport = LostAckTransport(replies: [fixture.resumeRejection(offset: 2), fixture.openingAccepted(offset: 2)])
        let (host, _) = try lostAckHost(fixture, transport: transport)
        _ = try await Self.collect(await host.execute(fixture.loadEffect()))
        _ = try await Self.collect(await host.execute(fixture.startEffect(checkpoint: checkpoint)))
        await transport.unsubscribe()
        _ = try await Self.collect(await host.execute(fixture.deleteEffect()))
        _ = try await Self.collect(await host.execute(fixture.truncateEffect(nextOffset: 0)))
        var stream = await host.execute(fixture.startEffect()).makeAsyncIterator()
        do {
            _ = try await stream.next()
            XCTFail("Closed original notifications must stop retry")
        } catch {}
        let frames = await transport.frames
        let subscriptions = await transport.subscriptionCount
        XCTAssertEqual(frames.map(\.first), [0x22])
        XCTAssertEqual(subscriptions, 1)
    }

    private func seedLostAckCheckpoint(_ fixture: Fixture) async throws -> Data {
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root, mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) }, sendControl: { _ in }
        )
        let (core, start) = try await coreReadyToStart(fixture, host: host)
        var stream = await host.execute(start).makeAsyncIterator()
        let started = try await stream.next()
        try core.dispatch(CoreHostEvent(effect: start, payload: XCTUnwrap(started)).packet)
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID, sequence: 9, offset: 0, bytes: fixture.ciphertext
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID, windowIndex: 1, firstSequence: 9, lastSequence: 9,
            nextOffset: UInt64(fixture.ciphertext.count), prefixSHA256: fixture.ciphertextSHA256, checkpointRevision: 2
        ))
        let staged = try await stream.next()
        try core.dispatch(CoreHostEvent(effect: start, payload: XCTUnwrap(staged)).packet)
        let save = try nextEffect(core, kind: EncryptedUploadV2Abi.effectSaveCheckpoint)
        let checkpoint = try XCTUnwrap(save.packet.fields.compactMap { field -> Data? in
            if case let .bytes(28, bytes) = field { return bytes }
            return nil
        }.first)
        _ = try await dispatch(core, host: host, effect: save)
        _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        return checkpoint
    }

    private func coreReadyToStart(
        _ fixture: Fixture, host: EncryptedUploadV2TransferHost
    ) async throws -> (CoreAbiClient, CoreEffect) {
        let core = try CoreAbiClient()
        let fields = fixture.startEffect().packet.fields.filter {
            if case .bytes(161, _) = $0 { return false }
            return true
        }
        try core.start(.init(
            kind: EncryptedUploadV2Abi.commandTransferEncryptedRecording, operation: 0, requestID: 0,
            cancellationHigh: 2, cancellationLow: 3, fields: fields
        ), capabilities: CoreCapabilities.all.rawValue)
        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectLoadCheckpoint))
        _ = try await dispatch(core, host: host, effect: nextEffect(core, kind: EncryptedUploadV2Abi.effectTruncateSink))
        let prepare = try nextEffect(core, kind: EncryptedUploadV2Abi.effectPrepareSession)
        try core.dispatch(CoreHostEvent(effect: prepare, kind: EncryptedUploadV2Abi.eventSessionPrepared, fields: [
            .bytes(id: 161, value: Data(repeating: 0x66, count: 32)),
        ]).packet)
        return (core, try nextEffect(core, kind: EncryptedUploadV2Abi.effectStartTransfer))
    }

    private func nextEffect(_ core: CoreAbiClient, kind: UInt32) throws -> CoreEffect {
        while let packet = try core.pollOutput() {
            if packet.kind == 0x0328 { continue } // Byte-count progress has no host callback.
            if packet.kind >= 0x0400 {
                let notification = try CoreNotification(packet: packet)
                XCTAssertNotEqual(notification.kind, .failed)
                continue
            }
            XCTAssertEqual(packet.kind, kind)
            return try CoreEffect(packet: packet)
        }
        throw XCTUnwrapFailure.missingEffect
    }

    private func dispatch(
        _ core: CoreAbiClient, host: EncryptedUploadV2TransferHost, effect: CoreEffect
    ) async throws -> [CoreHostEventPayload] {
        let events = try await Self.collect(await host.execute(effect))
        for event in events { try core.dispatch(CoreHostEvent(effect: effect, payload: event).packet) }
        return events
    }

    private enum XCTUnwrapFailure: Error { case missingEffect }

    private func lostAckHost(
        _ fixture: Fixture, transport: LostAckTransport
    ) throws -> (EncryptedUploadV2TransferHost, EncryptedUploadV2TransferControl) {
        let mapper = try CoreModelMapper()
        let control = EncryptedUploadV2TransferControl(
            mapper: mapper, subscribe: { _ in await transport.subscribe() },
            write: { _, frame in await transport.write(frame) }, unsubscribe: { _ in await transport.unsubscribe() }
        )
        return (EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root, mapper: mapper, transferControl: control,
            resolvePeripheralID: { "peripheral-1" }
        ), control)
    }

    func testCompletionOperationsRejectConcurrentReentry() async throws {
        let fixture = try Fixture()
        let gate = SuspendedFirstCompletionCall()
        let registry = EncryptedUploadV2MaterialRegistry()
        try await registry.register(
            id: "material-id",
            provider: EncryptedUploadV2MaterialProvider(
                authorization: Data(repeating: 0xa1, count: 408),
                stagingRequest: { _ in URLRequest(url: URL(string: "https://staging.example")!) },
                submitManifest: { _ in },
                finalize: { _ in },
                completionReceipt: { _ in Data(repeating: 0xb2, count: 336) },
                cancel: {},
                uploadContext: { _ in .init(challenge: Data(), exchangeProof: { _ in Data() }) }
            )
        )
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in },
            services: .init(
                materialRegistry: registry,
                sendSignedDocument: { _, _, _, _ in await gate.suspendFirst() },
                uploadCiphertext: { _, _ in },
                confirmTransfer: { _, _ in },
                nextWriteID: { 7 },
                refreshUploadContext: { _, validate in try await validate() }
            )
        )
        let firstEffect = fixture.prepareEffect()
        let first = Task.detached { @Sendable in
            var values: [CoreHostEventPayload] = []
            for try await value in await host.execute(firstEffect) { values.append(value) }
            return values
        }
        await gate.waitUntilEntered()

        do {
            _ = try await Self.collect(await host.execute(fixture.prepareEffect()))
            XCTFail("Expected concurrent completion reentry to fail")
        } catch let failure as EncryptedUploadV2HostFailure {
            XCTAssertEqual(failure.errorCode, 8)
        }

        await gate.resume()
        let firstEvents = try await first.value
        XCTAssertEqual(firstEvents.map(\.kind), [EncryptedUploadV2Abi.eventSessionPrepared])
        let preConfirmCancellation = await host.confirmationAttemptedOrClaimCancellation(firstEffect.cancellationID)
        XCTAssertFalse(preConfirmCancellation)
    }

    func testCompletionServicesStageOpaqueArtifactsBeforeReceiptGatedConfirm() async throws {
        try await checkCompletionServices(shouldUpload: true)
    }

    func testAlreadyStagedCiphertextSkipsPutButStillCompletesReceiptFlow() async throws {
        try await checkCompletionServices(shouldUpload: false)
    }

    func testSkippedPutStillRejectsTamperedFileEvidence() async throws {
        try await checkCompletionServices(shouldUpload: false, tamper: true)
    }

    private func checkCompletionServices(shouldUpload: Bool, tamper: Bool = false) async throws {
        let fixture = try Fixture()
        let authorization = Data(repeating: 0xa1, count: 408)
        let receipt = Data(repeating: 0xb2, count: 336)
        let calls = EncryptedUploadV2CompletionCalls()
        let directorySync = DirectorySyncFailure()
        let confirmedCommit = SuspendedFirstCompletionCall()
        let registry = EncryptedUploadV2MaterialRegistry()
        try await registry.register(
            id: "material-id",
            provider: EncryptedUploadV2MaterialProvider(
                authorization: authorization,
                stagingRequest: { _ in
                    await calls.append(.stagingRequest)
                    var request = URLRequest(url: URL(string: "https://staging.example/upload")!)
                    request.httpMethod = "PUT"
                    return request
                },
                submitManifest: { submission in
                    await calls.append(.manifest(submission.manifest))
                },
                finalize: { _ in await calls.append(.finalize) },
                completionReceipt: { _ in
                    await calls.append(.receipt)
                    return receipt
                },
                cancel: { await calls.append(.cancel) },
                uploadContext: { _ in .init(challenge: Data(), exchangeProof: { _ in Data() }) },
                shouldUploadCiphertext: { _ in
                    if tamper { try Data("tampered".utf8).write(to: fixture.fileURL) }
                    return shouldUpload
                }
            )
        )
        let services = EncryptedUploadV2TransferHostServices(
            materialRegistry: registry,
            sendSignedDocument: { kind, _, document, _ in
                await calls.append(.signed(kind: kind, document: document))
            },
            uploadCiphertext: { _, fileURL in
                await calls.append(.upload(try Data(contentsOf: fileURL)))
            },
            confirmTransfer: { _, frame in
                await calls.append(.confirm(frame))
                await confirmedCommit.suspendFirst()
            },
            nextWriteID: { 7 },
            refreshUploadContext: { _, validate in try await validate(); await calls.append(.context) }
        )
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in },
            claimConfirmationCancellation: { _ in await confirmedCommit.hasEntered() },
            checkpointStore: .init(syncDirectory: { try directorySync.sync($0) }),
            services: services
        )

        let prepared = try await Self.collect(await host.execute(fixture.prepareEffect()))
        XCTAssertEqual(prepared, [.init(
            kind: EncryptedUploadV2Abi.eventSessionPrepared,
            fields: [.bytes(
                id: EncryptedUploadV2Abi.fieldAuthorizationSHA256,
                value: Data(SHA256.hash(data: authorization))
            )]
        )])

        var transfer = await host.execute(fixture.startEffect(
            authorizationSHA256: Data(SHA256.hash(data: authorization))
        )).makeAsyncIterator()
        _ = try await transfer.next()
        fixture.sendCleanWindow()
        _ = try await transfer.next()
        let checkpoint = Data("opaque-core-checkpoint".utf8)
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
            checkpoint: checkpoint
        )))
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectAcknowledgeWindow,
            checkpoint: checkpoint
        )))
        fixture.sendManifestAndEOF()
        _ = try await transfer.next()

        if tamper {
            do {
                _ = try await Self.collect(await host.execute(fixture.stageEffect()))
                XCTFail("Skipped PUT must still verify the ciphertext file")
            } catch {}
            let values = await calls.values
            XCTAssertEqual(values, [.context, .signed(kind: 1, document: authorization)])
            return
        }
        let stageEvents = try await Self.collect(await host.execute(fixture.stageEffect()))
        XCTAssertEqual(stageEvents, [.init(kind: EncryptedUploadV2Abi.eventArtifactsStaged)])
        let receiptEvents = try await Self.collect(await host.execute(fixture.awaitReceiptEffect()))
        let receiptSHA256 = Data(SHA256.hash(data: receipt))
        XCTAssertEqual(receiptEvents, [.init(
            kind: EncryptedUploadV2Abi.eventReceiptAccepted,
            fields: [.bytes(id: EncryptedUploadV2Abi.fieldReceiptSHA256, value: receiptSHA256)]
        )])
        let callsBeforeMismatchedConfirm = await calls.values.count
        do {
            _ = try await Self.collect(await host.execute(fixture.confirmEffect(
                receiptSHA256: Data(repeating: 0xff, count: 32)
            )))
            XCTFail("Expected a mismatched receipt digest to fail closed")
        } catch let failure as EncryptedUploadV2HostFailure {
            XCTAssertEqual(failure.errorCode, 11)
        }
        let callsAfterMismatchedConfirm = await calls.values.count
        XCTAssertEqual(callsAfterMismatchedConfirm, callsBeforeMismatchedConfirm)
        let remainsRegisteredBeforeConfirm = await registry.contains(id: "material-id")
        XCTAssertTrue(remainsRegisteredBeforeConfirm)
        directorySync.setShouldFail(true)
        do {
            _ = try await Self.collect(await host.execute(
                fixture.confirmEffect(receiptSHA256: receiptSHA256)
            ))
            XCTFail("Expected failed durable cleanup to prevent device confirmation")
        } catch {}
        let callsAfterCleanupFailure = await calls.values.count
        XCTAssertEqual(callsAfterCleanupFailure, callsBeforeMismatchedConfirm + 1, "A fresh context precedes first receipt admission")
        let remainsRegisteredAfterCleanupFailure = await registry.contains(id: "material-id")
        XCTAssertTrue(remainsRegisteredAfterCleanupFailure)
        directorySync.setShouldFail(false)
        let confirmEffect = fixture.confirmEffect(receiptSHA256: receiptSHA256)
        let confirm = Task.detached { @Sendable in
            try await Self.collect(await host.execute(confirmEffect))
        }
        await confirmedCommit.waitUntilEntered()
        let cancellationDefersAtActualWrite = await host.confirmationAttemptedOrClaimCancellation(
            confirmEffect.cancellationID
        )
        XCTAssertTrue(cancellationDefersAtActualWrite)
        try await registry.terminate(id: "material-id", outcome: .completed)
        confirm.cancel()
        await confirmedCommit.resume()
        let confirmEvents = try await confirm.value
        XCTAssertEqual(confirmEvents, [.init(kind: EncryptedUploadV2Abi.eventRecordingConfirmed)])
        let cancellationStillSeesExactSettlement = await host.confirmationAttemptedOrClaimCancellation(
            confirmEffect.cancellationID
        )
        XCTAssertTrue(cancellationStillSeesExactSettlement)

        let values = await calls.values
        let expected: [EncryptedUploadV2CompletionCall] = [.context, .signed(kind: 1, document: authorization)]
            + (shouldUpload ? [.stagingRequest, .upload(fixture.ciphertext)] : [])
            + [.manifest(fixture.manifest), .finalize, .receipt, .context, .context, .signed(kind: 2, document: receipt)]
        XCTAssertEqual(Array(values.dropLast()), expected)
        let confirms = values.compactMap { value -> Data? in
            guard case let .confirm(frame) = value else { return nil }
            return frame
        }
        XCTAssertEqual(confirms.count, 1)
        XCTAssertEqual(confirms[0].first, 0x23)
        XCTAssertEqual(Data(confirms[0].suffix(32)), receiptSHA256)
        let remainsRegistered = await registry.contains(id: "material-id")
        XCTAssertFalse(remainsRegistered)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.fileURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.checkpointURL.path))
    }

    func testStartEffectStreamsAProvenWindowFrom0409IntoStructuredCoreFields() async throws {
        let fixture = try Fixture()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        var iterator = await host.execute(fixture.startEffect()).makeAsyncIterator()

        let first = try await iterator.next()
        XCTAssertEqual(first?.kind, EncryptedUploadV2Abi.eventTransferStarted)

        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: fixture.ciphertext
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 1,
            nextOffset: UInt64(fixture.ciphertext.count),
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))

        let next = try await iterator.next()
        let staged = try XCTUnwrap(next)
        XCTAssertEqual(staged.kind, EncryptedUploadV2Abi.eventWindowStaged)
        let expectedFields: [CoreField] = [
            .text(id: 3, value: fixture.serialNumber),
            .text(id: 13, value: fixture.recordingUUID),
            .unsigned(id: 129, value: 7),
            .bytes(id: 132, value: fixture.uploadSessionBytes),
            .unsigned(id: 165, value: 9),
            .unsigned(id: 128, value: fixture.transportSessionID),
            .unsigned(id: 133, value: 1),
            .unsigned(id: 39, value: UInt64(fixture.ciphertext.count)),
            .bytes(id: 143, value: fixture.ciphertextSHA256),
            .unsigned(id: 134, value: 4),
            .unsigned(id: 135, value: 4),
            .bytes(id: 136, value: Data()),
        ]
        XCTAssertEqual(staged.fields, expectedFields)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)
    }

    func testCheckpointSavePrecedesWindowAckAndResumesTheStartStreamToEOF() async throws {
        let fixture = try Fixture()
        let controls = SentControls()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { data in await controls.append(data) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.sendCleanWindow()
        _ = try await start.next()

        let checkpoint = Data("opaque-core-checkpoint".utf8)
        let saveEvents = try await Self.collect(await host.execute(
            fixture.checkpointEffect(kind: EncryptedUploadV2Abi.effectSaveCheckpoint, checkpoint: checkpoint)
        ))
        XCTAssertEqual(saveEvents.map(\.kind), [EncryptedUploadV2Abi.eventCheckpointSaved])
        let controlsBeforeAck = await controls.values
        XCTAssertTrue(controlsBeforeAck.isEmpty)

        var predecessor = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture.checkpointURL)) as? [String: Any])
        let predecessorSession = UUID()
        predecessor["ownerRevision"] = 8
        predecessor["uploadSessionBytes"] = withUnsafeBytes(of: predecessorSession.uuid) { Data($0) }.base64EncodedString()
        let predecessorURL = fixture.checkpointURL.deletingLastPathComponent()
            .appendingPathComponent(predecessorSession.uuidString).appendingPathExtension("json")
        try JSONSerialization.data(withJSONObject: predecessor).write(to: predecessorURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: predecessorURL.path))

        let ackEvents = try await Self.collect(await host.execute(
            fixture.checkpointEffect(kind: EncryptedUploadV2Abi.effectAcknowledgeWindow, checkpoint: checkpoint)
        ))
        XCTAssertEqual(ackEvents, [.init(
            kind: EncryptedUploadV2Abi.eventWindowAcknowledged,
            fields: [.bytes(id: 28, value: checkpoint)]
        )])
        let controlsAfterAck = await controls.values
        XCTAssertEqual(controlsAfterAck.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: predecessorURL.path), "Retire predecessor only after the new durable ACK")

        fixture.sendManifestAndEOF()
        let next = try await start.next()
        let completed = try XCTUnwrap(next)
        XCTAssertEqual(completed.kind, EncryptedUploadV2Abi.eventTransferCompleted)
        XCTAssertEqual(completed.fields, [
            .unsigned(id: 130, value: UInt64(fixture.ciphertext.count)),
            .bytes(id: 144, value: fixture.ciphertextSHA256),
            .unsigned(id: 168, value: 580),
            .bytes(id: 142, value: fixture.manifestSHA256),
            .unsigned(id: 145, value: 1),
        ])
    }

    func testRepairEffectSendsOnlyTheMissingSequenceAndReturnsTheRepairedWindow() async throws {
        let fixture = try Fixture(ciphertext: Data("abcdef".utf8))
        let controls = SentControls()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { data in await controls.append(data) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 3,
            offset: 4,
            bytes: Data("ef".utf8)
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))
        let missingValue = try await start.next()
        let missing = try XCTUnwrap(missingValue)
        XCTAssertEqual(missing.fields.last, .bytes(id: 136, value: Data([2, 0, 0, 0])))

        var repair = await host.execute(fixture.repairEffect(missingSequences: [2])).makeAsyncIterator()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 2,
            offset: 2,
            bytes: Data("cd".utf8)
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 3,
            nextOffset: 6,
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))

        let repairedValue = try await repair.next()
        let repaired = try XCTUnwrap(repairedValue)
        XCTAssertEqual(repaired.kind, EncryptedUploadV2Abi.eventWindowStaged)
        XCTAssertEqual(repaired.fields.last, .bytes(id: 136, value: Data()))
        let sent = await controls.values
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(Self.readUInt16(sent[0], at: 64), 1)
        XCTAssertEqual(Self.readUInt32(sent[0], at: 68), 2)
        XCTAssertEqual(try Data(contentsOf: fixture.fileURL), fixture.ciphertext)
    }

    func testLiveInitializerStartsAndClaimsTheExisting0409Controller() async throws {
        let fixture = try Fixture()
        let transport = TransferHostTransport(startAcknowledgement: fixture.startAcknowledgement())
        let mapper = try CoreModelMapper()
        let control = EncryptedUploadV2TransferControl(
            mapper: mapper,
            subscribe: { try await transport.subscribe(peripheralID: $0) },
            write: { await transport.write(peripheralID: $0, data: $1) },
            unsubscribe: { _ in }
        )
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: mapper,
            transferControl: control,
            resolvePeripheralID: { "peripheral-1" }
        )
        var stream = await host.execute(fixture.startEffect()).makeAsyncIterator()

        let started = try await stream.next()

        XCTAssertEqual(started?.kind, EncryptedUploadV2Abi.eventTransferStarted)
        let writes = await transport.writes
        XCTAssertEqual(writes.map(\.first), [0x20])
        let subscribedPeripheralID = await transport.subscribedPeripheralID
        XCTAssertEqual(subscribedPeripheralID, "peripheral-1")
    }

    func testReloadedCheckpointRestoresTheNativeSequenceSidecarForResume() async throws {
        let fixture = try Fixture()
        let firstHost = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        var first = await firstHost.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await first.next()
        fixture.sendCleanWindow()
        _ = try await first.next()
        let coreCheckpoint = Data("opaque-core-checkpoint".utf8)
        _ = try await Self.collect(await firstHost.execute(
            fixture.checkpointEffect(
                kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
                checkpoint: coreCheckpoint
            )
        ))
        let snapshot = try await firstHost.checkpoint(
            serialNumber: fixture.serialNumber,
            recordingUUID: fixture.recordingUUID,
            recordingGeneration: 7
        )
        XCTAssertEqual(snapshot?.uploadSessionID, fixture.uploadSessionID)
        XCTAssertEqual(snapshot?.transportSessionID, fixture.transportSessionID)
        XCTAssertEqual(snapshot?.sinkID, fixture.sinkID)
        XCTAssertEqual(snapshot?.windowPackets, 4)
        XCTAssertEqual(snapshot?.dataPayloadBytes, 4)

        let resumed = CapturedNativeCheckpoint()
        let resumeNotifications = AsyncThrowingStream<Data, Error>.makeStream()
        let reloadedHost = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, checkpoint in
                await resumed.set(checkpoint)
                return .opened(resumeNotifications.stream)
            },
            sendControl: { _ in }
        )
        let loaded = try await Self.collect(await reloadedHost.execute(fixture.loadEffect()))
        XCTAssertEqual(loaded, [.init(
            kind: EncryptedUploadV2Abi.eventCheckpointLoaded,
            fields: [.bytes(id: 28, value: coreCheckpoint)]
        )])
        let truncated = try await Self.collect(await reloadedHost.execute(
            fixture.truncateEffect(nextOffset: UInt64(fixture.ciphertext.count))
        ))
        XCTAssertEqual(truncated.map(\.kind), [EncryptedUploadV2Abi.eventSinkTruncated])

        var start = await reloadedHost.execute(
            fixture.startEffect(checkpoint: coreCheckpoint)
        ).makeAsyncIterator()
        _ = try await start.next()

        let checkpoint = await resumed.value
        XCTAssertEqual(checkpoint, .init(
            revision: 1,
            nextCiphertextOffset: UInt64(fixture.ciphertext.count),
            prefixSHA256: fixture.ciphertextSHA256,
            highestContiguousSequence: 1
        ))

        let deleted = try await Self.collect(await reloadedHost.execute(fixture.deleteEffect()))
        XCTAssertTrue(deleted.isEmpty)
        let emptyHost = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        let afterDelete = try await Self.collect(await emptyHost.execute(fixture.loadEffect()))
        XCTAssertEqual(afterDelete, [.init(kind: EncryptedUploadV2Abi.eventCheckpointLoaded)])
    }

    func testAbortReleasesTheExactLiveTransportAndEndsItsStream() async throws {
        let fixture = try Fixture()
        let aborted = CapturedTransportSession()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in },
            abortTransfer: { sessionID in await aborted.set(sessionID) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()

        let abortEvents = try await Self.collect(await host.execute(fixture.abortEffect()))

        XCTAssertTrue(abortEvents.isEmpty)
        let abortedSessionID = await aborted.value
        XCTAssertEqual(abortedSessionID, fixture.transportSessionID)
        let terminal = try await start.next()
        XCTAssertNil(terminal)
    }

    func testCompletedTransferRetainsTheLiveOwnerUntilCoreAborts() async throws {
        let fixture = try Fixture()
        let aborted = CapturedTransportSession()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in },
            abortTransfer: { sessionID in await aborted.set(sessionID) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.sendCleanWindow()
        _ = try await start.next()
        let checkpoint = Data("opaque-core-checkpoint".utf8)
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
            checkpoint: checkpoint
        )))
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectAcknowledgeWindow,
            checkpoint: checkpoint
        )))
        fixture.sendManifestAndEOF()
        _ = try await start.next()

        _ = try await Self.collect(await host.execute(fixture.abortEffect()))

        let abortedSessionID = await aborted.value
        XCTAssertEqual(abortedSessionID, fixture.transportSessionID)
    }

    func testMalformedTransferRetainsTheLiveOwnerUntilCoreAborts() async throws {
        let fixture = try Fixture()
        let aborted = CapturedTransportSession()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in },
            abortTransfer: { sessionID in await aborted.set(sessionID) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID + 1,
            sequence: 1,
            offset: 0,
            bytes: fixture.ciphertext
        ))
        do {
            _ = try await start.next()
            XCTFail("Expected the foreign transfer packet to fail")
        } catch {}

        _ = try await Self.collect(await host.execute(fixture.abortEffect()))

        let abortedSessionID = await aborted.value
        XCTAssertEqual(abortedSessionID, fixture.transportSessionID)
    }

    func testAbortWhileStartIsOpeningCannotResurrectATransfer() async throws {
        let fixture = try Fixture()
        let opening = SuspendedTransferOpen(result: .opened(fixture.notifications.stream))
        let aborted = CapturedTransportSession()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in try await opening.open() },
            sendControl: { _ in },
            abortTransfer: { sessionID in await aborted.set(sessionID) }
        )
        let startTask = Task { await host.execute(fixture.startEffect()) }
        await opening.waitUntilEntered()

        let abortEffect = fixture.abortEffect()
        let abortTask = Task.detached { @Sendable in
            var values: [CoreHostEventPayload] = []
            for try await value in await host.execute(abortEffect) { values.append(value) }
            return values
        }
        await opening.waitUntilCancelled()
        await opening.resume()
        _ = try await abortTask.value
        var start = await startTask.value.makeAsyncIterator()
        do {
            _ = try await start.next()
            XCTFail("Expected the cancelled opening transfer to stay cancelled")
        } catch {}

        let abortedSessionID = await aborted.value
        XCTAssertEqual(abortedSessionID, fixture.transportSessionID)
    }

    func testAbortedWindowAcknowledgementCannotMutateANewerTransferGeneration() async throws {
        let fixture = try Fixture()
        let secondNotifications = AsyncThrowingStream<Data, Error>.makeStream()
        let streams = TransferStreamSequence([
            fixture.notifications.stream,
            secondNotifications.stream,
        ])
        let suspendedControl = SuspendedControlSend()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(try streams.next()) },
            sendControl: { data in try await suspendedControl.send(data) }
        )
        var first = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await first.next()
        fixture.sendCleanWindow()
        _ = try await first.next()
        let checkpoint = Data("opaque-core-checkpoint".utf8)
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
            checkpoint: checkpoint
        )))

        let acknowledgeEffect = fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectAcknowledgeWindow,
            checkpoint: checkpoint
        )
        let staleAcknowledgement = Task.detached { @Sendable in
            try await Self.collect(await host.execute(acknowledgeEffect))
        }
        await suspendedControl.waitUntilEntered()
        _ = try await Self.collect(await host.execute(fixture.abortEffect()))
        _ = try await Self.collect(await host.execute(fixture.deleteEffect()))
        _ = try await Self.collect(await host.execute(fixture.truncateEffect(nextOffset: 0)))

        var second = await host.execute(fixture.startEffect()).makeAsyncIterator()
        let secondStarted = try await second.next()
        XCTAssertEqual(secondStarted?.kind, EncryptedUploadV2Abi.eventTransferStarted)
        await suspendedControl.resume()
        do {
            _ = try await staleAcknowledgement.value
            XCTFail("Expected the stale acknowledgement to fail after abort")
        } catch {}

        secondNotifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: fixture.ciphertext
        ))
        secondNotifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 1,
            nextOffset: UInt64(fixture.ciphertext.count),
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))
        let secondWindow = try await second.next()
        XCTAssertEqual(secondWindow?.kind, EncryptedUploadV2Abi.eventWindowStaged)
    }

    func testTruncateRejectsASinkIDThatCanEscapeTheStorageDirectory() async throws {
        let fixture = try Fixture()
        let victimName = "encrypted-upload-v2-victim-\(UUID().uuidString)"
        let victimURL = fixture.root.deletingLastPathComponent()
            .appendingPathComponent(victimName)
            .appendingPathExtension("encrypted-upload-v2")
        let original = Data("must-survive".utf8)
        try original.write(to: victimURL)
        defer { try? FileManager.default.removeItem(at: victimURL) }
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        let effect = CoreEffect.encryptedUploadV2TruncateSink(CorePacket(
            kind: EncryptedUploadV2Abi.effectTruncateSink,
            operation: 8,
            requestID: 7,
            cancellationHigh: 2,
            cancellationLow: 3,
            fields: [
                .text(id: EncryptedUploadV2Abi.fieldSinkID, value: "../\(victimName)"),
                .unsigned(id: EncryptedUploadV2Abi.fieldOffset, value: 0),
            ]
        ))

        do {
            _ = try await Self.collect(await host.execute(effect))
            XCTFail("Expected an invalid sink ID to be rejected")
        } catch {}

        XCTAssertEqual(try Data(contentsOf: victimURL), original)
    }

    func testNotificationReaderRejectsBufferedBytesBeyondItsBound() async throws {
        let notifications = AsyncThrowingStream<Data, Error>.makeStream()
        let reader = EncryptedUploadV2NotificationReader(
            notifications.stream,
            maximumBufferedBytes: 100,
            maximumBufferedEvents: 1
        )
        await reader.start()
        notifications.continuation.yield(Data([1]))
        notifications.continuation.yield(Data([2]))
        await reader.waitUntilObserved(count: 2)

        do {
            _ = try await reader.next()
            XCTFail("Expected bounded notification buffering to fail closed")
        } catch let error as EncryptedUploadV2NotificationReaderError {
            XCTAssertEqual(error, .bufferLimitExceeded)
        }
    }

    func testNotificationReaderRejectsEmptyPayloadWithoutBufferingIt() async throws {
        let notifications = AsyncThrowingStream<Data, Error>.makeStream()
        let reader = EncryptedUploadV2NotificationReader(
            notifications.stream,
            maximumBufferedBytes: 100,
            maximumBufferedEvents: 2
        )
        await reader.start()
        notifications.continuation.yield(Data())
        await reader.waitUntilObserved(count: 1)

        do {
            _ = try await reader.next()
            XCTFail("Expected an empty notification to fail closed")
        } catch let error as EncryptedUploadV2NotificationReaderError {
            XCTAssertEqual(error, .invalidPayload)
        }
    }

    func testDurableCheckpointStoreSynchronizesReplacementAndDeletionDirectories() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = root.appendingPathComponent("checkpoint.json")
        let syncs = DirectorySyncProbe()
        let store = EncryptedUploadV2DurableFileStore(
            syncDirectory: { directory in syncs.record(directory) }
        )
        let value = Data("durable-checkpoint".utf8)

        try store.replace(value, at: url)
        XCTAssertEqual(try Data(contentsOf: url), value)
        XCTAssertEqual(syncs.paths, [root.deletingLastPathComponent().path, root.path])

        try store.removeIfPresent(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(syncs.paths, [
            root.deletingLastPathComponent().path,
            root.path,
            root.path,
        ])
    }

    func testDataBeforeCleanWindowAckFailsWithoutSendingTheAck() async throws {
        let fixture = try Fixture(ciphertext: Data("abcdefgh".utf8))
        let controls = SentControls()
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { data in await controls.append(data) }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("abcd".utf8)
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 1,
            nextOffset: 4,
            prefixSHA256: Data(SHA256.hash(data: Data("abcd".utf8))),
            checkpointRevision: 1
        ))
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 2,
            offset: 4,
            bytes: Data("efgh".utf8)
        ))
        await host.waitUntilNotificationObserved(count: 3)
        let checkpoint = Data("opaque-core-checkpoint".utf8)
        _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
            kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
            checkpoint: checkpoint
        )))

        do {
            _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
                kind: EncryptedUploadV2Abi.effectAcknowledgeWindow,
                checkpoint: checkpoint
            )))
            XCTFail("Expected pre-ACK transfer traffic to fail closed")
        } catch {}
        let sent = await controls.values
        XCTAssertTrue(sent.isEmpty)
    }

    func testMissingWindowCannotWriteADurableCheckpoint() async throws {
        let fixture = try Fixture(ciphertext: Data("abcdef".utf8))
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 2,
            nextOffset: 6,
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))
        _ = try await start.next()

        do {
            _ = try await Self.collect(await host.execute(fixture.checkpointEffect(
                kind: EncryptedUploadV2Abi.effectSaveCheckpoint,
                checkpoint: Data("must-not-persist".utf8)
            )))
            XCTFail("Expected an incomplete window to reject checkpoint persistence")
        } catch {}

        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.checkpointURL.path))
    }

    func testRepairFailureOwnsOneErrorAndClosesTheOriginalStartStreamSilently() async throws {
        let fixture = try Fixture(ciphertext: Data("abcdef".utf8))
        let host = EncryptedUploadV2TransferHost(
            rootDirectory: fixture.root,
            mapper: try CoreModelMapper(),
            openTransfer: { _, _ in .opened(fixture.notifications.stream) },
            sendControl: { _ in }
        )
        var start = await host.execute(fixture.startEffect()).makeAsyncIterator()
        _ = try await start.next()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID,
            sequence: 1,
            offset: 0,
            bytes: Data("ab".utf8)
        ))
        fixture.notifications.continuation.yield(Self.windowEnd(
            sessionID: fixture.transportSessionID,
            windowIndex: 1,
            firstSequence: 1,
            lastSequence: 2,
            nextOffset: 6,
            prefixSHA256: fixture.ciphertextSHA256,
            checkpointRevision: 1
        ))
        _ = try await start.next()
        var repair = await host.execute(
            fixture.repairEffect(missingSequences: [2])
        ).makeAsyncIterator()
        fixture.notifications.continuation.yield(Self.dataPacket(
            sessionID: fixture.transportSessionID + 1,
            sequence: 2,
            offset: 2,
            bytes: Data("cdef".utf8)
        ))

        do {
            _ = try await repair.next()
            XCTFail("Expected the repair owner to receive the terminal error")
        } catch {}
        let terminal = try await start.next()
        XCTAssertNil(terminal)
    }

    private struct Fixture: @unchecked Sendable {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let notifications = AsyncThrowingStream<Data, Error>.makeStream()
        let serialNumber = "EVFXXW67KP"
        let recordingUUID = "00112233-4455-6677-8899-aabbccddeeff"
        let sinkID = "53B6CE85-B90A-4C11-9359-FD7E3A5B3344"
        let transportSessionID: UInt64 = 0x0000_1122_3344_5566
        let uploadSessionID = UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")!
        let ciphertext: Data
        let dataPayloadBytes: UInt16
        let manifest = Data((0..<580).map { UInt8($0 % 251) })

        init(ciphertext: Data = Data("abcd".utf8), dataPayloadBytes: UInt16 = 4) throws {
            self.ciphertext = ciphertext
            self.dataPayloadBytes = dataPayloadBytes
        }

        static func lostAck() throws -> Self {
            try Self(ciphertext: Data("abcd".utf8) + Data(repeating: 0, count: 268), dataPayloadBytes: 300)
        }

        var uploadSessionBytes: Data {
            withUnsafeBytes(of: uploadSessionID.uuid) { Data($0) }
        }

        var ciphertextSHA256: Data { Data(SHA256.hash(data: ciphertext)) }
        var manifestSHA256: Data { Data(SHA256.hash(data: manifest)) }

        var fileURL: URL {
            root.appendingPathComponent(sinkID).appendingPathExtension("encrypted-upload-v2")
        }

        var checkpointURL: URL {
            root.appendingPathComponent("Checkpoints", isDirectory: true)
                .appendingPathComponent(uploadSessionID.uuidString)
                .appendingPathExtension("json")
        }

        func startEffect(
            checkpoint: Data? = nil,
            authorizationSHA256: Data = Data(repeating: 0x66, count: 32)
        ) -> CoreEffect {
            var fields: [CoreField] = [
                .text(id: 3, value: serialNumber),
                .text(id: 13, value: recordingUUID),
                .unsigned(id: 129, value: 7),
                .unsigned(id: 147, value: 3),
                .bytes(id: 132, value: uploadSessionBytes),
                .unsigned(id: 165, value: 9),
                .unsigned(id: 128, value: transportSessionID),
                .text(id: 12, value: "material-id"),
                .text(id: 14, value: sinkID),
                .unsigned(id: 166, value: 3),
                .unsigned(id: 167, value: 3),
                .unsigned(id: 137, value: 0x7f),
                .unsigned(id: 138, value: 1024),
                .unsigned(id: 139, value: 580),
                .unsigned(id: 169, value: UInt64(dataPayloadBytes)),
                .unsigned(id: 170, value: 4),
                .unsigned(id: 140, value: 1),
                .unsigned(id: 141, value: 2),
                .unsigned(id: 134, value: 4),
                .unsigned(id: 135, value: UInt64(dataPayloadBytes)),
                .unsigned(id: 130, value: UInt64(ciphertext.count)),
                .bytes(id: 144, value: ciphertextSHA256),
                .bytes(id: 161, value: authorizationSHA256),
            ]
            if let checkpoint { fields.append(.bytes(id: 28, value: checkpoint)) }
            return .encryptedUploadV2StartTransfer(CorePacket(
                kind: EncryptedUploadV2Abi.effectStartTransfer,
                operation: 8,
                requestID: 1,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: fields
            ))
        }

        func loadEffect() -> CoreEffect {
            .encryptedUploadV2LoadCheckpoint(CorePacket(
                kind: EncryptedUploadV2Abi.effectLoadCheckpoint,
                operation: 8,
                requestID: 3,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [
                    .text(id: 3, value: serialNumber),
                    .text(id: 13, value: recordingUUID),
                    .unsigned(id: 129, value: 7),
                    .bytes(id: 132, value: uploadSessionBytes),
                    .unsigned(id: 165, value: 9),
                ]
            ))
        }

        func truncateEffect(nextOffset: UInt64) -> CoreEffect {
            .encryptedUploadV2TruncateSink(CorePacket(
                kind: EncryptedUploadV2Abi.effectTruncateSink,
                operation: 8,
                requestID: 4,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [
                    .text(id: 14, value: sinkID),
                    .unsigned(id: 39, value: nextOffset),
                ]
            ))
        }

        func deleteEffect() -> CoreEffect {
            .encryptedUploadV2DeleteCheckpoint(CorePacket(
                kind: EncryptedUploadV2Abi.effectDeleteCheckpoint,
                operation: 8,
                requestID: 5,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [.bytes(id: 132, value: uploadSessionBytes)]
            ))
        }

        func abortEffect() -> CoreEffect {
            .encryptedUploadV2Abort(CorePacket(
                kind: EncryptedUploadV2Abi.effectAbort,
                operation: 8,
                requestID: 6,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [.text(id: 12, value: "material-id")]
            ))
        }

        func prepareEffect() -> CoreEffect {
            .encryptedUploadV2PrepareSession(CorePacket(
                kind: EncryptedUploadV2Abi.effectPrepareSession,
                operation: 8,
                requestID: 7,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [.text(id: EncryptedUploadV2Abi.fieldMaterialID, value: "material-id")]
            ))
        }

        func stageEffect() -> CoreEffect {
            .encryptedUploadV2StageArtifacts(evidenceEffect(
                kind: EncryptedUploadV2Abi.effectStageArtifacts,
                requestID: 8,
                includeSink: true
            ))
        }

        func awaitReceiptEffect() -> CoreEffect {
            .encryptedUploadV2AwaitReceipt(evidenceEffect(
                kind: EncryptedUploadV2Abi.effectAwaitReceipt,
                requestID: 9,
                includeSink: false
            ))
        }

        func confirmEffect(receiptSHA256: Data) -> CoreEffect {
            .encryptedUploadV2ConfirmWithReceipt(CorePacket(
                kind: EncryptedUploadV2Abi.effectConfirmWithReceipt,
                operation: 8,
                requestID: 10,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [
                    .text(id: EncryptedUploadV2Abi.fieldMaterialID, value: "material-id"),
                    .bytes(id: EncryptedUploadV2Abi.fieldReceiptSHA256, value: receiptSHA256),
                ]
            ))
        }

        private func evidenceEffect(kind: UInt32, requestID: UInt64, includeSink: Bool) -> CorePacket {
            var fields: [CoreField] = [
                .text(id: EncryptedUploadV2Abi.fieldMaterialID, value: "material-id"),
                .unsigned(id: EncryptedUploadV2Abi.fieldCiphertextLength, value: UInt64(ciphertext.count)),
                .bytes(id: EncryptedUploadV2Abi.fieldCiphertextSHA256, value: ciphertextSHA256),
                .unsigned(id: EncryptedUploadV2Abi.fieldManifestLength, value: UInt64(manifest.count)),
                .bytes(id: EncryptedUploadV2Abi.fieldManifestSHA256, value: manifestSHA256),
                .unsigned(id: EncryptedUploadV2Abi.fieldBlockCount, value: 1),
            ]
            if includeSink {
                fields.append(.text(id: EncryptedUploadV2Abi.fieldSinkID, value: sinkID))
            }
            return CorePacket(
                kind: kind,
                operation: 8,
                requestID: requestID,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: fields
            )
        }

        func checkpointEffect(kind: UInt32, checkpoint: Data) -> CoreEffect {
            let packet = CorePacket(
                kind: kind,
                operation: 8,
                requestID: UInt64(kind),
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [.bytes(id: 28, value: checkpoint)]
            )
            switch kind {
            case EncryptedUploadV2Abi.effectSaveCheckpoint:
                return .encryptedUploadV2SaveCheckpoint(packet)
            case EncryptedUploadV2Abi.effectAcknowledgeWindow:
                return .encryptedUploadV2AcknowledgeWindow(packet)
            default:
                preconditionFailure("unsupported checkpoint effect")
            }
        }

        func repairEffect(missingSequences: [UInt32]) -> CoreEffect {
            var bytes = Data()
            for sequence in missingSequences { bytes.appendLE(sequence) }
            return .encryptedUploadV2RepairWindow(CorePacket(
                kind: EncryptedUploadV2Abi.effectRepairWindow,
                operation: 8,
                requestID: 2,
                cancellationHigh: 2,
                cancellationLow: 3,
                fields: [.bytes(id: 136, value: bytes)]
            ))
        }

        func sendCleanWindow() {
            notifications.continuation.yield(EncryptedUploadV2TransferHostTests.dataPacket(
                sessionID: transportSessionID,
                sequence: 1,
                offset: 0,
                bytes: ciphertext
            ))
            notifications.continuation.yield(EncryptedUploadV2TransferHostTests.windowEnd(
                sessionID: transportSessionID,
                windowIndex: 1,
                firstSequence: 1,
                lastSequence: 1,
                nextOffset: UInt64(ciphertext.count),
                prefixSHA256: ciphertextSHA256,
                checkpointRevision: 1
            ))
        }

        func sendManifestAndEOF() {
            notifications.continuation.yield(EncryptedUploadV2TransferHostTests.manifestChunk(
                sessionID: transportSessionID,
                totalLength: UInt16(manifest.count),
                offset: 0,
                digest: manifestSHA256,
                bytes: Data(manifest[0..<300])
            ))
            notifications.continuation.yield(EncryptedUploadV2TransferHostTests.manifestChunk(
                sessionID: transportSessionID,
                totalLength: UInt16(manifest.count),
                offset: 300,
                digest: manifestSHA256,
                bytes: Data(manifest[300..<580])
            ))
            notifications.continuation.yield(EncryptedUploadV2TransferHostTests.eof(
                sessionID: transportSessionID,
                finalSequence: 1,
                ciphertextLength: UInt64(ciphertext.count),
                ciphertextSHA256: ciphertextSHA256,
                manifestSHA256: manifestSHA256
            ))
        }

        func startAcknowledgement() -> Data {
            var data = EncryptedUploadV2TransferHostTests.header(
                type: 0x40,
                sessionID: transportSessionID
            )
            data.append(uploadSessionBytes)
            data.append(Self.uuidBytes(recordingUUID))
            data.appendLE(UInt32(7))
            data.appendLE(UInt64(ciphertext.count))
            data.append(ciphertextSHA256)
            data.appendLE(UInt16(4))
            data.appendLE(dataPayloadBytes)
            data.appendLE(UInt32(1))
            data.appendLE(UInt32(0))
            data.appendLE(UInt64(0))
            data.append(Data(SHA256.hash(data: Data())))
            return data
        }

        func resumeRejection(
            offset: UInt64, revision: UInt32? = nil, reason: UInt16 = 0x0f,
            prefix: Data? = nil, sessionID: UInt64? = nil
        ) -> Data {
            var data = EncryptedUploadV2TransferHostTests.header(type: 0x46, sessionID: sessionID ?? transportSessionID)
            data.appendLE(reason)
            data.appendLE(UInt16(0))
            data.appendLE(revision ?? (offset == 0 ? 0 : 1))
            data.appendLE(offset)
            data.append(prefix ?? Data(SHA256.hash(data: ciphertext.prefix(Int(offset)))))
            return data
        }

        func openingAccepted(offset: UInt64) -> Data {
            if offset == 0 { return startAcknowledgement() }
            var data = EncryptedUploadV2TransferHostTests.header(type: 0x45, sessionID: transportSessionID)
            data.append(uploadSessionBytes)
            data.append(Self.uuidBytes(recordingUUID))
            data.appendLE(UInt32(7))
            data.appendLE(UInt32(1))
            data.appendLE(offset)
            data.append(Data(SHA256.hash(data: ciphertext.prefix(Int(offset)))))
            data.appendLE(UInt16(4))
            data.appendLE(dataPayloadBytes)
            return data
        }

        private static func uuidBytes(_ value: String) -> Data {
            let hex = value.replacingOccurrences(of: "-", with: "")
            return Data(stride(from: 0, to: hex.count, by: 2).map { offset in
                let start = hex.index(hex.startIndex, offsetBy: offset)
                return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
            })
        }
    }

    private static func dataPacket(
        sessionID: UInt64,
        sequence: UInt32,
        offset: UInt64,
        bytes: Data
    ) -> Data {
        var data = header(type: 0x41, sessionID: sessionID)
        data.appendLE(sequence)
        data.appendLE(offset)
        data.appendLE(UInt16(bytes.count))
        data.appendLE(UInt16(0))
        data.append(bytes)
        return data
    }

    private static func windowEnd(
        sessionID: UInt64,
        windowIndex: UInt32,
        firstSequence: UInt32,
        lastSequence: UInt32,
        nextOffset: UInt64,
        prefixSHA256: Data,
        checkpointRevision: UInt32
    ) -> Data {
        var data = header(type: 0x42, sessionID: sessionID)
        data.appendLE(windowIndex)
        data.appendLE(firstSequence)
        data.appendLE(lastSequence)
        data.appendLE(nextOffset)
        data.append(prefixSHA256)
        data.appendLE(checkpointRevision)
        return data
    }

    private static func manifestChunk(
        sessionID: UInt64,
        totalLength: UInt16,
        offset: UInt16,
        digest: Data,
        bytes: Data
    ) -> Data {
        var data = header(type: 0x43, sessionID: sessionID)
        data.appendLE(totalLength)
        data.appendLE(offset)
        data.appendLE(UInt16(bytes.count))
        data.appendLE(UInt16(0))
        data.append(digest)
        data.append(bytes)
        return data
    }

    private static func eof(
        sessionID: UInt64,
        finalSequence: UInt32,
        ciphertextLength: UInt64,
        ciphertextSHA256: Data,
        manifestSHA256: Data
    ) -> Data {
        var data = header(type: 0x44, sessionID: sessionID)
        data.appendLE(finalSequence)
        data.appendLE(UInt32(1))
        data.appendLE(ciphertextLength)
        data.append(ciphertextSHA256)
        data.append(manifestSHA256)
        return data
    }

    private static func header(type: UInt8, sessionID: UInt64) -> Data {
        var data = Data([type, 0x02, 0, 0])
        data.appendLE(sessionID)
        return data
    }

    private static func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
        data[offset..<(offset + 2)].enumerated().reduce(0) { value, pair in
            value | (UInt16(pair.element) << UInt16(pair.offset * 8))
        }
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        data[offset..<(offset + 4)].enumerated().reduce(0) { value, pair in
            value | (UInt32(pair.element) << UInt32(pair.offset * 8))
        }
    }

    private static func collect(
        _ stream: AsyncThrowingStream<CoreHostEventPayload, Error>
    ) async throws -> [CoreHostEventPayload] {
        var values: [CoreHostEventPayload] = []
        for try await value in stream { values.append(value) }
        return values
    }
}

private actor SentControls {
    private(set) var values: [Data] = []
    func append(_ value: Data) { values.append(value) }
}

private actor LostAckTransport {
    private var replies: [Data]
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private(set) var frames: [Data] = []
    private(set) var subscriptionCount = 0

    init(replies: [Data]) { self.replies = replies }

    func subscribe() -> AsyncThrowingStream<Data, Error> {
        subscriptionCount += 1
        return AsyncThrowingStream { continuation = $0 }
    }

    func write(_ frame: Data) {
        frames.append(frame)
        if frame.first == 0x20 || frame.first == 0x22 {
            if replies.isEmpty { continuation?.finish() }
            else { continuation?.yield(replies.removeFirst()) }
        }
    }

    func yield(_ data: Data) { continuation?.yield(data) }
    func unsubscribe() { continuation?.finish(); continuation = nil }
}

private actor TransferHostTransport {
    private let startAcknowledgement: Data
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private(set) var subscribedPeripheralID: String?
    private(set) var writes: [Data] = []

    init(startAcknowledgement: Data) {
        self.startAcknowledgement = startAcknowledgement
    }

    func subscribe(peripheralID: String) throws -> AsyncThrowingStream<Data, Error> {
        subscribedPeripheralID = peripheralID
        return AsyncThrowingStream { continuation = $0 }
    }

    func write(peripheralID: String, data: Data) {
        writes.append(data)
        if data.first == 0x20 { continuation?.yield(startAcknowledgement) }
    }
}

private actor CapturedNativeCheckpoint {
    private(set) var value: EncryptedUploadV2CheckpointValue?
    func set(_ value: EncryptedUploadV2CheckpointValue?) { self.value = value }
}

private enum EncryptedUploadV2CompletionCall: Equatable, Sendable {
    case context
    case signed(kind: UInt8, document: Data)
    case stagingRequest
    case upload(Data)
    case manifest(Data)
    case finalize
    case receipt
    case confirm(Data)
    case cancel
}

private actor EncryptedUploadV2CompletionCalls {
    private(set) var values: [EncryptedUploadV2CompletionCall] = []
    func append(_ value: EncryptedUploadV2CompletionCall) { values.append(value) }
}

private actor SuspendedFirstCompletionCall {
    private var enteredContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<Void, Never>?
    private var entered = false
    private var callCount = 0

    func suspendFirst() async {
        callCount += 1
        guard callCount == 1 else { return }
        entered = true
        enteredContinuation?.resume()
        enteredContinuation = nil
        await withCheckedContinuation { resumeContinuation = $0 }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enteredContinuation = $0 }
    }

    func hasEntered() -> Bool { entered }

    func resume() {
        resumeContinuation?.resume()
        resumeContinuation = nil
    }
}

private actor CapturedTransportSession {
    private(set) var value: UInt64?
    func set(_ value: UInt64) { self.value = value }
}

private actor SuspendedTransferOpen {
    private let result: EncryptedUploadV2TransferOpenResult
    private var enteredContinuation: CheckedContinuation<Void, Never>?
    private var cancelledContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<Void, Never>?
    private var entered = false
    private var cancelled = false
    private var resumed = false

    init(result: EncryptedUploadV2TransferOpenResult) {
        self.result = result
    }

    func open() async throws -> EncryptedUploadV2TransferOpenResult {
        entered = true
        enteredContinuation?.resume()
        enteredContinuation = nil
        await withTaskCancellationHandler {
            if !resumed {
                await withCheckedContinuation { resumeContinuation = $0 }
            }
        } onCancel: {
            Task { await self.observeCancellation() }
        }
        return result
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enteredContinuation = $0 }
    }

    func resume() {
        resumed = true
        resumeContinuation?.resume()
        resumeContinuation = nil
    }

    func waitUntilCancelled() async {
        if cancelled { return }
        await withCheckedContinuation { cancelledContinuation = $0 }
    }

    private func observeCancellation() {
        cancelled = true
        cancelledContinuation?.resume()
        cancelledContinuation = nil
    }
}

private final class TransferStreamSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var streams: [AsyncThrowingStream<Data, Error>]

    init(_ streams: [AsyncThrowingStream<Data, Error>]) {
        self.streams = streams
    }

    func next() throws -> AsyncThrowingStream<Data, Error> {
        try lock.withLock {
            guard !streams.isEmpty else {
                throw NSError(domain: "EncryptedUploadV2TransferHostTests", code: 1)
            }
            return streams.removeFirst()
        }
    }
}

private actor SuspendedControlSend {
    private var enteredContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<Void, Never>?
    private var entered = false
    private var resumed = false

    func send(_: Data) async throws {
        entered = true
        enteredContinuation?.resume()
        enteredContinuation = nil
        if !resumed {
            await withCheckedContinuation { resumeContinuation = $0 }
        }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enteredContinuation = $0 }
    }

    func resume() {
        resumed = true
        resumeContinuation?.resume()
        resumeContinuation = nil
    }
}

private final class DirectorySyncProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []

    var paths: [String] {
        lock.withLock { storage.map { ($0.path as NSString).standardizingPath } }
    }

    func record(_ url: URL) {
        lock.withLock { storage.append(url) }
    }
}

private final class DirectorySyncFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var shouldFail = false

    func setShouldFail(_ value: Bool) {
        lock.withLock { shouldFail = value }
    }

    func sync(_: URL) throws {
        let fails = lock.withLock { shouldFail }
        if fails {
            throw NSError(domain: "EncryptedUploadV2TransferHostTests", code: 2)
        }
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
