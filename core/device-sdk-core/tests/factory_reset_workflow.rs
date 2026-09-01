use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, HostMaterialEffect, PersistenceEffect,
        RequestId, WorkflowEngine, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        CHAR_DEVICE_COMMAND, CHAR_PROVISIONING_RESULT, DEVICE_CMD_BLE_FACTORY_RESET,
        DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK,
    },
    model::{
        DeviceSerialNumber, DurableFactoryResetResult, FactoryResetCommandId, FactoryResetResult,
        HostMaterialId,
    },
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([4; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Timer,
        Capability::Persistence,
        Capability::HostMaterial,
    ])
}

fn device() -> DeviceSerialNumber {
    DeviceSerialNumber::new("EVFXXW67KP").unwrap()
}

fn command_id() -> FactoryResetCommandId {
    FactoryResetCommandId::new("cmd_reset_123").unwrap()
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

fn start_reset(engine: &mut WorkflowEngine) -> (RequestId, RequestId) {
    let started = engine
        .start(
            Command::FactoryReset {
                device: device(),
                command_id: command_id(),
                grant_id: HostMaterialId::new("grant-1").unwrap(),
            },
            &capabilities(),
            CANCELLATION,
        )
        .unwrap();
    let nonce_read = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Read { .. }))
    });
    let grant_request_effects = engine
        .dispatch(host(
            nonce_read,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: vec![0x33; 16],
            }),
        ))
        .unwrap();
    let grant_request = request_id(&grant_request_effects, |effect| {
        matches!(
            effect,
            Effect::HostMaterial(HostMaterialEffect::PrepareFactoryResetGrant { .. })
        )
    });
    let subscribing = engine
        .dispatch(host(
            grant_request,
            HostEventKind::FactoryResetGrantPrepared {
                grant: vec![0x44; 171],
            },
        ))
        .unwrap();
    let subscribe_request = request_id(
        &subscribing,
        |effect| matches!(effect, Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. }) if characteristic_uuid == CHAR_PROVISIONING_RESULT),
    );
    let grant_write = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let grant_write_request = request_id(
        &grant_write,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. }) if characteristic_uuid == CHAR_DEVICE_COMMAND && payload == &vec![0x44; 171]),
    );
    let opcode_write = engine
        .dispatch(host(
            grant_write_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let opcode_request = request_id(
        &opcode_write,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { payload, .. }) if payload == &[DEVICE_CMD_BLE_FACTORY_RESET]),
    );
    engine
        .dispatch(host(
            opcode_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    (subscribe_request, opcode_request)
}

#[test]
fn factory_reset_persists_exact_success_before_receipt_and_deletes_after_receipt() {
    let mut engine = WorkflowEngine::default();
    let (subscribe_request, _) = start_reset(&mut engine);
    let persisting = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 0x34, 0x12],
            }),
        ))
        .unwrap();
    let save_request = request_id(
        &persisting,
        |effect| matches!(effect, Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { result }) if result.command_id == command_id() && result.result.deleted_recording_count == 0x1234),
    );
    assert!(
        !persisting
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );

    let receipting = engine
        .dispatch(host(save_request, HostEventKind::FactoryResetResultSaved))
        .unwrap();
    let receipt_request = request_id(
        &receipting,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { payload, .. }) if payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]),
    );
    let deleting = engine
        .dispatch(host(
            receipt_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let delete_request = request_id(
        &deleting,
        |effect| matches!(effect, Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { command_id: id }) if id == &command_id()),
    );
    assert!(matches!(engine.status(), WorkflowStatus::Running { .. }));

    let completed = engine
        .dispatch(host(
            delete_request,
            HostEventKind::FactoryResetResultDeleted,
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(
            bota_device_sdk_core::engine::WorkflowNotification::Completed {
                operation: Operation::FactoryReset
            }
        )
    )));
}

#[test]
fn factory_reset_rejections_never_persist_or_send_receipt() {
    for result_code in [1, 2] {
        let mut engine = WorkflowEngine::default();
        let (subscribe_request, _) = start_reset(&mut engine);
        let failed = engine
            .dispatch(host(
                subscribe_request,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                    value: vec![result_code],
                }),
            ))
            .unwrap();

        assert!(!failed.iter().any(|request| matches!(
            request.effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. })
                | Effect::Ble(BleEffect::Write { .. })
        )));
        assert!(matches!(
            engine.status(),
            WorkflowStatus::Failed { error }
                if error.code == ErrorCode::ProtocolRejected
                    && error.protocol_status == Some(u16::from(result_code))
        ));
    }
}

#[test]
fn persistence_failure_prevents_receipt_and_receipt_failure_retains_result() {
    let mut persist_failure_engine = WorkflowEngine::default();
    let (subscribe_request, _) = start_reset(&mut persist_failure_engine);
    let persisting = persist_failure_engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 2, 0],
            }),
        ))
        .unwrap();
    let save_request = request_id(&persisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. })
        )
    });
    let failed = persist_failure_engine
        .dispatch(host(
            save_request,
            HostEventKind::PersistenceFailed {
                platform_code: Some(28),
            },
        ))
        .unwrap();
    assert!(
        !failed
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );

    let mut receipt_failure_engine = WorkflowEngine::default();
    let (subscribe_request, _) = start_reset(&mut receipt_failure_engine);
    let persisting = receipt_failure_engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 2, 0],
            }),
        ))
        .unwrap();
    let save_request = request_id(&persisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. })
        )
    });
    let receipting = receipt_failure_engine
        .dispatch(host(save_request, HostEventKind::FactoryResetResultSaved))
        .unwrap();
    let receipt_request = request_id(
        &receipting,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { payload, .. }) if payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]),
    );
    let failed = receipt_failure_engine
        .dispatch(host(
            receipt_request,
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: Some(7),
            }),
        ))
        .unwrap();
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { .. })
    )));
}

#[test]
fn resume_repersist_exact_replay_before_sending_only_receipt() {
    let mut engine = WorkflowEngine::default();
    let persisted = DurableFactoryResetResult {
        command_id: command_id(),
        result: FactoryResetResult {
            result_code: 0,
            deleted_recording_count: 7,
        },
    };
    let started = engine
        .start(
            Command::ResumeFactoryReset {
                device: device(),
                command_id: persisted.command_id,
                expected_result: Some(persisted.result),
            },
            &capabilities(),
            CANCELLATION,
        )
        .unwrap();
    assert!(!started.iter().any(|request| matches!(
        request.effect,
        Effect::HostMaterial(_)
            | Effect::Ble(BleEffect::Read { .. })
            | Effect::Ble(BleEffect::Write { .. })
    )));
    let subscribe_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let repersisting = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 7, 0],
            }),
        ))
        .unwrap();
    let save_request = request_id(&repersisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { result })
                if result.command_id == command_id()
                    && result.result.deleted_recording_count == 7
        )
    });
    assert!(!repersisting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]
    )));
    let receipting = engine
        .dispatch(host(save_request, HostEventKind::FactoryResetResultSaved))
        .unwrap();
    assert!(receipting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]
    )));
    assert!(!repersisting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload == &[DEVICE_CMD_BLE_FACTORY_RESET]
    )));
}

#[test]
fn unjournaled_resume_persists_replay_before_sending_only_receipt() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(
            Command::ResumeFactoryReset {
                device: device(),
                command_id: command_id(),
                expected_result: None,
            },
            &capabilities(),
            CANCELLATION,
        )
        .unwrap();
    assert!(!started.iter().any(|request| matches!(
        request.effect,
        Effect::HostMaterial(_)
            | Effect::Ble(BleEffect::Read { .. })
            | Effect::Ble(BleEffect::Write { .. })
    )));
    let subscribe_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let persisting = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 0x34, 0x12],
            }),
        ))
        .unwrap();
    let save_request = request_id(&persisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { result })
                if result.command_id == command_id()
                    && result.result.deleted_recording_count == 0x1234
        )
    });
    assert!(!persisting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload == &[DEVICE_CMD_BLE_FACTORY_RESET]
                || payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]
    )));

    let receipting = engine
        .dispatch(host(save_request, HostEventKind::FactoryResetResultSaved))
        .unwrap();
    assert!(receipting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload == &[DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK]
    )));
}

#[test]
fn malformed_success_and_disconnect_before_result_never_send_receipt() {
    for payload in [vec![0], vec![0, 7], vec![0, 7, 0, 0xff]] {
        let mut engine = WorkflowEngine::default();
        let (subscribe_request, _) = start_reset(&mut engine);
        let failed = engine
            .dispatch(host(
                subscribe_request,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                    value: payload,
                }),
            ))
            .unwrap();
        assert!(!failed.iter().any(|request| matches!(
            request.effect,
            Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. })
                | Effect::Ble(BleEffect::Write { .. })
        )));
        assert!(matches!(
            engine.status(),
            WorkflowStatus::Failed { error } if error.code == ErrorCode::ProtocolRejected
        ));
    }

    let mut engine = WorkflowEngine::default();
    let (subscribe_request, _) = start_reset(&mut engine);
    let failed = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "reset-device".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. })
            | Effect::Ble(BleEffect::Write { .. })
    )));
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::NotConnected
    ));
}

#[test]
fn resume_rejects_a_replay_that_does_not_match_the_durable_result() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(
            Command::ResumeFactoryReset {
                device: device(),
                command_id: command_id(),
                expected_result: Some(FactoryResetResult {
                    result_code: 0,
                    deleted_recording_count: 7,
                }),
            },
            &capabilities(),
            CANCELLATION,
        )
        .unwrap();
    let subscribe_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
            }),
        ))
        .unwrap();
    let failed = engine
        .dispatch(host(
            subscribe_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_PROVISIONING_RESULT.into(),
                value: vec![0, 8, 0],
            }),
        ))
        .unwrap();

    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { .. })
            | Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { .. })
    )));
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::ProtocolRejected
    ));
}
