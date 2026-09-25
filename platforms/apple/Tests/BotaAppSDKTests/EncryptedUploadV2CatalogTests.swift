import CryptoKit
import Foundation
import XCTest
@testable import BotaAppSDK

final class EncryptedUploadV2CatalogTests: XCTestCase {
    func testBothSubscriptionsPrecedeListAndAreReleasedAtValidatedEnd() async throws {
        let io = CatalogIO()
        let catalog = EncryptedUploadV2Catalog(mapper: try CoreModelMapper(),
            subscribe: { _, uuid in await io.subscribe(uuid) },
            write: { _, bytes in await io.write(bytes) },
            unsubscribe: { _, uuid in await io.unsubscribe(uuid) })
        let values = try await catalog.list(peripheralID: "device")
        XCTAssertTrue(values.isEmpty)
        let calls = await io.calls
        XCTAssertEqual(calls, ["list-subscribe", "error-subscribe", "write", "list-unsubscribe", "error-unsubscribe"])
    }

    func testMalformedCatalogReleasesBothSubscriptionsWithoutFallback() async throws {
        let io = CatalogIO(malformed: true)
        let catalog = EncryptedUploadV2Catalog(mapper: try CoreModelMapper(),
            subscribe: { _, uuid in await io.subscribe(uuid) },
            write: { _, bytes in await io.write(bytes) },
            unsubscribe: { _, uuid in await io.unsubscribe(uuid) })
        do { _ = try await catalog.list(peripheralID: "device"); XCTFail("Malformed list must reject") } catch {}
        let calls = await io.calls
        XCTAssertEqual(calls, ["list-subscribe", "error-subscribe", "write", "list-unsubscribe", "error-unsubscribe"])
    }
}

private actor CatalogIO {
    let malformed: Bool
    var calls: [String] = []
    var streams: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    init(malformed: Bool = false) { self.malformed = malformed }
    func subscribe(_ uuid: String) -> AsyncThrowingStream<Data, Error> {
        calls.append(uuid == BotaBluetoothUUIDs.recordingListV2 ? "list-subscribe" : "error-subscribe")
        let pair = AsyncThrowingStream<Data, Error>.makeStream()
        streams[uuid] = pair.continuation
        return pair.stream
    }
    func write(_ command: Data) {
        calls.append("write")
        let end = Data([0x49, 2, 0, 0]) + Data(command[4..<12])
            + Data([0, 0, 0, 0, 1, 0, 0, 0]) + Data(SHA256.hash(data: Data()))
        streams[BotaBluetoothUUIDs.recordingListV2]?.yield(malformed ? end + Data([0]) : end)
    }
    func unsubscribe(_ uuid: String) {
        calls.append(uuid == BotaBluetoothUUIDs.recordingListV2 ? "list-unsubscribe" : "error-unsubscribe")
        streams.removeValue(forKey: uuid)?.finish()
    }
}
