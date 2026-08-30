const HEADER: &str = include_str!("../include/bota_device_sdk.h");

#[test]
fn c_abi_uses_opaque_handles_and_explicit_buffer_ownership() {
    assert!(HEADER.contains("typedef struct BotaDeviceSdkEngine BotaDeviceSdkEngine;"));
    assert!(HEADER.contains("BotaDeviceSdkEngine *bota_device_sdk_engine_new(void);"));
    assert!(HEADER.contains("void bota_device_sdk_engine_free(BotaDeviceSdkEngine *engine);"));

    assert!(HEADER.contains("const uint8_t *command_json"));
    assert!(HEADER.contains("const uint8_t *event_json"));
    assert!(HEADER.contains("typedef struct BotaDeviceSdkOwnedBuffer"));
    assert!(HEADER.contains("uint8_t *data;"));
    assert!(HEADER.contains("size_t len;"));
    assert!(HEADER.contains("void bota_device_sdk_buffer_free(BotaDeviceSdkOwnedBuffer buffer);"));
    assert!(HEADER.contains("A NULL input is"));
    assert!(HEADER.contains("must be passed exactly once to buffer_free"));
    assert!(HEADER.contains("undefined behavior"));
}

#[test]
fn c_abi_keeps_request_and_cancellation_identity_numeric() {
    assert!(HEADER.contains("uint64_t request_id"));
    assert!(HEADER.contains("uint64_t cancellation_id_high"));
    assert!(HEADER.contains("uint64_t cancellation_id_low"));
    assert!(HEADER.contains("uint64_t capability_bits"));
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
    ] {
        assert!(
            !HEADER.contains(forbidden),
            "C header exposes forbidden Rust detail: {forbidden}"
        );
    }
}
