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
