use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkStatusV1, bota_device_sdk_v1_engine_free,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_engine_start, capability_bits, field_id,
    packet_kind,
};

const SERIAL: &str = "ABC123";
const RECORDING: &str = "00112233-4455-6677-8899-aabbccddeeff";

fn all_capabilities() -> u64 {
    capability_bits::BLE
        | capability_bits::TIMER
        | capability_bits::PERSISTENCE
        | capability_bits::SECURE_STORAGE
        | capability_bits::NETWORK_TRANSFER
        | capability_bits::PROGRESS
        | capability_bits::HOST_MATERIAL
        | capability_bits::RECORDING_SINK
        | capability_bits::FIRMWARE_BLOB
}

fn start(packet: &BotaDeviceSdkPacketV1, capabilities: u64) -> BotaDeviceSdkStatusV1 {
    let engine = bota_device_sdk_v1_engine_new();
    let view = packet.view();
    let status = unsafe { bota_device_sdk_v1_engine_start(engine, &view, capabilities) };
    unsafe { bota_device_sdk_v1_engine_free(engine) };
    status
}

fn serial_command(kind: u32) -> BotaDeviceSdkPacketV1 {
    BotaDeviceSdkPacketV1::new(kind)
        .with_cancellation_id(0x0102, 0x0304)
        .with_text(field_id::SERIAL_NUMBER, SERIAL)
}

#[test]
fn every_workflow_command_starts_through_the_native_entry_point() {
    let commands = [
        BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
            .with_cancellation_id(1, 1)
            .with_u64(field_id::TIMEOUT_MS, 5_000)
            .with_bool(field_id::ALLOW_DUPLICATES, true),
        serial_command(packet_kind::COMMAND_CONNECT)
            .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
            .with_text(field_id::NAME, "Bota Note")
            .with_text(field_id::ADVERTISED_ADDRESS, "aabbccddeeff")
            .with_i64(field_id::RSSI, -62),
        serial_command(packet_kind::COMMAND_RECONNECT)
            .with_text(field_id::STORED_PERIPHERAL_ID, "peripheral-1")
            .with_text(field_id::STORED_NAME, "Bota Note")
            .with_text(field_id::ADVERTISED_ADDRESS, "aa:bb:cc:dd:ee:ff")
            .with_u64(field_id::SCAN_TIMEOUT_MS, 5_000)
            .with_u64(field_id::CONNECTION_TIMEOUT_MS, 15_000),
        serial_command(packet_kind::COMMAND_PROVISION)
            .with_text(field_id::MATERIAL_ID, "material-1"),
        serial_command(packet_kind::COMMAND_TRANSFER_RECORDING)
            .with_text(field_id::RECORDING_UUID, RECORDING)
            .with_text(field_id::SINK_ID, "sink-1")
            .with_u64(field_id::TOTAL_UNITS, 128),
        serial_command(packet_kind::COMMAND_TRANSFER_ENCRYPTED_RECORDING)
            .with_text(field_id::RECORDING_UUID, RECORDING)
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
            .with_bytes(field_id::CIPHERTEXT_SHA256, vec![0x33; 32]),
        serial_command(packet_kind::COMMAND_UPLOAD_RECORDING)
            .with_text(field_id::RECORDING_UUID, RECORDING)
            .with_text(field_id::UPLOAD_ID, "upload-1")
            .with_text(field_id::DESTINATION_ID, "destination-1"),
        serial_command(packet_kind::COMMAND_UPDATE_FIRMWARE)
            .with_text(field_id::FIRMWARE_VERSION, "1.0.11")
            .with_u64(field_id::FIRMWARE_SIZE_BYTES, 1_048_576)
            .with_u64(field_id::FIRMWARE_CRC32, 0x1234_5678)
            .with_u64(field_id::DOWNLOAD_ID, 42)
            .with_u64(field_id::SCAN_TIMEOUT_MS, 5_000)
            .with_u64(field_id::CONNECTION_TIMEOUT_MS, 15_000),
        serial_command(packet_kind::COMMAND_READ_DEVICE_LOGS),
        serial_command(packet_kind::COMMAND_FACTORY_RESET)
            .with_text(field_id::COMMAND_ID, "reset-1")
            .with_text(field_id::GRANT_ID, "grant-1"),
        serial_command(packet_kind::COMMAND_RESUME_FACTORY_RESET)
            .with_text(field_id::COMMAND_ID, "reset-1")
            .with_u64(field_id::RESULT_CODE, 0)
            .with_u64(field_id::DELETED_RECORDING_COUNT, 9),
        serial_command(packet_kind::COMMAND_RESUME_FACTORY_RESET)
            .with_text(field_id::COMMAND_ID, "reset-after-reinstall"),
    ];

    for command in &commands {
        assert_eq!(
            start(command, all_capabilities()),
            BotaDeviceSdkStatusV1::Ok
        );
    }
}

#[test]
fn selected_device_connect_does_not_require_an_expected_serial() {
    let command = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_CONNECT)
        .with_cancellation_id(0x0102, 0x0304)
        .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
        .with_text(field_id::NAME, "Bota Pin")
        .with_i64(field_id::RSSI, -62);

    assert_eq!(
        start(&command, all_capabilities()),
        BotaDeviceSdkStatusV1::Ok
    );
}

#[test]
fn invalid_command_inputs_fail_without_bypassing_core_validation() {
    let invalid_serial = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_READ_DEVICE_LOGS)
        .with_text(field_id::SERIAL_NUMBER, "not valid");
    let invalid_uuid = serial_command(packet_kind::COMMAND_TRANSFER_RECORDING)
        .with_text(field_id::RECORDING_UUID, "invalid")
        .with_text(field_id::SINK_ID, "sink-1")
        .with_u64(field_id::TOTAL_UNITS, 10);
    let oversized_firmware = serial_command(packet_kind::COMMAND_UPDATE_FIRMWARE)
        .with_text(field_id::FIRMWARE_VERSION, "1.0.11")
        .with_u64(field_id::FIRMWARE_SIZE_BYTES, u64::from(u32::MAX) + 1)
        .with_u64(field_id::FIRMWARE_CRC32, 0)
        .with_u64(field_id::DOWNLOAD_ID, 1);
    let missing_field = serial_command(packet_kind::COMMAND_CONNECT);
    let unknown_kind = serial_command(0x01ff);
    let duplicate_field = serial_command(packet_kind::COMMAND_READ_DEVICE_LOGS)
        .with_text(field_id::SERIAL_NUMBER, SERIAL);
    let mistyped_field = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
        .with_text(field_id::TIMEOUT_MS, "5000")
        .with_bool(field_id::ALLOW_DUPLICATES, false);
    let unknown_field = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
        .with_u64(field_id::TIMEOUT_MS, 5_000)
        .with_bool(field_id::ALLOW_DUPLICATES, false)
        .with_u64(999, 1);
    let partial_reset_result = serial_command(packet_kind::COMMAND_RESUME_FACTORY_RESET)
        .with_text(field_id::COMMAND_ID, "reset-1")
        .with_u64(field_id::RESULT_CODE, 0);
    let v2_sensitive_payload = serial_command(packet_kind::COMMAND_TRANSFER_ENCRYPTED_RECORDING)
        .with_bytes(field_id::PAYLOAD, vec![0x41; 32]);

    for command in [
        invalid_serial,
        invalid_uuid,
        oversized_firmware,
        missing_field,
        unknown_kind,
        duplicate_field,
        mistyped_field,
        unknown_field,
        partial_reset_result,
        v2_sensitive_payload,
    ] {
        assert_eq!(
            start(&command, all_capabilities()),
            BotaDeviceSdkStatusV1::OperationFailed
        );
    }
}

#[test]
fn unknown_capability_bits_and_unsupported_abi_are_rejected() {
    let command = BotaDeviceSdkPacketV1::new(packet_kind::COMMAND_DISCOVER_DEVICES)
        .with_u64(field_id::TIMEOUT_MS, 5_000)
        .with_bool(field_id::ALLOW_DUPLICATES, false);
    assert_eq!(
        start(&command, all_capabilities() | (1 << 63)),
        BotaDeviceSdkStatusV1::OperationFailed
    );

    let engine = bota_device_sdk_v1_engine_new();
    let mut view = command.view();
    view.abi_version = 2;
    let status = unsafe { bota_device_sdk_v1_engine_start(engine, &view, all_capabilities()) };
    assert_eq!(status, BotaDeviceSdkStatusV1::UnsupportedAbi);
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}
