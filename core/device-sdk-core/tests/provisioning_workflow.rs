use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, HostMaterialEffect, RequestId,
        WorkflowEngine, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{CHAR_DEVICE_TOKEN, CHAR_PROVISIONING_RESULT},
    model::{DeviceSerialNumber, HostMaterialId, ProvisioningMaterial, ProvisioningNonce},
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([3; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Timer,
        Capability::Persistence,
        Capability::HostMaterial,
    ])
}

fn command() -> Command {
    Command::Provision {
        device: DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
        material_id: HostMaterialId::new("bind-attempt-1").unwrap(),
    }
}

fn request_id(effects: &[EffectRequest], predicate: impl Fn(&Effect) -> bool) -> RequestId {
    effects
        .iter()
        .find(|request| predicate(&request.effect))
        .expect("expected effect")
        .request_id
}

fn host(request_id: RequestId, kind: HostEventKind) -> Event {
    Event::Host(HostEvent { request_id, kind })
}

fn reach_material_request(engine: &mut WorkflowEngine) -> (RequestId, Vec<EffectRequest>) {
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let nonce_read = request_id(
        &started,
        |effect| matches!(effect, Effect::Ble(BleEffect::Read { characteristic_uuid, .. }) if characteristic_uuid.ends_with("0002-1000-8000-00805F9B34FB")),
    );
    let public_key_read = engine
        .dispatch(host(
            nonce_read,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: vec![0x11; 16],
            }),
        ))
        .unwrap();
    let public_key_request = request_id(
        &public_key_read,
        |effect| matches!(effect, Effect::Ble(BleEffect::Read { characteristic_uuid, .. }) if characteristic_uuid.ends_with("0001-1000-8000-00805F9B34FB")),
    );
    let material_request = engine
        .dispatch(host(
            public_key_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: vec![0x22; 64],
            }),
        ))
        .unwrap();
    let request = request_id(
        &material_request,
        |effect| matches!(effect, Effect::HostMaterial(HostMaterialEffect::PrepareProvisioning { nonce: ProvisioningNonce(bytes), .. }) if bytes == &[0x11; 16]),
    );
    (request, material_request)
}

fn reach_subscription(
    engine: &mut WorkflowEngine,
    material: ProvisioningMaterial,
) -> (RequestId, Vec<EffectRequest>) {
    let (material_request, _) = reach_material_request(engine);
    let subscribing = engine
        .dispatch(host(
            material_request,
            HostEventKind::ProvisioningMaterialPrepared { material },
        ))
        .unwrap();
    let subscribe_request = request_id(
        &subscribing,
        |effect| matches!(effect, Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. }) if characteristic_uuid == CHAR_PROVISIONING_RESULT),
    );
    (subscribe_request, subscribing)
}

#[test]
fn provisioning_reads_nonce_and_key_then_writes_bounded_chunks_after_subscribing() {
    let mut engine = WorkflowEngine::default();
    let (subscribe_request, _) = reach_subscription(
        &mut engine,
        ProvisioningMaterial {
            api_endpoint: vec![2],
            device_token: b"token123".to_vec(),
            mtu: 12,
        },
    );

    let endpoint_write = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let endpoint_request = request_id(
        &endpoint_write,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { payload, .. }) if payload == &[2]),
    );
    let first_chunk = engine
        .dispatch(host(
            endpoint_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let first_chunk_request = request_id(
        &first_chunk,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. }) if characteristic_uuid == CHAR_DEVICE_TOKEN && payload == &[0, 2, b't', b'o', b'k', b'e', b'n']),
    );
    let second_chunk = engine
        .dispatch(host(
            first_chunk_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let second_chunk_request = request_id(
        &second_chunk,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. }) if characteristic_uuid == CHAR_DEVICE_TOKEN && payload == &[1, 2, b'1', b'2', b'3']),
    );
    let waiting = engine
        .dispatch(host(
            second_chunk_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(waiting.is_empty());

    let completed = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0],
            }),
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(
            bota_device_sdk_core::engine::WorkflowNotification::Completed {
                operation: Operation::Provision
            }
        )
    )));
    assert_eq!(
        engine.status(),
        &WorkflowStatus::Completed {
            operation: Operation::Provision
        }
    );
}

#[test]
fn provisioning_rejects_too_many_chunks_before_any_material_write() {
    let mut engine = WorkflowEngine::default();
    let (material_request, _) = reach_material_request(&mut engine);
    let failed = engine
        .dispatch(host(
            material_request,
            HostEventKind::ProvisioningMaterialPrepared {
                material: ProvisioningMaterial {
                    api_endpoint: vec![2],
                    device_token: vec![0x55; 256],
                    mtu: 8,
                },
            },
        ))
        .unwrap();

    assert!(
        !failed
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::PayloadTooLarge
    ));
}

#[test]
fn provisioning_disconnect_fails_without_exposing_material_in_notifications() {
    let mut engine = WorkflowEngine::default();
    let secret = b"dtok_secret_value".to_vec();
    let (subscribe_request, effects) = reach_subscription(
        &mut engine,
        ProvisioningMaterial {
            api_endpoint: vec![1],
            device_token: secret.clone(),
            mtu: 185,
        },
    );
    let serialized_notifications = serde_json::to_string(
        &effects
            .iter()
            .filter(|request| matches!(request.effect, Effect::Notify(_)))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(!serialized_notifications.contains("dtok_secret_value"));
    assert!(!serialized_notifications.contains("bind-attempt-1"));

    let failed = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "connected-device".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(failed.iter().any(|request| matches!(
        &request.effect,
        Effect::Notify(bota_device_sdk_core::engine::WorkflowNotification::Failed { error })
            if error.code == ErrorCode::NotConnected
    )));
}
