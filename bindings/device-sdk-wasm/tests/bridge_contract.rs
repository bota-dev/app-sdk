use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, Effect, HostEvent, HostEventKind, PersistenceEffect,
        WorkflowNotification, WorkflowStatus,
    },
    protocol::EncryptedUploadV2Capabilities,
};
use bota_device_sdk_wasm::{
    BridgeCore, decode_device_status_dto, decode_encrypted_upload_v2_capabilities_dto,
};

fn request_id_for(
    effects: &[bota_device_sdk_core::engine::EffectRequest],
    predicate: impl Fn(&Effect) -> bool,
) -> bota_device_sdk_core::engine::RequestId {
    effects
        .iter()
        .find(|request| predicate(&request.effect))
        .map(|request| request.request_id)
        .expect("expected effect")
}

#[test]
fn exact_connection_is_owned_by_the_shared_rust_workflow() {
    let mut bridge = BridgeCore::default();
    let cancellation_id = [0x5a; 16];

    let effects = bridge
        .start_exact_connection(
            "GDPPSBZJN6",
            "browser-peripheral-1",
            Some("Bota Pin"),
            cancellation_id,
        )
        .expect("connection should start");
    let connect_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Connect { peripheral_id })
                if peripheral_id == "browser-peripheral-1"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: connect_request,
            kind: HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: "browser-peripheral-1".to_owned(),
            }),
        })
        .expect("connect event should be accepted");
    let discover_request = request_id_for(&effects, |effect| {
        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: discover_request,
            kind: HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: "browser-peripheral-1".to_owned(),
            }),
        })
        .expect("service discovery should be accepted");
    let serial_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read {
                service_uuid,
                characteristic_uuid,
            }) if service_uuid == "180A" && characteristic_uuid == "2A25"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: serial_request,
            kind: HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"GDPPSBZJN6".to_vec(),
            }),
        })
        .expect("serial read should be accepted");
    let persist_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { device, candidate })
                if device.as_str() == "GDPPSBZJN6"
                    && candidate.peripheral_id == "browser-peripheral-1"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: persist_request,
            kind: HostEventKind::ConnectionIdentitySaved,
        })
        .expect("identity persistence should complete the workflow");

    assert!(effects.iter().any(|request| {
        matches!(
            &request.effect,
            Effect::Notify(WorkflowNotification::ConnectionEstablished { device, .. })
                if device.as_str() == "GDPPSBZJN6"
        )
    }));
    assert!(matches!(bridge.status(), WorkflowStatus::Completed { .. }));
}

#[test]
fn status_decoder_uses_the_frozen_status_layout() {
    let status = decode_device_status_dto(&[
        0x43, 0x03, 0x03, 0x01, 0x00, 0xf1, 0x53, 0x65, 0x18, 0x00, 0x08, 0x00, 0x02, 0x14, 0x03,
        0x68, 0x10, 0x49, 0x4d, 0x45, 0x49, 0x3d, 0x31, 0x32, 0x33, 0x0a, 0x52, 0x4f, 0x41, 0x4d,
        0x3d, 0x31, 0x0a,
    ])
    .expect("valid status should decode");

    assert_eq!(status.battery_percent, 67);
    assert_eq!(status.battery_mv, Some(4200));
    assert_eq!(status.storage_total_mb, 2048);
    assert_eq!(status.storage_used_mb, 512);
    assert_eq!(status.pending_recordings, 1);
    assert!(status.flags.wifi_connected);
    assert!(status.flags.lte_connected);
    assert_eq!(
        status.modem_info.expect("modem info").imei.as_deref(),
        Some("123")
    );
}

#[test]
fn encrypted_upload_capability_decoder_preserves_exact_bounds() {
    let decoded = decode_encrypted_upload_v2_capabilities_dto(&[
        0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x98, 0x01, 0x44, 0x02, 0xf4, 0x00, 0x10,
        0x00, 0x08, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
    ])
    .expect("valid capabilities should decode");

    assert_eq!(
        decoded,
        EncryptedUploadV2Capabilities {
            flags: 0x7f,
            maximum_signed_blob_bytes: 408,
            maximum_manifest_bytes: 580,
            maximum_data_payload_bytes: 244,
            maximum_window_packets: 16,
            durable_checkpoint_interval_blocks: 8,
            maximum_missing_sequences: 4,
        }
    );
}

#[test]
fn malformed_status_is_rejected_by_the_shared_decoder() {
    let error = decode_device_status_dto(&[0x00, 0x01]).expect_err("truncated status must fail");

    assert_eq!(error.code.as_str(), "truncated_packet");
    assert_eq!(error.operation.as_str(), "decode");
}
