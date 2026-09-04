use bota_device_sdk_ffi::{
    ABI_VERSION, BotaDeviceSdkFieldViewV1, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1,
    BotaDeviceSdkSliceV1, BotaDeviceSdkStatusV1, bota_device_sdk_v1_packet_free,
    bota_device_sdk_v1_packet_view, field_id, field_type, packet_kind,
};
use std::{mem, ptr, slice};

#[test]
fn packet_layout_is_stable_on_the_supported_64_bit_build_host() {
    assert_eq!(mem::size_of::<BotaDeviceSdkSliceV1>(), 16);
    assert_eq!(mem::align_of::<BotaDeviceSdkSliceV1>(), 8);
    assert_eq!(mem::size_of::<BotaDeviceSdkFieldViewV1>(), 40);
    assert_eq!(mem::align_of::<BotaDeviceSdkFieldViewV1>(), 8);
    assert_eq!(mem::size_of::<BotaDeviceSdkPacketViewV1>(), 56);
    assert_eq!(mem::align_of::<BotaDeviceSdkPacketViewV1>(), 8);
}

#[test]
fn packet_kind_ranges_and_first_command_values_are_stable() {
    assert_eq!(packet_kind::COMMAND_RANGE_START, 0x0100);
    assert_eq!(packet_kind::COMMAND_DISCOVER_DEVICES, 0x0101);
    assert_eq!(packet_kind::COMMAND_CONNECT, 0x0102);
    assert_eq!(packet_kind::HOST_EVENT_RANGE_START, 0x0200);
    assert_eq!(packet_kind::HOST_EFFECT_RANGE_START, 0x0300);
    assert_eq!(packet_kind::NOTIFICATION_RANGE_START, 0x0400);
    assert_eq!(packet_kind::PROTOCOL_VALUE_RANGE_START, 0x0500);
}

#[test]
fn encrypted_upload_v2_contract_inspection_allocations_are_additive() {
    assert_eq!(packet_kind::COMMAND_TRANSFER_ENCRYPTED_RECORDING, 0x010c);
    assert_eq!(
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_LOADED,
        0x022b
    );
    assert_eq!(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_FAILED, 0x0238);
    assert_eq!(
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_LOAD_CHECKPOINT,
        0x0342
    );
    assert_eq!(packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_ABORT, 0x034d);
    assert_eq!(packet_kind::NOTIFICATION_ENCRYPTED_UPLOAD_V2_STAGED, 0x0410);
    assert_eq!(
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY,
        0x0520
    );
    assert_eq!(
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB,
        0x0521
    );
    assert_eq!(
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS,
        0x0522
    );

    let fields = [
        field_id::MESSAGE_TYPE,
        field_id::TRANSPORT_SESSION_ID,
        field_id::RECORDING_GENERATION,
        field_id::CIPHERTEXT_LENGTH,
        field_id::PLAINTEXT_LENGTH,
        field_id::UPLOAD_SESSION_UUID,
        field_id::CHECKPOINT_REVISION,
        field_id::WINDOW_PACKETS,
        field_id::DATA_PAYLOAD_BYTES,
        field_id::MISSING_SEQUENCE,
        field_id::CAPABILITY_FLAGS,
        field_id::MAX_SIGNED_BLOB_BYTES,
        field_id::MAX_MANIFEST_BYTES,
        field_id::CHECKPOINT_INTERVAL,
        field_id::MAX_MISSING_SEQUENCES,
        field_id::MANIFEST_SHA256,
        field_id::PREFIX_SHA256,
        field_id::CIPHERTEXT_SHA256,
        field_id::BLOCK_COUNT,
        field_id::COMPLETION_STATE,
        field_id::STORAGE_FORMAT,
        field_id::LIST_REVISION,
        field_id::DURATION_SECONDS,
        field_id::BODY_LENGTH,
        field_id::BLOB_KIND,
        field_id::WRITE_ID,
        field_id::PHASE,
        field_id::TRANSPORT_PROFILE,
        field_id::DETAIL_CODE,
        field_id::PROFILE_VERSION,
        field_id::REQUEST_FLAGS,
        field_id::FIRST_SEQUENCE,
        field_id::LAST_SEQUENCE,
        field_id::WINDOW_INDEX,
        field_id::AUTHORIZATION_SHA256,
        field_id::RECEIPT_SHA256,
        field_id::PROGRESS_PERCENT,
        field_id::DURABLE_CIPHERTEXT_BYTES,
    ];
    assert_eq!(fields, std::array::from_fn(|index| 127 + index as u32));
    assert_eq!(field_id::OWNER_REVISION, 165);
    assert_eq!(field_id::UPLOAD_PROFILE, 166);
    assert_eq!(field_id::UPLOAD_SECURITY_POLICY, 167);
    assert_eq!(field_id::MANIFEST_LENGTH, 168);
    assert_eq!(field_id::MAX_DATA_PAYLOAD_BYTES, 169);
    assert_eq!(field_id::MAX_WINDOW_PACKETS, 170);

    let header = include_str!("../include/bota_device_sdk.h");
    for expected in [
        "BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_ENCRYPTED_RECORDING = 0x010C",
        "BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_FAILED = 0x0238",
        "BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_ABORT = 0x034D",
        "BOTA_DEVICE_SDK_V1_NOTIFICATION_ENCRYPTED_UPLOAD_V2_STAGED = 0x0410",
        "BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY = 0x0520",
        "BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB = 0x0521",
        "BOTA_DEVICE_SDK_V1_PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS = 0x0522",
        "BOTA_DEVICE_SDK_V1_FIELD_MESSAGE_TYPE = 127",
        "BOTA_DEVICE_SDK_V1_FIELD_DURABLE_CIPHERTEXT_BYTES = 164",
        "BOTA_DEVICE_SDK_V1_FIELD_MAX_WINDOW_PACKETS = 170",
    ] {
        assert!(
            header.contains(expected),
            "missing header allocation: {expected}"
        );
    }
}

#[test]
fn owned_packet_view_preserves_scalar_utf8_and_binary_fields_until_free() {
    let packet = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_CONNECT)
        .with_i64(field_id::RSSI, -67)
        .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
        .with_bytes(99, vec![0x00, 0xff, 0x00, 0x7f]);
    let packet = Box::into_raw(Box::new(packet));
    let mut view = BotaDeviceSdkPacketViewV1::default();

    let status = unsafe { bota_device_sdk_v1_packet_view(packet, &mut view) };

    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert_eq!(view.abi_version, ABI_VERSION);
    assert_eq!(view.kind, packet_kind::COMMAND_CONNECT);
    let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
    assert_eq!(fields.len(), 3);
    assert_eq!(fields[0].field_id, field_id::RSSI);
    assert_eq!(fields[0].field_type, field_type::SIGNED);
    assert_eq!(fields[0].signed_value, -67);
    assert_eq!(fields[1].field_id, field_id::PERIPHERAL_ID);
    assert_eq!(fields[1].field_type, field_type::UTF8);
    let text = unsafe { slice::from_raw_parts(fields[1].data.data, fields[1].data.len as usize) };
    assert_eq!(text, b"peripheral-1");
    assert_eq!(fields[2].field_type, field_type::BYTES);
    let bytes = unsafe { slice::from_raw_parts(fields[2].data.data, fields[2].data.len as usize) };
    assert_eq!(bytes, [0x00, 0xff, 0x00, 0x7f]);

    unsafe { bota_device_sdk_v1_packet_free(packet) };
}

#[test]
fn empty_packet_uses_a_null_zero_field_list() {
    let packet = Box::into_raw(Box::new(BotaDeviceSdkPacketV1::new(
        packet_kind::COMMAND_DISCOVER_DEVICES,
    )));
    let mut view = BotaDeviceSdkPacketViewV1::default();

    let status = unsafe { bota_device_sdk_v1_packet_view(packet, &mut view) };

    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert!(view.fields.is_null());
    assert_eq!(view.field_count, 0);
    unsafe { bota_device_sdk_v1_packet_free(packet) };
}

#[test]
fn null_packet_or_view_is_rejected() {
    let mut view = BotaDeviceSdkPacketViewV1::default();
    let status = unsafe { bota_device_sdk_v1_packet_view(ptr::null(), &mut view) };
    assert_eq!(status, BotaDeviceSdkStatusV1::InvalidArgument);

    let packet = Box::into_raw(Box::new(BotaDeviceSdkPacketV1::new(
        packet_kind::COMMAND_DISCOVER_DEVICES,
    )));
    let status = unsafe { bota_device_sdk_v1_packet_view(packet, ptr::null_mut()) };
    assert_eq!(status, BotaDeviceSdkStatusV1::InvalidArgument);
    unsafe { bota_device_sdk_v1_packet_free(packet) };
}
