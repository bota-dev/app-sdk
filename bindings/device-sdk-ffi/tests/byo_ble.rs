use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkStatusV1, bota_device_sdk_v1_engine_free,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_packet_free, bota_device_sdk_v1_packet_view,
    bota_device_sdk_v1_protocol_decode, bota_device_sdk_v1_protocol_encode, field_id::*,
};
use std::{ptr, slice};

#[test]
fn native_frame_codec_uses_typed_fields_and_rejects_oversized_input() {
    let engine = bota_device_sdk_v1_engine_new();
    assert!(!engine.is_null());
    let input = BotaDeviceSdkPacketV1::new(0x052e)
        .with_u64(MESSAGE_TYPE, 112)
        .with_u64(COMMAND, 3)
        .with_u64(RESULT_CODE, 0)
        .with_u64(WRITE_ID, 1)
        .with_u64(OFFSET, 0)
        .with_u64(BODY_LENGTH, 3)
        .with_u64(CAPACITY, 20)
        .with_bytes(PAYLOAD, b"abc".to_vec());
    let mut output = ptr::null_mut();
    assert_eq!(
        unsafe { bota_device_sdk_v1_protocol_encode(engine, &input.view(), &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    let mut view = std::mem::MaybeUninit::uninit();
    assert_eq!(
        unsafe { bota_device_sdk_v1_packet_view(output, view.as_mut_ptr()) },
        BotaDeviceSdkStatusV1::Ok
    );
    let view = unsafe { view.assume_init() };
    let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
    let value = fields.iter().find(|f| f.field_id == VALUE).unwrap();
    let bytes = unsafe { slice::from_raw_parts(value.data.data, value.data.len as usize) }.to_vec();
    unsafe { bota_device_sdk_v1_packet_free(output) };
    let input = BotaDeviceSdkPacketV1::new(0x052f).with_bytes(VALUE, bytes);
    assert_eq!(
        unsafe { bota_device_sdk_v1_protocol_decode(engine, &input.view(), &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_packet_free(output) };
    let bad = BotaDeviceSdkPacketV1::new(0x052f).with_bytes(VALUE, vec![0; 513]);
    assert_ne!(
        unsafe { bota_device_sdk_v1_protocol_decode(engine, &bad.view(), &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn customer_adapter_validates_headers_and_bounds_native_input() {
    let engine = bota_device_sdk_v1_engine_new();
    let input = BotaDeviceSdkPacketV1::new(0x0530)
        .with_u64(COMMAND, 3)
        .with_bytes(VALUE, br#"{"Authorization":"Bearer upload-jwt"}"#.to_vec());
    let mut output = ptr::null_mut();
    assert_eq!(
        unsafe { bota_device_sdk_v1_protocol_encode(engine, &input.view(), &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_packet_free(output) };
    // Valid JSON at the exact ABI limit must work; the same document with one
    // more whitespace byte must fail because of size, not invalid JSON.
    for (length, accepted) in [(32768, true), (32769, false)] {
        let mut json = b"{}".to_vec();
        json.resize(length, b' ');
        let input = BotaDeviceSdkPacketV1::new(0x0530)
            .with_u64(COMMAND, 3)
            .with_bytes(VALUE, json);
        output = ptr::null_mut();
        let status =
            unsafe { bota_device_sdk_v1_protocol_encode(engine, &input.view(), &mut output) };
        assert_eq!(status == BotaDeviceSdkStatusV1::Ok, accepted);
        if accepted {
            unsafe { bota_device_sdk_v1_packet_free(output) };
        } else {
            assert!(output.is_null());
        }
    }
    for command in [1, 2, 3, 4] {
        let input = BotaDeviceSdkPacketV1::new(0x0530)
            .with_u64(COMMAND, command)
            .with_bytes(VALUE, vec![0; 32769]);
        assert_ne!(
            unsafe { bota_device_sdk_v1_protocol_encode(engine, &input.view(), &mut output) },
            BotaDeviceSdkStatusV1::Ok
        );
    }
    let input = BotaDeviceSdkPacketV1::new(0x0530)
        .with_u64(COMMAND, 3)
        .with_bytes(VALUE, br#"{"Host":"attacker.example"}"#.to_vec());
    assert_ne!(
        unsafe { bota_device_sdk_v1_protocol_encode(engine, &input.view(), &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}
