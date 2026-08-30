use bota_device_sdk_ffi::{
    ABI_VERSION, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, BotaDeviceSdkSliceV1,
    BotaDeviceSdkStatusV1, bota_device_sdk_v1_packet_free, bota_device_sdk_v1_packet_view,
    packet_kind,
};
use std::{mem, ptr, slice};

#[test]
fn packet_layout_is_fixed_across_supported_pointer_widths() {
    assert_eq!(mem::size_of::<BotaDeviceSdkSliceV1>(), 16);
    assert_eq!(mem::align_of::<BotaDeviceSdkSliceV1>(), 8);
    assert_eq!(mem::size_of::<BotaDeviceSdkPacketViewV1>(), 184);
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
fn owned_packet_view_preserves_utf8_and_binary_bytes_until_free() {
    let packet = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_CONNECT)
        .with_text(0, "peripheral-1")
        .with_bytes(0, vec![0x00, 0xff, 0x00, 0x7f]);
    let packet = Box::into_raw(Box::new(packet));
    let mut view = BotaDeviceSdkPacketViewV1::default();

    let status = unsafe { bota_device_sdk_v1_packet_view(packet, &mut view) };

    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert_eq!(view.abi_version, ABI_VERSION);
    assert_eq!(view.kind, packet_kind::COMMAND_CONNECT);
    let text = unsafe { slice::from_raw_parts(view.text[0].data, view.text[0].len as usize) };
    let bytes = unsafe { slice::from_raw_parts(view.bytes[0].data, view.bytes[0].len as usize) };
    assert_eq!(text, b"peripheral-1");
    assert_eq!(bytes, [0x00, 0xff, 0x00, 0x7f]);

    unsafe { bota_device_sdk_v1_packet_free(packet) };
}

#[test]
fn empty_packet_fields_use_null_zero_slices() {
    let packet = Box::into_raw(Box::new(BotaDeviceSdkPacketV1::new(
        packet_kind::COMMAND_DISCOVER_DEVICES,
    )));
    let mut view = BotaDeviceSdkPacketViewV1::default();

    let status = unsafe { bota_device_sdk_v1_packet_view(packet, &mut view) };

    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    for value in view.text.into_iter().chain(view.bytes) {
        assert!(value.data.is_null());
        assert_eq!(value.len, 0);
    }
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
