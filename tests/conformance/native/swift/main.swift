import BotaDeviceSDKC

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fatalError(message)
    }
}

func emptySlice() -> BotaDeviceSdkSliceV1 {
    BotaDeviceSdkSliceV1(data: nil, len: 0)
}

func unsignedField(_ id: UInt32, _ value: UInt64) -> BotaDeviceSdkFieldViewV1 {
    BotaDeviceSdkFieldViewV1(
        field_id: id,
        field_type: BOTA_DEVICE_SDK_V1_FIELD_TYPE_UNSIGNED,
        unsigned_value: value,
        signed_value: 0,
        data: emptySlice()
    )
}

func boolField(_ id: UInt32, _ value: Bool) -> BotaDeviceSdkFieldViewV1 {
    BotaDeviceSdkFieldViewV1(
        field_id: id,
        field_type: BOTA_DEVICE_SDK_V1_FIELD_TYPE_BOOL,
        unsigned_value: value ? 1 : 0,
        signed_value: 0,
        data: emptySlice()
    )
}

func pollKind(_ engine: OpaquePointer) -> UInt32 {
    var owner: OpaquePointer?
    require(bota_device_sdk_v1_engine_poll_output(engine, &owner).rawValue == 0, "poll failed")
    require(owner != nil, "poll returned no owner")
    var view = BotaDeviceSdkPacketViewV1()
    require(bota_device_sdk_v1_packet_view(owner, &view).rawValue == 0, "view failed")
    bota_device_sdk_v1_packet_free(owner)
    return view.kind
}

require(bota_device_sdk_v1_abi_version() == BOTA_DEVICE_SDK_ABI_VERSION, "ABI mismatch")
guard let engine = bota_device_sdk_v1_engine_new() else {
    fatalError("engine allocation failed")
}

var fields = [
    unsignedField(BOTA_DEVICE_SDK_V1_FIELD_TIMEOUT_MS, 5_000),
    boolField(BOTA_DEVICE_SDK_V1_FIELD_ALLOW_DUPLICATES, true),
]
let startStatus = fields.withUnsafeBufferPointer { buffer in
    var command = BotaDeviceSdkPacketViewV1(
        abi_version: BOTA_DEVICE_SDK_ABI_VERSION,
        kind: BOTA_DEVICE_SDK_V1_COMMAND_DISCOVER_DEVICES,
        operation: 0,
        reserved: 0,
        request_id: 0,
        cancellation_id_high: 0x0102,
        cancellation_id_low: 0x0304,
        fields: buffer.baseAddress,
        field_count: UInt64(buffer.count)
    )
    return bota_device_sdk_v1_engine_start(
        engine,
        &command,
        BOTA_DEVICE_SDK_V1_CAPABILITY_BLE | BOTA_DEVICE_SDK_V1_CAPABILITY_TIMER
    )
}
require(startStatus.rawValue == 0, "start failed")
require(pollKind(engine) == BOTA_DEVICE_SDK_V1_NOTIFICATION_STARTED, "missing started output")
require(pollKind(engine) == BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN, "missing scan output")
require(pollKind(engine) == BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE, "missing timer output")

require(bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x9999).rawValue == -2, "bad cancel accepted")
var errorOwner: OpaquePointer?
require(bota_device_sdk_v1_engine_last_error(engine, &errorOwner).rawValue == 0, "missing error")
var errorView = BotaDeviceSdkErrorViewV1()
require(bota_device_sdk_v1_error_view(errorOwner, &errorView).rawValue == 0, "error view failed")
require(errorView.code == BOTA_DEVICE_SDK_V1_ERROR_UNEXPECTED_EVENT, "wrong error code")
bota_device_sdk_v1_error_free(errorOwner)

require(bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x0304).rawValue == 0, "cancel failed")
while true {
    var owner: OpaquePointer?
    let status = bota_device_sdk_v1_engine_poll_output(engine, &owner)
    if status.rawValue == 1 {
        break
    }
    require(status.rawValue == 0, "drain failed")
    bota_device_sdk_v1_packet_free(owner)
}
bota_device_sdk_v1_engine_free(engine)
