const HEADER: &str = include_str!("../../../bindings/device-sdk-ffi/include/bota_device_sdk.h");

#[test]
fn c_abi_uses_versioned_opaque_handles_and_explicit_error_ownership() {
    assert!(HEADER.contains("#define BOTA_DEVICE_SDK_ABI_VERSION UINT32_C(1)"));
    assert!(HEADER.contains("typedef struct BotaDeviceSdkEngineV1 BotaDeviceSdkEngineV1;"));
    assert!(HEADER.contains("typedef struct BotaDeviceSdkErrorV1 BotaDeviceSdkErrorV1;"));
    assert!(HEADER.contains("BotaDeviceSdkEngineV1 *bota_device_sdk_v1_engine_new(void);"));
    assert!(HEADER.contains("void bota_device_sdk_v1_engine_free(BotaDeviceSdkEngineV1 *engine);"));
    assert!(HEADER.contains("void bota_device_sdk_v1_error_free(BotaDeviceSdkErrorV1 *error);"));
    assert!(HEADER.contains("must be passed exactly once to error_free"));
    assert!(HEADER.contains("undefined behavior"));
}

#[test]
fn c_abi_keeps_request_and_cancellation_identity_numeric() {
    assert!(HEADER.contains("uint64_t request_id"));
    assert!(HEADER.contains("uint64_t cancellation_id_high"));
    assert!(HEADER.contains("uint64_t cancellation_id_low"));
    assert!(HEADER.contains("uint64_t unsigned_value"));
    assert!(HEADER.contains("int64_t signed_value"));
    assert!(HEADER.contains("uint64_t len"));
}

#[test]
fn c_abi_has_extensible_typed_packet_fields() {
    assert!(HEADER.contains("typedef struct BotaDeviceSdkFieldViewV1"));
    assert!(HEADER.contains("const BotaDeviceSdkFieldViewV1 *fields"));
    assert!(HEADER.contains("uint64_t field_count"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_FIELD_TYPE_UTF8"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_FIELD_TYPE_BYTES"));
    assert!(HEADER.contains("BotaDeviceSdkPacketV1 *packet"));
    assert!(HEADER.contains("void bota_device_sdk_v1_packet_free"));
    assert!(HEADER.contains("bota_device_sdk_v1_engine_poll_output"));
    assert!(HEADER.contains("bota_device_sdk_v1_engine_dispatch"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_NOTIFICATION"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_FAILED"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_WRITE"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_NOTIFICATION_FAILED"));
    assert!(HEADER.contains("BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT"));
}

#[test]
fn c_header_exposes_no_rust_layout_or_async_runtime_types() {
    for forbidden in [
        "std::",
        "Vec<",
        "String",
        "Box<",
        "Future",
        "Pin<",
        "tokio",
        "WorkflowEngine",
        "json",
        "JSON",
    ] {
        assert!(
            !HEADER.contains(forbidden),
            "C header exposes forbidden Rust detail: {forbidden}"
        );
    }
}
