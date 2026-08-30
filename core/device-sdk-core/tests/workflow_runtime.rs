mod support;

use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect, Event,
        HostEvent, HostEventKind, RequestId, TimerEffect, WorkflowEngine, WorkflowNotification,
        WorkflowStatus,
    },
    error::{ErrorCode, Operation},
};
use support::FakeHost;

const CANCELLATION: CancellationId = CancellationId::from_bytes([7; 16]);

fn discovery() -> Command {
    Command::DiscoverDevices {
        timeout_ms: 5_000,
        allow_duplicates: true,
    }
}

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([Capability::Ble, Capability::Timer])
}

#[test]
fn unsupported_capability_fails_before_effects_or_state_change() {
    let mut engine = WorkflowEngine::default();

    let error = engine
        .start(discovery(), &CapabilitySet::default(), CANCELLATION)
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    assert_eq!(engine.status(), &WorkflowStatus::Idle);
}

#[test]
fn requests_are_monotonic_and_a_second_command_cannot_replace_the_owner() {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(discovery(), &capabilities(), CANCELLATION)
        .unwrap();

    let request_ids: Vec<u64> = effects
        .iter()
        .map(|effect| effect.request_id.as_u64())
        .collect();
    assert_eq!(request_ids, vec![1, 2, 3]);
    assert!(matches!(
        effects[0].effect,
        Effect::Notify(WorkflowNotification::Started {
            operation: Operation::Discover
        })
    ));

    let error = engine
        .start(
            discovery(),
            &capabilities(),
            CancellationId::from_bytes([8; 16]),
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OperationInProgress);
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Running {
            operation: Operation::Discover,
            cancellation_id: CANCELLATION,
        }
    ));
}

#[test]
fn stale_host_events_are_rejected_without_ending_the_workflow() {
    let mut engine = WorkflowEngine::default();
    engine
        .start(discovery(), &capabilities(), CANCELLATION)
        .unwrap();

    let error = engine
        .dispatch(Event::Host(HostEvent {
            request_id: RequestId::from_u64(999),
            kind: HostEventKind::Ble(BleEvent::ScanStopped),
        }))
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::UnexpectedEvent);
    assert!(matches!(engine.status(), WorkflowStatus::Running { .. }));
}

#[test]
fn discovery_streams_candidates_and_completes_after_its_timer() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(discovery(), &capabilities(), CANCELLATION)
        .unwrap();
    let scan_request = started
        .iter()
        .find(|request| matches!(request.effect, Effect::Ble(BleEffect::StartScan { .. })))
        .unwrap()
        .request_id;
    let timer_request = started
        .iter()
        .find(|request| matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. })))
        .unwrap()
        .request_id;

    let candidate = engine
        .dispatch(Event::Host(HostEvent {
            request_id: scan_request,
            kind: HostEventKind::Ble(BleEvent::ScanResult {
                candidate: bota_device_sdk_core::model::DeviceCandidate {
                    peripheral_id: "ios-peripheral".into(),
                    name: Some("Bota Note".into()),
                    advertised_address: None,
                    rssi: -40,
                },
            }),
        }))
        .unwrap();
    assert!(matches!(
        candidate.as_slice(),
        [bota_device_sdk_core::engine::EffectRequest {
            effect: Effect::Notify(WorkflowNotification::DeviceDiscovered { candidate }),
            ..
        }] if candidate.peripheral_id == "ios-peripheral"
    ));

    let second_candidate = engine
        .dispatch(Event::Host(HostEvent {
            request_id: scan_request,
            kind: HostEventKind::Ble(BleEvent::ScanResult {
                candidate: bota_device_sdk_core::model::DeviceCandidate {
                    peripheral_id: "second-peripheral".into(),
                    name: Some("Bota Pin".into()),
                    advertised_address: Some("ef7f269cc773".into()),
                    rssi: -45,
                },
            }),
        }))
        .unwrap();
    assert!(matches!(
        second_candidate.as_slice(),
        [bota_device_sdk_core::engine::EffectRequest {
            effect: Effect::Notify(WorkflowNotification::DeviceDiscovered { candidate }),
            ..
        }] if candidate.peripheral_id == "second-peripheral"
    ));

    let stopping = engine
        .dispatch(Event::Host(HostEvent {
            request_id: timer_request,
            kind: HostEventKind::TimerFired { timer_id: 1 },
        }))
        .unwrap();
    let stop_request = stopping
        .iter()
        .find(|request| matches!(request.effect, Effect::Ble(BleEffect::StopScan)))
        .unwrap()
        .request_id;

    let completed = engine
        .dispatch(Event::Host(HostEvent {
            request_id: stop_request,
            kind: HostEventKind::Ble(BleEvent::ScanStopped),
        }))
        .unwrap();
    assert!(matches!(
        completed.as_slice(),
        [bota_device_sdk_core::engine::EffectRequest {
            effect: Effect::Notify(WorkflowNotification::Completed {
                operation: Operation::Discover
            }),
            ..
        }]
    ));
    assert_eq!(
        engine.status(),
        &WorkflowStatus::Completed {
            operation: Operation::Discover
        }
    );

    let error = engine
        .dispatch(Event::Host(HostEvent {
            request_id: stop_request,
            kind: HostEventKind::Ble(BleEvent::ScanStopped),
        }))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnexpectedEvent);
}

#[test]
fn cancellation_is_scoped_and_idempotent() {
    let mut engine = WorkflowEngine::default();
    engine
        .start(discovery(), &capabilities(), CANCELLATION)
        .unwrap();

    let wrong = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CancellationId::from_bytes([9; 16]),
        })
        .unwrap_err();
    assert_eq!(wrong.code, ErrorCode::UnexpectedEvent);

    let effects = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CANCELLATION,
        })
        .unwrap();
    assert!(
        effects
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::StopScan)))
    );
    assert!(effects.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Cancelled {
            operation: Operation::Discover
        })
    )));
    assert_eq!(
        engine.status(),
        &WorkflowStatus::Cancelled {
            operation: Operation::Discover
        }
    );

    assert!(
        engine
            .dispatch(Event::Cancelled {
                cancellation_id: CANCELLATION,
            })
            .unwrap()
            .is_empty()
    );
}

#[test]
fn fake_host_rejects_a_response_for_an_unknown_request() {
    let mut host = FakeHost::default();
    let mut engine = WorkflowEngine::default();
    host.record(
        engine
            .start(discovery(), &capabilities(), CANCELLATION)
            .unwrap(),
    );

    let error = host
        .respond(
            RequestId::from_u64(99),
            HostEventKind::Ble(BleEvent::ScanStopped),
        )
        .unwrap_err();

    assert_eq!(error, "response request ID is not outstanding");
}
