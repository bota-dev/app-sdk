use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, PersistenceEffect, RequestId, TimerEffect,
        WorkflowEngine, WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    model::{ConnectionMode, DeviceCandidate, DeviceSerialNumber, ReconnectHint},
};

const MANUAL_CANCELLATION: CancellationId = CancellationId::from_bytes([1; 16]);
const RECONNECT_CANCELLATION: CancellationId = CancellationId::from_bytes([2; 16]);

fn serial(value: &str) -> DeviceSerialNumber {
    DeviceSerialNumber::new(value).unwrap()
}

fn candidate(peripheral_id: &str, advertised_address: Option<&str>, rssi: i16) -> DeviceCandidate {
    DeviceCandidate {
        peripheral_id: peripheral_id.into(),
        name: Some("Bota Pin".into()),
        advertised_address: advertised_address.map(str::to_owned),
        rssi,
    }
}

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([Capability::Ble, Capability::Timer, Capability::Persistence])
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

fn reach_serial_read(
    engine: &mut WorkflowEngine,
    started: &[EffectRequest],
    peripheral_id: &str,
) -> RequestId {
    let connect_request = request_id(started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Connect { .. }))
    });
    let discovering = engine
        .dispatch(host(
            connect_request,
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: peripheral_id.into(),
            }),
        ))
        .unwrap();
    let discover_request = request_id(&discovering, |effect| {
        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
    });
    let reading = engine
        .dispatch(host(
            discover_request,
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: peripheral_id.into(),
            }),
        ))
        .unwrap();
    request_id(&reading, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Read { .. }))
    })
}

fn start_reconnect(engine: &mut WorkflowEngine, hint: ReconnectHint) -> Vec<EffectRequest> {
    engine
        .start(
            Command::Reconnect {
                device: serial("EVFXXW67KP"),
                hint,
            },
            &capabilities(),
            RECONNECT_CANCELLATION,
        )
        .unwrap()
}

fn finish_scan(engine: &mut WorkflowEngine, started: &[EffectRequest]) -> Vec<EffectRequest> {
    let timer_request = request_id(started, |effect| {
        matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
    });
    let stopping = engine
        .dispatch(host(
            timer_request,
            HostEventKind::TimerFired { timer_id: 1 },
        ))
        .unwrap();
    let stop_request = request_id(&stopping, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StopScan))
    });
    engine
        .dispatch(host(
            stop_request,
            HostEventKind::Ble(BleEvent::ScanStopped),
        ))
        .unwrap()
}

#[test]
fn manual_connect_reads_serial_fresh_before_persisting_identity() {
    let mut engine = WorkflowEngine::default();
    let selected = candidate("ios-peripheral-id", None, -50);
    let started = engine
        .start(
            Command::Connect {
                device: serial("EVFXXW67KP"),
                candidate: selected.clone(),
            },
            &capabilities(),
            MANUAL_CANCELLATION,
        )
        .unwrap();

    let read_request = reach_serial_read(&mut engine, &started, &selected.peripheral_id);
    let persisting = engine
        .dispatch(host(
            read_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"EVFXXW67KP".to_vec(),
            }),
        ))
        .unwrap();
    assert!(persisting.iter().any(|request| matches!(
        &request.effect,
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity {
            device,
            candidate,
        }) if device.as_str() == "EVFXXW67KP" && candidate == &selected
    )));

    let save_request = request_id(&persisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. })
        )
    });
    let completed = engine
        .dispatch(host(save_request, HostEventKind::ConnectionIdentitySaved))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::ConnectionEstablished {
            mode: ConnectionMode::Manual,
            ..
        })
    )));
    assert_eq!(
        engine.status(),
        &WorkflowStatus::Completed {
            operation: Operation::Connect
        }
    );
}

#[test]
fn manual_connect_rejects_a_serial_mismatch_after_releasing_the_candidate() {
    let mut engine = WorkflowEngine::default();
    let selected = candidate("ios-peripheral-id", None, -50);
    let started = engine
        .start(
            Command::Connect {
                device: serial("EVFXXW67KP"),
                candidate: selected.clone(),
            },
            &capabilities(),
            MANUAL_CANCELLATION,
        )
        .unwrap();
    let read_request = reach_serial_read(&mut engine, &started, &selected.peripheral_id);

    let releasing = engine
        .dispatch(host(
            read_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"OTHER12345".to_vec(),
            }),
        ))
        .unwrap();
    let disconnect_request = request_id(&releasing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
    });
    let failed = engine
        .dispatch(host(
            disconnect_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: selected.peripheral_id,
                reason_code: None,
            }),
        ))
        .unwrap();

    assert!(failed.iter().any(|request| matches!(
        &request.effect,
        Effect::Notify(WorkflowNotification::Failed { error })
            if error.code == ErrorCode::IdentityMismatch
    )));
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::IdentityMismatch
    ));
}

#[test]
fn reconnect_waits_for_an_exact_address_without_probing_same_name_early() {
    let mut engine = WorkflowEngine::default();
    let started = start_reconnect(
        &mut engine,
        ReconnectHint {
            stored_peripheral_id: Some("old-ios-id".into()),
            advertised_address: Some("ef7f269cc773".into()),
            stored_name: Some("Bota Pin".into()),
            scan_timeout_ms: 1_000,
            connection_timeout_ms: 10_000,
        },
    );
    let scan_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
    });

    let ignored = engine
        .dispatch(host(
            scan_request,
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: candidate("new-ios-id", None, -40),
            }),
        ))
        .unwrap();
    assert!(ignored.is_empty());

    let exact = candidate("new-ios-id", Some("EF:7F:26:9C:C7:73"), -42);
    let stopping = engine
        .dispatch(host(
            scan_request,
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: exact.clone(),
            }),
        ))
        .unwrap();
    assert!(
        !stopping
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Read { .. })))
    );
    let stop_request = request_id(&stopping, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StopScan))
    });
    let connecting = engine
        .dispatch(host(
            stop_request,
            HostEventKind::Ble(BleEvent::ScanStopped),
        ))
        .unwrap();
    assert!(connecting.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == &exact.peripheral_id
    )));

    let connect_request = request_id(&connecting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Connect { .. }))
    });
    let discovering = engine
        .dispatch(host(
            connect_request,
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: exact.peripheral_id.clone(),
            }),
        ))
        .unwrap();
    let discover_request = request_id(&discovering, |effect| {
        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
    });
    let persisting = engine
        .dispatch(host(
            discover_request,
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: exact.peripheral_id,
            }),
        ))
        .unwrap();
    assert!(persisting.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. })
    )));
    assert!(
        !persisting
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Read { .. })))
    );
}

#[test]
fn reconnect_releases_serial_mismatches_before_probing_the_next_candidate() {
    let mut engine = WorkflowEngine::default();
    let started = start_reconnect(
        &mut engine,
        ReconnectHint {
            stored_peripheral_id: None,
            advertised_address: None,
            stored_name: Some("Bota Pin".into()),
            scan_timeout_ms: 1_000,
            connection_timeout_ms: 10_000,
        },
    );
    let scan_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
    });
    for discovered in [
        candidate("wrong-nearby", None, -20),
        candidate("rotated-target", None, -40),
    ] {
        engine
            .dispatch(host(
                scan_request,
                HostEventKind::Ble(BleEvent::ScanResult {
                    candidate: discovered,
                }),
            ))
            .unwrap();
    }

    let first_connect = finish_scan(&mut engine, &started);
    let first_read = reach_serial_read(&mut engine, &first_connect, "wrong-nearby");
    let releasing = engine
        .dispatch(host(
            first_read,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"OTHER12345".to_vec(),
            }),
        ))
        .unwrap();
    assert!(!releasing.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == "rotated-target"
    )));

    let disconnect_request = request_id(&releasing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
    });
    let second_connect = engine
        .dispatch(host(
            disconnect_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "wrong-nearby".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(second_connect.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == "rotated-target"
    )));
    assert!(second_connect.iter().any(|request| matches!(
        &request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint })
            if checkpoint.retry_count == 1 && checkpoint.completed_units == 1
    )));
    let checkpoint_json = second_connect
        .iter()
        .find_map(|request| match &request.effect {
            Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint }) => {
                Some(serde_json::to_string(checkpoint).unwrap())
            }
            _ => None,
        })
        .unwrap();
    assert!(!checkpoint_json.contains("wrong-nearby"));
    assert!(!checkpoint_json.contains("rotated-target"));

    let second_read = reach_serial_read(&mut engine, &second_connect, "rotated-target");
    let persisting = engine
        .dispatch(host(
            second_read,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"EVFXXW67KP".to_vec(),
            }),
        ))
        .unwrap();
    assert!(persisting.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. })
    )));
}

#[test]
fn reconnect_timeout_releases_one_candidate_before_starting_the_next() {
    let mut engine = WorkflowEngine::default();
    let started = start_reconnect(
        &mut engine,
        ReconnectHint {
            stored_peripheral_id: None,
            advertised_address: None,
            stored_name: Some("Bota Pin".into()),
            scan_timeout_ms: 1_000,
            connection_timeout_ms: 10_000,
        },
    );
    let scan_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
    });
    for discovered in [
        candidate("first", None, -20),
        candidate("second", None, -30),
    ] {
        engine
            .dispatch(host(
                scan_request,
                HostEventKind::Ble(BleEvent::ScanResult {
                    candidate: discovered,
                }),
            ))
            .unwrap();
    }

    let first_connect = finish_scan(&mut engine, &started);
    let attempt_timer = first_connect
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule {
                timer_id: 2,
                delay_ms: 10_000,
            }) => Some(request.request_id),
            _ => None,
        })
        .expect("candidate connection uses the next monotonic timer");
    let releasing = engine
        .dispatch(host(
            attempt_timer,
            HostEventKind::TimerFired { timer_id: 2 },
        ))
        .unwrap();
    assert!(!releasing.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == "second"
    )));

    let disconnect_request = request_id(&releasing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
    });
    let next = engine
        .dispatch(host(
            disconnect_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "first".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(next.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == "second"
    )));
}

#[test]
fn background_reconnect_cannot_replace_a_manual_connection_owner() {
    let mut engine = WorkflowEngine::default();
    engine
        .start(
            Command::Connect {
                device: serial("EVFXXW67KP"),
                candidate: candidate("manual-device", None, -30),
            },
            &capabilities(),
            MANUAL_CANCELLATION,
        )
        .unwrap();

    let error = engine
        .start(
            Command::Reconnect {
                device: serial("C8SU2XXWHI"),
                hint: ReconnectHint::default(),
            },
            &capabilities(),
            RECONNECT_CANCELLATION,
        )
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::OperationInProgress);
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Running {
            operation: Operation::Connect,
            cancellation_id: MANUAL_CANCELLATION,
        }
    ));
}

#[test]
fn connection_trace_fixture_pins_the_react_native_parity_cases() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/workflows/connection.json"
    )))
    .unwrap();
    let names: Vec<&str> = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scenario| scenario["name"].as_str().unwrap())
        .collect();

    assert_eq!(
        names,
        [
            "connection-manual-success",
            "connection-identity-rejection",
            "connection-cancellation",
            "connection-reconnect-resume",
            "connection-owner-rejection",
        ]
    );
}
