#![cfg(feature = "uniffi-spike")]

use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, Command, Effect, EffectRequest, HostEventKind, TimerEffect,
        WorkflowNotification,
    },
    error::Operation,
};
use bota_device_sdk_ffi_smoke::{
    BOTA_DEVICE_SDK_CAPABILITY_BLE, BOTA_DEVICE_SDK_CAPABILITY_TIMER, UniFfiEngine,
};

#[test]
fn uniffi_object_drives_the_comparison_json_boundary() {
    let engine = UniFfiEngine::new();
    let command = serde_json::to_string(&Command::DiscoverDevices {
        timeout_ms: 5_000,
        allow_duplicates: true,
    })
    .unwrap();
    engine
        .start_json(
            command.clone(),
            BOTA_DEVICE_SDK_CAPABILITY_BLE | BOTA_DEVICE_SDK_CAPABILITY_TIMER,
            0x0102_0304_0506_0708,
            0x1112_1314_1516_1718,
        )
        .unwrap();

    let started: EffectRequest = serde_json::from_str(&engine.poll_output().unwrap()).unwrap();
    assert!(matches!(
        started.effect,
        Effect::Notify(WorkflowNotification::Started { .. })
    ));
    let scan: EffectRequest = serde_json::from_str(&engine.poll_output().unwrap()).unwrap();
    assert!(matches!(
        scan.effect,
        Effect::Ble(BleEffect::StartScan { .. })
    ));
    let timer: EffectRequest = serde_json::from_str(&engine.poll_output().unwrap()).unwrap();
    let (timer_request_id, timer_id) = match timer {
        EffectRequest {
            request_id,
            effect: Effect::Timer(TimerEffect::Schedule { timer_id, .. }),
            ..
        } => (request_id.as_u64(), timer_id),
        other => panic!("unexpected timer effect: {other:?}"),
    };
    let timer_event = serde_json::to_string(&HostEventKind::TimerFired { timer_id }).unwrap();
    assert!(
        engine
            .dispatch_json(timer_request_id + 100, timer_event.clone())
            .is_err()
    );
    engine.dispatch_json(timer_request_id, timer_event).unwrap();
    let stop: EffectRequest = serde_json::from_str(&engine.poll_output().unwrap()).unwrap();
    let stop_request_id = stop.request_id.as_u64();
    assert!(matches!(stop.effect, Effect::Ble(BleEffect::StopScan)));
    engine
        .dispatch_json(
            stop_request_id,
            serde_json::to_string(&HostEventKind::Ble(BleEvent::ScanStopped)).unwrap(),
        )
        .unwrap();
    let completed: EffectRequest = serde_json::from_str(&engine.poll_output().unwrap()).unwrap();
    assert!(matches!(
        completed.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::Discover
        })
    ));

    assert!(engine.start_json("{".to_owned(), 0, 0, 1).is_err());
    engine
        .start_json(
            command,
            BOTA_DEVICE_SDK_CAPABILITY_BLE | BOTA_DEVICE_SDK_CAPABILITY_TIMER,
            0x2122_2324_2526_2728,
            0x3132_3334_3536_3738,
        )
        .unwrap();
    engine
        .cancel(0x2122_2324_2526_2728, 0x3132_3334_3536_3738)
        .unwrap();
    let remaining = std::iter::from_fn(|| engine.poll_output())
        .map(|output| serde_json::from_str::<EffectRequest>(&output).unwrap())
        .collect::<Vec<_>>();
    assert!(remaining.iter().any(|output| matches!(
        output.effect,
        Effect::Notify(WorkflowNotification::Cancelled {
            operation: Operation::Discover
        })
    )));
}
