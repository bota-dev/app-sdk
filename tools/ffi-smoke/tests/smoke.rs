use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, Command, Effect, EffectRequest, HostEventKind, TimerEffect,
        WorkflowNotification,
    },
    error::Operation,
};
use bota_device_sdk_ffi_smoke::{
    BOTA_DEVICE_SDK_CAPABILITY_BLE, BOTA_DEVICE_SDK_CAPABILITY_TIMER, BotaDeviceSdkOwnedBuffer,
    BotaDeviceSdkStatus, bota_device_sdk_buffer_free, bota_device_sdk_engine_cancel,
    bota_device_sdk_engine_dispatch_json, bota_device_sdk_engine_free,
    bota_device_sdk_engine_last_error, bota_device_sdk_engine_new,
    bota_device_sdk_engine_poll_output, bota_device_sdk_engine_start_json,
};

unsafe fn poll(engine: *mut bota_device_sdk_ffi_smoke::BotaDeviceSdkEngine) -> EffectRequest {
    let mut buffer = BotaDeviceSdkOwnedBuffer::default();
    assert_eq!(
        unsafe { bota_device_sdk_engine_poll_output(engine, &mut buffer) },
        BotaDeviceSdkStatus::Ok
    );
    let bytes = unsafe { std::slice::from_raw_parts(buffer.data, buffer.len) }.to_vec();
    unsafe { bota_device_sdk_buffer_free(buffer) };
    serde_json::from_slice(&bytes).unwrap()
}

unsafe fn read_buffer(buffer: BotaDeviceSdkOwnedBuffer) -> Vec<u8> {
    let bytes = unsafe { std::slice::from_raw_parts(buffer.data, buffer.len) }.to_vec();
    unsafe { bota_device_sdk_buffer_free(buffer) };
    bytes
}

#[test]
fn manual_c_abi_drives_start_dispatch_poll_and_buffer_free() {
    let engine = bota_device_sdk_engine_new();
    assert!(!engine.is_null());
    let command = serde_json::to_vec(&Command::DiscoverDevices {
        timeout_ms: 5_000,
        allow_duplicates: true,
    })
    .unwrap();

    assert_eq!(
        unsafe {
            bota_device_sdk_engine_start_json(
                engine,
                command.as_ptr(),
                command.len(),
                BOTA_DEVICE_SDK_CAPABILITY_BLE | BOTA_DEVICE_SDK_CAPABILITY_TIMER,
                0,
                7,
            )
        },
        BotaDeviceSdkStatus::Ok
    );

    let started = unsafe { poll(engine) };
    assert!(matches!(
        started.effect,
        Effect::Notify(WorkflowNotification::Started {
            operation: Operation::Discover
        })
    ));
    let scan = unsafe { poll(engine) };
    assert!(matches!(
        scan.effect,
        Effect::Ble(BleEffect::StartScan { .. })
    ));
    let timer = unsafe { poll(engine) };
    let (timer_request_id, timer_id) = match timer {
        EffectRequest {
            request_id,
            effect: Effect::Timer(TimerEffect::Schedule { timer_id, .. }),
            ..
        } => (request_id.as_u64(), timer_id),
        other => panic!("unexpected timer effect: {other:?}"),
    };

    let timer_event = serde_json::to_vec(&HostEventKind::TimerFired { timer_id }).unwrap();
    assert_eq!(
        unsafe {
            bota_device_sdk_engine_dispatch_json(
                engine,
                timer_request_id,
                timer_event.as_ptr(),
                timer_event.len(),
            )
        },
        BotaDeviceSdkStatus::Ok
    );
    let stop = unsafe { poll(engine) };
    let stop_request_id = stop.request_id.as_u64();
    assert!(matches!(stop.effect, Effect::Ble(BleEffect::StopScan)));

    let stopped = serde_json::to_vec(&HostEventKind::Ble(BleEvent::ScanStopped)).unwrap();
    assert_eq!(
        unsafe {
            bota_device_sdk_engine_dispatch_json(
                engine,
                stop_request_id,
                stopped.as_ptr(),
                stopped.len(),
            )
        },
        BotaDeviceSdkStatus::Ok
    );
    let completed = unsafe { poll(engine) };
    assert!(matches!(
        completed.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::Discover
        })
    ));

    unsafe { bota_device_sdk_engine_free(engine) };
}

#[test]
fn manual_c_abi_preserves_cancellation_and_error_delivery() {
    let engine = bota_device_sdk_engine_new();
    let command = serde_json::to_vec(&Command::DiscoverDevices {
        timeout_ms: 5_000,
        allow_duplicates: false,
    })
    .unwrap();

    assert_eq!(
        unsafe {
            bota_device_sdk_engine_start_json(
                engine,
                command.as_ptr(),
                command.len(),
                BOTA_DEVICE_SDK_CAPABILITY_BLE | BOTA_DEVICE_SDK_CAPABILITY_TIMER,
                0,
                9,
            )
        },
        BotaDeviceSdkStatus::Ok
    );
    assert_eq!(
        unsafe { bota_device_sdk_engine_cancel(engine, 0, 9) },
        BotaDeviceSdkStatus::Ok
    );

    let mut notifications = Vec::new();
    loop {
        let mut buffer = BotaDeviceSdkOwnedBuffer::default();
        match unsafe { bota_device_sdk_engine_poll_output(engine, &mut buffer) } {
            BotaDeviceSdkStatus::Ok => {
                let output: EffectRequest =
                    serde_json::from_slice(&unsafe { read_buffer(buffer) }).unwrap();
                if let Effect::Notify(notification) = output.effect {
                    notifications.push(notification);
                }
            }
            BotaDeviceSdkStatus::NoOutput => break,
            status => panic!("unexpected poll status: {status:?}"),
        }
    }
    assert!(matches!(
        notifications.last(),
        Some(WorkflowNotification::Cancelled {
            operation: Operation::Discover
        })
    ));

    let invalid = b"{";
    assert_eq!(
        unsafe {
            bota_device_sdk_engine_start_json(
                engine,
                invalid.as_ptr(),
                invalid.len(),
                BOTA_DEVICE_SDK_CAPABILITY_BLE | BOTA_DEVICE_SDK_CAPABILITY_TIMER,
                0,
                10,
            )
        },
        BotaDeviceSdkStatus::OperationFailed
    );
    let mut error = BotaDeviceSdkOwnedBuffer::default();
    assert_eq!(
        unsafe { bota_device_sdk_engine_last_error(engine, &mut error) },
        BotaDeviceSdkStatus::Ok
    );
    let error: serde_json::Value = serde_json::from_slice(&unsafe { read_buffer(error) }).unwrap();
    assert!(error["message"].as_str().unwrap().contains("command JSON"));

    unsafe { bota_device_sdk_engine_free(engine) };
}

#[cfg(feature = "uniffi-spike")]
#[test]
fn uniffi_object_drives_the_same_engine_boundary() {
    use bota_device_sdk_ffi_smoke::UniFfiEngine;

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
