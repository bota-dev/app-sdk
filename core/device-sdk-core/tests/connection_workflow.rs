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

fn assert_identity_not_trusted(effects: &[EffectRequest]) {
    assert!(!effects.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. })
            | Effect::Notify(WorkflowNotification::ConnectionEstablished { .. })
    )));
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
fn selected_device_connect_learns_serial_before_persisting_identity() {
    let mut engine = WorkflowEngine::default();
    let selected = candidate("ios-peripheral-id", None, -50);
    let started = engine
        .start(
            Command::ConnectSelected {
                candidate: selected.clone(),
            },
            &capabilities(),
            MANUAL_CANCELLATION,
        )
        .unwrap();

    assert!(!started.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
    )));

    let read_request = reach_serial_read(&mut engine, &started, &selected.peripheral_id);
    let persisting = engine
        .dispatch(host(
            read_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"LEARNED123".to_vec(),
            }),
        ))
        .unwrap();
    assert!(persisting.iter().any(|request| matches!(
        &request.effect,
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity {
            device,
            candidate,
        }) if device.as_str() == "LEARNED123" && candidate == &selected
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
        &request.effect,
        Effect::Notify(WorkflowNotification::ConnectionEstablished {
            device,
            mode: ConnectionMode::Manual,
            ..
        }) if device.as_str() == "LEARNED123"
    )));
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
fn reconnect_joins_scan_stop_before_retiring_queued_advertisements_and_timer() {
    for stop_on_match in [true, false] {
        let mut engine = WorkflowEngine::default();
        let exact = candidate("exact-peripheral", None, -42);
        let started = start_reconnect(
            &mut engine,
            ReconnectHint {
                stored_peripheral_id: Some(exact.peripheral_id.clone()),
                scan_timeout_ms: 1_000,
                ..ReconnectHint::default()
            },
        );
        let scan_request = request_id(&started, |effect| {
            matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
        });
        let timer_request = request_id(&started, |effect| {
            matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
        });
        if !stop_on_match {
            engine
                .dispatch(host(
                    scan_request,
                    HostEventKind::Ble(BleEvent::ScanResult {
                        candidate: candidate("same-name-probe", None, -55),
                    }),
                ))
                .unwrap();
        }
        let stopping = engine
            .dispatch(if stop_on_match {
                host(
                    scan_request,
                    HostEventKind::Ble(BleEvent::ScanResult {
                        candidate: exact.clone(),
                    }),
                )
            } else {
                host(timer_request, HostEventKind::TimerFired { timer_id: 1 })
            })
            .unwrap();
        let stop_request = request_id(&stopping, |effect| {
            matches!(effect, Effect::Ble(BleEffect::StopScan))
        });

        // Both callbacks may already be queued when the host begins removing
        // its scan subscription. Neither may start another connection or
        // replace the candidate selected before StopScan was submitted.
        for late in [
            host(
                scan_request,
                HostEventKind::Ble(BleEvent::ScanResult {
                    candidate: candidate("late-peripheral", None, -5),
                }),
            ),
            host(timer_request, HostEventKind::TimerFired { timer_id: 1 }),
        ] {
            assert!(engine.dispatch(late).unwrap().is_empty());
        }
        let connecting = engine
            .dispatch(host(
                stop_request,
                HostEventKind::Ble(BleEvent::ScanStopped),
            ))
            .unwrap();
        let expected_id = if stop_on_match {
            "exact-peripheral"
        } else {
            "same-name-probe"
        };
        assert!(connecting.iter().any(|request| matches!(
            &request.effect,
            Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == expected_id
        )));
        assert_identity_not_trusted(&connecting);
        let read = reach_serial_read(&mut engine, &connecting, expected_id);
        let persisting = engine
            .dispatch(host(
                read,
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
}

#[test]
fn reconnect_stopping_scan_rejects_unrelated_callbacks() {
    let mut engine = WorkflowEngine::default();
    let exact = candidate("exact-peripheral", None, -42);
    let started = start_reconnect(
        &mut engine,
        ReconnectHint {
            stored_peripheral_id: Some(exact.peripheral_id.clone()),
            ..ReconnectHint::default()
        },
    );
    let scan_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
    });
    let timer_request = request_id(&started, |effect| {
        matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
    });
    engine
        .dispatch(host(
            scan_request,
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: exact.clone(),
            }),
        ))
        .unwrap();
    for foreign in [
        host(
            timer_request,
            HostEventKind::Ble(BleEvent::ScanResult { candidate: exact }),
        ),
        host(scan_request, HostEventKind::TimerFired { timer_id: 1 }),
        host(timer_request, HostEventKind::TimerFired { timer_id: 999 }),
    ] {
        assert_eq!(
            engine.dispatch(foreign).unwrap_err().code,
            ErrorCode::UnexpectedEvent
        );
    }
}

#[test]
fn timed_out_connection_attempt_retires_only_its_late_io_before_disconnect_ack() {
    for manual in [false, true] {
        for phase in 0..3 {
            for fails in [false, true] {
                let mut engine = WorkflowEngine::default();
                let selected = candidate("timed-out", None, -40);
                let connecting = if manual {
                    engine
                        .start(
                            Command::Connect {
                                device: serial("EVFXXW67KP"),
                                candidate: selected.clone(),
                            },
                            &capabilities(),
                            MANUAL_CANCELLATION,
                        )
                        .unwrap()
                } else {
                    let started = start_reconnect(&mut engine, ReconnectHint::default());
                    let scan = request_id(&started, |effect| {
                        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
                    });
                    for found in [selected.clone(), candidate("next-probe", None, -55)] {
                        engine
                            .dispatch(host(
                                scan,
                                HostEventKind::Ble(BleEvent::ScanResult { candidate: found }),
                            ))
                            .unwrap();
                    }
                    finish_scan(&mut engine, &started)
                };
                let timer = connecting
                    .iter()
                    .find(|request| {
                        matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. }))
                    })
                    .unwrap();
                let Effect::Timer(TimerEffect::Schedule { timer_id, .. }) = timer.effect else {
                    unreachable!()
                };
                let connect = request_id(&connecting, |effect| {
                    matches!(effect, Effect::Ble(BleEffect::Connect { .. }))
                });
                let mut pending = connect;
                let mut completion = BleEvent::Connected {
                    peripheral_id: selected.peripheral_id.clone(),
                };
                if phase > 0 {
                    let discovering = engine
                        .dispatch(host(connect, HostEventKind::Ble(completion)))
                        .unwrap();
                    pending = request_id(&discovering, |effect| {
                        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
                    });
                    completion = BleEvent::ServicesDiscovered {
                        peripheral_id: selected.peripheral_id.clone(),
                    };
                    if phase > 1 {
                        let reading = engine
                            .dispatch(host(pending, HostEventKind::Ble(completion)))
                            .unwrap();
                        pending = request_id(&reading, |effect| {
                            matches!(effect, Effect::Ble(BleEffect::Read { .. }))
                        });
                        completion = BleEvent::ReadCompleted {
                            value: b"EVFXXW67KP".to_vec(),
                        };
                    }
                }
                let disconnecting = engine
                    .dispatch(host(
                        timer.request_id,
                        HostEventKind::TimerFired { timer_id },
                    ))
                    .unwrap();
                let disconnect = request_id(&disconnecting, |effect| {
                    matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
                });
                let late = if fails {
                    BleEvent::Failed {
                        platform_code: Some(8),
                    }
                } else {
                    completion
                };
                assert!(
                    engine
                        .dispatch(host(pending, HostEventKind::Ble(late.clone())))
                        .unwrap()
                        .is_empty(),
                    "manual={manual}, phase={phase}, fails={fails}"
                );
                assert_eq!(
                    engine
                        .dispatch(host(pending, HostEventKind::Ble(late)))
                        .unwrap_err()
                        .code,
                    ErrorCode::UnexpectedEvent
                );
                // Neither a late success nor failure may verify identity or begin another probe.
                assert!(matches!(engine.status(), WorkflowStatus::Running { .. }));
                let after_ack = engine
                    .dispatch(host(
                        disconnect,
                        HostEventKind::Ble(BleEvent::Disconnected {
                            peripheral_id: selected.peripheral_id,
                            reason_code: None,
                        }),
                    ))
                    .unwrap();
                if manual {
                    assert!(
                        matches!(engine.status(), WorkflowStatus::Failed { error } if error.code == ErrorCode::Timeout)
                    );
                } else {
                    assert!(after_ack.iter().any(|request| matches!(&request.effect, Effect::Ble(BleEffect::Connect { peripheral_id }) if peripheral_id == "next-probe")));
                    assert_identity_not_trusted(&after_ack);
                }
            }
        }
    }
}

#[test]
fn disconnecting_connection_rejects_foreign_request_class_and_peripheral_callbacks() {
    let mut engine = WorkflowEngine::default();
    let connecting = engine
        .start(
            Command::Connect {
                device: serial("EVFXXW67KP"),
                candidate: candidate("selected", None, -40),
            },
            &capabilities(),
            MANUAL_CANCELLATION,
        )
        .unwrap();
    let connect = request_id(&connecting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Connect { .. }))
    });
    let timer = connecting
        .iter()
        .find(|request| matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. })))
        .unwrap();
    let Effect::Timer(TimerEffect::Schedule { timer_id, .. }) = timer.effect else {
        unreachable!()
    };
    let disconnecting = engine
        .dispatch(host(
            timer.request_id,
            HostEventKind::TimerFired { timer_id },
        ))
        .unwrap();
    let disconnect = request_id(&disconnecting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
    });
    for foreign in [
        host(
            connect,
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: "foreign".into(),
            }),
        ),
        host(
            connect,
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: "selected".into(),
            }),
        ),
        host(
            connect,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"EVFXXW67KP".to_vec(),
            }),
        ),
        host(
            disconnect,
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: "selected".into(),
            }),
        ),
        host(
            disconnect,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "foreign".into(),
                reason_code: None,
            }),
        ),
    ] {
        assert_eq!(
            engine.dispatch(foreign).unwrap_err().code,
            ErrorCode::UnexpectedEvent
        );
    }
    assert!(
        engine
            .dispatch(host(
                connect,
                HostEventKind::Ble(BleEvent::Connected {
                    peripheral_id: "selected".into()
                })
            ))
            .unwrap()
            .is_empty()
    );
    engine
        .dispatch(host(
            disconnect,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "selected".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(
        matches!(engine.status(), WorkflowStatus::Failed { error } if error.code == ErrorCode::Timeout)
    );
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

    let stopping = engine
        .dispatch(host(
            scan_request,
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: candidate("new-ios-id", Some("EF:7F:26:9C:C7:73"), -42),
            }),
        ))
        .unwrap();
    assert!(
        stopping
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::StopScan)))
    );
    assert_identity_not_trusted(&stopping);
}

#[test]
fn reconnect_exact_hints_read_serial_before_trusting_identity_and_reject_mismatches() {
    let exact = candidate("exact-peripheral", Some("EF:7F:26:9C:C7:73"), -42);
    let hints = [
        ReconnectHint {
            stored_peripheral_id: Some(exact.peripheral_id.clone()),
            advertised_address: None,
            stored_name: Some("Bota Pin".into()),
            scan_timeout_ms: 1_000,
            connection_timeout_ms: 10_000,
        },
        ReconnectHint {
            stored_peripheral_id: Some("old-ios-id".into()),
            advertised_address: Some("ef7f269cc773".into()),
            stored_name: Some("Bota Pin".into()),
            scan_timeout_ms: 1_000,
            connection_timeout_ms: 10_000,
        },
    ];

    for hint in hints {
        let mut engine = WorkflowEngine::default();
        let started = start_reconnect(&mut engine, hint);
        assert_identity_not_trusted(&started);
        let scan_request = request_id(&started, |effect| {
            matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
        });

        let stopping = engine
            .dispatch(host(
                scan_request,
                HostEventKind::Ble(BleEvent::ScanResult {
                    candidate: exact.clone(),
                }),
            ))
            .unwrap();
        assert_identity_not_trusted(&stopping);
        let stop_request = request_id(&stopping, |effect| {
            matches!(effect, Effect::Ble(BleEffect::StopScan))
        });
        let connecting = engine
            .dispatch(host(
                stop_request,
                HostEventKind::Ble(BleEvent::ScanStopped),
            ))
            .unwrap();
        assert_identity_not_trusted(&connecting);

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
        assert_identity_not_trusted(&discovering);
        let discover_request = request_id(&discovering, |effect| {
            matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
        });
        let reading = engine
            .dispatch(host(
                discover_request,
                HostEventKind::Ble(BleEvent::ServicesDiscovered {
                    peripheral_id: exact.peripheral_id.clone(),
                }),
            ))
            .unwrap();
        assert_identity_not_trusted(&reading);
        let read_request = request_id(&reading, |effect| {
            matches!(
                effect,
                Effect::Ble(BleEffect::Read {
                    service_uuid,
                    characteristic_uuid,
                }) if service_uuid == "180A" && characteristic_uuid == "2A25"
            )
        });

        let releasing = engine
            .dispatch(host(
                read_request,
                HostEventKind::Ble(BleEvent::ReadCompleted {
                    value: b"OTHER12345".to_vec(),
                }),
            ))
            .unwrap();
        assert_identity_not_trusted(&releasing);
        let disconnect_request = request_id(&releasing, |effect| {
            matches!(effect, Effect::Ble(BleEffect::Disconnect { .. }))
        });
        let failed = engine
            .dispatch(host(
                disconnect_request,
                HostEventKind::Ble(BleEvent::Disconnected {
                    peripheral_id: exact.peripheral_id.clone(),
                    reason_code: None,
                }),
            ))
            .unwrap();
        assert_identity_not_trusted(&failed);
        assert!(failed.iter().any(|request| matches!(
            &request.effect,
            Effect::Notify(WorkflowNotification::Failed { error })
                if error.code == ErrorCode::DeviceNotFound
        )));
    }
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
