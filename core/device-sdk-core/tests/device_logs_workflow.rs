use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, RequestId, WorkflowEngine,
        WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        CHAR_DEVICE_LOG_CONTROL, CHAR_DEVICE_LOG_DATA, DEVICE_LOG_CMD_START, DEVICE_LOG_CMD_STOP,
        DEVICE_LOG_FLAG_DROPPED,
    },
    model::DeviceSerialNumber,
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([7; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([Capability::Ble])
}

fn command() -> Command {
    Command::ReadDeviceLogs {
        device: DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
    }
}

fn host(request_id: RequestId, kind: HostEventKind) -> Event {
    Event::Host(HostEvent { request_id, kind })
}

fn request_id(effects: &[EffectRequest], predicate: impl Fn(&Effect) -> bool) -> RequestId {
    effects
        .iter()
        .find(|request| predicate(&request.effect))
        .expect("expected effect")
        .request_id
}

fn packet(sequence: u16, flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(payload.len() + 3);
    packet.extend_from_slice(&sequence.to_le_bytes());
    packet.push(flags);
    packet.extend_from_slice(payload);
    packet
}

fn start_subscription(engine: &mut WorkflowEngine) -> (RequestId, Vec<EffectRequest>) {
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let subscription_request = request_id(&effects, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Subscribe {
                characteristic_uuid,
                ..
            }) if characteristic_uuid == CHAR_DEVICE_LOG_DATA
        )
    });
    (subscription_request, effects)
}

fn activate(engine: &mut WorkflowEngine) -> RequestId {
    let (subscription_request, _) = start_subscription(engine);
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write {
                characteristic_uuid,
                payload,
                ..
            }) if characteristic_uuid == CHAR_DEVICE_LOG_CONTROL
                && payload == &[DEVICE_LOG_CMD_START]
        )
    });
    let active = engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(active.is_empty());
    subscription_request
}

fn log_events(effects: &[EffectRequest]) -> Vec<(String, bool)> {
    effects
        .iter()
        .filter_map(|request| match &request.effect {
            Effect::Notify(WorkflowNotification::DeviceLog { event }) => {
                Some((event.message.clone(), event.is_backlog))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn subscribes_before_start_and_rejects_overlapping_ownership() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, effects) = start_subscription(&mut engine);

    assert!(
        !effects
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );
    let error = engine
        .start(
            command(),
            &capabilities(),
            CancellationId::from_bytes([8; 16]),
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OperationInProgress);

    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
            }),
        ))
        .unwrap();
    assert!(starting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            with_response: true,
            ..
        }) if characteristic_uuid == CHAR_DEVICE_LOG_CONTROL
            && payload == &[DEVICE_LOG_CMD_START]
    )));
}

#[test]
fn user_cancellation_stops_logging_before_releasing_the_subscription() {
    let mut engine = WorkflowEngine::default();
    activate(&mut engine);

    let effects = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CANCELLATION,
        })
        .unwrap();

    let stop_index = effects
        .iter()
        .position(|request| {
            matches!(
                &request.effect,
                Effect::Ble(BleEffect::Write {
                    characteristic_uuid,
                    payload,
                    ..
                }) if characteristic_uuid == CHAR_DEVICE_LOG_CONTROL
                    && payload == &[DEVICE_LOG_CMD_STOP]
            )
        })
        .expect("stop command");
    let unsubscribe_index = effects
        .iter()
        .position(|request| {
            matches!(
                &request.effect,
                Effect::Ble(BleEffect::Unsubscribe {
                    characteristic_uuid,
                    ..
                }) if characteristic_uuid == CHAR_DEVICE_LOG_DATA
            )
        })
        .expect("unsubscribe command");
    assert!(stop_index < unsubscribe_index);
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Cancelled {
            operation: Operation::ReadDeviceLogs,
        }
    ));
}

#[test]
fn disconnect_releases_subscription_without_writing_stop() {
    let mut engine = WorkflowEngine::default();
    let subscription_request = activate(&mut engine);

    let effects = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "device-1".into(),
                reason_code: None,
            }),
        ))
        .unwrap();

    assert!(effects.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Unsubscribe {
            characteristic_uuid,
            ..
        }) if characteristic_uuid == CHAR_DEVICE_LOG_DATA
    )));
    assert!(!effects.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            ..
        }) if characteristic_uuid == CHAR_DEVICE_LOG_CONTROL
            && payload == &[DEVICE_LOG_CMD_STOP]
    )));
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::NotConnected
    ));
}

#[test]
fn start_rejection_reports_feature_unavailable_and_releases_subscription() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_subscription(&mut engine);
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Write { .. }))
    });

    let effects = engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: Some(6),
            }),
        ))
        .unwrap();

    assert!(
        effects
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Unsubscribe { .. })))
    );
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error }
            if error.code == ErrorCode::FeatureUnavailable && !error.retryable
    ));
}

#[test]
fn notifications_preserve_split_utf8_across_sequence_wrap() {
    let mut engine = WorkflowEngine::default();
    let subscription_request = activate(&mut engine);
    let line = "battery 电量\n".as_bytes();
    let split = line.iter().position(|byte| *byte == 0xe7).unwrap() + 1;

    let first = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
                value: packet(u16::MAX, 0, &line[..split]),
            }),
        ))
        .unwrap();
    let second = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
                value: packet(0, 0, &line[split..]),
            }),
        ))
        .unwrap();

    assert!(log_events(&first).is_empty());
    assert_eq!(log_events(&second), vec![("battery 电量".into(), false)]);
}

#[test]
fn sequence_gaps_and_dropped_flags_discard_only_partial_lines() {
    let mut engine = WorkflowEngine::default();
    let subscription_request = activate(&mut engine);

    for (sequence, flags, payload) in [
        (10, 0, b"partial".as_slice()),
        (12, 0, b"gap recovered\n".as_slice()),
        (13, 0, b"stale".as_slice()),
        (14, DEVICE_LOG_FLAG_DROPPED, b"drop recovered\n".as_slice()),
    ] {
        let effects = engine
            .dispatch(host(
                subscription_request,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_DEVICE_LOG_DATA.into(),
                    value: packet(sequence, flags, payload),
                }),
            ))
            .unwrap();
        if sequence == 12 {
            assert_eq!(log_events(&effects), vec![("gap recovered".into(), false)]);
        } else if sequence == 14 {
            assert_eq!(log_events(&effects), vec![("drop recovered".into(), false)]);
        } else {
            assert!(log_events(&effects).is_empty());
        }
    }
}
