mod error;
mod packet;

pub use error::{
    ABI_VERSION, BotaDeviceSdkErrorV1, BotaDeviceSdkErrorViewV1, BotaDeviceSdkSliceV1,
    BotaDeviceSdkStatusV1,
};
pub use packet::{
    BotaDeviceSdkFieldViewV1, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1,
    bota_device_sdk_v1_packet_free, bota_device_sdk_v1_packet_view, field_id, field_type,
    kind as packet_kind,
};

use bota_device_sdk_core::{
    engine::{CancellationId, Event, WorkflowEngine},
    error::DeviceSdkError,
};
use error::internal_error;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Mutex,
};

#[derive(Default)]
struct EngineBridge {
    engine: WorkflowEngine,
    last_error: Option<DeviceSdkError>,
}

#[repr(C)]
pub struct BotaDeviceSdkEngineV1 {
    bridge: Mutex<EngineBridge>,
}

fn cancellation_id(high: u64, low: u64) -> CancellationId {
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&high.to_be_bytes());
    bytes[8..].copy_from_slice(&low.to_be_bytes());
    CancellationId::from_bytes(bytes)
}

unsafe fn with_engine(
    engine: *mut BotaDeviceSdkEngineV1,
    operation: impl FnOnce(&mut EngineBridge) -> Result<(), DeviceSdkError>,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        let engine = unsafe { &*engine };
        let mut bridge = engine
            .bridge
            .lock()
            .map_err(|_| internal_error("engine lock is poisoned"))?;
        match operation(&mut bridge) {
            Ok(()) => {
                bridge.last_error = None;
                Ok(())
            }
            Err(error) => {
                bridge.last_error = Some(error.clone());
                Err(error)
            }
        }
    })) {
        Ok(Ok(())) => BotaDeviceSdkStatusV1::Ok,
        Ok(Err(_)) => BotaDeviceSdkStatusV1::OperationFailed,
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_device_sdk_v1_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_device_sdk_v1_engine_new() -> *mut BotaDeviceSdkEngineV1 {
    catch_unwind(|| {
        Box::into_raw(Box::new(BotaDeviceSdkEngineV1 {
            bridge: Mutex::new(EngineBridge::default()),
        }))
    })
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be null or a live pointer returned by
/// [`bota_device_sdk_v1_engine_new`] that has not already been freed.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_free(engine: *mut BotaDeviceSdkEngineV1) {
    if !engine.is_null() {
        drop(unsafe { Box::from_raw(engine) });
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_cancel(
    engine: *mut BotaDeviceSdkEngineV1,
    cancellation_id_high: u64,
    cancellation_id_low: u64,
) -> BotaDeviceSdkStatusV1 {
    unsafe {
        with_engine(engine, |bridge| {
            bridge
                .engine
                .dispatch(Event::Cancelled {
                    cancellation_id: cancellation_id(cancellation_id_high, cancellation_id_low),
                })
                .map(|_| ())
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine and `out_error` must point to writable
/// pointer storage. A successful result must be freed exactly once.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_last_error(
    engine: *mut BotaDeviceSdkEngineV1,
    out_error: *mut *mut BotaDeviceSdkErrorV1,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() || out_error.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        unsafe { out_error.write(ptr::null_mut()) };
        let engine = unsafe { &*engine };
        let bridge = engine.bridge.lock().map_err(|_| ())?;
        Ok::<_, ()>(bridge.last_error.clone())
    })) {
        Ok(Ok(Some(error))) => {
            unsafe { out_error.write(Box::into_raw(Box::new(error.into()))) };
            BotaDeviceSdkStatusV1::Ok
        }
        Ok(Ok(None)) => BotaDeviceSdkStatusV1::NoOutput,
        Ok(Err(())) => BotaDeviceSdkStatusV1::OperationFailed,
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `error` must be a live SDK error and `out_view` must point to writable
/// storage. Borrowed slices in the view remain valid until `error` is freed.
pub unsafe extern "C" fn bota_device_sdk_v1_error_view(
    error: *const BotaDeviceSdkErrorV1,
    out_view: *mut BotaDeviceSdkErrorViewV1,
) -> BotaDeviceSdkStatusV1 {
    if error.is_null() || out_view.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        let error = unsafe { &*error };
        unsafe { out_view.write(error.view()) };
    })) {
        Ok(()) => BotaDeviceSdkStatusV1::Ok,
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `error` must be null or a live SDK-owned error that has not been freed.
pub unsafe extern "C" fn bota_device_sdk_v1_error_free(error: *mut BotaDeviceSdkErrorV1) {
    if !error.is_null() {
        drop(unsafe { Box::from_raw(error) });
    }
}
