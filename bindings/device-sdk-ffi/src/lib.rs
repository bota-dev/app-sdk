mod command;
mod error;
mod event;
mod output;
mod packet;
mod protocol;

pub use command::capability_bits;
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
    engine::{CancellationId, EffectRequest, Event, WorkflowEngine, WorkflowStatus},
    error::{DeviceSdkError, ErrorCode, Operation},
    protocol::DeviceLogDecoder,
};
use error::internal_error;
use std::{
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Mutex,
};

#[derive(Default)]
struct EngineBridge {
    engine: WorkflowEngine,
    outputs: VecDeque<EffectRequest>,
    log_decoder: DeviceLogDecoder,
    last_error: Option<DeviceSdkError>,
}

impl EngineBridge {
    fn enqueue(&mut self, effects: Vec<EffectRequest>) {
        self.outputs.extend(effects);
    }
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
            let effects = bridge.engine.dispatch(Event::Cancelled {
                cancellation_id: cancellation_id(cancellation_id_high, cancellation_id_low),
            })?;
            bridge.enqueue(effects);
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine. `packet` and every non-empty field
/// slice must remain readable for the duration of this call.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_start(
    engine: *mut BotaDeviceSdkEngineV1,
    packet: *const BotaDeviceSdkPacketViewV1,
    capability_bits: u64,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() || packet.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    let packet = unsafe { *packet };
    if packet.abi_version != ABI_VERSION {
        return BotaDeviceSdkStatusV1::UnsupportedAbi;
    }

    unsafe {
        with_engine(engine, |bridge| {
            let command = command::command_from_packet(&packet)?;
            let capabilities = command::capabilities_from_bits(capability_bits)?;
            let effects = bridge.engine.start(
                command,
                &capabilities,
                cancellation_id(packet.cancellation_id_high, packet.cancellation_id_low),
            )?;
            bridge.enqueue(effects);
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine and `out_packet` must point to writable
/// pointer storage. A successful packet must be freed exactly once.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_poll_output(
    engine: *mut BotaDeviceSdkEngineV1,
    out_packet: *mut *mut BotaDeviceSdkPacketV1,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() || out_packet.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        unsafe { out_packet.write(ptr::null_mut()) };
        let engine = unsafe { &*engine };
        let mut bridge = engine.bridge.lock().map_err(|_| ())?;
        let Some(effect) = bridge.outputs.pop_front() else {
            return Ok::<_, ()>(None);
        };
        match output::packet_from_effect_request(effect) {
            Ok(packet) => {
                bridge.last_error = None;
                Ok(Some(packet))
            }
            Err(error) => {
                bridge.last_error = Some(error);
                Err(())
            }
        }
    })) {
        Ok(Ok(Some(packet))) => {
            unsafe { out_packet.write(Box::into_raw(Box::new(packet))) };
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
/// `engine` must be a live SDK engine. `packet` and every non-empty field
/// slice must remain readable for the duration of this call.
pub unsafe extern "C" fn bota_device_sdk_v1_engine_dispatch(
    engine: *mut BotaDeviceSdkEngineV1,
    packet: *const BotaDeviceSdkPacketViewV1,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() || packet.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    let packet = unsafe { *packet };
    if packet.abi_version != ABI_VERSION {
        return BotaDeviceSdkStatusV1::UnsupportedAbi;
    }

    unsafe {
        with_engine(engine, |bridge| {
            let event = event::host_event_from_packet(&packet)?;
            let supplied_cancellation =
                cancellation_id(packet.cancellation_id_high, packet.cancellation_id_low);
            match bridge.engine.status() {
                WorkflowStatus::Running {
                    operation,
                    cancellation_id,
                } if *operation == operation_from_code(packet.operation)
                    && *cancellation_id == supplied_cancellation => {}
                WorkflowStatus::Running { .. } => {
                    return Err(DeviceSdkError::new(
                        ErrorCode::UnexpectedEvent,
                        Operation::Unknown,
                        false,
                    )
                    .with_detail(
                        "event operation or cancellation ID does not own the active workflow",
                    ));
                }
                _ => {
                    return Err(DeviceSdkError::new(
                        ErrorCode::UnexpectedEvent,
                        Operation::Unknown,
                        false,
                    )
                    .with_detail("no workflow is active"));
                }
            }
            let effects = bridge.engine.dispatch(Event::Host(event))?;
            bridge.enqueue(effects);
            Ok(())
        })
    }
}

fn operation_from_code(code: u32) -> Operation {
    match code {
        1 => Operation::Validate,
        2 => Operation::Decode,
        3 => Operation::Encode,
        4 => Operation::Discover,
        5 => Operation::Connect,
        6 => Operation::Reconnect,
        7 => Operation::Provision,
        8 => Operation::TransferRecording,
        9 => Operation::Upload,
        10 => Operation::UpdateFirmware,
        11 => Operation::ReadDeviceLogs,
        12 => Operation::FactoryReset,
        _ => Operation::Unknown,
    }
}

unsafe fn protocol_call(
    engine: *mut BotaDeviceSdkEngineV1,
    packet: *const BotaDeviceSdkPacketViewV1,
    out_packet: *mut *mut BotaDeviceSdkPacketV1,
    operation: impl FnOnce(
        &mut EngineBridge,
        &BotaDeviceSdkPacketViewV1,
    ) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError>,
) -> BotaDeviceSdkStatusV1 {
    if engine.is_null() || packet.is_null() || out_packet.is_null() {
        return BotaDeviceSdkStatusV1::InvalidArgument;
    }
    let packet = unsafe { *packet };
    if packet.abi_version != ABI_VERSION {
        return BotaDeviceSdkStatusV1::UnsupportedAbi;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        unsafe { out_packet.write(ptr::null_mut()) };
        let engine = unsafe { &*engine };
        let mut bridge = engine.bridge.lock().map_err(|_| ())?;
        match operation(&mut bridge, &packet) {
            Ok(packet) => {
                bridge.last_error = None;
                Ok(packet)
            }
            Err(error) => {
                bridge.last_error = Some(error);
                Err(())
            }
        }
    })) {
        Ok(Ok(packet)) => {
            unsafe { out_packet.write(Box::into_raw(Box::new(packet))) };
            BotaDeviceSdkStatusV1::Ok
        }
        Ok(Err(())) => BotaDeviceSdkStatusV1::OperationFailed,
        Err(_) => BotaDeviceSdkStatusV1::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// All pointers must be live for this call. A successful packet must be freed
/// exactly once. Stateful log decoding is scoped to `engine`.
pub unsafe extern "C" fn bota_device_sdk_v1_protocol_decode(
    engine: *mut BotaDeviceSdkEngineV1,
    packet: *const BotaDeviceSdkPacketViewV1,
    out_packet: *mut *mut BotaDeviceSdkPacketV1,
) -> BotaDeviceSdkStatusV1 {
    unsafe {
        protocol_call(engine, packet, out_packet, |bridge, packet| {
            protocol::decode(packet, &mut bridge.log_decoder)
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// All pointers must be live for this call. A successful packet must be freed
/// exactly once.
pub unsafe extern "C" fn bota_device_sdk_v1_protocol_encode(
    engine: *mut BotaDeviceSdkEngineV1,
    packet: *const BotaDeviceSdkPacketViewV1,
    out_packet: *mut *mut BotaDeviceSdkPacketV1,
) -> BotaDeviceSdkStatusV1 {
    unsafe {
        protocol_call(engine, packet, out_packet, |_bridge, packet| {
            protocol::encode(packet)
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
