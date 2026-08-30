use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, BotaDeviceSdkStatusV1,
    bota_device_sdk_v1_engine_free, bota_device_sdk_v1_engine_new,
    bota_device_sdk_v1_engine_poll_output, bota_device_sdk_v1_engine_start,
    bota_device_sdk_v1_packet_free, bota_device_sdk_v1_packet_view, capability_bits, field_id,
    packet_kind,
};
use std::{ops::Deref, ptr, slice};

#[test]
fn discovery_outputs_are_owned_ordered_and_correlated() {
    let command = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
        .with_cancellation_id(0x0102, 0x0304)
        .with_u64(field_id::TIMEOUT_MS, 5_000)
        .with_bool(field_id::ALLOW_DUPLICATES, true);
    let command_view = command.view();
    let engine = bota_device_sdk_v1_engine_new();
    let status = unsafe {
        bota_device_sdk_v1_engine_start(
            engine,
            &command_view,
            capability_bits::BLE | capability_bits::TIMER,
        )
    };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);

    let started = poll(engine);
    assert_eq!(started.kind, packet_kind::NOTIFICATION_STARTED);
    assert_eq!(started.request_id, 1);
    assert_eq!(started.operation, 4);
    assert_eq!(started.cancellation_id_high, 0x0102);
    assert_eq!(started.cancellation_id_low, 0x0304);

    let scan = poll(engine);
    assert_eq!(scan.kind, packet_kind::HOST_EFFECT_BLE_START_SCAN);
    assert_eq!(scan.request_id, 2);
    let scan_fields = unsafe { slice::from_raw_parts(scan.fields, scan.field_count as usize) };
    assert_eq!(scan_fields[0].field_id, field_id::ALLOW_DUPLICATES);
    assert_eq!(scan_fields[0].unsigned_value, 1);

    let timer = poll(engine);
    assert_eq!(timer.kind, packet_kind::HOST_EFFECT_TIMER_SCHEDULE);
    assert_eq!(timer.request_id, 3);
    let timer_fields = unsafe { slice::from_raw_parts(timer.fields, timer.field_count as usize) };
    assert!(
        timer_fields
            .iter()
            .any(|field| { field.field_id == field_id::DELAY_MS && field.unsigned_value == 5_000 })
    );

    let mut output = ptr::null_mut();
    let status = unsafe { bota_device_sdk_v1_engine_poll_output(engine, &mut output) };
    assert_eq!(status, BotaDeviceSdkStatusV1::NoOutput);
    assert!(output.is_null());
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn poll_rejects_null_arguments() {
    let engine = bota_device_sdk_v1_engine_new();
    let mut output = ptr::null_mut();
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_poll_output(ptr::null_mut(), &mut output) },
        BotaDeviceSdkStatusV1::InvalidArgument
    );
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_poll_output(engine, ptr::null_mut()) },
        BotaDeviceSdkStatusV1::InvalidArgument
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

struct PolledPacket {
    owner: *mut BotaDeviceSdkPacketV1,
    view: BotaDeviceSdkPacketViewV1,
}

impl Deref for PolledPacket {
    type Target = BotaDeviceSdkPacketViewV1;

    fn deref(&self) -> &Self::Target {
        &self.view
    }
}

impl Drop for PolledPacket {
    fn drop(&mut self) {
        unsafe { bota_device_sdk_v1_packet_free(self.owner) };
    }
}

fn poll(engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1) -> PolledPacket {
    let mut output = ptr::null_mut();
    let status = unsafe { bota_device_sdk_v1_engine_poll_output(engine, &mut output) };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    assert!(!output.is_null());
    let mut view = BotaDeviceSdkPacketViewV1::default();
    let status = unsafe { bota_device_sdk_v1_packet_view(output, &mut view) };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    PolledPacket {
        owner: output,
        view,
    }
}
