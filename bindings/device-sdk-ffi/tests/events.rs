use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkStatusV1, bota_device_sdk_v1_engine_cancel,
    bota_device_sdk_v1_engine_dispatch, bota_device_sdk_v1_engine_free,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_engine_poll_output,
    bota_device_sdk_v1_engine_start, bota_device_sdk_v1_packet_free, capability_bits, field_id,
    packet_kind,
};
use std::ptr;

fn start_discovery() -> *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1 {
    let engine = bota_device_sdk_v1_engine_new();
    let command = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
        .with_cancellation_id(0x0102, 0x0304)
        .with_u64(field_id::TIMEOUT_MS, 5_000)
        .with_bool(field_id::ALLOW_DUPLICATES, true);
    let status = unsafe {
        bota_device_sdk_v1_engine_start(
            engine,
            &command.view(),
            capability_bits::BLE | capability_bits::TIMER,
        )
    };
    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    drain(engine);
    engine
}

fn scan_result(request_id: u64, cancellation_low: u64) -> BotaDeviceSdkPacketV1 {
    BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_BLE_SCAN_RESULT)
        .with_operation(4)
        .with_request_id(request_id)
        .with_cancellation_id(0x0102, cancellation_low)
        .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
        .with_text(field_id::NAME, "Bota Note")
        .with_text(field_id::ADVERTISED_ADDRESS, "aabbccddeeff")
        .with_i64(field_id::RSSI, -60)
}

#[test]
fn matching_event_dispatches_and_produces_a_notification() {
    let engine = start_discovery();
    let event = scan_result(2, 0x0304);

    let status = unsafe { bota_device_sdk_v1_engine_dispatch(engine, &event.view()) };

    assert_eq!(status, BotaDeviceSdkStatusV1::Ok);
    let mut output = ptr::null_mut();
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_poll_output(engine, &mut output) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_packet_free(output) };
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn stale_request_and_mismatched_cancellation_do_not_end_the_active_workflow() {
    let engine = start_discovery();
    let stale = scan_result(999, 0x0304);
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_dispatch(engine, &stale.view()) },
        BotaDeviceSdkStatusV1::OperationFailed
    );
    let wrong_owner = scan_result(2, 0x9999);
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_dispatch(engine, &wrong_owner.view()) },
        BotaDeviceSdkStatusV1::OperationFailed
    );

    let matching = scan_result(2, 0x0304);
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_dispatch(engine, &matching.view()) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn mismatched_cancel_is_rejected_before_the_matching_owner_cancels() {
    let engine = start_discovery();
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x9999) },
        BotaDeviceSdkStatusV1::OperationFailed
    );
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_cancel(engine, 0x0102, 0x0304) },
        BotaDeviceSdkStatusV1::Ok
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

fn drain(engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1) {
    loop {
        let mut output = ptr::null_mut();
        match unsafe { bota_device_sdk_v1_engine_poll_output(engine, &mut output) } {
            BotaDeviceSdkStatusV1::Ok => unsafe { bota_device_sdk_v1_packet_free(output) },
            BotaDeviceSdkStatusV1::NoOutput => break,
            status => panic!("unexpected poll status: {status:?}"),
        }
    }
}
