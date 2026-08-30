use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, BotaDeviceSdkStatusV1,
    bota_device_sdk_v1_engine_free, bota_device_sdk_v1_engine_new, bota_device_sdk_v1_packet_free,
    bota_device_sdk_v1_packet_view, bota_device_sdk_v1_protocol_decode,
    bota_device_sdk_v1_protocol_encode, field_id, packet_kind,
};
use std::{ptr, slice};

#[test]
fn device_status_decode_and_firmware_data_encode_use_core_codecs() {
    let engine = bota_device_sdk_v1_engine_new();
    let status_bytes = hex("306300020100000009000100000300e20e");
    let input = BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_DECODE_DEVICE_STATUS)
        .with_bytes(field_id::VALUE, status_bytes);
    let decoded = decode(engine, &input);
    let fields = unsafe { slice::from_raw_parts(decoded.fields, decoded.field_count as usize) };
    assert!(fields.iter().any(|field| {
        field.field_id == field_id::BATTERY_PERCENT && field.unsigned_value == 48
    }));

    let input = BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_ENCODE_FIRMWARE_DATA)
        .with_u64(field_id::SEQUENCE, 0x1234)
        .with_bytes(field_id::PAYLOAD, vec![0, 255, 1]);
    let encoded = encode(engine, &input);
    let fields = unsafe { slice::from_raw_parts(encoded.fields, encoded.field_count as usize) };
    let value = fields
        .iter()
        .find(|field| field.field_id == field_id::VALUE)
        .unwrap();
    let bytes = unsafe { slice::from_raw_parts(value.data.data, value.data.len as usize) };
    assert_eq!(bytes, [0x20, 0x34, 0x12, 0x00, 0xff, 0x01]);
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn fragmented_device_logs_keep_decoder_state_on_the_engine() {
    let engine = bota_device_sdk_v1_engine_new();
    let first = BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_DECODE_DEVICE_LOGS)
        .with_bytes(field_id::VALUE, hex("000000626f6f74207061"));
    let decoded = decode(engine, &first);
    assert_eq!(decoded.field_count, 0);

    let second = BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_DECODE_DEVICE_LOGS)
        .with_bytes(field_id::VALUE, hex("01000073730a"));
    let decoded = decode(engine, &second);
    let fields = unsafe { slice::from_raw_parts(decoded.fields, decoded.field_count as usize) };
    let message = fields
        .iter()
        .find(|field| field.field_id == field_id::LOG_MESSAGE)
        .unwrap();
    let bytes = unsafe { slice::from_raw_parts(message.data.data, message.data.len as usize) };
    assert_eq!(bytes, b"boot pass");
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn malformed_protocol_input_returns_a_structured_engine_error() {
    let engine = bota_device_sdk_v1_engine_new();
    let input = BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_DECODE_DEVICE_STATUS)
        .with_bytes(field_id::VALUE, vec![1, 2]);
    let mut output = ptr::null_mut();
    let status = unsafe { bota_device_sdk_v1_protocol_decode(engine, &input.view(), &mut output) };
    assert_eq!(status, BotaDeviceSdkStatusV1::OperationFailed);
    assert!(output.is_null());
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

struct ProtocolOutput {
    owner: *mut BotaDeviceSdkPacketV1,
    view: BotaDeviceSdkPacketViewV1,
}

impl Drop for ProtocolOutput {
    fn drop(&mut self) {
        unsafe { bota_device_sdk_v1_packet_free(self.owner) };
    }
}

impl std::ops::Deref for ProtocolOutput {
    type Target = BotaDeviceSdkPacketViewV1;

    fn deref(&self) -> &Self::Target {
        &self.view
    }
}

fn decode(
    engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1,
    input: &BotaDeviceSdkPacketV1,
) -> ProtocolOutput {
    call(engine, input, bota_device_sdk_v1_protocol_decode)
}

fn encode(
    engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1,
    input: &BotaDeviceSdkPacketV1,
) -> ProtocolOutput {
    call(engine, input, bota_device_sdk_v1_protocol_encode)
}

fn call(
    engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1,
    input: &BotaDeviceSdkPacketV1,
    operation: unsafe extern "C" fn(
        *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1,
        *const BotaDeviceSdkPacketViewV1,
        *mut *mut BotaDeviceSdkPacketV1,
    ) -> BotaDeviceSdkStatusV1,
) -> ProtocolOutput {
    let mut owner = ptr::null_mut();
    let status = unsafe { operation(engine, &input.view(), &mut owner) };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    let mut view = BotaDeviceSdkPacketViewV1::default();
    assert_eq!(
        unsafe { bota_device_sdk_v1_packet_view(owner, &mut view) },
        BotaDeviceSdkStatusV1::Ok
    );
    ProtocolOutput { owner, view }
}

fn hex(value: &str) -> Vec<u8> {
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    assert!(remainder.is_empty());
    pairs
        .iter()
        .map(|pair| {
            let text = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(text, 16).unwrap()
        })
        .collect()
}
