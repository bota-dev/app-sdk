import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class CoreAbiClientTests: XCTestCase {
    func testCopiesEveryFieldRepresentationAndFreesPacketOnce() throws {
        let abi = TestCoreAbi()
        abi.enqueuePacket(
            CorePacket(
                kind: 0x0301,
                operation: 7,
                requestID: 42,
                cancellationHigh: 11,
                cancellationLow: 12,
                fields: [
                    .unsigned(id: 1, value: 99),
                    .signed(id: 2, value: -67),
                    .bool(id: 3, value: true),
                    .text(id: 4, value: "Bota"),
                    .bytes(id: 5, value: Data([0, 255, 0, 127])),
                ]
            )
        )
        let client = try CoreAbiClient(abi: abi)

        let packet = try XCTUnwrap(client.pollOutput())

        XCTAssertEqual(
            packet,
            CorePacket(
                kind: 0x0301,
                operation: 7,
                requestID: 42,
                cancellationHigh: 11,
                cancellationLow: 12,
                fields: [
                    .unsigned(id: 1, value: 99),
                    .signed(id: 2, value: -67),
                    .bool(id: 3, value: true),
                    .text(id: 4, value: "Bota"),
                    .bytes(id: 5, value: Data([0, 255, 0, 127])),
                ]
            )
        )
        XCTAssertEqual(abi.packetFreeCount, 1)
    }

    func testCopiesEmptySlicesAndEmbeddedZeroBytes() throws {
        let abi = TestCoreAbi()
        abi.enqueuePacket(
            CorePacket(
                kind: 0x0501,
                operation: 2,
                requestID: 0,
                cancellationHigh: 0,
                cancellationLow: 0,
                fields: [
                    .text(id: 1, value: ""),
                    .bytes(id: 2, value: Data()),
                    .bytes(id: 3, value: Data([0, 1, 0])),
                ]
            )
        )
        let client = try CoreAbiClient(abi: abi)

        let packet = try XCTUnwrap(client.pollOutput())

        XCTAssertEqual(
            packet.fields,
            [
                .text(id: 1, value: ""),
                .bytes(id: 2, value: Data()),
                .bytes(id: 3, value: Data([0, 1, 0])),
            ]
        )
        XCTAssertEqual(abi.packetFreeCount, 1)
    }

    func testInvalidUTF8IsRejectedAfterPacketIsFreed() throws {
        let abi = TestCoreAbi()
        abi.enqueueRawPacket(
            kind: 0x0501,
            operation: 2,
            fields: [TestField(id: 1, type: BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8, data: [0xC3, 0x28])]
        )
        let client = try CoreAbiClient(abi: abi)

        XCTAssertThrowsError(try client.pollOutput()) { error in
            XCTAssertEqual((error as? CoreError)?.code, UInt32(BOTA_DEVICE_SDK_V1_ERROR_INVALID_INPUT))
        }
        XCTAssertEqual(abi.packetFreeCount, 1)
    }

    func testFailedCallCopiesStructuredErrorAndFreesErrorOnce() throws {
        let abi = TestCoreAbi()
        abi.startStatus = BOTA_DEVICE_SDK_V1_OPERATION_FAILED
        abi.error = TestError(
            code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_TIMEOUT),
            operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT),
            retryable: true,
            protocolStatus: 0x0085,
            detail: Array("service discovery timed out".utf8)
        )
        let client = try CoreAbiClient(abi: abi)

        XCTAssertThrowsError(
            try client.start(
                CorePacket(
                    kind: UInt32(BOTA_DEVICE_SDK_V1_COMMAND_CONNECT),
                    operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT),
                    requestID: 0,
                    cancellationHigh: 1,
                    cancellationLow: 2,
                    fields: [.text(id: 4, value: "peripheral")]
                ),
                capabilities: 1
            )
        ) { error in
            XCTAssertEqual(
                error as? CoreError,
                CoreError(
                    code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_TIMEOUT),
                    operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_CONNECT),
                    retryable: true,
                    protocolStatus: 0x0085,
                    detail: "service discovery timed out"
                )
            )
        }
        XCTAssertEqual(abi.errorFreeCount, 1)
    }

    func testInputSlicesRemainValidForCompleteNativeCall() throws {
        let abi = TestCoreAbi()
        abi.startInspection = { view in
            XCTAssertEqual(view.field_count, 5)
            let fields = try XCTUnwrap(view.fields)
            XCTAssertEqual(fields[0].unsigned_value, 7)
            XCTAssertEqual(fields[1].signed_value, -8)
            XCTAssertEqual(fields[2].unsigned_value, 1)
            XCTAssertEqual(TestCoreAbi.copyBytes(fields[3].data), Array("hello".utf8))
            XCTAssertEqual(TestCoreAbi.copyBytes(fields[4].data), [0, 2, 0])
        }
        let client = try CoreAbiClient(abi: abi)

        try client.start(
            CorePacket(
                kind: 0x0101,
                operation: 4,
                requestID: 9,
                cancellationHigh: 10,
                cancellationLow: 11,
                fields: [
                    .unsigned(id: 1, value: 7),
                    .signed(id: 2, value: -8),
                    .bool(id: 3, value: true),
                    .text(id: 4, value: "hello"),
                    .bytes(id: 5, value: Data([0, 2, 0])),
                ]
            ),
            capabilities: 3
        )

        XCTAssertEqual(abi.startCount, 1)
    }

    func testNoOutputReturnsNilWithoutFreeingAPacket() throws {
        let abi = TestCoreAbi()
        let client = try CoreAbiClient(abi: abi)

        XCTAssertNil(try client.pollOutput())
        XCTAssertEqual(abi.packetFreeCount, 0)
    }

    func testEngineOwnerFreesExactlyOnce() throws {
        let abi = TestCoreAbi()
        var client: CoreAbiClient? = try CoreAbiClient(abi: abi)

        XCTAssertNotNil(client)
        XCTAssertEqual(abi.engineNewCount, 1)
        client = nil

        XCTAssertEqual(abi.engineFreeCount, 1)
    }

    func testRealProtocolRoundTripCopiesBinaryOutput() throws {
        let client = try CoreAbiClient()

        let output = try client.protocolEncode(
            CorePacket(
                kind: UInt32(BOTA_DEVICE_SDK_V1_PROTOCOL_ENCODE_FIRMWARE_DATA),
                operation: 0,
                requestID: 0,
                cancellationHigh: 0,
                cancellationLow: 0,
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE), value: 0x1234),
                    .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD), value: Data([0, 255, 1])),
                ]
            )
        )

        XCTAssertEqual(
            output.fields,
            [.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: Data([0x20, 0x34, 0x12, 0, 255, 1]))]
        )
    }
}

private struct TestField {
    let id: UInt32
    let type: UInt32
    var unsigned: UInt64 = 0
    var signed: Int64 = 0
    var data: [UInt8] = []
}

private struct TestError {
    let code: UInt32
    let operation: UInt32
    let retryable: Bool
    let protocolStatus: UInt16?
    let detail: [UInt8]
}

private final class TestPacketStorage {
    let view: BotaDeviceSdkPacketViewV1
    private let fields: UnsafeMutablePointer<BotaDeviceSdkFieldViewV1>?
    private let buffers: [UnsafeMutablePointer<UInt8>?]

    init(kind: UInt32, operation: UInt32, requestID: UInt64 = 0, fields source: [TestField]) {
        var buffers: [UnsafeMutablePointer<UInt8>?] = []
        let fields = source.isEmpty ? nil : UnsafeMutablePointer<BotaDeviceSdkFieldViewV1>.allocate(capacity: source.count)
        for (index, sourceField) in source.enumerated() {
            let buffer: UnsafeMutablePointer<UInt8>?
            if sourceField.data.isEmpty {
                buffer = nil
            } else {
                let allocated = UnsafeMutablePointer<UInt8>.allocate(capacity: sourceField.data.count)
                allocated.initialize(from: sourceField.data, count: sourceField.data.count)
                buffer = allocated
            }
            buffers.append(buffer)
            fields?[index] = BotaDeviceSdkFieldViewV1(
                field_id: sourceField.id,
                field_type: sourceField.type,
                unsigned_value: sourceField.unsigned,
                signed_value: sourceField.signed,
                data: BotaDeviceSdkSliceV1(data: buffer, len: UInt64(sourceField.data.count))
            )
        }
        self.fields = fields
        self.buffers = buffers
        view = BotaDeviceSdkPacketViewV1(
            abi_version: UInt32(BOTA_DEVICE_SDK_ABI_VERSION),
            kind: kind,
            operation: operation,
            reserved: 0,
            request_id: requestID,
            cancellation_id_high: 11,
            cancellation_id_low: 12,
            fields: UnsafePointer(fields),
            field_count: UInt64(source.count)
        )
    }

    convenience init(packet: CorePacket) {
        self.init(
            kind: packet.kind,
            operation: packet.operation,
            requestID: packet.requestID,
            fields: packet.fields.map { field in
                switch field {
                case let .unsigned(id, value):
                    return TestField(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED), unsigned: value)
                case let .signed(id, value):
                    return TestField(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_SIGNED), signed: value)
                case let .bool(id, value):
                    return TestField(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL), unsigned: value ? 1 : 0)
                case let .text(id, value):
                    return TestField(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8), data: Array(value.utf8))
                case let .bytes(id, value):
                    return TestField(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES), data: Array(value))
                }
            }
        )
    }

    deinit {
        fields?.deallocate()
        for buffer in buffers {
            buffer?.deallocate()
        }
    }
}

private final class TestErrorStorage {
    let view: BotaDeviceSdkErrorViewV1
    private let buffer: UnsafeMutablePointer<UInt8>?

    init(error: TestError) {
        if error.detail.isEmpty {
            buffer = nil
        } else {
            let allocated = UnsafeMutablePointer<UInt8>.allocate(capacity: error.detail.count)
            allocated.initialize(from: error.detail, count: error.detail.count)
            buffer = allocated
        }
        view = BotaDeviceSdkErrorViewV1(
            abi_version: UInt32(BOTA_DEVICE_SDK_ABI_VERSION),
            code: error.code,
            operation: error.operation,
            retryable: error.retryable ? 1 : 0,
            has_protocol_status: error.protocolStatus == nil ? 0 : 1,
            protocol_status: error.protocolStatus ?? 0,
            detail: BotaDeviceSdkSliceV1(data: buffer, len: UInt64(error.detail.count))
        )
    }

    deinit {
        buffer?.deallocate()
    }
}

private final class TestCoreAbi: CoreAbi, @unchecked Sendable {
    var startStatus = BOTA_DEVICE_SDK_V1_OK
    var error: TestError?
    var startInspection: ((BotaDeviceSdkPacketViewV1) throws -> Void)?
    private(set) var engineNewCount = 0
    private(set) var engineFreeCount = 0
    private(set) var packetFreeCount = 0
    private(set) var errorFreeCount = 0
    private(set) var startCount = 0
    private var packetQueue: [OpaquePointer] = []
    private var packets: [UInt: TestPacketStorage] = [:]
    private var errors: [UInt: TestErrorStorage] = [:]

    func enqueuePacket(_ packet: CorePacket) {
        enqueue(TestPacketStorage(packet: packet))
    }

    func enqueueRawPacket(kind: UInt32, operation: UInt32, fields: [TestField]) {
        enqueue(TestPacketStorage(kind: kind, operation: operation, fields: fields))
    }

    private func enqueue(_ storage: TestPacketStorage) {
        let pointer = Self.allocateToken()
        packets[UInt(bitPattern: pointer)] = storage
        packetQueue.append(pointer)
    }

    func engineNew() -> OpaquePointer? {
        engineNewCount += 1
        return Self.allocateToken()
    }

    func engineFree(_ engine: OpaquePointer?) {
        engineFreeCount += 1
        Self.freeToken(engine)
    }

    func engineCancel(_ engine: OpaquePointer?, high: UInt64, low: UInt64) -> BotaDeviceSdkStatusV1 {
        BOTA_DEVICE_SDK_V1_OK
    }

    func engineStart(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        capabilities: UInt64
    ) -> BotaDeviceSdkStatusV1 {
        startCount += 1
        if let packet {
            do {
                try startInspection?(packet.pointee)
            } catch {
                XCTFail("input inspection failed: \(error)")
                return BOTA_DEVICE_SDK_V1_OPERATION_FAILED
            }
        }
        return startStatus
    }

    func enginePollOutput(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        guard !packetQueue.isEmpty else {
            output?.pointee = nil
            return BOTA_DEVICE_SDK_V1_NO_OUTPUT
        }
        output?.pointee = packetQueue.removeFirst()
        return BOTA_DEVICE_SDK_V1_OK
    }

    func engineDispatch(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        BOTA_DEVICE_SDK_V1_OK
    }

    func protocolDecode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        enginePollOutput(engine, output: output)
    }

    func protocolEncode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        enginePollOutput(engine, output: output)
    }

    func engineLastError(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        guard let error else {
            output?.pointee = nil
            return BOTA_DEVICE_SDK_V1_NO_OUTPUT
        }
        let pointer = Self.allocateToken()
        errors[UInt(bitPattern: pointer)] = TestErrorStorage(error: error)
        output?.pointee = pointer
        return BOTA_DEVICE_SDK_V1_OK
    }

    func packetView(
        _ packet: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        guard let packet, let storage = packets[UInt(bitPattern: packet)] else {
            return BOTA_DEVICE_SDK_V1_INVALID_ARGUMENT
        }
        output?.pointee = storage.view
        return BOTA_DEVICE_SDK_V1_OK
    }

    func packetFree(_ packet: OpaquePointer?) {
        packetFreeCount += 1
        guard let packet else { return }
        packets.removeValue(forKey: UInt(bitPattern: packet))
        Self.freeToken(packet)
    }

    func errorView(
        _ error: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkErrorViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        guard let error, let storage = errors[UInt(bitPattern: error)] else {
            return BOTA_DEVICE_SDK_V1_INVALID_ARGUMENT
        }
        output?.pointee = storage.view
        return BOTA_DEVICE_SDK_V1_OK
    }

    func errorFree(_ error: OpaquePointer?) {
        errorFreeCount += 1
        guard let error else { return }
        errors.removeValue(forKey: UInt(bitPattern: error))
        Self.freeToken(error)
    }

    static func copyBytes(_ slice: BotaDeviceSdkSliceV1) -> [UInt8] {
        guard slice.len > 0, let data = slice.data else { return [] }
        return Array(UnsafeBufferPointer(start: data, count: Int(slice.len)))
    }

    private static func allocateToken() -> OpaquePointer {
        OpaquePointer(UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1))
    }

    private static func freeToken(_ pointer: OpaquePointer?) {
        guard let pointer else { return }
        UnsafeMutableRawPointer(pointer).deallocate()
    }
}
