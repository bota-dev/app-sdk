use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, HostMaterialEffect, RequestId,
        WorkflowEngine, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{CHAR_CREDENTIAL_ENVELOPE, CHAR_DEVICE_TOKEN, CHAR_PROVISIONING_RESULT},
    model::{DeviceSerialNumber, HostMaterialId, ProvisioningMaterial, ProvisioningNonce},
};

fn envelope() -> Vec<u8> {
    let mut bytes = vec![0; 230];
    bytes[..8].copy_from_slice(b"BOTATOK1");
    bytes
}

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
            credential_envelope: Some(envelope()),
            api_endpoint: vec![2],
            device_token: vec![],
            mtu: 185,
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
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. }) if characteristic_uuid == CHAR_CREDENTIAL_ENVELOPE && payload[..2] == [0, 2] && payload[2..] == envelope()[..178]),
    );
    let second_chunk = engine
        .dispatch(host(
            first_chunk_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let second_chunk_request = request_id(
        &second_chunk,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. }) if characteristic_uuid == CHAR_CREDENTIAL_ENVELOPE && payload[..2] == [1, 2] && payload[2..] == envelope()[178..]),
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
fn provisioning_rejects_oversized_plaintext_before_any_material_write() {
    let mut engine = WorkflowEngine::default();
    let (material_request, _) = reach_material_request(&mut engine);
    let failed = engine
        .dispatch(host(
            material_request,
            HostEventKind::ProvisioningMaterialPrepared {
                material: ProvisioningMaterial {
                    credential_envelope: None,
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
        WorkflowStatus::Failed { error } if error.code == ErrorCode::InvalidInput
    ));
}

#[test]
fn provisioning_disconnect_fails_without_exposing_material_in_notifications() {
    let mut engine = WorkflowEngine::default();
    let mut secret = envelope();
    secret[8..25].copy_from_slice(b"dtok_secret_value");
    let (subscribe_request, effects) = reach_subscription(
        &mut engine,
        ProvisioningMaterial {
            credential_envelope: Some(secret.clone()),
            api_endpoint: vec![1],
            device_token: vec![],
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

#[test]
fn provisioning_disconnect_releases_owner_for_a_fresh_retry() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let nonce_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Read { .. }))
    });
    engine
        .dispatch(host(
            nonce_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "connected-device".into(),
                reason_code: None,
            }),
        ))
        .unwrap();

    let retry = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    assert!(
        retry
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Read { .. })))
    );
    assert!(matches!(engine.status(), WorkflowStatus::Running { .. }));
}

#[test]
fn encrypted_token_uses_dedicated_characteristic_without_plaintext_fallback() {
    use bota_device_sdk_core::generated::protocol::{
        CHAR_CREDENTIAL_ENVELOPE, SERVICE_BOTA_CREDENTIAL,
    };
    let mut envelope = vec![0; 230];
    envelope[..8].copy_from_slice(b"BOTATOK1");
    let mut engine = WorkflowEngine::default();
    let (subscription, _) = reach_subscription(
        &mut engine,
        ProvisioningMaterial {
            api_endpoint: vec![0],
            device_token: vec![],
            credential_envelope: Some(envelope),
            mtu: 23,
        },
    );
    let effects = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let endpoint = request_id(&effects, |e| {
        matches!(e, Effect::Ble(BleEffect::Write { .. }))
    });
    let effects = engine
        .dispatch(host(endpoint, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    assert!(effects.iter().any(|e| matches!(&e.effect, Effect::Ble(BleEffect::Write {service_uuid, characteristic_uuid, payload, ..})
        if service_uuid == SERVICE_BOTA_CREDENTIAL && characteristic_uuid == CHAR_CREDENTIAL_ENVELOPE && payload[0] == 0 && payload[1] == 15)));
    assert!(!effects.iter().any(|e| matches!(&e.effect, Effect::Ble(BleEffect::Write {characteristic_uuid, ..}) if characteristic_uuid == CHAR_DEVICE_TOKEN)));
}

#[test]
fn mixed_material_is_rejected_before_subscribing_or_writing() {
    let mut engine = WorkflowEngine::default();
    let (request, _) = reach_material_request(&mut engine);
    let effects = engine
        .dispatch(host(
            request,
            HostEventKind::ProvisioningMaterialPrepared {
                material: ProvisioningMaterial {
                    api_endpoint: vec![0],
                    device_token: b"dtok_legacy".to_vec(),
                    credential_envelope: Some(envelope()),
                    mtu: 185,
                },
            },
        ))
        .unwrap();
    assert!(
        matches!(engine.status(), WorkflowStatus::Failed { error } if error.code == ErrorCode::InvalidInput)
    );
    assert!(!effects.iter().any(|e| matches!(
        e.effect,
        Effect::Ble(BleEffect::Write { .. } | BleEffect::Subscribe { .. })
    )));
}

#[test]
fn plaintext_token_uses_legacy_characteristic_only() {
    let mut engine = WorkflowEngine::default();
    let (subscription, _) = reach_subscription(
        &mut engine,
        ProvisioningMaterial {
            api_endpoint: vec![0],
            device_token: b"dtok_legacy".to_vec(),
            credential_envelope: None,
            mtu: 23,
        },
    );
    let effects = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let endpoint = request_id(&effects, |e| {
        matches!(e, Effect::Ble(BleEffect::Write { .. }))
    });
    let effects = engine
        .dispatch(host(endpoint, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    assert!(effects.iter().any(|e| matches!(&e.effect,
        Effect::Ble(BleEffect::Write { service_uuid, characteristic_uuid, payload, .. })
        if service_uuid == bota_device_sdk_core::generated::protocol::SERVICE_BOTA_PROVISIONING
        && characteristic_uuid == CHAR_DEVICE_TOKEN && payload == b"\x00\x01dtok_legacy")));
    assert!(!effects.iter().any(
        |e| matches!(&e.effect, Effect::Ble(BleEffect::Write {characteristic_uuid, ..})
        if characteristic_uuid == CHAR_CREDENTIAL_ENVELOPE)
    ));
}
