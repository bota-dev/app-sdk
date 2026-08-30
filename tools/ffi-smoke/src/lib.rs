#![cfg(feature = "uniffi-spike")]

use bota_device_sdk_core::engine::{
    CancellationId, CapabilitySet, Command, EffectRequest, Event, HostEvent, HostEventKind,
    RequestId, WorkflowEngine,
};
use std::{collections::VecDeque, sync::Mutex};

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

#[derive(Default)]
struct EngineBridge {
    engine: WorkflowEngine,
    outputs: VecDeque<String>,
}

impl EngineBridge {
    fn start_json(
        &mut self,
        command_json: &str,
        capability_bits: u64,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), String> {
        let command: Command = serde_json::from_str(command_json)
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

    fn dispatch_json(&mut self, request_id: u64, event_json: &str) -> Result<(), String> {
        let kind: HostEventKind = serde_json::from_str(event_json)
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
            self.outputs.push_back(
                serde_json::to_string(&effect)
                    .map_err(|error| format!("failed to encode workflow effect: {error}"))?,
            );
        }
        Ok(())
    }
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

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UniFfiSmokeError {
    #[error("{message}")]
    Failure { message: String },
}

impl From<String> for UniFfiSmokeError {
    fn from(message: String) -> Self {
        Self::Failure { message }
    }
}

#[derive(uniffi::Object)]
pub struct UniFfiEngine {
    bridge: Mutex<EngineBridge>,
}

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
                &command_json,
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
        self.with_bridge(|bridge| bridge.dispatch_json(request_id, &event_json))
    }

    pub fn cancel(
        &self,
        cancellation_id_high: u64,
        cancellation_id_low: u64,
    ) -> Result<(), UniFfiSmokeError> {
        self.with_bridge(|bridge| bridge.cancel(cancellation_id_high, cancellation_id_low))
    }

    pub fn poll_output(&self) -> Option<String> {
        self.bridge.lock().ok()?.outputs.pop_front()
    }
}

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

uniffi::setup_scaffolding!();
