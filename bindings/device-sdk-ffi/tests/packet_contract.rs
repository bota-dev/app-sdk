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
