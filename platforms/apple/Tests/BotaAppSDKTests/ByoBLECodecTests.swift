import Foundation
import XCTest
@testable import BotaAppSDK

final class ByoBLECodecTests: XCTestCase {
    func testEncodingUsesIndependentTypedABI() throws {
        let abi = TestCoreAbi()
        abi.enqueuePacket(.init(kind: 0x052e, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: [.bytes(id: 30, value: Data([112]))]))
        let codec = ByoBLECodec(core: try CoreAbiClient(abi: abi))
        XCTAssertEqual(try codec.encode(opcode: 112, operation: 2, requestID: 1,
            offset: 0, total: 20, payload: Data(repeating: 0, count: 20), capacity: 244), Data([112]))
    }
    func testDecoderRejectsMissingTypedMetadata() throws {
        let abi = TestCoreAbi()
        abi.enqueuePacket(.init(kind: 0x052f, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: []))
        XCTAssertThrowsError(try ByoBLECodec(core: CoreAbiClient(abi: abi)).decode(Data([113])))
    }
}
