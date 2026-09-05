import CryptoKit
import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2TransferHostTests: XCTestCase {
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

        let ackEvents = try await Self.collect(await host.execute(
            fixture.checkpointEffect(kind: EncryptedUploadV2Abi.effectAcknowledgeWindow, checkpoint: checkpoint)
        ))
        XCTAssertEqual(ackEvents, [.init(
            kind: EncryptedUploadV2Abi.eventWindowAcknowledged,
            fields: [.bytes(id: 28, value: checkpoint)]
        )])
        let controlsAfterAck = await controls.values
        XCTAssertEqual(controlsAfterAck.count, 1)

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
            openTransfer: { _, _ in .resumeRejected },
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
        let manifest = Data((0..<580).map { UInt8($0 % 251) })

        init(ciphertext: Data = Data("abcd".utf8)) throws {
            self.ciphertext = ciphertext
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

        func startEffect(checkpoint: Data? = nil) -> CoreEffect {
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
                .unsigned(id: 169, value: 4),
                .unsigned(id: 170, value: 4),
                .unsigned(id: 140, value: 1),
                .unsigned(id: 141, value: 2),
                .unsigned(id: 134, value: 4),
                .unsigned(id: 135, value: 4),
                .unsigned(id: 130, value: UInt64(ciphertext.count)),
                .bytes(id: 144, value: ciphertextSHA256),
                .bytes(id: 161, value: Data(repeating: 0x66, count: 32)),
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
            data.appendLE(UInt16(4))
            data.appendLE(UInt32(1))
            data.appendLE(UInt32(0))
            data.appendLE(UInt64(0))
            data.append(Data(SHA256.hash(data: Data())))
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

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
