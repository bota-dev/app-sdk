import BotaDeviceSDKC
import Foundation

protocol CoreAbi: Sendable {
    func engineNew() -> OpaquePointer?
    func engineFree(_ engine: OpaquePointer?)
    func engineCancel(_ engine: OpaquePointer?, high: UInt64, low: UInt64) -> BotaDeviceSdkStatusV1
    func engineStart(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        capabilities: UInt64
    ) -> BotaDeviceSdkStatusV1
    func enginePollOutput(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1
    func engineDispatch(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1
    func protocolDecode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1
    func protocolEncode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1
    func engineLastError(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1
    func packetView(
        _ packet: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1
    func packetFree(_ packet: OpaquePointer?)
    func errorView(
        _ error: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkErrorViewV1>?
    ) -> BotaDeviceSdkStatusV1
    func errorFree(_ error: OpaquePointer?)
}

final class CoreAbiClient: @unchecked Sendable {
    private let abi: any CoreAbi
    private let engine: NativeEngineHandle

    init(abi: any CoreAbi = NativeCoreAbi()) throws {
        self.abi = abi
        engine = try NativeEngineHandle(abi: abi)
    }

    func start(_ packet: CorePacket, capabilities: UInt64) throws {
        let status = withPacketView(packet) { view in
            abi.engineStart(engine.pointer, packet: view, capabilities: capabilities)
        }
        try requireSuccess(status, operation: packet.operation)
    }

    func cancel(cancellationHigh: UInt64, cancellationLow: UInt64) throws {
        let status = abi.engineCancel(
            engine.pointer,
            high: cancellationHigh,
            low: cancellationLow
        )
        try requireSuccess(status, operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UNKNOWN))
    }

    func dispatch(_ packet: CorePacket) throws {
        let status = withPacketView(packet) { view in
            abi.engineDispatch(engine.pointer, packet: view)
        }
        try requireSuccess(status, operation: packet.operation)
    }

    func pollOutput() throws -> CorePacket? {
        var owner: OpaquePointer?
        let status = abi.enginePollOutput(engine.pointer, output: &owner)
        if status == BOTA_DEVICE_SDK_V1_NO_OUTPUT {
            if let owner {
                abi.packetFree(owner)
            }
            return nil
        }
        guard status == BOTA_DEVICE_SDK_V1_OK else {
            if let owner {
                abi.packetFree(owner)
            }
            throw readLastError(status: status, operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UNKNOWN))
        }
        guard let owner else {
            throw bridgeError(
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UNKNOWN),
                detail: "native poll returned success without a packet"
            )
        }
        return try copyPacket(owner)
    }

    func protocolDecode(_ packet: CorePacket) throws -> CorePacket {
        try protocolCall(packet, function: abi.protocolDecode)
    }

    func protocolEncode(_ packet: CorePacket) throws -> CorePacket {
        try protocolCall(packet, function: abi.protocolEncode)
    }

    private func protocolCall(
        _ packet: CorePacket,
        function: (
            OpaquePointer?,
            UnsafePointer<BotaDeviceSdkPacketViewV1>?,
            UnsafeMutablePointer<OpaquePointer?>?
        ) -> BotaDeviceSdkStatusV1
    ) throws -> CorePacket {
        var owner: OpaquePointer?
        let status = withPacketView(packet) { view in
            function(engine.pointer, view, &owner)
        }
        guard status == BOTA_DEVICE_SDK_V1_OK else {
            if let owner {
                abi.packetFree(owner)
            }
            throw readLastError(status: status, operation: packet.operation)
        }
        guard let owner else {
            throw bridgeError(
                operation: packet.operation,
                detail: "native protocol call returned success without a packet"
            )
        }
        return try copyPacket(owner)
    }

    private func copyPacket(_ owner: OpaquePointer) throws -> CorePacket {
        defer { abi.packetFree(owner) }
        var view = BotaDeviceSdkPacketViewV1()
        let status = abi.packetView(owner, output: &view)
        guard status == BOTA_DEVICE_SDK_V1_OK else {
            throw bridgeError(
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UNKNOWN),
                detail: "native packet view failed with status \(status.rawValue)"
            )
        }
        guard view.abi_version == UInt32(BOTA_DEVICE_SDK_ABI_VERSION) else {
            throw bridgeError(
                operation: view.operation,
                detail: "native packet uses unsupported ABI version \(view.abi_version)"
            )
        }
        let fieldCount = try checkedCount(view.field_count, operation: view.operation)
        if fieldCount > 0, view.fields == nil {
            throw bridgeError(operation: view.operation, detail: "native packet has a null field list")
        }

        var fields: [CoreField] = []
        fields.reserveCapacity(fieldCount)
        if let fieldViews = view.fields {
            for index in 0..<fieldCount {
                fields.append(try copyField(fieldViews[index], operation: view.operation))
            }
        }
        return CorePacket(
            kind: view.kind,
            operation: view.operation,
            requestID: view.request_id,
            cancellationHigh: view.cancellation_id_high,
            cancellationLow: view.cancellation_id_low,
            fields: fields
        )
    }

    private func copyField(_ view: BotaDeviceSdkFieldViewV1, operation: UInt32) throws -> CoreField {
        switch view.field_type {
        case UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED):
            return .unsigned(id: view.field_id, value: view.unsigned_value)
        case UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_SIGNED):
            return .signed(id: view.field_id, value: view.signed_value)
        case UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL):
            guard view.unsigned_value <= 1 else {
                throw bridgeError(operation: operation, detail: "native Boolean field is not zero or one")
            }
            return .bool(id: view.field_id, value: view.unsigned_value == 1)
        case UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8):
            let data = try copyData(view.data, operation: operation)
            guard let value = String(data: data, encoding: .utf8) else {
                throw bridgeError(operation: operation, detail: "native UTF-8 field is malformed")
            }
            return .text(id: view.field_id, value: value)
        case UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES):
            return .bytes(id: view.field_id, value: try copyData(view.data, operation: operation))
        default:
            throw bridgeError(operation: operation, detail: "native field has unknown type \(view.field_type)")
        }
    }

    private func copyData(_ slice: BotaDeviceSdkSliceV1, operation: UInt32) throws -> Data {
        let count = try checkedCount(slice.len, operation: operation)
        guard count > 0 else { return Data() }
        guard let data = slice.data else {
            throw bridgeError(operation: operation, detail: "native non-empty slice has a null pointer")
        }
        return Data(bytes: data, count: count)
    }

    private func checkedCount(_ count: UInt64, operation: UInt32) throws -> Int {
        guard count <= UInt64(Int.max) else {
            throw bridgeError(operation: operation, detail: "native slice length exceeds this platform")
        }
        return Int(count)
    }

    private func requireSuccess(_ status: BotaDeviceSdkStatusV1, operation: UInt32) throws {
        guard status == BOTA_DEVICE_SDK_V1_OK else {
            throw readLastError(status: status, operation: operation)
        }
    }

    private func readLastError(status: BotaDeviceSdkStatusV1, operation: UInt32) -> CoreError {
        var owner: OpaquePointer?
        let ownerStatus = abi.engineLastError(engine.pointer, output: &owner)
        guard ownerStatus == BOTA_DEVICE_SDK_V1_OK, let owner else {
            if let owner {
                abi.errorFree(owner)
            }
            return CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INTERNAL),
                operation: operation,
                retryable: false,
                protocolStatus: nil,
                detail: "native call failed with status \(status.rawValue)"
            )
        }
        defer { abi.errorFree(owner) }

        var view = BotaDeviceSdkErrorViewV1()
        guard abi.errorView(owner, output: &view) == BOTA_DEVICE_SDK_V1_OK,
              view.abi_version == UInt32(BOTA_DEVICE_SDK_ABI_VERSION)
        else {
            return CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INTERNAL),
                operation: operation,
                retryable: false,
                protocolStatus: nil,
                detail: "native error view is unavailable"
            )
        }
        let detail: String
        if view.detail.len == 0 {
            detail = ""
        } else if view.detail.len <= UInt64(Int.max), let data = view.detail.data {
            detail = String(bytes: UnsafeBufferPointer(start: data, count: Int(view.detail.len)), encoding: .utf8)
                ?? "native error detail is not valid UTF-8"
        } else {
            detail = "native error detail is unavailable"
        }
        return CoreError(
            code: view.code,
            operation: view.operation,
            retryable: view.retryable != 0,
            protocolStatus: view.has_protocol_status == 0 ? nil : view.protocol_status,
            detail: detail
        )
    }

    private func bridgeError(operation: UInt32, detail: String) -> CoreError {
        CoreError(
            code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INVALID_INPUT),
            operation: operation,
            retryable: false,
            protocolStatus: nil,
            detail: detail
        )
    }

    private func withPacketView<Result>(
        _ packet: CorePacket,
        _ body: (UnsafePointer<BotaDeviceSdkPacketViewV1>) throws -> Result
    ) rethrows -> Result {
        var fieldViews: [BotaDeviceSdkFieldViewV1] = []
        fieldViews.reserveCapacity(packet.fields.count)

        func appendField(_ index: Int) throws -> Result {
            guard index < packet.fields.count else {
                return try fieldViews.withUnsafeBufferPointer { fields in
                    var view = BotaDeviceSdkPacketViewV1(
                        abi_version: UInt32(BOTA_DEVICE_SDK_ABI_VERSION),
                        kind: packet.kind,
                        operation: packet.operation,
                        reserved: 0,
                        request_id: packet.requestID,
                        cancellation_id_high: packet.cancellationHigh,
                        cancellation_id_low: packet.cancellationLow,
                        fields: fields.baseAddress,
                        field_count: UInt64(fields.count)
                    )
                    return try withUnsafePointer(to: &view, body)
                }
            }

            let field = packet.fields[index]
            switch field {
            case let .unsigned(id, value):
                fieldViews.append(Self.fieldView(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED), unsigned: value))
                return try appendField(index + 1)
            case let .signed(id, value):
                fieldViews.append(Self.fieldView(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_SIGNED), signed: value))
                return try appendField(index + 1)
            case let .bool(id, value):
                fieldViews.append(Self.fieldView(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL), unsigned: value ? 1 : 0))
                return try appendField(index + 1)
            case let .text(id, value):
                return try Data(value.utf8).withUnsafeBytes { bytes in
                    fieldViews.append(Self.fieldView(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8), bytes: bytes))
                    defer { fieldViews.removeLast() }
                    return try appendField(index + 1)
                }
            case let .bytes(id, value):
                return try value.withUnsafeBytes { bytes in
                    fieldViews.append(Self.fieldView(id: id, type: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES), bytes: bytes))
                    defer { fieldViews.removeLast() }
                    return try appendField(index + 1)
                }
            }
        }

        return try appendField(0)
    }

    private static func fieldView(
        id: UInt32,
        type: UInt32,
        unsigned: UInt64 = 0,
        signed: Int64 = 0,
        bytes: UnsafeRawBufferPointer = UnsafeRawBufferPointer(start: nil, count: 0)
    ) -> BotaDeviceSdkFieldViewV1 {
        BotaDeviceSdkFieldViewV1(
            field_id: id,
            field_type: type,
            unsigned_value: unsigned,
            signed_value: signed,
            data: BotaDeviceSdkSliceV1(
                data: bytes.bindMemory(to: UInt8.self).baseAddress,
                len: UInt64(bytes.count)
            )
        )
    }
}

private final class NativeEngineHandle: @unchecked Sendable {
    let pointer: OpaquePointer
    private let abi: any CoreAbi

    init(abi: any CoreAbi) throws {
        self.abi = abi
        guard let pointer = abi.engineNew() else {
            throw CoreError(
                code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INTERNAL),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UNKNOWN),
                retryable: false,
                protocolStatus: nil,
                detail: "native engine allocation failed"
            )
        }
        self.pointer = pointer
    }

    deinit {
        abi.engineFree(pointer)
    }
}

struct NativeCoreAbi: CoreAbi {
    func engineNew() -> OpaquePointer? { bota_device_sdk_v1_engine_new() }
    func engineFree(_ engine: OpaquePointer?) { bota_device_sdk_v1_engine_free(engine) }
    func engineCancel(_ engine: OpaquePointer?, high: UInt64, low: UInt64) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_engine_cancel(engine, high, low)
    }
    func engineStart(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        capabilities: UInt64
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_engine_start(engine, packet, capabilities)
    }
    func enginePollOutput(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_engine_poll_output(engine, output)
    }
    func engineDispatch(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_engine_dispatch(engine, packet)
    }
    func protocolDecode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_protocol_decode(engine, packet, output)
    }
    func protocolEncode(
        _ engine: OpaquePointer?,
        packet: UnsafePointer<BotaDeviceSdkPacketViewV1>?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_protocol_encode(engine, packet, output)
    }
    func engineLastError(
        _ engine: OpaquePointer?,
        output: UnsafeMutablePointer<OpaquePointer?>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_engine_last_error(engine, output)
    }
    func packetView(
        _ packet: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkPacketViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_packet_view(packet, output)
    }
    func packetFree(_ packet: OpaquePointer?) { bota_device_sdk_v1_packet_free(packet) }
    func errorView(
        _ error: OpaquePointer?,
        output: UnsafeMutablePointer<BotaDeviceSdkErrorViewV1>?
    ) -> BotaDeviceSdkStatusV1 {
        bota_device_sdk_v1_error_view(error, output)
    }
    func errorFree(_ error: OpaquePointer?) { bota_device_sdk_v1_error_free(error) }
}
