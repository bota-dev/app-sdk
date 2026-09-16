use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, BotaDeviceSdkStatusV1,
    bota_device_sdk_v1_engine_dispatch, bota_device_sdk_v1_engine_free,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_engine_poll_output,
    bota_device_sdk_v1_engine_start, bota_device_sdk_v1_packet_free,
    bota_device_sdk_v1_packet_view, capability_bits, field_id, packet_kind,
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

#[test]
fn encrypted_upload_v2_ffi_preserves_the_staging_and_receipt_gate() {
    let command = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_TRANSFER_ENCRYPTED_RECORDING)
        .with_cancellation_id(0x0102, 0x0304)
        .with_text(field_id::SERIAL_NUMBER, "ABC123")
        .with_text(
            field_id::RECORDING_UUID,
            "00112233-4455-6677-8899-aabbccddeeff",
        )
        .with_u64(field_id::RECORDING_GENERATION, 9)
        .with_u64(field_id::STORAGE_FORMAT, 3)
        .with_bytes(field_id::UPLOAD_SESSION_UUID, vec![0x11; 16])
        .with_u64(field_id::OWNER_REVISION, 3)
        .with_u64(field_id::TRANSPORT_SESSION_ID, 0x1122_3344_5566)
        .with_text(field_id::MATERIAL_ID, "v2-material-1")
        .with_text(field_id::SINK_ID, "v2-sink-1")
        .with_u64(field_id::UPLOAD_PROFILE, 3)
        .with_u64(field_id::UPLOAD_SECURITY_POLICY, 2)
        .with_u64(field_id::CAPABILITY_FLAGS, 0x7f)
        .with_u64(field_id::MAX_SIGNED_BLOB_BYTES, 1024)
        .with_u64(field_id::MAX_MANIFEST_BYTES, 1024)
        .with_u64(field_id::MAX_DATA_PAYLOAD_BYTES, 244)
        .with_u64(field_id::MAX_WINDOW_PACKETS, 16)
        .with_u64(field_id::CHECKPOINT_INTERVAL, 8)
        .with_u64(field_id::MAX_MISSING_SEQUENCES, 16)
        .with_u64(field_id::WINDOW_PACKETS, 16)
        .with_u64(field_id::DATA_PAYLOAD_BYTES, 244)
        .with_u64(field_id::CIPHERTEXT_LENGTH, 330)
        .with_bytes(field_id::CIPHERTEXT_SHA256, vec![0x33; 32]);
    let engine = bota_device_sdk_v1_engine_new();
    let capabilities = capability_bits::BLE
        | capability_bits::PERSISTENCE
        | capability_bits::PROGRESS
        | capability_bits::HOST_MATERIAL
        | capability_bits::RECORDING_SINK
        | capability_bits::NETWORK_TRANSFER;
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_start(engine, &command.view(), capabilities) },
        BotaDeviceSdkStatusV1::Ok
    );

    assert_eq!(poll(engine).kind, packet_kind::NOTIFICATION_STARTED);
    let load = poll(engine);
    assert_eq!(
        load.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_LOAD_CHECKPOINT
    );
    dispatch_v2(
        engine,
        load.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_LOADED),
    );

    let truncate = poll(engine);
    assert_eq!(
        truncate.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_TRUNCATE_SINK
    );
    dispatch_v2(
        engine,
        truncate.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_SINK_TRUNCATED),
    );

    let prepare = poll(engine);
    assert_eq!(
        prepare.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_PREPARE_SESSION
    );
    dispatch_v2(
        engine,
        prepare.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_SESSION_PREPARED)
            .with_bytes(field_id::AUTHORIZATION_SHA256, vec![0x66; 32]),
    );

    let transfer = poll(engine);
    assert_eq!(
        transfer.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_START_TRANSFER
    );
    dispatch_v2(
        engine,
        transfer.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_STARTED),
    );
    dispatch_v2(
        engine,
        transfer.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_COMPLETED)
            .with_u64(field_id::CIPHERTEXT_LENGTH, 330)
            .with_bytes(field_id::CIPHERTEXT_SHA256, vec![0x33; 32])
            .with_u64(field_id::MANIFEST_LENGTH, 580)
            .with_bytes(field_id::MANIFEST_SHA256, vec![0x55; 32])
            .with_u64(field_id::BLOCK_COUNT, 1),
    );

    let stage = poll(engine);
    assert_eq!(
        stage.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_STAGE_ARTIFACTS
    );
    dispatch_v2(
        engine,
        stage.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_ARTIFACTS_STAGED),
    );

    let staged = poll(engine);
    assert_eq!(
        staged.kind,
        packet_kind::NOTIFICATION_ENCRYPTED_UPLOAD_V2_STAGED
    );
    let staged_fields =
        unsafe { slice::from_raw_parts(staged.fields, staged.field_count as usize) };
    assert!(
        staged_fields
            .iter()
            .all(|field| field.field_id != field_id::PAYLOAD)
    );
    let await_receipt = poll(engine);
    assert_eq!(
        await_receipt.kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_AWAIT_RECEIPT
    );
    dispatch_v2(
        engine,
        await_receipt.request_id,
        BotaDeviceSdkPacketV1::new(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECEIPT_ACCEPTED)
            .with_bytes(field_id::RECEIPT_SHA256, vec![0x77; 32]),
    );
    assert_eq!(
        poll(engine).kind,
        packet_kind::HOST_EFFECT_ENCRYPTED_UPLOAD_V2_CONFIRM_WITH_RECEIPT
    );
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

fn dispatch_v2(
    engine: *mut bota_device_sdk_ffi::BotaDeviceSdkEngineV1,
    request_id: u64,
    event: BotaDeviceSdkPacketV1,
) {
    let event = event
        .with_operation(8)
        .with_request_id(request_id)
        .with_cancellation_id(0x0102, 0x0304);
    assert_eq!(
        unsafe { bota_device_sdk_v1_engine_dispatch(engine, &event.view()) },
        BotaDeviceSdkStatusV1::Ok
    );
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
