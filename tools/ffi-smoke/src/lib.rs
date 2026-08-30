use bota_device_sdk_core::engine::{
    CancellationId, CapabilitySet, Command, EffectRequest, Event, HostEvent, HostEventKind,
    RequestId, WorkflowEngine,
};
use std::{
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Mutex,
};

pub const BOTA_DEVICE_SDK_CAPABILITY_BLE: u64 = 1 << 0;
pub const BOTA_DEVICE_SDK_CAPABILITY_TIMER: u64 = 1 << 1;
pub const BOTA_DEVICE_SDK_CAPABILITY_PERSISTENCE: u64 = 1 << 2;
pub const BOTA_DEVICE_SDK_CAPABILITY_SECURE_STORAGE: u64 = 1 << 3;
pub const BOTA_DEVICE_SDK_CAPABILITY_NETWORK_TRANSFER: u64 = 1 << 4;
pub const BOTA_DEVICE_SDK_CAPABILITY_PROGRESS: u64 = 1 << 5;
pub const BOTA_DEVICE_SDK_CAPABILITY_HOST_MATERIAL: u64 = 1 << 6;
pub const BOTA_DEVICE_SDK_CAPABILITY_RECORDING_SINK: u64 = 1 << 7;
pub const BOTA_DEVICE_SDK_CAPABILITY_FIRMWARE_BLOB: u64 = 1 << 8;

const KNOWN_CAPABILITY_BITS: u64 = BOTA_DEVICE_SDK_CAPABILITY_BLE
    | BOTA_DEVICE_SDK_CAPABILITY_TIMER
    | BOTA_DEVICE_SDK_CAPABILITY_PERSISTENCE
    | BOTA_DEVICE_SDK_CAPABILITY_SECURE_STORAGE
    | BOTA_DEVICE_SDK_CAPABILITY_NETWORK_TRANSFER
    | BOTA_DEVICE_SDK_CAPABILITY_PROGRESS
    | BOTA_DEVICE_SDK_CAPABILITY_HOST_MATERIAL
    | BOTA_DEVICE_SDK_CAPABILITY_RECORDING_SINK
    | BOTA_DEVICE_SDK_CAPABILITY_FIRMWARE_BLOB;

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BotaDeviceSdkStatus {
    Ok = 0,
    NoOutput = 1,
    InvalidArgument = -1,
    OperationFailed = -2,
    Panic = -3,
}

#[repr(C)]
#[derive(Debug)]
pub struct BotaDeviceSdkOwnedBuffer {
    pub data: *mut u8,
    pub len: usize,
}

impl Default for BotaDeviceSdkOwnedBuffer {
    fn default() -> Self {
        Self {
            data: ptr::null_mut(),
            len: 0,
        }
    }
}

#[derive(Default)]
struct EngineBridge {
    engine: WorkflowEngine,
    outputs: VecDeque<Vec<u8>>,
    last_error: Option<Vec<u8>>,
}

impl EngineBridge {
    fn start_json(
        &mut self,
        command_json: &[u8],
        capability_bits: u64,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), String> {
        let command: Command = serde_json::from_slice(command_json)
            .map_err(|error| format!("invalid command JSON: {error}"))?;
        let capabilities = capabilities_from_bits(capability_bits)?;
        let effects = self
            .engine
            .start(
                command,
                &capabilities,
                cancellation_id(cancellation_id_high, cancellation_id_low),
            )
            .map_err(|error| error.to_string())?;
        self.enqueue(effects)
    }

    fn dispatch_json(&mut self, request_id: u64, event_json: &[u8]) -> Result<(), String> {
        let kind: HostEventKind = serde_json::from_slice(event_json)
            .map_err(|error| format!("invalid event JSON: {error}"))?;
        let effects = self
            .engine
            .dispatch(Event::Host(HostEvent {
                request_id: RequestId::from_u64(request_id),
                kind,
            }))
            .map_err(|error| error.to_string())?;
        self.enqueue(effects)
    }

    fn cancel(
        &mut self,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), String> {
        let effects = self
            .engine
            .dispatch(Event::Cancelled {
                cancellation_id: cancellation_id(cancellation_id_high, cancellation_id_low),
            })
            .map_err(|error| error.to_string())?;
        self.enqueue(effects)
    }

    fn enqueue(&mut self, effects: Vec<EffectRequest>) -> Result<(), String> {
        for effect in effects {
            let encoded = serde_json::to_vec(&effect)
                .map_err(|error| format!("failed to encode workflow effect: {error}"))?;
            self.outputs.push_back(encoded);
        }
        self.last_error = None;
        Ok(())
    }

    fn fail(&mut self, message: String) {
        self.last_error = serde_json::to_vec(&serde_json::json!({ "message": message })).ok();
    }
}

#[repr(C)]
pub struct BotaDeviceSdkEngine {
    bridge: Mutex<EngineBridge>,
}

fn cancellation_id(high: u64, low: u64) -> CancellationId {
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&high.to_be_bytes());
    bytes[8..].copy_from_slice(&low.to_be_bytes());
    CancellationId::from_bytes(bytes)
}

fn capabilities_from_bits(bits: u64) -> Result<CapabilitySet, String> {
    let unknown = bits & !KNOWN_CAPABILITY_BITS;
    if unknown != 0 {
        return Err(format!("unknown capability bits: 0x{unknown:x}"));
    }

    let names = [
        (BOTA_DEVICE_SDK_CAPABILITY_BLE, "Ble"),
        (BOTA_DEVICE_SDK_CAPABILITY_TIMER, "Timer"),
        (BOTA_DEVICE_SDK_CAPABILITY_PERSISTENCE, "Persistence"),
        (BOTA_DEVICE_SDK_CAPABILITY_SECURE_STORAGE, "SecureStorage"),
        (
            BOTA_DEVICE_SDK_CAPABILITY_NETWORK_TRANSFER,
            "NetworkTransfer",
        ),
        (BOTA_DEVICE_SDK_CAPABILITY_PROGRESS, "Progress"),
        (BOTA_DEVICE_SDK_CAPABILITY_HOST_MATERIAL, "HostMaterial"),
        (BOTA_DEVICE_SDK_CAPABILITY_RECORDING_SINK, "RecordingSink"),
        (BOTA_DEVICE_SDK_CAPABILITY_FIRMWARE_BLOB, "FirmwareBlob"),
    ]
    .into_iter()
    .filter_map(|(mask, name)| (bits & mask != 0).then_some(name))
    .collect::<Vec<_>>();

    serde_json::from_value(serde_json::json!(names))
        .map_err(|error| format!("failed to decode capabilities: {error}"))
}

unsafe fn copied_input(data: *const u8, len: usize) -> Result<Vec<u8>, BotaDeviceSdkStatus> {
    if data.is_null() && len != 0 {
        return Err(BotaDeviceSdkStatus::InvalidArgument);
    }
    if len == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { std::slice::from_raw_parts(data, len) }.to_vec())
}

unsafe fn write_owned_buffer(
    bytes: Vec<u8>,
    out: *mut BotaDeviceSdkOwnedBuffer,
) -> BotaDeviceSdkStatus {
    if out.is_null() {
        return BotaDeviceSdkStatus::InvalidArgument;
    }
    let mut bytes = bytes.into_boxed_slice();
    let buffer = BotaDeviceSdkOwnedBuffer {
        data: bytes.as_mut_ptr(),
        len: bytes.len(),
    };
    std::mem::forget(bytes);
    unsafe { out.write(buffer) };
    BotaDeviceSdkStatus::Ok
}

unsafe fn run_with_engine(
    engine: *mut BotaDeviceSdkEngine,
    operation: impl FnOnce(&mut EngineBridge) -> Result<(), String>,
) -> BotaDeviceSdkStatus {
    if engine.is_null() {
        return BotaDeviceSdkStatus::InvalidArgument;
    }
    match catch_unwind(AssertUnwindSafe(|| {
        let engine = unsafe { &*engine };
        let mut bridge = engine
            .bridge
            .lock()
            .map_err(|_| "engine lock is poisoned".to_owned())?;
        operation(&mut bridge).inspect_err(|message| bridge.fail(message.clone()))
    })) {
        Ok(Ok(())) => BotaDeviceSdkStatus::Ok,
        Ok(Err(_)) => BotaDeviceSdkStatus::OperationFailed,
        Err(_) => BotaDeviceSdkStatus::Panic,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bota_device_sdk_engine_new() -> *mut BotaDeviceSdkEngine {
    catch_unwind(|| {
        Box::into_raw(Box::new(BotaDeviceSdkEngine {
            bridge: Mutex::new(EngineBridge::default()),
        }))
    })
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be null or a live pointer returned by
/// [`bota_device_sdk_engine_new`] that has not already been freed.
pub unsafe extern "C" fn bota_device_sdk_engine_free(engine: *mut BotaDeviceSdkEngine) {
    if !engine.is_null() {
        drop(unsafe { Box::from_raw(engine) });
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine. `command_json` must point to
/// `command_len` readable bytes for the duration of this call.
pub unsafe extern "C" fn bota_device_sdk_engine_start_json(
    engine: *mut BotaDeviceSdkEngine,
    command_json: *const u8,
    command_len: usize,
    capability_bits: u64,
    cancellation_id_high: u64,
    cancellation_id_low: u64,
) -> BotaDeviceSdkStatus {
    let command_json = match unsafe { copied_input(command_json, command_len) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    unsafe {
        run_with_engine(engine, |bridge| {
            bridge.start_json(
                &command_json,
                capability_bits,
                cancellation_id_high,
                cancellation_id_low,
            )
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine. `event_json` must point to `event_len`
/// readable bytes for the duration of this call.
pub unsafe extern "C" fn bota_device_sdk_engine_dispatch_json(
    engine: *mut BotaDeviceSdkEngine,
    request_id: u64,
    event_json: *const u8,
    event_len: usize,
) -> BotaDeviceSdkStatus {
    let event_json = match unsafe { copied_input(event_json, event_len) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    unsafe {
        run_with_engine(engine, |bridge| {
            bridge.dispatch_json(request_id, &event_json)
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine.
pub unsafe extern "C" fn bota_device_sdk_engine_cancel(
    engine: *mut BotaDeviceSdkEngine,
    cancellation_id_high: u64,
    cancellation_id_low: u64,
) -> BotaDeviceSdkStatus {
    unsafe {
        run_with_engine(engine, |bridge| {
            bridge.cancel(cancellation_id_high, cancellation_id_low)
        })
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine and `out_buffer` must point to writable
/// memory. A successful output must later be passed exactly once to
/// [`bota_device_sdk_buffer_free`].
pub unsafe extern "C" fn bota_device_sdk_engine_poll_output(
    engine: *mut BotaDeviceSdkEngine,
    out_buffer: *mut BotaDeviceSdkOwnedBuffer,
) -> BotaDeviceSdkStatus {
    if engine.is_null() || out_buffer.is_null() {
        return BotaDeviceSdkStatus::InvalidArgument;
    }
    match catch_unwind(AssertUnwindSafe(|| {
        unsafe { out_buffer.write(BotaDeviceSdkOwnedBuffer::default()) };
        let engine = unsafe { &*engine };
        let mut bridge = engine.bridge.lock().map_err(|_| ())?;
        Ok::<_, ()>(bridge.outputs.pop_front())
    })) {
        Ok(Ok(Some(bytes))) => unsafe { write_owned_buffer(bytes, out_buffer) },
        Ok(Ok(None)) => BotaDeviceSdkStatus::NoOutput,
        Ok(Err(())) => BotaDeviceSdkStatus::OperationFailed,
        Err(_) => BotaDeviceSdkStatus::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `engine` must be a live SDK engine and `out_buffer` must point to writable
/// memory. A successful output must later be passed exactly once to
/// [`bota_device_sdk_buffer_free`].
pub unsafe extern "C" fn bota_device_sdk_engine_last_error(
    engine: *mut BotaDeviceSdkEngine,
    out_buffer: *mut BotaDeviceSdkOwnedBuffer,
) -> BotaDeviceSdkStatus {
    if engine.is_null() || out_buffer.is_null() {
        return BotaDeviceSdkStatus::InvalidArgument;
    }
    match catch_unwind(AssertUnwindSafe(|| {
        unsafe { out_buffer.write(BotaDeviceSdkOwnedBuffer::default()) };
        let engine = unsafe { &*engine };
        let bridge = engine.bridge.lock().map_err(|_| ())?;
        Ok::<_, ()>(bridge.last_error.clone())
    })) {
        Ok(Ok(Some(bytes))) => unsafe { write_owned_buffer(bytes, out_buffer) },
        Ok(Ok(None)) => BotaDeviceSdkStatus::NoOutput,
        Ok(Err(())) => BotaDeviceSdkStatus::OperationFailed,
        Err(_) => BotaDeviceSdkStatus::Panic,
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `buffer` must be an SDK-owned value returned by a successful poll or error
/// call, and it must not have been freed previously.
pub unsafe extern "C" fn bota_device_sdk_buffer_free(buffer: BotaDeviceSdkOwnedBuffer) {
    if !buffer.data.is_null() {
        let slice = ptr::slice_from_raw_parts_mut(buffer.data, buffer.len);
        drop(unsafe { Box::from_raw(slice) });
    }
}

#[cfg(feature = "uniffi-spike")]
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UniFfiSmokeError {
    #[error("{message}")]
    Failure { message: String },
}

#[cfg(feature = "uniffi-spike")]
impl From<String> for UniFfiSmokeError {
    fn from(message: String) -> Self {
        Self::Failure { message }
    }
}

#[cfg(feature = "uniffi-spike")]
#[derive(uniffi::Object)]
pub struct UniFfiEngine {
    bridge: Mutex<EngineBridge>,
}

#[cfg(feature = "uniffi-spike")]
#[uniffi::export]
impl UniFfiEngine {
    #[uniffi::constructor]
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            bridge: Mutex::new(EngineBridge::default()),
        })
    }

    pub fn start_json(
        &self,
        command_json: String,
        capability_bits: u64,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), UniFfiSmokeError> {
        self.with_bridge(|bridge| {
            bridge.start_json(
                command_json.as_bytes(),
                capability_bits,
                cancellation_id_high,
                cancellation_id_low,
            )
        })
    }

    pub fn dispatch_json(
        &self,
        request_id: u64,
        event_json: String,
    ) -> Result<(), UniFfiSmokeError> {
        self.with_bridge(|bridge| bridge.dispatch_json(request_id, event_json.as_bytes()))
    }

    pub fn cancel(
        &self,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), UniFfiSmokeError> {
        self.with_bridge(|bridge| bridge.cancel(cancellation_id_high, cancellation_id_low))
    }

    pub fn poll_output(&self) -> Option<String> {
        self.bridge
            .lock()
            .ok()?
            .outputs
            .pop_front()
            .and_then(|output| String::from_utf8(output).ok())
    }
}

#[cfg(feature = "uniffi-spike")]
impl UniFfiEngine {
    fn with_bridge(
        &self,
        operation: impl FnOnce(&mut EngineBridge) -> Result<(), String>,
    ) -> Result<(), UniFfiSmokeError> {
        let mut bridge = self.bridge.lock().map_err(|_| UniFfiSmokeError::Failure {
            message: "engine lock is poisoned".to_owned(),
        })?;
        operation(&mut bridge).map_err(Into::into)
    }
}

#[cfg(feature = "uniffi-spike")]
uniffi::setup_scaffolding!();
