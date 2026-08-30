use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, RequestId, TimerEffect, WorkflowEngine,
        WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        CHAR_DEVICE_STATUS, CHAR_TRANSFER_CONTROL, CHAR_TRANSFER_STATUS, FLAG_SYNC_ACTIVE,
        FLAG_WIFI_CONNECTED, TRIGGER_UPLOAD_ACCEPTED, TRIGGER_UPLOAD_BUSY,
    },
    model::{DeviceSerialNumber, RecordingUuid, UploadDestinationId, UploadSessionId},
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([6; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([Capability::Ble, Capability::Timer, Capability::Progress])
}

fn device() -> DeviceSerialNumber {
    DeviceSerialNumber::new("EVFXXW67KP").unwrap()
}

fn recording() -> RecordingUuid {
    RecordingUuid::from_bytes([0x22; 16])
}

fn upload_id() -> UploadSessionId {
    UploadSessionId::new("upload-1").unwrap()
}

fn destination_id() -> UploadDestinationId {
    UploadDestinationId::new("destination-1").unwrap()
}

fn command() -> Command {
    Command::UploadRecording {
        device: device(),
        recording: recording(),
        upload_id: upload_id(),
        destination_id: destination_id(),
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

fn status(sync_active: bool, pending: u8, network: bool) -> Vec<u8> {
    let mut bytes = vec![0; 14];
    bytes[3] = pending;
    bytes[8] = if sync_active { FLAG_SYNC_ACTIVE } else { 0 }
        | if network { FLAG_WIFI_CONNECTED } else { 0 };
    bytes
}

fn start_with_status(engine: &mut WorkflowEngine, value: Vec<u8>) -> Vec<EffectRequest> {
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let status_request = request_id(&started, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_DEVICE_STATUS
        )
    });
    engine
        .dispatch(host(
            status_request,
            HostEventKind::Ble(BleEvent::ReadCompleted { value }),
        ))
        .unwrap()
}

fn reach_trigger_response(engine: &mut WorkflowEngine) -> RequestId {
    let subscribing = start_with_status(engine, status(false, 1, true));
    let subscription_request = request_id(&subscribing, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_TRANSFER_STATUS
        )
    });
    let triggering = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
            }),
        ))
        .unwrap();
    let write_request = request_id(&triggering, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write {
                characteristic_uuid,
                payload,
                ..
            }) if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload == &[3]
        )
    });
    engine
        .dispatch(host(
            write_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    subscription_request
}

fn poll_status(
    engine: &mut WorkflowEngine,
    effects: &[EffectRequest],
    value: Vec<u8>,
) -> Vec<EffectRequest> {
    let timer_request = request_id(effects, |effect| {
        matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
    });
    let timer_id = effects
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule { timer_id, .. }) => Some(timer_id),
            _ => None,
        })
        .unwrap();
    let reading = engine
        .dispatch(host(timer_request, HostEventKind::TimerFired { timer_id }))
        .unwrap();
    let status_request = request_id(&reading, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_DEVICE_STATUS
        )
    });
    engine
        .dispatch(host(
            status_request,
            HostEventKind::Ble(BleEvent::ReadCompleted { value }),
        ))
        .unwrap()
}

fn has_fallback(effects: &[EffectRequest]) -> bool {
    effects.iter().any(|request| {
        matches!(
            &request.effect,
            Effect::Notify(WorkflowNotification::BleFallbackReady {
                upload_id: id,
                destination_id: destination,
                recording: item,
            }) if id == &upload_id() && destination == &destination_id() && item == &recording()
        )
    })
}

#[test]
fn busy_response_preserves_device_upload_and_never_falls_back() {
    let mut engine = WorkflowEngine::default();
    let subscription_request = reach_trigger_response(&mut engine);
    let checking = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![3, TRIGGER_UPLOAD_BUSY],
            }),
        ))
        .unwrap();
    let status_request = request_id(&checking, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Read { .. }))
    });
    let preserved = engine
        .dispatch(host(
            status_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: status(false, 1, true),
            }),
        ))
        .unwrap();
    assert!(!has_fallback(&checking));
    assert!(!has_fallback(&preserved));
    assert!(preserved.iter().any(|request| matches!(
        &request.effect,
        Effect::Notify(WorkflowNotification::DeviceUploadPreserved { upload_id: id })
            if id == &upload_id()
    )));
}

#[test]
fn detached_or_unknown_ownership_never_falls_back() {
    let mut detached = WorkflowEngine::default();
    let monitoring = start_with_status(&mut detached, status(true, 1, true));
    let timer_request = request_id(&monitoring, |effect| {
        matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
    });
    let failed = detached
        .dispatch(host(
            timer_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "device-1".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(!has_fallback(&failed));
    assert!(matches!(
        detached.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::NotConnected
    ));

    let mut unknown = WorkflowEngine::default();
    let started = unknown
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let status_request = request_id(&started, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Read { .. }))
    });
    let failed = unknown
        .dispatch(host(
            status_request,
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: Some(7),
            }),
        ))
        .unwrap();
    assert!(!has_fallback(&failed));
    assert!(matches!(
        unknown.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::UploadOwnershipUnknown
    ));
}

#[test]
fn direct_failure_falls_back_only_after_fresh_inactive_status() {
    let mut engine = WorkflowEngine::default();
    let monitoring = start_with_status(&mut engine, status(true, 1, true));
    let fallback = poll_status(&mut engine, &monitoring, status(false, 1, true));

    assert!(has_fallback(&fallback));
    assert!(fallback.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::Upload,
        })
    )));
}

#[test]
fn successful_direct_upload_completes_without_ble_fallback() {
    let mut engine = WorkflowEngine::default();
    let monitoring = start_with_status(&mut engine, status(true, 1, true));
    let completed = poll_status(&mut engine, &monitoring, status(false, 0, true));

    assert!(!has_fallback(&completed));
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::Upload,
        })
    )));
}

#[test]
fn accepted_trigger_monitors_until_direct_upload_finishes() {
    let mut engine = WorkflowEngine::default();
    let subscription_request = reach_trigger_response(&mut engine);
    let monitoring = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![3, TRIGGER_UPLOAD_ACCEPTED],
            }),
        ))
        .unwrap();
    assert!(!has_fallback(&monitoring));
    assert!(
        monitoring
            .iter()
            .any(|request| matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. })))
    );
}
