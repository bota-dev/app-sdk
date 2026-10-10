use bota_device_sdk_core::model::ByoRecovery;
use bota_device_sdk_ffi::{
    BotaDeviceSdkPacketV1, BotaDeviceSdkStatusV1, bota_device_sdk_v1_engine_free,
    bota_device_sdk_v1_engine_new, bota_device_sdk_v1_packet_free, bota_device_sdk_v1_packet_view,
    bota_device_sdk_v1_protocol_encode, field_id::*, packet_kind,
};
use std::{ptr, slice};

fn create() -> BotaDeviceSdkPacketV1 {
    scope(1)
}
fn scope(command: u64) -> BotaDeviceSdkPacketV1 {
    BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_REDUCE_BYO_RECOVERY)
        .with_u64(COMMAND, command)
        .with_u64(BYO_ENVIRONMENT, 1)
        .with_text(BYO_ORGANIZATION_ID, "organization")
        .with_text(BYO_PROJECT_ID, "project")
        .with_text(BYO_DEVICE_ID, "device")
        .with_u64(BYO_BINDING_GENERATION, 1)
        .with_u64(BYO_ASSIGNMENT_GENERATION, 1)
        .with_text(BYO_POLICY_REVISION, "1")
        .with_text(RECORDING_UUID, "00112233-4455-6677-8899-aabbccddeeff")
        .with_u64(RECORDING_GENERATION, 1)
}

#[test]
fn native_abi_roundtrips_pending_renewal_before_any_network_effect() {
    use bota_device_sdk_core::model::{ByoCapture, ByoEnvironment, ByoRoute};
    let mut state = ByoRecovery::new(ByoCapture {
        environment: ByoEnvironment::Gamma,
        organization_id: "organization".into(),
        project_id: "project".into(),
        device_id: "device".into(),
        binding_generation: 1,
        device_assignment_generation: 1,
        policy_revision: "1".into(),
        recording_uuid: "00112233-4455-6677-8899-aabbccddeeff".into(),
        recording_generation: 1,
    })
    .unwrap();
    state.source_finalized(1000, "a".repeat(64)).unwrap();
    state
        .bind(
            ByoRoute {
                recording_id: "recording".into(),
                configuration_id: "00112233-4455-4677-8899-aabbccddeeff".into(),
                configuration_revision: 1,
                configuration_sha256: "b".repeat(64),
                destination_ref: "customer".into(),
                session_id: "10112233-4455-4677-8899-aabbccddeeff".into(),
                owner_revision: 1,
            },
            false,
        )
        .unwrap();
    let engine = bota_device_sdk_v1_engine_new();
    let operation = "20112233-4455-4677-8899-aabbccddeeff";
    for command in [13, 15, 14] {
        let mut packet = scope(command).with_bytes(CHECKPOINT, state.encode_checkpoint().unwrap());
        if command != 15 {
            packet = packet
                .with_text(BYO_OPERATION_ID, operation)
                .with_u64(BYO_RENEWAL_REVISION, if command == 14 { 1 } else { 0 });
        }
        let mut output = ptr::null_mut();
        assert_eq!(
            unsafe { bota_device_sdk_v1_protocol_encode(engine, &packet.view(), &mut output) },
            BotaDeviceSdkStatusV1::Ok
        );
        let mut view = std::mem::MaybeUninit::uninit();
        assert_eq!(
            unsafe { bota_device_sdk_v1_packet_view(output, view.as_mut_ptr()) },
            BotaDeviceSdkStatusV1::Ok
        );
        let view = unsafe { view.assume_init() };
        let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
        let field = fields.iter().find(|f| f.field_id == CHECKPOINT).unwrap();
        state = ByoRecovery::decode_checkpoint(unsafe {
            slice::from_raw_parts(field.data.data, field.data.len as usize)
        })
        .unwrap();
        assert_eq!(
            state.renewal_operation.as_deref(),
            if command == 14 { None } else { Some(operation) }
        );
        assert_eq!(state.renewal_revision, if command == 14 { 1 } else { 0 });
        assert!(!state.may_cleanup());
        unsafe { bota_device_sdk_v1_packet_free(output) };
    }
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}
#[test]
fn native_abi_reduces_typed_metadata_and_rejects_materials_and_oversized_checkpoints() {
    let engine = bota_device_sdk_v1_engine_new();
    for (packet, expected) in [
        (create(), BotaDeviceSdkStatusV1::Ok),
        (
            create().with_bytes(CHECKPOINT, vec![0; 2049]),
            BotaDeviceSdkStatusV1::OperationFailed,
        ),
        (
            create().with_bytes(VALUE, b"opaque authorization".to_vec()),
            BotaDeviceSdkStatusV1::OperationFailed,
        ),
        (
            BotaDeviceSdkPacketV1::new(packet_kind::PROTOCOL_REDUCE_BYO_RECOVERY),
            BotaDeviceSdkStatusV1::OperationFailed,
        ),
    ] {
        let mut output = ptr::null_mut();
        assert_eq!(
            unsafe { bota_device_sdk_v1_protocol_encode(engine, &packet.view(), &mut output) },
            expected
        );
        if expected == BotaDeviceSdkStatusV1::Ok {
            let mut view = std::mem::MaybeUninit::uninit();
            assert_eq!(
                unsafe { bota_device_sdk_v1_packet_view(output, view.as_mut_ptr()) },
                BotaDeviceSdkStatusV1::Ok
            );
            let view = unsafe { view.assume_init() };
            let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
            let field = fields.iter().find(|f| f.field_id == CHECKPOINT).unwrap();
            let bytes = unsafe { slice::from_raw_parts(field.data.data, field.data.len as usize) };
            assert!(ByoRecovery::decode_checkpoint(bytes).is_ok());
            assert_eq!(
                fields
                    .iter()
                    .find(|f| f.field_id == BYO_MAY_CLEANUP)
                    .unwrap()
                    .unsigned_value,
                0
            );
            unsafe { bota_device_sdk_v1_packet_free(output) };
        } else {
            assert!(output.is_null());
        }
    }
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}
